import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const Builder = require('node-pg-migrate/dist/migrationBuilder').default;
const migration = require('../../migrations/20261110000000_separate_user_fetch_failures.cjs');
const validation = require('../../migrations/20261110000001_validate_user_snapshot_current.cjs');
const cleanup = require('../../migrations/20261110000002_purge_legacy_failed_user_snapshots.cjs');
const departure = require('../../migrations/20261111000000_create_ding_user_departure.cjs');
function build(direction: 'up' | 'down' = 'up', definition = migration) {
  const builder = new Builder({ query: () => { throw new Error('DATABASE_ACCESS_NOT_ALLOWED'); } }, undefined, false, console);
  definition[direction](builder);
  return { sql: builder.getSql() as string, transactional: builder.isUsingTransaction() as boolean };
}

describe('user snapshot migration and writer contract (no database)', () => {
  it('adds a transactional departure table keyed by enterprise and source approval with a bounded lock wait', () => {
    const { sql, transactional } = build('up', departure);
    expect(transactional).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s'");
    expect(sql).toContain('PRIMARY KEY (corp_id, source_process_instance_id)');
    expect(sql).toContain('REFERENCES public.ding_approval_instance (corp_id, process_instance_id) ON DELETE RESTRICT');
    expect(sql).toContain("CHECK (candidate_user_id IS NULL OR (region = 'MX' AND user_id IS NULL");
    expect(sql).toContain("CHECK (NOT identity_review_required OR identity_method IS NOT DISTINCT FROM 'manual')");
    expect(sql).toContain('WHERE user_id IS NOT NULL AND departed_on IS NOT NULL AND NOT identity_review_required');
    expect(() => build('down', departure)).toThrow('DEPARTURE_ROLLBACK_REQUIRES_PRESERVING_MANUALLY_CONFIRMED_RECORDS');
  });
  it('builds transactional DDL for separate failure history and a unique current profile', () => {
    const { sql, transactional } = build();
    expect(transactional).toBe(true);
    expect(sql).toContain('"public"."ding_user_fetch_failure"');
    expect(sql).toContain('CREATE UNIQUE INDEX user_snapshot_one_current_per_user');
    expect(sql).toContain('ON public.ding_user_snapshot(corp_id, user_id) WHERE is_current = true');
    expect(sql).toContain("fetch_status IS NOT DISTINCT FROM 'success' AND valid_to IS NULL");
  });
  it('archives failures and restores deterministic last successful versions before enforcing uniqueness', () => {
    const { sql } = build();
    expect(sql.indexOf('INSERT INTO public.ding_user_fetch_failure')).toBeLessThan(sql.indexOf('SET is_current = false'));
    expect(sql.indexOf('SET is_current = true, valid_to = NULL')).toBeLessThan(sql.indexOf('CREATE UNIQUE INDEX'));
    expect(sql).toContain('ORDER BY corp_id, user_id, valid_from DESC, id DESC');
    expect(sql).toContain('LOCK TABLE public.ding_user_snapshot IN SHARE ROW EXCLUSIVE MODE');
  });
  it('keeps historical rows and source IDs instead of deleting them', () => {
    const { sql } = build();
    expect(sql).toContain('source_snapshot_id');
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b|\bDROP\s+TABLE\b|\bTRUNCATE\b/i);
  });

  it('closes older successful versions at the next success instead of the migration timestamp', () => {
    const { sql } = build();
    expect(sql).toContain('LEAD(valid_from) OVER (PARTITION BY corp_id, user_id ORDER BY valid_from, id)');
    expect(sql).toContain('valid_to = LEAST(COALESCE(s.valid_to, t.next_success_from), t.next_success_from)');
    expect(sql).toContain('t.next_success_from IS NOT NULL');
    expect(sql).toContain('s.valid_to > t.next_success_from');
  });

  it('bounds lock waits and defers the history scan until a separately committed validation stage', () => {
    const first = build();
    expect(first.sql.indexOf("SET LOCAL lock_timeout = '5s'")).toBeLessThan(first.sql.indexOf('LOCK TABLE'));
    expect(first.sql).toContain("SET LOCAL statement_timeout = '5min'");
    expect(first.sql).toMatch(/ADD CONSTRAINT user_snapshot_current_success[\s\S]+?NOT VALID;/);
    expect(first.sql).not.toContain('VALIDATE CONSTRAINT');
    const second = build('up', validation);
    expect(second.transactional).toBe(false);
    expect(second.sql.trim()).toMatch(/^BEGIN;/);
    expect(second.sql.trim()).toMatch(/COMMIT;$/);
    expect(second.sql).toContain("SET LOCAL lock_timeout = '5s'");
    expect(second.sql).toContain('VALIDATE CONSTRAINT user_snapshot_current_success');
  });

  it.each([true, false])('uses the installed migration runner to release first-stage locks (singleTransaction=%s)', async (singleTransaction) => {
    const { Migration } = require('node-pg-migrate/dist/migration');
    const queries: string[] = [];
    const db = { query: async (query: string) => { queries.push(query); return { rows: [] }; } };
    const runner = new Migration(db, '20261110000001_validate_user_snapshot_current.cjs', validation,
      { singleTransaction, migrationsTable: 'migrations_test', schema: 'public', dryRun: false }, undefined,
      { info() {}, warn() {}, debug() {}, error() {} });
    await runner.apply('up');
    if (singleTransaction) {
      expect(queries[0]).toBe('COMMIT;');
      expect(queries[1]).toContain('BEGIN;');
      expect(queries[queries.length - 1]).toBe('BEGIN;');
    } else {
      expect(queries[0].trim()).toMatch(/^BEGIN;/);
    }
    const validate = queries.find(query => query.includes('VALIDATE CONSTRAINT'))!;
    expect(validate.trim()).toMatch(/COMMIT;$/);
  });
  it('refuses a destructive automatic rollback', () => {
    expect(build('down').sql).toContain('USER_SNAPSHOT_MANUAL_ROLLBACK_REQUIRED');
    expect(build('down', validation).sql).toContain('USER_SNAPSHOT_MANUAL_ROLLBACK_REQUIRED');
  });
  it('routes manual metadata synchronization through the common transaction writer', () => {
    const source = readFileSync(fileURLToPath(new URL('../../scripts/sync-metadata.ts', import.meta.url)), 'utf8');
    expect(source).toContain('await upsertSnapshot(');
    expect(source).toContain('await recordFetchFailure(');
    expect(source).not.toMatch(/(?:INSERT INTO|UPDATE) ding_user_snapshot/);
  });
});

describe('legacy failed user snapshot cleanup safety contract (no database)', () => {
  it('uses one transaction and bounded locks before checking or modifying data', () => {
    const { sql, transactional } = build('up', cleanup);
    expect(transactional).toBe(true);
    expect(sql.indexOf("SET LOCAL lock_timeout = '5s'")).toBeLessThan(sql.indexOf('LOCK TABLE'));
    expect(sql).toContain("SET LOCAL statement_timeout = '5min'");
    expect(sql).toContain('LOCK TABLE public.ding_user_snapshot, public.ding_user_fetch_failure IN SHARE ROW EXCLUSIVE MODE');
    expect(sql).not.toMatch(/\bCOMMIT\b|\bCASCADE\s*;/i);
  });

  it('refuses missing validation, foreign keys, or custom write side effects before archiving', () => {
    const { sql } = build('up', cleanup);
    for (const code of ['REQUIRES_VALIDATED_CONSTRAINT', 'REFERENCES_EXIST', 'CUSTOM_WRITERS_EXIST', 'ARCHIVE_MISMATCH']) {
      expect(sql.indexOf(`USER_SNAPSHOT_CLEANUP_${code}`)).toBeGreaterThan(-1);
      expect(sql.indexOf(`USER_SNAPSHOT_CLEANUP_${code}`)).toBeLessThan(sql.indexOf('ADD "source_snapshot_payload"'));
    }
    expect(sql).toContain("confrelid = 'public.ding_user_snapshot'::regclass AND contype = 'f'");
    expect(sql).toContain('AND NOT tgisinternal');
    expect(sql).toContain("AND rulename <> '_RETURN'");
  });

  it('requires a matching archive by identity, normalized error and failure time, not only counts', () => {
    const { sql } = build('up', cleanup);
    for (const field of ['corp_id', 'user_id']) expect(sql).toContain(`f.${field} IS DISTINCT FROM s.${field}`);
    expect(sql).toContain("f.fetch_status IS DISTINCT FROM COALESCE(NULLIF(s.fetch_status, ''), 'failed')");
    expect(sql).toContain("f.fetch_error IS DISTINCT FROM COALESCE(s.fetch_error, 'USER_FETCH_FAILED')");
    expect(sql).toContain('f.first_failed_at IS DISTINCT FROM s.valid_from');
    expect(sql).toContain('f.id IS NULL');
  });

  it('archives each full row before deleting only matching noncurrent failures and preserves counters', () => {
    const { sql } = build('up', cleanup);
    expect(sql.indexOf('SET source_snapshot_payload = to_jsonb(s)')).toBeLessThan(sql.indexOf('DELETE FROM'));
    const deletion = sql.slice(sql.indexOf('DELETE FROM'), sql.indexOf('DO $verify$'));
    expect(deletion).toContain("s.is_current = false AND s.fetch_status IS DISTINCT FROM 'success'");
    expect(deletion).toContain('f.source_snapshot_payload = to_jsonb(s)');
    expect(deletion).toContain('f.corp_id = s.corp_id AND f.user_id = s.user_id');
    expect(sql).toContain('USER_SNAPSHOT_CLEANUP_INCOMPLETE');
    expect(sql).not.toMatch(/\bDELETE FROM public\.ding_user_fetch_failure|\bTRUNCATE\b|\bDROP\s+TABLE\b/i);
    expect(sql).not.toMatch(/SET\s+(?:failure_count|last_failed_at|first_failed_at)\s*=/i);
  });

  it('refuses automatic rollback rather than guessing how to reinsert historical rows', () => {
    expect(build('down', cleanup).sql).toContain('USER_SNAPSHOT_CLEANUP_MANUAL_ROLLBACK_REQUIRED');
  });

  it('previews only the explicitly named cleanup despite a mixed and out-of-order legacy migration history', async () => {
    const { runner } = require('node-pg-migrate');
    const queries: string[] = [];
    const dbClient = { async query(sql: string) {
      queries.push(sql);
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ lockObtained: true }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ lockReleased: true }] };
      if (sql.includes('information_schema.tables')) return { rows: [{ table_name: 'pgmigrations' }] };
      if (sql.includes('information_schema.table_constraints')) return { rows: [{ constraint_name: 'pgmigrations_pkey' }] };
      if (sql.startsWith('SELECT name FROM')) return { rows: [{ name: '20260703000000_create_ding_process_template' }] };
      return { rows: [] };
    } };
    const name = '20261110000002_purge_legacy_failed_user_snapshots';
    const result = await runner({ dbClient, dir: fileURLToPath(new URL('../../migrations', import.meta.url)),
      file: name, direction: 'up', schema: 'public', migrationsTable: 'pgmigrations',
      checkOrder: false, singleTransaction: true, dryRun: true,
      logger: { info() {}, debug() {}, warn() {}, error() {} },
    });
    expect(result.map((item: { name: string }) => item.name)).toEqual([name]);
    expect(queries.some(sql => /\b(?:CREATE|ALTER|DELETE|UPDATE|INSERT)\b/i.test(sql))).toBe(false);
  });
});
