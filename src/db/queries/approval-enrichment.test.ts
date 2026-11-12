import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { repairApprovalMetadata, tryRepairApprovalMetadata } from './approval-enrichment.js';

describe('approval metadata SQL safety contracts', () => {
  it('writes only for the active parents locked in this transaction', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ n: 1 }] })
      .mockResolvedValueOnce({ rows: [{ process_instance_id: 'instance-a' }] });
    await repairApprovalMetadata({ query } as unknown as pg.PoolClient, 'corp-a', ['instance-a', 'deleted']);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query).toHaveBeenNthCalledWith(1, expect.stringMatching(/deleted_at IS NULL\s+ORDER BY process_instance_id FOR NO KEY UPDATE/),
      ['corp-a', ['instance-a', 'deleted']]);
    expect(query.mock.calls[1][0]).toContain('AND t.deleted_at IS NULL');
    for (const [sql, params] of query.mock.calls.slice(1)) {
      expect(params).toEqual(['corp-a', ['instance-a'], expect.any(String)]);
      expect(sql).toContain('s.corp_id=$1 AND s.process_instance_id=ANY($2::varchar[])');
      expect(sql).toContain('p.valid_from<=b.occurred_at');
      expect(sql).toContain('b.occurred_at<p.valid_to');
      expect(sql).toContain('FROM ding_user_directory p');
      expect(sql).toContain('p.corp_id=d.corp_id AND p.user_id=d.user_id');
      expect(sql).toContain('d.raw_user_ids_agree AND (d.raw_user_id IS NULL OR d.raw_user_id=d.user_id)');
      expect(sql).toContain('lock_departure_directory_name(d.corp_id, d.user_id, p.source_process_instance_id, p.name)');
      expect(sql).toContain('CASE WHEN u.source_ready THEN u.source_process_instance_id');
      expect(sql).toMatch(/(?:originator|approver)_user_name_source_instance_id=c\./);
      expect(sql).not.toContain('dept_id_list');
      expect(sql).toContain('IS NOT DISTINCT FROM ROW(c.stored_');
      expect(sql).not.toMatch(/SET[^;]+raw_payload\s*=/s);
    }
  });
  it('skips both writes when every parent was deleted before the lock was granted', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    expect(await repairApprovalMetadata({ query } as unknown as pg.PoolClient, 'corp-a', ['deleted'])).toEqual({ instances: 0, tasks: 0 });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('preview generates SELECT counts rather than writes', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ n: 2 }] });
    expect(await repairApprovalMetadata({ query } as unknown as pg.PoolClient, 'corp-a', ['a'], true)).toEqual({ instances: 2, tasks: 2 });
    expect(query).toHaveBeenCalledTimes(2);
    for (const [sql] of query.mock.calls) {
      expect(sql).not.toMatch(/\bUPDATE\b|\bDELETE\b|\bINSERT\b/);
      expect(sql).not.toContain('lock_departure_directory_name');
    }
  });
  it('uses the same whitespace characters as JavaScript trim', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ n: 0 }] });
    await repairApprovalMetadata({ query } as unknown as pg.PoolClient, 'corp-a', ['a'], true);
    const whitespace = Array.from({ length: 0x10000 }, (_, code) => String.fromCharCode(code))
      .filter(character => character.trim() === '').join('');
    for (const [, params] of query.mock.calls) expect(params[2]).toBe(whitespace);
  });
  it('rolls enrichment errors back to a savepoint so the caller can preserve the approval archive', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }) // SAVEPOINT
      .mockResolvedValueOnce({ rows: [{ process_instance_id: 'a' }] })
      .mockResolvedValueOnce({ rows: [{ n: 1 }] }) // 实例已更新，任务补全失败
      .mockRejectedValueOnce(new Error('synthetic unavailable table'));
    await tryRepairApprovalMetadata({ query } as unknown as pg.PoolClient, 'corp-a', ['a']);
    expect(query.mock.calls.map(call => call[0])).toContain('ROLLBACK TO SAVEPOINT approval_metadata');
    expect(query.mock.calls.at(-1)?.[0]).toBe('RELEASE SAVEPOINT approval_metadata');
  });
});
