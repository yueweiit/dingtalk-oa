import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApprovalStatusReconciler, type ApprovalStatusReconcileDependencies } from './approval-status-reconcile.js';
import { InvalidApprovalInstanceIdError } from '../dingtalk/api-client.js';
import { tokenManager } from '../dingtalk/token-manager.js';
import { refreshApprovalInstance } from '../normalize/orchestrator.js';
import type { DingApprovalInstance } from '../db/types.js';

const { upsertInstance, recordApiUsage } = vi.hoisted(() => ({ upsertInstance: vi.fn(), recordApiUsage: vi.fn() }));
vi.mock('../config/index.js', () => ({ getConfig: () => ({ DINGTALK_APP_KEY: 'test-key', DINGTALK_APP_SECRET: 'test-secret' }) }));
vi.mock('../db/queries/attachment-archive.js', () => ({ recordApiUsage }));
vi.mock('../db/queries/approval-instance.js', () => ({ upsertInstance, findRunningApprovalInstances: vi.fn() }));
vi.mock('../db/queries/approval-enrichment.js', () => ({ tryRepairApprovalMetadata: vi.fn() }));
vi.mock('../db/pool.js', () => ({ withTransaction: async (run: (client: object) => Promise<unknown>) => run({}) }));

const options = { limit: 3, delayMs: 500, invalidIdCooldownMinutes: 1440 };

afterEach(() => {
  tokenManager.clearToken();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  upsertInstance.mockReset();
  recordApiUsage.mockReset();
});

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

  it.each(['token refresh', 'instance response body'])('continues reconciliation after a timeout in %s', async (failure) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const deadlines = vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
      const timer = new AbortController();
      setTimeout(() => timer.abort(new DOMException('request timed out', 'TimeoutError')), milliseconds);
      return timer.signal;
    });
    recordApiUsage.mockResolvedValue(undefined);

    let now = Date.parse('2026-11-11T00:00:00Z');
    let round = 1;
    let tokenStalled = false;
    const abortedRequests: string[] = [];
    const stall = (request: string, signal?: AbortSignal | null) => new Promise<never>((_, reject) => {
      signal?.addEventListener('abort', () => {
        abortedRequests.push(request);
        reject(new DOMException('aborted while receiving data', 'AbortError'));
      }, { once: true });
    });
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (url.pathname === '/gettoken') {
        if (round === 2 && failure === 'token refresh' && !tokenStalled) {
          tokenStalled = true;
          return stall('token', init?.signal);
        }
        return Response.json({ access_token: 'token', expires_in: 7200 });
      }

      const id = url.searchParams.get('processInstanceId');
      if (round === 1 && id === 'cooling-instance') {
        return Response.json({ code: 'processInstanceIdError' }, { status: 400 });
      }
      if (round === 2 && id === 'slow-instance' && failure === 'instance response body') {
        return { ok: true, text: () => stall('detail', init?.signal) };
      }
      return Response.json({ result: { status: id === 'cooling-instance' ? 'TERMINATED' : 'RUNNING', result: null } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const row = (id: string) => ({
      corp_id: 'corp-1', process_instance_id: id, process_code: 'PROC-1', status: 'RUNNING', result: null,
    }) as DingApprovalInstance;
    const cooled = row('cooling-instance');
    const other = [row('slow-instance'), row('healthy-instance')];
    const findRunningInstances = vi.fn<ApprovalStatusReconcileDependencies['findRunningInstances']>()
      .mockImplementation(async (limit, coolingDown) => (round === 1 ? [cooled] : [...other, cooled])
        .filter(instance => !coolingDown.some(ref => ref.processInstanceId === instance.process_instance_id)).slice(0, limit));
    const reconcile = createApprovalStatusReconciler({ findRunningInstances, refreshInstance: refreshApprovalInstance,
      wait: async () => {}, now: () => now });
    const runRound = async () => {
      const result = reconcile({ ...options, delayMs: 0 });
      await vi.runAllTimersAsync();
      return result;
    };

    expect(await runRound()).toMatchObject({ scanned: 1, failed: 1 });
    tokenManager.clearToken();
    round = 2;
    now += 24 * 60 * 60_000 - 1;
    expect(await runRound()).toEqual({ scanned: 2, changed: 0, unchanged: 1, failed: 1 });
    expect(abortedRequests).toEqual(failure === 'token refresh' ? ['token'] : ['detail', 'detail']);
    expect(upsertInstance.mock.calls.map(([row]) => row.process_instance_id)).toEqual(['healthy-instance']);
    expect(findRunningInstances).toHaveBeenLastCalledWith(3, [{ corpId: 'corp-1', processInstanceId: 'cooling-instance' }]);

    round = 3;
    now += 1;
    expect(await runRound()).toEqual({ scanned: 3, changed: 1, unchanged: 2, failed: 0 });
    expect(findRunningInstances).toHaveBeenLastCalledWith(3, []);
    expect(upsertInstance.mock.calls.map(([row]) => row.process_instance_id))
      .toEqual(['healthy-instance', 'slow-instance', 'healthy-instance', 'cooling-instance']);
    expect(upsertInstance).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'TERMINATED' }), expect.anything());
    expect(deadlines).toHaveBeenCalledWith(10_000);
  });
});
