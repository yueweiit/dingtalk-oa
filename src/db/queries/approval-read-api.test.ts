import type pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, withClient } = vi.hoisted(() => ({ query: vi.fn(), withClient: vi.fn() }));
vi.mock('../pool.js', () => ({ withClient }));
import { listReadApprovals, listReadAttachments, findReadAttachment } from './approval-read-api.js';

const until = '2026-10-29T02:00:00.999999Z';
beforeEach(() => {
  query.mockReset().mockResolvedValue({ rows: [] });
  withClient.mockReset().mockImplementation(run => run({ query } as unknown as pg.PoolClient));
});

describe('approval read SQL boundaries', () => {
  it('uses parameterized corporate/process filters and microsecond tuple pagination, including tombstones', async () => {
    const filters = { corpId: 'corp-1', processCode: 'PROC-1', approvalNo: "' OR TRUE --", updatedAfter: '2026-10-01T00:00:00+08:00' };
    const position = { updatedAt: '2026-10-29T00:00:00.123456Z', processInstanceId: 'instance-1' };
    await listReadApprovals({ filters, limit: 50, syncUntil: until, position });
    const [sql, values] = query.mock.calls.find(([sql]) => String(sql).startsWith('SELECT'))!;
    expect(sql).toContain('i.corp_id=$1');
    expect(sql).toContain('i.process_code=$2');
    expect(sql).not.toContain(filters.approvalNo);
    expect(sql).toContain('i.updated_at>=');
    expect(sql).toContain('i.updated_at<=');
    expect(sql).toContain('(i.updated_at, i.process_instance_id)>(');
    expect(sql).toContain('ORDER BY i.updated_at, i.process_instance_id');
    expect(sql).toContain('SS.US');
    expect(sql).toContain('i.raw_payload AS "rawPayload"');
    expect(sql).toContain('AS "templateName"');
    expect(sql).not.toContain('deleted_at IS NULL');
    expect(sql).not.toContain('t.enabled');
    expect(values).toEqual(['corp-1', 'PROC-1', filters.approvalNo, filters.updatedAfter, until,
      position.updatedAt, position.processInstanceId, 51]);
    expect(query.mock.calls[0][0]).toBe('BEGIN READ ONLY');
    expect(query.mock.calls.at(-1)![0]).toBe('COMMIT');
  });

  it('gets a database time bound once and returns retired attachments with an independent watermark', async () => {
    query.mockImplementation(async sql => ({ rows: String(sql).includes('clock_timestamp()') ? [{ syncUntil: until }] : [] }));
    const position = { updatedAt: '2026-10-29T00:00:00.123456Z', processInstanceId: 'a', fileId: 'file-2' };
    const result = await listReadAttachments({ filters: { corpId: 'corp-1' }, limit: 1, position });
    const [sql, values] = query.mock.calls.find(([sql]) => String(sql).includes('FROM costing_read.attachment_archive'))!;
    expect(sql).toContain('(a.updated_at, a.process_instance_id, a.file_id)>(');
    expect(sql).toContain('ORDER BY a.updated_at, a.process_instance_id, a.file_id');
    expect(sql).not.toContain('retired_at IS NULL');
    expect(sql).not.toContain('i.deleted_at IS NULL');
    expect(sql).not.toContain('a.object_key');
    expect(values).toContain(position.fileId);
    expect(result).toEqual({ items: [], syncUntil: until });
  });

  it('requires a nonempty corporation even at the repository boundary', async () => {
    await expect(listReadApprovals({ filters: { corpId: '' }, limit: 1 })).rejects.toThrow();
    await expect(findReadAttachment({ corpId: ' ' }, 'file-1')).rejects.toThrow();
    expect(withClient).not.toHaveBeenCalled();
  });

  it('restricts downloads by the requested corp, instance and file before storage access', async () => {
    await findReadAttachment({ corpId: 'corp-2', processInstanceId: 'a' }, 'file-1');
    const [sql, values] = query.mock.calls.find(([sql]) => String(sql).startsWith('SELECT'))!;
    expect(sql).toContain('i.corp_id=$1');
    expect(sql).not.toContain('i.process_code=ANY');
    expect(sql).toContain('i.process_instance_id=$2');
    expect(sql).toContain('a.file_id=$3');
    expect(sql).toContain('i.corp_id=a.corp_id');
    expect(values).toEqual(['corp-2', 'a', 'file-1']);
  });

  it('rolls back the read-only transaction on query failure', async () => {
    query.mockImplementation(async sql => {
      if (String(sql).startsWith('SELECT')) throw new Error('database offline');
      return { rows: [] };
    });
    await expect(listReadApprovals({ filters: { corpId: 'corp-1' }, limit: 1, syncUntil: until })).rejects.toThrow();
    expect(query.mock.calls.at(-1)![0]).toBe('ROLLBACK');
  });
});
