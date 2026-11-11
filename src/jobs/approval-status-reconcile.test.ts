import { describe, expect, it, vi } from 'vitest';
import { createApprovalStatusReconciler, type ApprovalStatusReconcileDependencies } from './approval-status-reconcile.js';
import { InvalidApprovalInstanceIdError } from '../dingtalk/api-client.js';
import type { DingApprovalInstance } from '../db/types.js';

const options = { limit: 3, delayMs: 500, invalidIdCooldownMinutes: 1440 };

describe('reconcileRunningApprovalStatuses', () => {
  it('refreshes each running instance and reports changed, unchanged, and failed results', async () => {
    const refreshInstance = vi.fn()
      .mockResolvedValueOnce({ status: 'TERMINATED', result: '' })
      .mockResolvedValueOnce({ status: 'RUNNING', result: 'agree' })
      .mockRejectedValueOnce(new Error('DingTalk unavailable'));
    const wait = vi.fn().mockResolvedValue(undefined);

    const reconcile = createApprovalStatusReconciler({
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
      now: Date.now,
    });
    const result = await reconcile(options);

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

  it('excludes a rejected ID before the next limited scan and retries at expiry, scoped to its enterprise', async () => {
    let now = Date.parse('2026-11-11T00:00:00Z');
    const instance = (corp_id: string, process_instance_id: string) => ({
      corp_id, process_instance_id, process_code: 'PROC-1', status: 'RUNNING', result: null,
    }) as DingApprovalInstance;
    const rows = [instance('corp-1', 'same-id'), instance('corp-2', 'same-id'), instance('corp-1', 'network-error')];
    const findRunningInstances = vi.fn<ApprovalStatusReconcileDependencies['findRunningInstances']>()
      .mockImplementation(async (limit, coolingDown) => rows.filter(row => !coolingDown.some(ref =>
        ref.corpId === row.corp_id && ref.processInstanceId === row.process_instance_id)).slice(0, limit));
    const refreshInstance = vi.fn<ApprovalStatusReconcileDependencies['refreshInstance']>()
      .mockRejectedValueOnce(new Error('getInstance failed', { cause: new InvalidApprovalInstanceIdError('processInstanceIdError') }))
      .mockResolvedValueOnce({ status: 'RUNNING', result: null })
      .mockRejectedValueOnce(new Error('HTTP 429'))
      .mockResolvedValue({ status: 'RUNNING', result: null });
    const reconcile = createApprovalStatusReconciler({ findRunningInstances, refreshInstance, wait: async () => {}, now: () => now });
    const batch = { ...options, limit: 2, delayMs: 0 };

    expect((await reconcile(batch)).failed).toBe(1);
    now += 24 * 60 * 60_000 - 1;
    expect((await reconcile(batch)).failed).toBe(1);
    expect(findRunningInstances).toHaveBeenLastCalledWith(2, [{ corpId: 'corp-1', processInstanceId: 'same-id' }]);
    expect(refreshInstance.mock.calls.slice(2).map(([ref]) => [ref.corpId, ref.processInstanceId]))
      .toEqual([['corp-2', 'same-id'], ['corp-1', 'network-error']]);

    // A transient error on the second scan stays eligible even while the invalid ID is cooling down.
    expect((await reconcile(batch)).unchanged).toBe(2);
    expect(refreshInstance.mock.calls.at(-1)?.[0].processInstanceId).toBe('network-error');

    now += 1;
    expect((await reconcile(batch)).unchanged).toBe(2);
    expect(findRunningInstances).toHaveBeenLastCalledWith(2, []);
    expect(refreshInstance.mock.calls.at(-2)?.[0]).toMatchObject({ corpId: 'corp-1', processInstanceId: 'same-id' });
  });
});
