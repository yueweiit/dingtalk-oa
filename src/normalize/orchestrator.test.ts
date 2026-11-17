import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ order: [] as string[], client: {}, instance: vi.fn(), task: vi.fn(), repair: vi.fn(), sync: vi.fn(), departure: vi.fn() }));
const { getInstance } = vi.hoisted(() => ({ getInstance: vi.fn() }));
vi.mock('../dingtalk/api-client.js', async importOriginal => ({
  ...await importOriginal<typeof import('../dingtalk/api-client.js')>(), getInstance,
}));
vi.mock('../db/pool.js', () => ({ withTransaction: async (run: (client: object) => Promise<unknown>) => {
  state.order.push('begin'); await run(state.client); state.order.push('commit');
} }));
vi.mock('../db/queries/approval-instance.js', () => ({ upsertInstance: state.instance }));
vi.mock('../db/queries/approval-task.js', () => ({ upsertTask: state.task }));
vi.mock('../db/queries/approval-enrichment.js', () => ({ tryRepairApprovalMetadata: state.repair }));
vi.mock('../db/queries/user-departure.js', () => ({ syncApprovalDeparture: state.departure }));
vi.mock('./approval-user-sync.js', () => ({ syncApprovalUsers: state.sync }));
vi.mock('../jobs/budget-alert-monitor.js', () => ({ monitorBudgetAlertForInstance: vi.fn() }));
vi.mock('../jobs/approval-empty-node-monitor.js', () => ({ monitorEmptyApprovalNodesForInstance: vi.fn() }));
import { persistApprovalInstance, refreshApprovalInstance } from './orchestrator.js';
import { InvalidApprovalInstanceIdError } from '../dingtalk/api-client.js';
import { subscribeAttachmentQueue } from '../archive/queue-signal.js';

describe('shared approval persistence and enrichment', () => {
  beforeEach(() => {
    vi.clearAllMocks(); state.order.length = 0;
    state.instance.mockResolvedValue({}); state.task.mockResolvedValue({});
    state.repair.mockImplementation(async () => { state.order.push('local-enrichment'); });
    state.departure.mockImplementation(async () => { state.order.push('departure'); });
    state.sync.mockImplementation(async () => { state.order.push('network-enrichment'); });
  });
  it('repairs from local data within the caller transaction and fetches all participant profiles only after commit', async () => {
    await persistApprovalInstance({ corpId: 'corp-a', processInstanceId: 'instance-a' }, {
      status: 'RUNNING', originatorUserId: 'originator', tasks: [
        { taskId: 'a', status: 'RUNNING', userId: 'approver-a' },
        { taskId: 'b', status: 'RUNNING', userId: 'approver-b' },
      ],
    });
    expect(state.order).toEqual(['begin', 'local-enrichment', 'commit', 'network-enrichment']);
    expect(state.instance).toHaveBeenCalledWith(expect.objectContaining({ originator_user_id: 'originator' }), state.client, true);
    expect(state.repair).toHaveBeenCalledWith(state.client, 'corp-a', ['instance-a']);
    expect(state.sync).toHaveBeenCalledWith('corp-a', 'instance-a', ['originator', 'approver-a', 'approver-b']);
    expect(state.departure).not.toHaveBeenCalled();
  });

  it('reconciles a departure from the canonical archived row before participant refresh', async () => {
    const code = 'PROC-A917A16C-ADED-42A0-830A-DF20A5880948';
    const archived = { process_code: code, process_instance_id: 'departure-a', originator_user_id: 'originator' };
    state.instance.mockResolvedValueOnce(archived);
    await persistApprovalInstance({ corpId: 'corp-a', processInstanceId: 'departure-a', processCode: code }, {
      status: 'COMPLETED', result: 'agree', originatorUserId: 'originator',
    });
    expect(state.departure).toHaveBeenCalledWith(state.client, archived);
    expect(state.order).toEqual(['begin', 'departure', 'local-enrichment', 'commit', 'network-enrichment']);
  });

  it('preserves the typed fetch error for status reconciliation without writing approval data', async () => {
    const error = new InvalidApprovalInstanceIdError('processInstanceIdError');
    getInstance.mockRejectedValueOnce(error);
    await expect(refreshApprovalInstance({ corpId: 'corp-a', processInstanceId: 'instance-a' }))
      .rejects.toMatchObject({ message: 'getInstance 失败: processInstanceIdError', cause: error });
    expect(state.order).toEqual([]);
    expect(state.instance).not.toHaveBeenCalled();
    expect(state.task).not.toHaveBeenCalled();
  });

  it('wakes the archive worker only after a committed live refresh', async () => {
    const wake = vi.fn(() => { state.order.push('archive-wake'); });
    const unsubscribe = subscribeAttachmentQueue(wake);
    try {
      await persistApprovalInstance({ corpId: 'corp', processInstanceId: 'live' }, { status: 'RUNNING' });
      expect(state.order).toEqual(['begin', 'local-enrichment', 'commit', 'archive-wake']);
      state.instance.mockRejectedValueOnce(new Error('rollback'));
      await expect(persistApprovalInstance({ corpId: 'corp', processInstanceId: 'failed' }, { status: 'RUNNING' }))
        .rejects.toThrow('rollback');
      expect(wake).toHaveBeenCalledTimes(1);
    } finally { unsubscribe(); }
  });

  it('leaves historical imports at ordinary priority without immediate wake-ups', async () => {
    const wake = vi.fn();
    const unsubscribe = subscribeAttachmentQueue(wake);
    try {
      await persistApprovalInstance({ corpId: 'corp', processInstanceId: 'old', attachmentPriority: 'backfill' }, { status: 'COMPLETED' });
      expect(state.instance).toHaveBeenCalledWith(expect.anything(), state.client, false);
      expect(wake).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });
});
