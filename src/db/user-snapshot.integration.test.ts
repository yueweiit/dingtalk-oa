import pg from 'pg';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCurrentSnapshot, recordFetchFailure, upsertSnapshot } from './queries/user-snapshot.js';

const state = vi.hoisted(() => ({ pool: null as pg.Pool | null }));
vi.mock('./pool.js', () => {
  const withClient = async (run: (client: pg.PoolClient) => Promise<unknown>) => {
    if (!state.pool) throw new Error('USER_SNAPSHOT_TEST_DATABASE_NOT_CONNECTED');
    const client = await state.pool.connect();
    try { return await run(client); } finally { client.release(); }
  };
  return { withClient, withTransaction: (run: (client: pg.PoolClient) => Promise<unknown>) => withClient(async client => {
    await client.query('BEGIN');
    try { const result = await run(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
  }) };
});

const require = createRequire(import.meta.url);
const Builder = require('node-pg-migrate/dist/migrationBuilder').default;
const databaseUrl = process.env.USER_SNAPSHOT_TEST_DATABASE_URL;
const schema = `user_snapshot_it_${process.pid}_${Date.now()}`;
let admin: pg.Client | null = null;
let created = false;
function sql(name: string): string {
  const builder = new Builder({ query: () => { throw new Error('MIGRATION_BUILDER_MUST_NOT_CONNECT'); } }, undefined, false, console);
  require(`../../migrations/${name}.cjs`).up(builder);
  // 在获准测试库的独立 schema 执行真实迁移，禁止改写 public 表。
  return (builder.getSql() as string).replaceAll('"public".', `"${schema}".`).replace(/\bpublic\./g, `"${schema}".`);
}
const migration = '20261110000000_separate_user_fetch_failures';
const validationMigration = '20261110000001_validate_user_snapshot_current';
const cleanupMigration = '20261110000002_purge_legacy_failed_user_snapshots';
const profile = { corp_id: 'corp-test', user_id: 'user-test', name: '测试人员', snapshot_hash: 'hash-new' };
const failure = { corp_id: profile.corp_id, user_id: profile.user_id, fetch_status: 'not_found', fetch_error: 'synthetic user not found' };

describe.skipIf(!databaseUrl)('user snapshot migration and concurrency (isolated PostgreSQL)', () => {
  beforeAll(async () => {
    let url: URL;
    try { url = new URL(databaseUrl!); } catch { throw new Error('USER_SNAPSHOT_TEST_DATABASE_URL_INVALID'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || !/^\/user_snapshot_test(?:_[a-z0-9_]+)?$/.test(url.pathname)
      || [...url.searchParams.keys()].some(key => ['host', 'hostaddr', 'port', 'dbname', 'options', 'service'].includes(key.toLowerCase()))) {
      throw new Error('USER_SNAPSHOT_TEST_REQUIRES_DISPOSABLE_LOOPBACK_DATABASE');
    }
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await admin.query(`SET search_path TO "${schema}"`);
    await admin.query(sql('20260703000003_create_ding_user_snapshot'));
    await admin.query(sql('20260914000000_add_union_id_to_user_snapshot'));
    await admin.query('BEGIN');
    try { await admin.query(sql(migration)); await admin.query('COMMIT'); }
    catch (error) { await admin.query('ROLLBACK'); throw error; }
    await admin.query(sql(validationMigration));
    state.pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 5 });
  });
  afterAll(async () => {
    await state.pool?.end(); state.pool = null;
    if (admin && created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });
  beforeEach(async () => {
    await admin!.query(`TRUNCATE "${schema}".ding_user_fetch_failure, "${schema}".ding_user_snapshot`);
  });

  async function migrateLegacy(seedSql = '') {
    await admin!.query('BEGIN');
    try {
      await admin!.query(`DROP TABLE "${schema}".ding_user_fetch_failure;
        DROP INDEX "${schema}".user_snapshot_one_current_per_user;
        ALTER TABLE "${schema}".ding_user_snapshot DROP CONSTRAINT user_snapshot_current_success;`);
      if (seedSql) await admin!.query(seedSql);
      await admin!.query(sql(migration));
      await admin!.query('COMMIT');
    } catch (error) {
      await admin!.query('ROLLBACK');
      throw error;
    }
  }

  it('preserves all historical rows, restores the last success, and removes duplicate current markers', async () => {
    await migrateLegacy(`INSERT INTO ding_user_snapshot
        (corp_id,user_id,name,snapshot_hash,fetch_status,is_current,valid_from,valid_to) VALUES
        ('corp-test','user-test','旧姓名','old','success',true,'2026-11-01',NULL),
        ('corp-test','user-test','最后成功姓名','latest','success',false,'2026-11-02','2026-11-03'),
        ('corp-test','user-test','unknown','failed-1','failed',true,'2026-11-03',NULL),
        ('corp-test','never-succeeded','unknown','failed-2','failed',true,'2026-11-03',NULL)`);
    await admin!.query(sql(validationMigration));
    const current = await getCurrentSnapshot(profile.corp_id, profile.user_id);
    expect(current).toMatchObject({ name: '最后成功姓名', is_current: true, valid_to: null, fetch_status: 'success' });
    expect(await getCurrentSnapshot('corp-test', 'never-succeeded')).toBeNull();
    expect((await admin!.query('SELECT count(*)::int AS n FROM ding_user_snapshot')).rows[0].n).toBe(4);
    expect((await admin!.query('SELECT count(*)::int AS n FROM ding_user_fetch_failure')).rows[0].n).toBe(2);
    const { rows: periods } = await admin!.query(`SELECT a.valid_to = b.valid_from AS adjacent
      FROM ding_user_snapshot a JOIN ding_user_snapshot b USING(corp_id,user_id)
      WHERE a.snapshot_hash = 'old' AND b.snapshot_hash = 'latest'`);
    expect(periods[0].adjacent).toBe(true);
  });

  it('closes multiple open successful versions at each following version start', async () => {
    await migrateLegacy(`INSERT INTO ding_user_snapshot
      (corp_id,user_id,snapshot_hash,fetch_status,is_current,valid_from) VALUES
      ('corp-test','user-test','a','success',true,'2026-11-01'),
      ('corp-test','user-test','b','success',true,'2026-11-02'),
      ('corp-test','user-test','c','success',true,'2026-11-03')`);
    const { rows } = await admin!.query(`SELECT snapshot_hash,is_current,valid_to::date::text AS valid_until
      FROM ding_user_snapshot ORDER BY id`);
    expect(rows).toEqual([
      { snapshot_hash: 'a', is_current: false, valid_until: '2026-11-02' },
      { snapshot_hash: 'b', is_current: false, valid_until: '2026-11-03' },
      { snapshot_hash: 'c', is_current: true, valid_until: null },
    ]);
    await admin!.query(sql(validationMigration));
  });

  it('repairs overlapping closed periods while preserving an earlier known end and separating enterprises', async () => {
    await migrateLegacy(`INSERT INTO ding_user_snapshot
      (corp_id,user_id,snapshot_hash,fetch_status,is_current,valid_from,valid_to) VALUES
      ('corp-test','user-test','a','success',true,'2026-11-01','2026-11-02'),
      ('corp-test','user-test','b','success',false,'2026-11-03','2026-11-09'),
      ('corp-test','user-test','c','success',true,'2026-11-05',NULL),
      ('corp-other','user-test','other','success',true,'2026-11-02',NULL)`);
    const { rows } = await admin!.query(`SELECT snapshot_hash,valid_to::date::text AS valid_until FROM ding_user_snapshot ORDER BY snapshot_hash`);
    expect(rows).toEqual([
      { snapshot_hash: 'a', valid_until: '2026-11-02' }, { snapshot_hash: 'b', valid_until: '2026-11-05' },
      { snapshot_hash: 'c', valid_until: null }, { snapshot_hash: 'other', valid_until: null },
    ]);
    await admin!.query(sql(validationMigration));
  });

  it('orders versions with identical start times by id without producing negative periods', async () => {
    await migrateLegacy(`INSERT INTO ding_user_snapshot
      (corp_id,user_id,snapshot_hash,fetch_status,is_current,valid_from) VALUES
      ('corp-test','user-test','a','success',true,'2026-11-01'),
      ('corp-test','user-test','b','success',true,'2026-11-01')`);
    const { rows } = await admin!.query(`SELECT snapshot_hash,is_current,valid_to = valid_from AS zero_length
      FROM ding_user_snapshot ORDER BY id`);
    expect(rows).toEqual([
      { snapshot_hash: 'a', is_current: false, zero_length: true },
      { snapshot_hash: 'b', is_current: true, zero_length: null },
    ]);
    await admin!.query(sql(validationMigration));
  });

  it('enforces NOT VALID checks immediately, then validates without blocking an open reader', async () => {
    await migrateLegacy();
    const timeouts = async () => (await admin!.query(`SELECT current_setting('lock_timeout') AS lock_timeout,
      current_setting('statement_timeout') AS statement_timeout`)).rows[0];
    const originalTimeouts = await timeouts();
    const validated = async () => (await admin!.query(`SELECT convalidated FROM pg_constraint
      WHERE conrelid = '"${schema}".ding_user_snapshot'::regclass AND conname = 'user_snapshot_current_success'`)).rows[0].convalidated;
    expect(await validated()).toBe(false);
    await expect(admin!.query(`INSERT INTO ding_user_snapshot(corp_id,user_id,snapshot_hash,fetch_status)
      VALUES ('corp-test','invalid','failure','failed')`)).rejects.toMatchObject({ code: '23514' });
    const reader = await state.pool!.connect();
    try {
      await reader.query('BEGIN');
      await reader.query('SELECT count(*) FROM ding_user_snapshot');
      // 若仍使用 ADD CHECK 的排他锁，这里会被 reader 的 ACCESS SHARE 阻塞并超时。
      await admin!.query(sql(validationMigration));
      expect(await validated()).toBe(true);
      expect(await timeouts()).toEqual(originalTimeouts);
      await admin!.query(sql(validationMigration));
      expect(await validated()).toBe(true);
    } finally {
      await reader.query('ROLLBACK'); reader.release();
    }
  }, 15_000);
  it('keeps the last successful profile through repeated API failures', async () => {
    await upsertSnapshot(profile);
    await recordFetchFailure(failure); await recordFetchFailure(failure);
    expect((await getCurrentSnapshot(profile.corp_id, profile.user_id))?.name).toBe(profile.name);
    expect((await admin!.query('SELECT failure_count FROM ding_user_fetch_failure')).rows[0].failure_count).toBe('2');
  });
  it('serializes concurrent identical successful writes into one current content version', async () => {
    await Promise.all(Array.from({ length: 4 }, () => upsertSnapshot(profile)));
    expect((await admin!.query('SELECT count(*)::int AS n FROM ding_user_snapshot')).rows[0].n).toBe(1);
  });
  it('serializes changed profiles and failures while keeping exactly one successful current version', async () => {
    await upsertSnapshot(profile);
    await Promise.all([
      upsertSnapshot({ ...profile, name: '新姓名1', snapshot_hash: 'hash-1' }),
      upsertSnapshot({ ...profile, name: '新姓名2', snapshot_hash: 'hash-2' }), recordFetchFailure(failure),
    ]);
    const { rows } = await admin!.query("SELECT * FROM ding_user_snapshot WHERE is_current");
    expect(rows).toHaveLength(1); expect(rows[0].fetch_status).toBe('success');
  });
  it('rolls back closing the old version if inserting a replacement fails', async () => {
    await upsertSnapshot(profile);
    await expect(upsertSnapshot({ ...profile, name: 'x'.repeat(257), snapshot_hash: 'invalid' })).rejects.toMatchObject({ code: '22001' });
    expect((await getCurrentSnapshot(profile.corp_id, profile.user_id))?.snapshot_hash).toBe(profile.snapshot_hash);
  });
  it('enforces uniqueness and successful-only current versions for writers bypassing the helper', async () => {
    await upsertSnapshot(profile);
    await expect(admin!.query(`INSERT INTO ding_user_snapshot(corp_id,user_id,snapshot_hash) VALUES ('corp-test','user-test','bypass')`))
      .rejects.toMatchObject({ code: '23505' });
    await expect(admin!.query(`INSERT INTO ding_user_snapshot(corp_id,user_id,snapshot_hash,fetch_status)
      VALUES ('corp-test','another-user','failed','failed')`)).rejects.toMatchObject({ code: '23514' });
  });
  it('keeps successful content versions unchanged when only unionId is enriched', async () => {
    await upsertSnapshot(profile);
    await upsertSnapshot({ ...profile, union_id: 'known-union' });
    expect((await admin!.query('SELECT count(*)::int AS n FROM ding_user_snapshot')).rows[0].n).toBe(1);
    expect((await getCurrentSnapshot(profile.corp_id, profile.user_id))?.union_id).toBe('known-union');
  });

  describe('legacy failure cleanup', () => {
    const successfulRows = `INSERT INTO ding_user_snapshot
      (corp_id,user_id,name,snapshot_hash,fetch_status,is_current,valid_from,valid_to) VALUES
      ('corp-test','user-test','历史姓名','success-old','success',false,'2026-11-01','2026-11-02'),
      ('corp-test','user-test','当前姓名','success-current','success',true,'2026-11-02',NULL);`;
    beforeEach(async () => {
      await migrateLegacy(`${successfulRows}
        INSERT INTO ding_user_snapshot
          (corp_id,user_id,name,union_id,snapshot_hash,fetch_status,fetch_error,is_current,valid_from,raw_payload) VALUES
          ('corp-test','user-test','unknown','legacy-union','legacy-failed','failed','synthetic error',true,'2026-11-03','{"code":60121}'),
          ('corp-other','user-test','unknown',NULL,'legacy-null',NULL,NULL,true,'2026-11-04',NULL),
          ('corp-test','never-succeeded','unknown',NULL,'legacy-blank','','',true,'2026-11-05',NULL),
          ('corp-test','missing-user','unknown',NULL,'legacy-not-found','not_found','synthetic not found',true,'2026-11-06',NULL);`);
      await admin!.query(sql(validationMigration));
    });

    async function runCleanup(afterCleanupSql?: string) {
      await admin!.query('BEGIN');
      try {
        await admin!.query(sql(cleanupMigration));
        if (afterCleanupSql) await admin!.query(afterCleanupSql);
        await admin!.query('COMMIT');
      }
      catch (error) { await admin!.query('ROLLBACK'); throw error; }
    }
    async function expectRejectedCleanup(error: string | { code: string }, afterCleanupSql?: string) {
      const before = (await admin!.query(`SELECT to_jsonb(s) AS payload FROM ding_user_snapshot s ORDER BY id`)).rows;
      const errorsBefore = (await admin!.query(`SELECT to_jsonb(f) AS payload FROM ding_user_fetch_failure f ORDER BY id`)).rows;
      await expect(runCleanup(afterCleanupSql)).rejects.toMatchObject(typeof error === 'string' ? { message: error } : error);
      expect((await admin!.query(`SELECT to_jsonb(s) AS payload FROM ding_user_snapshot s ORDER BY id`)).rows).toEqual(before);
      expect((await admin!.query(`SELECT to_jsonb(f) AS payload FROM ding_user_fetch_failure f ORDER BY id`)).rows).toEqual(errorsBefore);
      expect((await admin!.query(`SELECT 1 FROM information_schema.columns
        WHERE table_schema=$1 AND table_name='ding_user_fetch_failure' AND column_name='source_snapshot_payload'`, [schema])).rows).toEqual([]);
    }

    it('moves complete failed rows into the error archive and preserves every successful version and error counter', async () => {
      await admin!.query(`UPDATE ding_user_fetch_failure SET failure_count=7, last_failed_at=last_failed_at + interval '1 second'
        WHERE fetch_error='synthetic error'`);
      const failed = (await admin!.query(`SELECT id,to_jsonb(s) AS payload FROM ding_user_snapshot s
        WHERE fetch_status IS DISTINCT FROM 'success' ORDER BY id`)).rows;
      const successful = (await admin!.query(`SELECT to_jsonb(s) AS payload FROM ding_user_snapshot s
        WHERE fetch_status='success' ORDER BY id`)).rows;
      const counters = (await admin!.query(`SELECT id,failure_count,first_failed_at,last_failed_at FROM ding_user_fetch_failure ORDER BY id`)).rows;
      await runCleanup();
      expect((await admin!.query(`SELECT to_jsonb(s) AS payload FROM ding_user_snapshot s ORDER BY id`)).rows).toEqual(successful);
      const archived = (await admin!.query(`SELECT source_snapshot_id AS id,source_snapshot_payload AS payload
        FROM ding_user_fetch_failure ORDER BY source_snapshot_id`)).rows;
      expect(archived).toEqual(failed);
      expect((await admin!.query(`SELECT id,failure_count,first_failed_at,last_failed_at FROM ding_user_fetch_failure ORDER BY id`)).rows).toEqual(counters);
      expect((await getCurrentSnapshot('corp-test', 'user-test'))?.name).toBe('当前姓名');
      expect(await getCurrentSnapshot('corp-test', 'never-succeeded')).toBeNull();
    });

    it('refuses cleanup if even one legacy failure has no archived counterpart', async () => {
      await admin!.query(`DELETE FROM ding_user_fetch_failure WHERE fetch_error='synthetic error'`);
      await expectRejectedCleanup('USER_SNAPSHOT_CLEANUP_ARCHIVE_MISMATCH');
    });

    it('rolls back deleted rows, archive payloads and the new column when the transaction fails after cleanup', async () => {
      // 模拟迁移登记前的后续语句失败；若清理中途提交，原行及新增列将无法回滚。
      await expectRejectedCleanup({ code: '22012' }, 'SELECT 1 / 0');
    });

    it.each([
      "corp_id='different-corp'", "user_id='different-user'", "fetch_status='different_status'",
      "fetch_error='different error'", "first_failed_at=first_failed_at - interval '1 second'",
    ])('refuses mismatched archive data (%s) without deleting any row', async (change) => {
      await admin!.query(`UPDATE ding_user_fetch_failure SET ${change} WHERE fetch_error='synthetic error'`);
      await expectRejectedCleanup('USER_SNAPSHOT_CLEANUP_ARCHIVE_MISMATCH');
    });

    it.each(['NO ACTION', 'CASCADE', 'SET NULL'])('refuses inbound foreign keys including ON DELETE %s without modifying dependents', async action => {
      await admin!.query(`CREATE TABLE "${schema}".cleanup_reference
        (snapshot_id bigint REFERENCES "${schema}".ding_user_snapshot(id) ON DELETE ${action});
        INSERT INTO "${schema}".cleanup_reference SELECT id FROM ding_user_snapshot WHERE snapshot_hash='legacy-failed'`);
      try {
        const dependents = (await admin!.query(`SELECT * FROM "${schema}".cleanup_reference`)).rows;
        await expectRejectedCleanup('USER_SNAPSHOT_CLEANUP_REFERENCES_EXIST');
        expect((await admin!.query(`SELECT * FROM "${schema}".cleanup_reference`)).rows).toEqual(dependents);
      } finally { await admin!.query(`DROP TABLE "${schema}".cleanup_reference`); }
    });

    it.each(['ding_user_snapshot', 'ding_user_fetch_failure'])('refuses custom triggers on %s', async table => {
      await admin!.query(`CREATE FUNCTION "${schema}".cleanup_custom_writer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END $$;
        CREATE TRIGGER cleanup_custom_writer BEFORE UPDATE OR DELETE ON "${schema}".${table}
        FOR EACH ROW EXECUTE FUNCTION "${schema}".cleanup_custom_writer()`);
      try { await expectRejectedCleanup('USER_SNAPSHOT_CLEANUP_CUSTOM_WRITERS_EXIST'); }
      finally {
        await admin!.query(`DROP TRIGGER cleanup_custom_writer ON "${schema}".${table}; DROP FUNCTION "${schema}".cleanup_custom_writer()`);
      }
    });

    it('refuses delete rules that could silently skip or redirect cleanup', async () => {
      await admin!.query(`CREATE RULE cleanup_skip_delete AS ON DELETE TO "${schema}".ding_user_snapshot DO INSTEAD NOTHING`);
      try { await expectRejectedCleanup('USER_SNAPSHOT_CLEANUP_CUSTOM_WRITERS_EXIST'); }
      finally { await admin!.query(`DROP RULE cleanup_skip_delete ON "${schema}".ding_user_snapshot`); }
    });

    it('requires the previous validation stage before removing any historical row', async () => {
      await admin!.query(`ALTER TABLE ding_user_snapshot DROP CONSTRAINT user_snapshot_current_success;
        ALTER TABLE ding_user_snapshot ADD CONSTRAINT user_snapshot_current_success
        CHECK (NOT is_current OR (fetch_status IS NOT DISTINCT FROM 'success' AND valid_to IS NULL)) NOT VALID`);
      await expectRejectedCleanup('USER_SNAPSHOT_CLEANUP_REQUIRES_VALIDATED_CONSTRAINT');
    });

    it('allows an already clean success-only table without manufacturing failure records', async () => {
      await admin!.query(`TRUNCATE "${schema}".ding_user_snapshot, "${schema}".ding_user_fetch_failure`);
      await migrateLegacy(successfulRows);
      await admin!.query(sql(validationMigration));
      await runCleanup();
      expect((await admin!.query('SELECT count(*)::int AS n FROM ding_user_snapshot')).rows[0].n).toBe(2);
      expect((await admin!.query('SELECT count(*)::int AS n FROM ding_user_fetch_failure')).rows[0].n).toBe(0);
    });

    it('keeps normal profile and failure writes compatible after cleanup', async () => {
      await runCleanup();
      await upsertSnapshot(profile);
      await recordFetchFailure(failure);
      expect((await getCurrentSnapshot(profile.corp_id, profile.user_id))?.snapshot_hash).toBe(profile.snapshot_hash);
      const errors = (await admin!.query(`SELECT source_snapshot_id,source_snapshot_payload FROM ding_user_fetch_failure
        WHERE fetch_error=$1`, [failure.fetch_error])).rows;
      expect(errors).toEqual([{ source_snapshot_id: null, source_snapshot_payload: null }]);
      expect((await admin!.query(`SELECT 1 FROM ding_user_snapshot WHERE fetch_status IS DISTINCT FROM 'success'`)).rows).toEqual([]);
    });
  });
});
