import { describe, expect, it, vi } from 'vitest';
import { refreshCompletedLogisticsApprovals } from './completed-approval-refresh.js';
import type { CompletedApprovalRefreshInstance } from '../db/queries/approval-instance.js';

const instance = (id: string) => ({
  corp_id: 'corp-1', process_instance_id: id, process_code: 'LOG', status: 'COMPLETED',
  result: 'agree', raw_payload: { status: 'COMPLETED', operationRecords: [] }, refresh_generation: '1',
} as unknown as CompletedApprovalRefreshInstance);

describe('completed logistics approval refresh', () => {
  it('persists comment-only changes through the existing refresher and continues after API failures', async () => {
    const rows = [instance('a'), instance('b'), instance('c')];
    const finish = vi.fn().mockResolvedValue(undefined);
    const wait = vi.fn().mockResolvedValue(undefined);
    const failure = new Error('DingTalk unavailable');
    const refresh = vi.fn()
      .mockResolvedValueOnce({ status: 'COMPLETED', operationRecords: [{ remark: 'payment', files: [{ fileId: 'new' }] }] })
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(rows[2].raw_payload);
    const claim = vi.fn().mockResolvedValue(rows);
    const result = await refreshCompletedLogisticsApprovals({ limit: 3, delayMs: 1000, minIntervalSeconds: 3600 }, {
      claim, refresh, finish, wait,
    });
    expect(claim).toHaveBeenCalledWith(3, 3600);
    expect(refresh.mock.calls.map(([params]) => params.processInstanceId)).toEqual(['a', 'b', 'c']);
    expect(finish.mock.calls).toEqual([[rows[0]], [rows[1], failure], [rows[2]]]);
    expect(wait.mock.calls).toEqual([[1000], [1000]]);
    expect(result).toEqual({ scanned: 3, refreshed: 2, failed: 1 });
  });

  it('keeps processing a claimed batch when failure reporting itself fails', async () => {
    const refresh = vi.fn().mockRejectedValueOnce(new Error('API failed')).mockResolvedValueOnce({ status: 'COMPLETED' });
    const finish = vi.fn().mockRejectedValueOnce(new Error('database temporarily unavailable')).mockResolvedValueOnce(undefined);
    const result = await refreshCompletedLogisticsApprovals({ limit: 2, delayMs: 1000, minIntervalSeconds: 3600 }, {
      claim: async () => [instance('a'), instance('b')], refresh, finish, wait: async () => undefined,
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ scanned: 2, refreshed: 1, failed: 1 });
  });
});
