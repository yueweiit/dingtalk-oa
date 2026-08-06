import { describe, expect, it, vi } from 'vitest';
import { reconcileRunningApprovalStatuses } from './approval-status-reconcile.js';

describe('reconcileRunningApprovalStatuses', () => {
  it('refreshes each running instance and reports changed, unchanged, and failed results', async () => {
    const refreshInstance = vi.fn()
      .mockResolvedValueOnce({ status: 'TERMINATED', result: '' })
      .mockResolvedValueOnce({ status: 'RUNNING', result: 'agree' })
      .mockRejectedValueOnce(new Error('DingTalk unavailable'));
    const wait = vi.fn().mockResolvedValue(undefined);

    const result = await reconcileRunningApprovalStatuses({ limit: 3, delayMs: 500 }, {
      findRunningInstances: vi.fn().mockResolvedValue([
        {
          corp_id: 'corp-1',
          process_instance_id: 'instance-1',
          process_code: 'PROC-1',
          status: 'RUNNING',
          result: 'agree',
          originator_user_id: 'user-1',
        },
        {
          corp_id: 'corp-1',
          process_instance_id: 'instance-2',
          process_code: 'PROC-2',
          status: 'RUNNING',
          result: 'agree',
          originator_user_id: null,
        },
        {
          corp_id: 'corp-1',
          process_instance_id: 'instance-3',
          process_code: 'PROC-3',
          status: 'RUNNING',
          result: null,
          originator_user_id: null,
        },
      ] as any),
      refreshInstance,
      wait,
    });

    expect(result).toEqual({ scanned: 3, changed: 1, unchanged: 1, failed: 1 });
    expect(refreshInstance).toHaveBeenCalledTimes(3);
    expect(refreshInstance.mock.calls[0]).toEqual([{
      corpId: 'corp-1',
      processInstanceId: 'instance-1',
      processCode: 'PROC-1',
      originatorUserId: 'user-1',
    }]);
    expect(wait).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledWith(500);
  });
});
