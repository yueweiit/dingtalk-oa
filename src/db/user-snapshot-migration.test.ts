import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const Builder = require('node-pg-migrate/dist/migrationBuilder').default;
const migration = require('../../migrations/20261110000000_separate_user_fetch_failures.cjs');
const validation = require('../../migrations/20261110000001_validate_user_snapshot_current.cjs');
function build(direction: 'up' | 'down' = 'up', definition = migration) {
  const builder = new Builder({ query: () => { throw new Error('DATABASE_ACCESS_NOT_ALLOWED'); } }, undefined, false, console);
  definition[direction](builder);
  return { sql: builder.getSql() as string, transactional: builder.isUsingTransaction() as boolean };
}

describe('user snapshot migration and writer contract (no database)', () => {
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
