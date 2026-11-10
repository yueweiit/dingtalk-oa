import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findRunningApprovalTimeoutCandidates, monitorApprovalTimeouts, type ApprovalTimeoutCandidate } from './approval-timeout-monitor.js';
import { claimAlertDelivery } from '../db/queries/alert-notification.js';
import { configSchema } from '../config/schema.js';

const state = vi.hoisted(() => ({
  config: {
    DINGTALK_CORP_ID: 'corp-1',
    DINGTALK_ALERT_RECIPIENT_USER_IDS: 'old-fixed-receiver',
    APPROVAL_TIMEOUT_PROCESS_CODES: 'PROC-TEST',
    APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS: '',
    APPROVAL_TIMEOUT_MINUTES: 72 * 60,
  },
  query: vi.fn(),
  send: vi.fn(),
  sendGroup: vi.fn(),
}));
vi.mock('../config/index.js', () => ({ getConfig: () => state.config }));
vi.mock('../db/pool.js', () => ({ withClient: (run: (client: unknown) => unknown) => run({ query: state.query }) }));
vi.mock('../dingtalk/alert-robot.js', () => ({ sendAlertChatMessage: state.send, sendAlertGroupMessage: state.sendGroup }));

const startedAt = new Date('2026-11-01T04:00:00Z');
const atHour = (hour: number) => new Date(startedAt.getTime() + hour * 3_600_000);
const candidate = (overrides: Partial<ApprovalTimeoutCandidate> = {}): ApprovalTimeoutCandidate => ({
  corpId: 'corp-1', processInstanceId: 'instance-1', processCode: 'PROC-TEST',
  title: '测试采购审批', taskId: 'task-1', taskStartTime: startedAt,
  approverUserId: 'approver-1', approverUserName: '测试审批人', nodeName: '负责人审批',
  rawTask: {}, rawInstance: {}, ...overrides,
});
function dependencies(hour = 72, candidates = [candidate()]) {
  return {
    now: () => atHour(hour),
    findCandidates: vi.fn<(codes: string[], corpId: string) => Promise<ApprovalTimeoutCandidate[]>>().mockResolvedValue(candidates),
    claimDelivery: vi.fn<typeof claimAlertDelivery>().mockResolvedValue(true),
    markSent: vi.fn<(key: Parameters<typeof claimAlertDelivery>[0]) => Promise<void>>().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    send: vi.fn<(users: string[], content: string) => Promise<void>>().mockResolvedValue(undefined),
    sendGroup: vi.fn<(group: string, content: string, mentionUserIds: string[]) => Promise<void>>().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  state.config.DINGTALK_CORP_ID = 'corp-1';
  state.config.APPROVAL_TIMEOUT_PROCESS_CODES = 'PROC-TEST';
  state.config.APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS = '';
  state.query.mockReset();
  state.send.mockReset().mockResolvedValue(undefined);
  state.sendGroup.mockReset().mockResolvedValue(undefined);
});

describe('approval timeout reminders', () => {
  it('waits a full 72 hours and sends to the task approver instead of fixed recipients', async () => {
    const early = dependencies(72 - 1 / 3600);
    expect((await monitorApprovalTimeouts(early)).sent).toBe(0);
    expect(early.claimDelivery).not.toHaveBeenCalled();
    const deps = dependencies();
    expect(await monitorApprovalTimeouts(deps)).toEqual({ scanned: 1, eligible: 1, sent: 1, failed: 0 });
    expect(deps.findCandidates).toHaveBeenCalledWith(['PROC-TEST'], 'corp-1');
    expect(deps.send).toHaveBeenCalledWith(['approver-1'], expect.stringContaining('72小时0分钟'));
    const content = deps.send.mock.calls[0][1];
    expect(content).toContain('负责人审批');
    expect(content).toContain('测试审批人');
    expect(content).toContain('https://applink.dingtalk.com/approval/detail?corpId=corp-1&instanceId=instance-1');
  });

  it('keeps old overdue tasks eligible and uses the same delivery key after restart', async () => {
    const deps = dependencies();
    await monitorApprovalTimeouts(deps);
    const restarted = dependencies(24 * 50);
    restarted.claimDelivery.mockResolvedValue(false);
    expect((await monitorApprovalTimeouts(restarted)).eligible).toBe(1);
    expect(restarted.claimDelivery.mock.calls[0][0]).toEqual(deps.claimDelivery.mock.calls[0][0]);
    expect(restarted.send).not.toHaveBeenCalled();
    restarted.claimDelivery.mockResolvedValue(true);
    expect((await monitorApprovalTimeouts(restarted)).sent).toBe(1);
  });

  it('sends personal and deduplicated group messages with separate delivery keys', async () => {
    state.config.APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS = 'cid-group; cid-group, cid-other';
    const deps = dependencies();
    expect((await monitorApprovalTimeouts(deps)).sent).toBe(3);
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.sendGroup).toHaveBeenCalledWith('cid-group', expect.stringContaining('待审批人：测试审批人'), ['approver-1']);
    expect(deps.sendGroup).toHaveBeenCalledTimes(2);
    expect(new Set(deps.claimDelivery.mock.calls.map(([key]) => key.recipientUserId)).size).toBe(3);
    expect(deps.claimDelivery.mock.calls[0][1]).toMatchObject({ repeatAfterMinutes: 1440, channel: 'personal' });
  });

  it('retries a failed group without resending the successful personal message', async () => {
    state.config.APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS = 'cid-group';
    const deps = dependencies();
    const sent = new Set<string>();
    deps.claimDelivery.mockImplementation(async (key) => !sent.has(key.recipientUserId));
    deps.markSent.mockImplementation(async (key) => { sent.add(key.recipientUserId); });
    deps.sendGroup.mockRejectedValueOnce(new Error('HTTP 429'));
    expect(await monitorApprovalTimeouts(deps)).toEqual({ scanned: 1, eligible: 1, sent: 1, failed: 1 });
    expect(await monitorApprovalTimeouts(deps)).toEqual({ scanned: 1, eligible: 1, sent: 1, failed: 0 });
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.markFailed).toHaveBeenCalledTimes(1);
  });

  it('routes parallel tasks to their respective approvers', async () => {
    state.config.APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS = 'cid-group';
    const deps = dependencies(72, [candidate(), candidate({ taskId: 'task-2', approverUserId: 'approver-2' })]);
    await monitorApprovalTimeouts(deps);
    expect(deps.send).toHaveBeenCalledWith(['approver-1'], expect.any(String));
    expect(deps.send).toHaveBeenCalledWith(['approver-2'], expect.any(String));
    expect(deps.sendGroup).toHaveBeenCalledWith('cid-group', expect.any(String), ['approver-1']);
    expect(deps.sendGroup).toHaveBeenCalledWith('cid-group', expect.any(String), ['approver-2']);
  });

  it('skips personal delivery when approver is missing and still sends a configured group', async () => {
    state.config.APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS = 'cid-group';
    const deps = dependencies(72, [candidate({ approverUserId: null, approverUserName: null })]);
    await monitorApprovalTimeouts(deps);
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.sendGroup).toHaveBeenCalledWith('cid-group', expect.stringContaining('未识别审批人'), []);
  });

  it('uses raw task user and time for historical rows', async () => {
    state.config.APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS = 'cid-group';
    const deps = dependencies(72, [candidate({
      taskStartTime: null, approverUserId: null, rawTask: { userId: 'raw-approver', startTime: startedAt.getTime() },
    })]);
    await monitorApprovalTimeouts(deps);
    expect(deps.send).toHaveBeenCalledWith(['raw-approver'], expect.any(String));
    expect(deps.sendGroup).toHaveBeenCalledWith('cid-group', expect.any(String), ['raw-approver']);
  });

  it.each([undefined, null, '', '   '])('never uses a retained historical approver when the latest snapshot has userId=%j', async (userId) => {
    state.config.APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS = 'cid-group';
    const deps = dependencies(72, [candidate({
      rawTask: { taskId: 'task-1', status: 'RUNNING', userId: 'old-task-approver' },
      rawInstance: { tasks: [{ taskId: 'task-1', status: 'RUNNING', userId, userName: '历史姓名' }] },
    })]);
    await monitorApprovalTimeouts(deps);
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.sendGroup).toHaveBeenCalledWith('cid-group', expect.stringContaining('未识别审批人'), []);
    expect(deps.sendGroup.mock.calls[0][1]).not.toContain('历史姓名');
    expect(deps.sendGroup.mock.calls[0][1]).not.toContain('测试审批人');
  });

  it.each([undefined, null, '', '   '])('does not fall back to retained columns when only a raw task with userId=%j is available', async (userId) => {
    state.config.APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS = 'cid-group';
    const deps = dependencies(72, [candidate({ rawTask: { taskId: 'task-1', status: 'RUNNING', userId } })]);
    await monitorApprovalTimeouts(deps);
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.sendGroup).toHaveBeenCalledWith('cid-group', expect.stringContaining('未识别审批人'), []);
  });

  it('routes to the current snapshot approver instead of a mismatched retained column or name', async () => {
    state.config.APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS = 'cid-group';
    const deps = dependencies(72, [candidate({ rawInstance: {
      tasks: [{ taskId: 'task-1', status: 'RUNNING', userId: 'current-approver' }],
    } })]);
    await monitorApprovalTimeouts(deps);
    expect(deps.send).toHaveBeenCalledWith(['current-approver'], expect.stringContaining('待审批人：current-approver'));
    expect(deps.sendGroup).toHaveBeenCalledWith('cid-group', expect.not.stringContaining('测试审批人'), ['current-approver']);
  });

  it('does not estimate node time from instance creation or accept invalid/future times', async () => {
    const deps = dependencies(72, [
      candidate({ taskStartTime: null, rawInstance: { createTime: '2020-01-01T00:00:00Z' } }),
      candidate({ taskStartTime: new Date('invalid') }), candidate({ taskStartTime: atHour(80) }),
    ]);
    await monitorApprovalTimeouts(deps);
    expect(deps.claimDelivery).not.toHaveBeenCalled();
  });

  it.each([
    { tasks: [] },
    { tasks: [{ taskId: 'task-1', status: 'COMPLETED', userId: 'approver-1' }] },
    { tasks: [{ taskId: 'task-1', status: 'RUNNING', userId: 'approver-1', finishTime: 1 }] },
  ])('skips removed, completed or transferred tasks in the latest snapshot: %j', async (rawInstance) => {
    const deps = dependencies(72, [candidate({ rawInstance })]);
    await monitorApprovalTimeouts(deps);
    expect(deps.send).not.toHaveBeenCalled();
  });

  it('accepts the current running task from the latest snapshot', async () => {
    const deps = dependencies(72, [candidate({ rawInstance: {
      tasks: [{ taskId: 'task-1', status: 'RUNNING', userId: 'approver-1' }],
    } })]);
    await monitorApprovalTimeouts(deps);
    expect(deps.send).toHaveBeenCalledTimes(1);
  });

  it('distinguishes reentered tasks while keeping long task IDs within schema limits', async () => {
    const first = dependencies(96, [candidate({ taskId: 't'.repeat(128) })]);
    const next = dependencies(96, [candidate({ taskId: 't'.repeat(128), taskStartTime: atHour(24) })]);
    await monitorApprovalTimeouts(first);
    await monitorApprovalTimeouts(next);
    const phase = first.claimDelivery.mock.calls[0][0].alertPhase;
    expect(phase.length).toBeLessThanOrEqual(64);
    expect(next.claimDelivery.mock.calls[0][0].alertPhase).not.toBe(phase);
  });

  it('requires enterprise/process scope and rejects candidates from another enterprise', async () => {
    const deps = dependencies();
    state.config.DINGTALK_CORP_ID = '';
    await monitorApprovalTimeouts(deps);
    state.config.DINGTALK_CORP_ID = 'corp-1';
    state.config.APPROVAL_TIMEOUT_PROCESS_CODES = '';
    await monitorApprovalTimeouts(deps);
    expect(deps.findCandidates).not.toHaveBeenCalled();
    state.config.APPROVAL_TIMEOUT_PROCESS_CODES = 'PROC-TEST';
    const other = dependencies(72, [candidate({ corpId: 'other-corp' })]);
    await monitorApprovalTimeouts(other);
    expect(other.send).not.toHaveBeenCalled();
  });

  it('continues other channels after a claim or failure-record error', async () => {
    state.config.APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS = 'cid-group';
    const deps = dependencies();
    deps.claimDelivery.mockRejectedValueOnce(new Error('database unavailable'));
    expect((await monitorApprovalTimeouts(deps)).failed).toBe(1);
    expect(deps.sendGroup).toHaveBeenCalledTimes(1);
    deps.send.mockRejectedValueOnce(new Error('send failed'));
    deps.markFailed.mockRejectedValueOnce(new Error('database unavailable'));
    expect((await monitorApprovalTimeouts(deps)).failed).toBe(1);
    expect(deps.sendGroup).toHaveBeenCalledTimes(2);
  });
});

describe('timeout SQL contracts (mocked database)', () => {
  it('defaults to 72 hours while accepting legacy window configuration', () => {
    const config = configSchema.parse({
      PGUSER: 'test', PGPASSWORD: 'test', PGDATABASE: 'test',
      DINGTALK_APP_KEY: 'test', DINGTALK_APP_SECRET: 'test', APPROVAL_TIMEOUT_WINDOW_BEFORE_MINUTES: '40',
    });
    expect(config.APPROVAL_TIMEOUT_MINUTES).toBe(4320);
    expect(config.APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS).toBe('');
  });

  it('wires the real monitor defaults to the 24-hour repeat claim and task recipient', async () => {
    state.query.mockResolvedValueOnce({ rows: [{
      corp_id: 'corp-1', process_instance_id: 'i', process_code: 'PROC-TEST', title: '测试审批',
      task_id: 't', start_time: new Date(0), approver_user_id: 'approver-1',
      approver_user_name: null, node_name: null, task_raw_payload: {}, instance_raw_payload: {},
    }] }).mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 1 });
    expect((await monitorApprovalTimeouts()).sent).toBe(1);
    expect(state.query.mock.calls[1][1][6]).toBe(1440);
    expect(state.send).toHaveBeenCalledWith(['approver-1'], expect.any(String));
  });

  it('selects only running unfinished tasks in the configured enterprise', async () => {
    state.query.mockResolvedValue({ rows: [] });
    await findRunningApprovalTimeoutCandidates(['PROC-TEST'], 'corp-1');
    const [sql, values] = state.query.mock.calls[0];
    expect(values).toEqual([['PROC-TEST'], 'corp-1']);
    for (const clause of ['i.corp_id = $2', "UPPER(COALESCE(i.status, '')) = 'RUNNING'",
      "UPPER(COALESCE(t.status, '')) = 'RUNNING'", 't.end_time IS NULL']) expect(sql).toContain(clause);
  });

  it('makes daily redelivery opt-in and leaves other alert types as one-time deliveries', async () => {
    state.query.mockResolvedValue({ rowCount: 1 });
    const key = { corpId: 'corp-1', processInstanceId: 'i', alertType: 'approval_timeout', alertPhase: 'daily:task', recipientUserId: 'a' };
    expect(await claimAlertDelivery(key, {}, 1440)).toBe(true);
    expect(state.query.mock.calls[0][1][6]).toBe(1440);
    expect(state.query.mock.calls[0][0]).toContain('ding_alert_notification.sent_at <= now() - make_interval');
    await claimAlertDelivery({ ...key, alertType: 'budget_threshold' }, {});
    expect(state.query.mock.calls[1][1][6]).toBeNull();
    state.query.mockResolvedValue({ rowCount: 0 });
    expect(await claimAlertDelivery(key, {}, 1440)).toBe(false);
    await expect(claimAlertDelivery(key, {}, 0)).rejects.toThrow('ALERT_INVALID_REPEAT_INTERVAL');
  });
});
