import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationPath = fileURLToPath(
  new URL('../../migrations/1788508800000_create_costing_actor_names_view.cjs', import.meta.url)
);

describe('costing approval actor names view migration', () => {
  it('exposes only actors referenced by allowlisted approvals and archived comments', () => {
    const source = readFileSync(migrationPath, 'utf8');

    expect(source).toContain('costing_read.approval_actor_names_v1');
    expect(source).toContain('costing_read.allowed_process_template');
    expect(source).toContain('originator_user_id');
    expect(source).toContain("raw_payload->'operationRecords'");
    expect(source).toContain('comment_user_id');
    expect(source).toContain('public.ding_user_snapshot');
    expect(source).toContain("fetch_status = 'success'");
    expect(source).toContain('u.is_current DESC');
  });

  it('grants the reader only the restricted view and provides a reversible down migration', () => {
    const source = readFileSync(migrationPath, 'utf8');

    expect(source).toContain('GRANT SELECT ON costing_read.approval_actor_names_v1 TO costing_reader');
    expect(source).not.toContain('GRANT SELECT ON public.ding_user_snapshot');
    expect(source).toContain('DROP VIEW IF EXISTS costing_read.approval_actor_names_v1');
  });

  it('preserves the existing public column types during an in-place view upgrade', () => {
    const source = readFileSync(migrationPath, 'utf8');

    expect(source).toContain('refs.corp_id::text AS corp_id');
    expect(source).toContain('refs.user_id::text AS user_id');
    expect(source).toContain('u.name::text AS name');
    expect(source).toContain('u.title::text AS title');
  });
});
