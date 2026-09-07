import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('packing workbook cache migration', () => {
  it('creates only constrained refresh functions and read views for costing clients', () => {
    const migrationPath = fileURLToPath(new URL(
      '../../../migrations/20260907000000_create_packing_sheet_cache.cjs',
      import.meta.url,
    ));
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql).toContain('costing_read.allowed_packing_workbook');
    expect(sql).toContain('costing_read.packing_sheet_snapshot');
    expect(sql).toContain('costing_read.packing_refresh_request');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('REVOKE ALL ON FUNCTION');
    expect(sql).toContain('packing_sheet_snapshots_v1');
    expect(sql).toContain('request_packing_workbook_index_refresh');
    expect(sql).toContain('request_packing_sheet_refresh');
    expect(sql).toContain("request_key !~ '^[0-9a-f]{64}$'");
    expect(sql).not.toContain('GRANT INSERT ON costing_read.packing_refresh_request');
  });
});
