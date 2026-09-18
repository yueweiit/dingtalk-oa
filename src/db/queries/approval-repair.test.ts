import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('approval repair queue migration', () => {
  it('exposes an idempotent submit function and a read-only status view', () => {
    const migrationPath = fileURLToPath(new URL(
      '../../../migrations/1788856369000_create_approval_repair_queue.cjs',
      import.meta.url,
    ));
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql).toContain('costing_read.approval_repair_request');
    expect(sql).toContain('costing_read.approval_repair_status_v1');
    expect(sql).toContain('costing_read.request_approval_repair');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(sql).toContain('existing repair request expectation mismatch');
    expect(sql).toContain('costing_read.allowed_process_template');
    expect(sql).toContain("status IN ('pending', 'running', 'retry', 'success', 'manual_required')");
    expect(sql).toContain("expected_purpose IN ('international_logistics', 'purchase_expense')");
    expect(sql).toContain("request_key !~ '^[0-9a-f]{64}$'");
    expect(sql).toContain('GRANT SELECT ON costing_read.approval_repair_status_v1 TO costing_reader');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION costing_read.request_approval_repair');
    expect(sql).not.toContain('GRANT INSERT ON costing_read.approval_repair_request');
    expect(sql).not.toContain('GRANT UPDATE ON costing_read.approval_repair_request');
    expect(sql).not.toContain('GRANT INSERT ON public.ding_approval_instance');
  });
});
