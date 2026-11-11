import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findRunningApprovalTimeoutCandidates, monitorApprovalTimeouts, type ApprovalTimeoutCandidate, type ApprovalTimeoutMonitorDependencies } from './approval-timeout-monitor.js';
import { claimAlertDelivery, type ClaimedAlertDelivery } from '../db/queries/alert-notification.js';
import { configSchema } from '../config/schema.js';
import { alertMarkdownParams } from '../dingtalk/alert-markdown.js';

const state = vi.hoisted(() => ({
  config: {
    DINGTALK_CORP_ID: 'corp-1',
    DINGTALK_ALERT_RECIPIENT_USER_IDS: 'old-fixed-receiver',
    APPROVAL_TIMEOUT_PROCESS_CODES: 'PROC-TEST',
    APPROVAL_TIMEOUT_PAUSED_INSTANCES: [] as [string, string][],
    APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS: '',
    APPROVAL_TIMEOUT_ES_USER_IDS: '',
    APPROVAL_TIMEOUT_ZH_USER_IDS: '',
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
const chineseTitle = '审批超时汇总';
const spanishTitle = 'Aprobaciones vencidas';
const candidate = (overrides: Partial<ApprovalTimeoutCandidate> = {}): ApprovalTimeoutCandidate => ({
  corpId: 'corp-1', processInstanceId: 'instance-1', processCode: 'PROC-TEST',
  title: '测试采购审批', taskId: 'task-1', taskStartTime: startedAt,
  approverUserId: 'approver-1', nodeName: '负责人审批',
  rawTask: {}, rawInstance: {}, ...overrides,
});
function dependencies(hour = 72, candidates = [candidate()]) {
  return {
    now: () => atHour(hour),
    findCandidates: vi.fn<ApprovalTimeoutMonitorDependencies['findCandidates']>().mockImplementation(async (_codes, _corpId, refs) =>
      refs ? candidates.filter(item => refs.some(ref => ref.processInstanceId === item.processInstanceId && ref.taskId === item.taskId)) : candidates),
    findApproverProfiles: vi.fn<ApprovalTimeoutMonitorDependencies['findApproverProfiles']>().mockImplementation(async (_corpId, ids) =>
      ids.includes('approver-1') ? [{ userId: 'approver-1', name: '测试审批人' }] : []),
    claimDeliveries: vi.fn<ApprovalTimeoutMonitorDependencies['claimDeliveries']>()
      .mockImplementation(async (_target, items) => items.map(({ processInstanceId, alertPhase }) => ({ processInstanceId, alertPhase, attemptCount: 1 }))),
    renewDeliveries: vi.fn<ApprovalTimeoutMonitorDependencies['renewDeliveries']>().mockImplementation(async (_target, claims) => claims),
    finishDeliveries: vi.fn<ApprovalTimeoutMonitorDependencies['finishDeliveries']>().mockResolvedValue(undefined),
    send: vi.fn<ApprovalTimeoutMonitorDependencies['send']>().mockResolvedValue(undefined),
    sendGroup: vi.fn<ApprovalTimeoutMonitorDependencies['sendGroup']>().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  state.config.DINGTALK_CORP_ID = 'corp-1';
  state.config.APPROVAL_TIMEOUT_PROCESS_CODES = 'PROC-TEST';
  state.config.APPROVAL_TIMEOUT_PAUSED_INSTANCES = [];
  state.config.APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS = '';
  state.config.APPROVAL_TIMEOUT_ES_USER_IDS = '';
  state.config.APPROVAL_TIMEOUT_ZH_USER_IDS = '';
  state.query.mockReset();
  state.send.mockReset().mockResolvedValue(undefined);
  state.sendGroup.mockReset().mockResolvedValue(undefined);
});

describe('approval timeout reminders', () => {
  it.each(['personal', 'group'])('stops a %s reminder if shutdown arrives while renewing its claim', async (channel) => {
    state.config.APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS = 'cid-group';
    const stop = new AbortController();
    const deps = dependencies(72, [candidate({ approverUserId: channel === 'group' ? null : 'approver-1' })]);
    deps.renewDeliveries.mockImplementationOnce(async (_target, claims) => {
      stop.abort();
      return claims;
    });

    expect(await monitorApprovalTimeouts(deps, stop.signal)).toMatchObject({ sent: 0, failed: 0 });
    expect(deps.claimDeliveries).toHaveBeenCalledTimes(1);
    expect(deps.claimDeliveries.mock.calls[0][1][0].payload).toMatchObject({ channel });
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.sendGroup).not.toHaveBeenCalled();
    expect(deps.finishDeliveries.mock.calls).toEqual([[
      deps.claimDeliveries.mock.calls[0][0], expect.arrayContaining([expect.objectContaining({ processInstanceId: 'instance-1' })]),
      null, 'APPROVAL_TIMEOUT_SCHEDULER_STOPPED',
    ]]);
  });

  it('records a reminder already being sent and releases unsent segments on shutdown', async () => {
    state.config.APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS = 'cid-group';
    const stop = new AbortController();
    const rows = Array.from({ length: 20 }, (_, index) => candidate({
      processInstanceId: `instance-${index}`, taskId: `task-${index}`,
      title: '审批😀'.repeat(100), nodeName: '节点'.repeat(100),
    }));
    const deps = dependencies(72, rows);
    deps.send.mockImplementationOnce(async () => { stop.abort(); });

    expect(await monitorApprovalTimeouts(deps, stop.signal)).toMatchObject({ sent: 1, failed: 0 });
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.sendGroup).not.toHaveBeenCalled();
    expect(deps.finishDeliveries).toHaveBeenCalledTimes(2);
    const [sent, released] = deps.finishDeliveries.mock.calls;
    expect(sent.slice(2)).toEqual([expect.any(String), undefined]);
    expect(released.slice(2)).toEqual([null, 'APPROVAL_TIMEOUT_SCHEDULER_STOPPED']);
    expect(released[1].length).toBeGreaterThan(0);
    expect([...sent[1], ...released[1]].map(item => item.processInstanceId).sort())
      .toEqual(rows.map(row => row.processInstanceId).sort());
  });

  it('keeps every node of a paused instance out of claims, personal digests and group mentions', async () => {
    state.config.APPROVAL_TIMEOUT_PAUSED_INSTANCES = [['corp-1', 'instance-1'], ['corp-2', 'instance-2']];
    state.config.APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS = 'cid-group';
    const deps = dependencies(72, [
      candidate({ title: '暂停的审批', approverUserId: 'paused-approver' }),
      candidate({ title: '暂停的并行节点', taskId: 'task-parallel', approverUserId: 'paused-other' }),
      candidate({ processInstanceId: 'instance-2', taskId: 'task-2' }),
    ]);

    expect(await monitorApprovalTimeouts(deps)).toEqual({ scanned: 3, eligible: 1, sent: 2, failed: 0 });
    expect(deps.findApproverProfiles.mock.calls).toEqual([['corp-1', ['approver-1']]]);
    expect(deps.claimDeliveries.mock.calls.flatMap(([, items]) => items.map(item => item.processInstanceId)))
      .toEqual(['instance-2', 'instance-2']);
    expect(deps.send).toHaveBeenCalledWith(['approver-1'], expect.stringContaining('instanceId=instance-2'), chineseTitle);
    expect(deps.sendGroup).toHaveBeenCalledWith('cid-group', expect.stringContaining('instanceId=instance-2'), ['approver-1'], chineseTitle);
    expect(deps.send.mock.calls[0][1]).not.toContain('暂停的');
    expect(deps.sendGroup.mock.calls[0][1]).not.toContain('暂停的');

    state.config.APPROVAL_TIMEOUT_PAUSED_INSTANCES = [];
    expect((await monitorApprovalTimeouts(dependencies())).sent).toBe(2);
  });

  it('parses an empty or enterprise-qualified pause list and rejects malformed entries', () => {
    const environment = { PGUSER: 'x', PGPASSWORD: 'x', PGDATABASE: 'x', DINGTALK_APP_KEY: 'x', DINGTALK_APP_SECRET: 'x' };
    expect(configSchema.parse(environment).APPROVAL_TIMEOUT_PAUSED_INSTANCES).toEqual([]);
    expect(configSchema.parse({ ...environment, APPROVAL_TIMEOUT_PAUSED_INSTANCES: 'corp-1:i_A, corp-2:i-B;corp-1:i_C' })
      .APPROVAL_TIMEOUT_PAUSED_INSTANCES).toEqual([['corp-1', 'i_A'], ['corp-2', 'i-B'], ['corp-1', 'i_C']]);
    for (const entry of ['i_A', ':i_A', 'corp-1:', 'corp-1:i_A:extra']) {
      expect(configSchema.safeParse({ ...environment, APPROVAL_TIMEOUT_PAUSED_INSTANCES: entry }).success).toBe(false);
    }
  });

  it('waits a full 72 hours and sends to the task approver instead of fixed recipients', async () => {
    const early = dependencies(72 - 1 / 3600);
    expect((await monitorApprovalTimeouts(early)).sent).toBe(0);
    expect(early.claimDeliveries).not.toHaveBeenCalled();
    const deps = dependencies();
    expect(await monitorApprovalTimeouts(deps)).toEqual({ scanned: 1, eligible: 1, sent: 1, failed: 0 });
    expect(deps.findCandidates).toHaveBeenCalledWith(['PROC-TEST'], 'corp-1');
    expect(deps.send).toHaveBeenCalledWith(['approver-1'], expect.stringContaining('72小时0分钟'), chineseTitle);
    const content = deps.send.mock.calls[0][1];
    expect(content).toContain('负责人审批');
    expect(content).toContain('测试审批人');
    expect(content).toContain('https://applink.dingtalk.com/approval/detail?corpId=corp-1&instanceId=instance-1');
    expect(content).not.toMatch(/首次提醒时限|每满 24 小时/);
  });

  it('keeps old overdue tasks eligible and uses the same delivery key after restart', async () => {
    const deps = dependencies();
    await monitorApprovalTimeouts(deps);
    const restarted = dependencies(24 * 50);
    restarted.claimDeliveries.mockResolvedValueOnce([]);
    expect((await monitorApprovalTimeouts(restarted)).eligible).toBe(1);
    expect(restarted.claimDeliveries.mock.calls[0][0]).toEqual(deps.claimDeliveries.mock.calls[0][0]);
    expect(restarted.claimDeliveries.mock.calls[0][1][0].alertPhase).toBe(deps.claimDeliveries.mock.calls[0][1][0].alertPhase);
    expect(restarted.send).not.toHaveBeenCalled();
    expect((await monitorApprovalTimeouts(restarted)).sent).toBe(1);
  });

  it('sends personal and deduplicated group messages with separate delivery keys', async () => {
    state.config.APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS = 'cid-group; cid-group, cid-other';
    const deps = dependencies();
    expect((await monitorApprovalTimeouts(deps)).sent).toBe(3);
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.sendGroup).toHaveBeenCalledWith('cid-group', expect.stringContaining('待审批人：测试审批人'), ['approver-1'], chineseTitle);
    expect(deps.sendGroup).toHaveBeenCalledTimes(2);
    expect(new Set(deps.claimDeliveries.mock.calls.map(([target]) => target.recipientUserId)).size).toBe(3);
    expect(deps.claimDeliveries.mock.calls[0][1][0].payload).toMatchObject({ repeatAfterMinutes: 1440, channel: 'personal' });
  });

  it('retries a failed group without resending the successful personal message', async () => {
    state.config.APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS = 'cid-group';
    const deps = dependencies(72, [candidate(), candidate({ processInstanceId: 'instance-2', taskId: 'task-2' })]);
    const sent = new Set<string>();
    deps.claimDeliveries.mockImplementation(async (target, items) => sent.has(target.recipientUserId) ? [] :
      items.map(({ processInstanceId, alertPhase }) => ({ processInstanceId, alertPhase, attemptCount: 1 })));
    deps.finishDeliveries.mockImplementation(async (target, _items, _batchId, error) => {
      if (error === undefined) sent.add(target.recipientUserId);
    });
    deps.sendGroup.mockRejectedValueOnce(new Error('HTTP 429'));
    expect(await monitorApprovalTimeouts(deps)).toEqual({ scanned: 2, eligible: 2, sent: 1, failed: 1 });
    expect(await monitorApprovalTimeouts(deps)).toEqual({ scanned: 2, eligible: 2, sent: 1, failed: 0 });
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.sendGroup).toHaveBeenCalledTimes(2);
    expect(deps.finishDeliveries.mock.calls[1]).toEqual([
      expect.objectContaining({ recipientUserId: expect.stringMatching(/^group:/) }),
      expect.arrayContaining([expect.objectContaining({ processInstanceId: 'instance-1' }), expect.objectContaining({ processInstanceId: 'instance-2' })]),
      expect.any(String), 'HTTP 429',
    ]);
  });

  it('routes parallel tasks to their respective approvers and sends one digest per group', async () => {
    state.config.APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS = 'cid-group';
    const deps = dependencies(72, [
      candidate({ title: '第一单' }),
      candidate({ taskId: 'task-2', title: '第二单', approverUserId: 'approver-2' }),
      candidate({ taskId: 'task-3', title: '第三单' }),
    ]);
    await monitorApprovalTimeouts(deps);
    expect(deps.send).toHaveBeenCalledTimes(2);
    expect(deps.send).toHaveBeenCalledWith(['approver-1'], expect.stringMatching(/第一单[\s\S]+第三单/), chineseTitle);
    expect(deps.send.mock.calls[0][1]).not.toContain('第二单');
    expect(deps.send).toHaveBeenCalledWith(['approver-2'], expect.stringContaining('第二单'), chineseTitle);
    expect(deps.sendGroup).toHaveBeenCalledTimes(1);
    expect(deps.sendGroup).toHaveBeenCalledWith('cid-group',
      expect.stringMatching(/第一单[\s\S]+第二单[\s\S]+第三单/), ['approver-1', 'approver-2'], chineseTitle);
  });

  it('localizes personal messages by the current approver account and keeps a mixed group in one digest', async () => {
    state.config.APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS = 'cid-group';
    state.config.APPROVAL_TIMEOUT_ES_USER_IDS = ' approver-es, approver-es ; other-account ';
    const deps = dependencies(75, [
      candidate({ title: '采购支出', nodeName: 'Revisión', rawInstance: {
        tasks: [{ taskId: 'task-1', status: 'RUNNING', userId: 'approver-es', userName: 'Ana' }],
      } }),
      candidate({ taskId: 'task-2', title: 'Solicitud de compra' }),
    ]);
    await monitorApprovalTimeouts(deps);
    expect(deps.send).toHaveBeenCalledTimes(2);
    expect(deps.send).toHaveBeenCalledWith(['approver-es'], expect.stringContaining('Etapa: Revisión · Responsable: Ana · Tiempo de espera: 75 h 0 min'), spanishTitle);
    const spanish = deps.send.mock.calls[0][1];
    expect(spanish).toContain('[Ver aprobación]');
    expect(spanish).not.toMatch(/首次提醒时限|每满 24 小时/);
    expect(deps.send).toHaveBeenCalledWith(['approver-1'], expect.stringContaining('Solicitud de compra · 节点：负责人审批'), chineseTitle);
    expect(deps.sendGroup).toHaveBeenCalledTimes(1);
    expect(deps.sendGroup).toHaveBeenCalledWith('cid-group', expect.stringMatching(/Ver aprobación[\s\S]+查看审批/),
      ['approver-es', 'approver-1'], `${chineseTitle} / ${spanishTitle}`);
  });

  it('uses the current account name for display and language without configuring IDs', async () => {
    state.config.APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS = 'cid-group';
    const deps = dependencies(72, [
      candidate({
        rawInstance: { tasks: [{ taskId: 'task-1', status: 'RUNNING', userId: 'latin-account' }] },
        rawTask: { userId: 'approver-1', userName: '旧审批人' },
      }),
      candidate({ taskId: 'task-2', approverUserId: 'chinese-account' }),
      candidate({ taskId: 'task-3', approverUserId: 'single-name-account' }),
    ]);
    deps.findApproverProfiles.mockResolvedValue([
      { userId: 'latin-account', name: 'LUCÍA.GÓMEZ（露西亚）' },
      { userId: 'chinese-account', name: '张三（Leo）' },
      { userId: 'single-name-account', name: 'Lucía' },
    ]);
    await monitorApprovalTimeouts(deps);
    expect(deps.findApproverProfiles).toHaveBeenCalledTimes(1);
    expect(deps.findApproverProfiles).toHaveBeenCalledWith('corp-1', ['latin-account', 'chinese-account', 'single-name-account']);
    expect(deps.send).toHaveBeenCalledWith(['latin-account'], expect.stringContaining('Responsable: LUCÍA.GÓMEZ（露西亚）'), spanishTitle);
    expect(deps.send.mock.calls[0][1]).not.toContain('旧审批人');
    expect(deps.send).toHaveBeenCalledWith(['chinese-account'], expect.stringContaining('待审批人：张三（Leo）'), chineseTitle);
    expect(deps.send).toHaveBeenCalledWith(['single-name-account'], expect.stringContaining('Responsable: Lucía'), spanishTitle);
    expect(deps.sendGroup).toHaveBeenCalledWith('cid-group', expect.stringContaining('LUCÍA.GÓMEZ（露西亚）'),
      ['latin-account', 'chinese-account', 'single-name-account'], `${chineseTitle} / ${spanishTitle}`);
  });

  it('honors a Chinese account override for a Latin display name', async () => {
    state.config.APPROVAL_TIMEOUT_ZH_USER_IDS = 'approver-1';
    state.config.APPROVAL_TIMEOUT_ES_USER_IDS = 'approver-1';
    const deps = dependencies();
    deps.findApproverProfiles.mockResolvedValue([{ userId: 'approver-1', name: 'Leo' }]);
    await monitorApprovalTimeouts(deps);
    expect(deps.send).toHaveBeenCalledWith(['approver-1'], expect.stringContaining('待审批人：Leo'), chineseTitle);
  });

  it.each([
    ['（露西亚）Lucía Gómez', spanishTitle],
    ['Leo（昵称）张三', chineseTitle],
    ['(露西亚（别名）) Lucía Gómez', spanishTitle],
    ['Lucía Gómez（露西亚', chineseTitle],
  ])('chooses the locale using the text outside balanced aliases for %s', async (name, expectedTitle) => {
    const deps = dependencies();
    deps.findApproverProfiles.mockResolvedValue([{ userId: 'approver-1', name }]);
    await monitorApprovalTimeouts(deps);
    expect(deps.send).toHaveBeenCalledWith(['approver-1'], expect.stringContaining(name), expectedTitle);
  });

  it('ignores a legacy archived name paired with the new ID after transfer', async () => {
    state.config.APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS = 'cid-group';
    const legacyRow = {
      ...candidate({ approverUserId: 'new-user',
        rawTask: { userId: 'old-user', userName: '旧审批人' },
        rawInstance: { tasks: [{ taskId: 'task-1', status: 'RUNNING', userId: 'new-user' }] },
      }),
      approverUserName: '旧审批人',
    };
    const deps = dependencies(72, [legacyRow]);
    deps.findApproverProfiles.mockResolvedValue([]);
    await monitorApprovalTimeouts(deps);
    expect(deps.send).toHaveBeenCalledWith(['new-user'], expect.stringContaining('待审批人：new-user'), chineseTitle);
    expect(deps.sendGroup).toHaveBeenCalledWith('cid-group', expect.not.stringContaining('旧审批人'), ['new-user'], chineseTitle);
  });

  it.each([
    { from: 'chinese-user', to: 'spanish-user', name: 'Ana', title: spanishTitle, approver: 'Responsable: Ana', link: 'Ver aprobación' },
    { from: 'spanish-user', to: 'chinese-user', name: '王五', title: chineseTitle, approver: '待审批人：王五', link: '查看审批' },
  ])('reroutes a transferred task from $from to $to with the new language and group mention', async ({ from, to, name, title, approver, link }) => {
    state.config.APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS = 'cid-group';
    const original = candidate({ title: '转交单据', approverUserId: from });
    const another = candidate({ processInstanceId: 'instance-2', taskId: 'task-2', title: '原有单据', approverUserId: to });
    const completed = candidate({ processInstanceId: 'instance-3', taskId: 'task-3', title: '已办单据', approverUserId: from });
    const transferred = { ...original, rawInstance: { tasks: [{ taskId: 'task-1', status: 'RUNNING', userId: to, userName: name }] } };
    const deps = dependencies(72, [transferred, another]);
    deps.findApproverProfiles.mockImplementation(async (_corpId, ids) => [
      { userId: 'spanish-user', name: 'Ana' }, { userId: 'chinese-user', name: '王五' },
    ].filter(profile => ids.includes(profile.userId)));
    deps.findCandidates.mockResolvedValueOnce([original, another, completed]);

    expect(await monitorApprovalTimeouts(deps)).toEqual({ scanned: 3, eligible: 3, sent: 2, failed: 0 });
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.send).toHaveBeenCalledWith([to], expect.stringMatching(/原有单据[\s\S]+转交单据/), title);
    expect(deps.send.mock.calls[0][1]).toContain(approver);
    expect(deps.sendGroup).toHaveBeenCalledTimes(1);
    expect(deps.sendGroup).toHaveBeenCalledWith('cid-group', expect.stringContaining(link), [to], title);
    expect(deps.sendGroup.mock.calls[0][1]).not.toContain('已办单据');
    expect(deps.finishDeliveries).toHaveBeenCalledWith(expect.objectContaining({ recipientUserId: from }),
      expect.arrayContaining([expect.objectContaining({ processInstanceId: original.processInstanceId })]),
      null, 'APPROVAL_TIMEOUT_TASK_CHANGED');
  });

  it('sends a single personal digest with all links for a backlog like the reported one', async () => {
    const items = Array.from({ length: 24 }, (_, index) => candidate({
      processInstanceId: `instance-${index}`, taskId: `task-${index}`, title: `采购支出审批${index}`,
    }));
    const deps = dependencies(96, items);
    expect(await monitorApprovalTimeouts(deps)).toEqual({ scanned: 24, eligible: 24, sent: 1, failed: 0 });
    expect(deps.send).toHaveBeenCalledTimes(1);
    const content = deps.send.mock.calls[0][1];
    expect(content).toContain('24 个待审批节点');
    for (const item of items) expect(content).toContain(`instanceId=${item.processInstanceId})`);
    expect(deps.finishDeliveries).toHaveBeenCalledTimes(1);
    expect(deps.finishDeliveries.mock.calls[0][1]).toHaveLength(24);
  });

  it('omits already notified tasks from both the digest and the group mentions', async () => {
    state.config.APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS = 'cid-group';
    const deps = dependencies(72, [
      candidate({ title: '今天已提醒' }),
      candidate({ taskId: 'new-task', title: '本轮到期', approverUserId: 'approver-2' }),
    ]);
    deps.claimDeliveries.mockImplementation(async (_target, items) => items.filter(item => item.payload.taskId === 'new-task')
      .map(({ processInstanceId, alertPhase }) => ({ processInstanceId, alertPhase, attemptCount: 1 })));
    await monitorApprovalTimeouts(deps);
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.send).toHaveBeenCalledWith(['approver-2'], expect.stringContaining('本轮到期'), chineseTitle);
    expect(deps.sendGroup).toHaveBeenCalledTimes(1);
    expect(deps.sendGroup).toHaveBeenCalledWith('cid-group', expect.not.stringContaining('今天已提醒'), ['approver-2'], chineseTitle);
  });

  it('splits oversized digests into complete entries using the actual UTF-8 Markdown payload size', async () => {
    state.config.APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS = 'cid-group';
    const items = Array.from({ length: 42 }, (_, index) => candidate({
      processInstanceId: `long-${index}`, taskId: `task-${index}`, title: '审批😀'.repeat(100), nodeName: '节点'.repeat(100),
    }));
    const deps = dependencies(96, items);
    await monitorApprovalTimeouts(deps);
    const groupMessages = deps.sendGroup.mock.calls;
    expect(groupMessages.length).toBeGreaterThan(1);
    for (const [, content, mentions, title] of groupMessages) {
      expect(Buffer.byteLength(alertMarkdownParams(content, mentions, title))).toBeLessThanOrEqual(15_000);
      expect(mentions).toEqual(['approver-1']);
    }
    for (const item of items) {
      expect(groupMessages.filter(([, content]) => content.includes(`instanceId=${item.processInstanceId})`))).toHaveLength(1);
    }
    const groupResults = deps.finishDeliveries.mock.calls.filter(([target]) => target.recipientUserId.startsWith('group:'));
    expect(groupResults).toHaveLength(groupMessages.length);
    expect(groupResults.flatMap(([, claims]) => claims).map(claim => claim.processInstanceId)).toEqual(items.map(item => item.processInstanceId));
  });

  it('does not send expired later parts after another scan reclaims and sends them', async () => {
    const items = Array.from({ length: 36 }, (_, index) => candidate({
      processInstanceId: `expired-${index}`, taskId: `task-${index}`, title: '多字节标题😀'.repeat(100),
      nodeName: '节点'.repeat(100),
    }));
    const workerA = dependencies(96, items);
    const workerB = dependencies(96, items);
    let now = 0;
    const leaseMinutes = 15;
    const sent = new Set<string>();
    const attempts = new Map<string, { attemptCount: number; expiresAt: number }>();
    const claim: ApprovalTimeoutMonitorDependencies['claimDeliveries'] = async (_target, deliveries) => deliveries.flatMap(item => {
      const old = attempts.get(item.processInstanceId);
      if (sent.has(item.processInstanceId) || (old && old.expiresAt > now)) return [];
      const attemptCount = (old?.attemptCount ?? 0) + 1;
      attempts.set(item.processInstanceId, { attemptCount, expiresAt: now + leaseMinutes });
      return [{ processInstanceId: item.processInstanceId, alertPhase: item.alertPhase, attemptCount }];
    });
    const renew: ApprovalTimeoutMonitorDependencies['renewDeliveries'] = async (_target, claims) => claims.filter(item => {
      const attempt = attempts.get(item.processInstanceId);
      if (sent.has(item.processInstanceId) || !attempt || attempt.attemptCount !== item.attemptCount || attempt.expiresAt <= now) return false;
      attempt.expiresAt = now + leaseMinutes;
      return true;
    });
    const saveSent = (claims: ClaimedAlertDelivery[]) => claims.forEach(item => sent.add(item.processInstanceId));
    let release!: () => void;
    let firstPartSaved!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const firstPart = new Promise<void>(resolve => { firstPartSaved = resolve; });
    workerA.finishDeliveries.mockImplementationOnce(async (_target, claims) => {
      saveSent(claims);
      firstPartSaved();
      await blocked;
    });
    workerB.finishDeliveries.mockImplementation(async (_target, claims) => { saveSent(claims); });
    for (const worker of [workerA, workerB]) {
      worker.claimDeliveries.mockImplementation(claim);
      worker.renewDeliveries.mockImplementation(renew);
    }

    const firstRun = monitorApprovalTimeouts(workerA);
    try {
      await Promise.race([firstPart, firstRun.then(() => { throw new Error('First worker finished before saving its first part'); })]);
      expect(sent.size).toBeLessThan(items.length);
      now = 16;
      expect((await monitorApprovalTimeouts(workerB)).sent).toBeGreaterThan(0);
    } finally {
      release();
      await firstRun;
    }
    expect(workerA.send).toHaveBeenCalledTimes(1);
    expect(workerA.renewDeliveries.mock.calls.length).toBeGreaterThan(1);
    const messages = [...workerA.send.mock.calls, ...workerB.send.mock.calls];
    for (const item of items) {
      expect(messages.filter(([, content]) => content.includes(`instanceId=${item.processInstanceId})`))).toHaveLength(1);
    }
  });

  it('removes a lost lease from a partially renewed group digest and its mentions', async () => {
    state.config.APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS = 'cid-group';
    state.config.APPROVAL_TIMEOUT_ES_USER_IDS = 'approver-2';
    const deps = dependencies(72, [
      candidate({ processInstanceId: 'expired-instance', title: '过期条目' }),
      candidate({ processInstanceId: 'active-instance', title: '有效条目', approverUserId: 'approver-2' }),
    ]);
    deps.renewDeliveries.mockImplementation(async (target, claims) => target.recipientUserId.startsWith('group:')
      ? claims.filter(claim => claim.processInstanceId === 'active-instance') : claims);
    await monitorApprovalTimeouts(deps);
    expect(deps.sendGroup).toHaveBeenCalledTimes(1);
    expect(deps.sendGroup).toHaveBeenCalledWith('cid-group', expect.stringContaining('有效条目'), ['approver-2'], spanishTitle);
    expect(deps.sendGroup.mock.calls[0][1]).not.toContain('过期条目');
    const groupFinish = deps.finishDeliveries.mock.calls.find(([target]) => target.recipientUserId.startsWith('group:'));
    expect(groupFinish?.[1].map(claim => claim.processInstanceId)).toEqual(['active-instance']);
  });

  it('skips personal delivery when approver is missing and still sends a configured group', async () => {
    state.config.APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS = 'cid-group';
    const deps = dependencies(72, [candidate({ approverUserId: null })]);
    await monitorApprovalTimeouts(deps);
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.sendGroup).toHaveBeenCalledWith('cid-group', expect.stringContaining('未识别审批人'), [], chineseTitle);
  });

  it('uses raw task user and time for historical rows', async () => {
    state.config.APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS = 'cid-group';
    const deps = dependencies(72, [candidate({
      taskStartTime: null, approverUserId: null, rawTask: { userId: 'raw-approver', startTime: startedAt.getTime() },
    })]);
    await monitorApprovalTimeouts(deps);
    expect(deps.send).toHaveBeenCalledWith(['raw-approver'], expect.any(String), chineseTitle);
    expect(deps.sendGroup).toHaveBeenCalledWith('cid-group', expect.any(String), ['raw-approver'], chineseTitle);
  });

  it.each([undefined, null, '', '   '])('never uses a retained historical approver when the latest snapshot has userId=%j', async (userId) => {
    state.config.APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS = 'cid-group';
    const deps = dependencies(72, [candidate({
      rawTask: { taskId: 'task-1', status: 'RUNNING', userId: 'old-task-approver' },
      rawInstance: { tasks: [{ taskId: 'task-1', status: 'RUNNING', userId, userName: '历史姓名' }] },
    })]);
    await monitorApprovalTimeouts(deps);
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.sendGroup).toHaveBeenCalledWith('cid-group', expect.stringContaining('未识别审批人'), [], chineseTitle);
    expect(deps.sendGroup.mock.calls[0][1]).not.toContain('历史姓名');
    expect(deps.sendGroup.mock.calls[0][1]).not.toContain('测试审批人');
  });

  it.each([undefined, null, '', '   '])('does not fall back to retained columns when only a raw task with userId=%j is available', async (userId) => {
    state.config.APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS = 'cid-group';
    const deps = dependencies(72, [candidate({ rawTask: { taskId: 'task-1', status: 'RUNNING', userId } })]);
    await monitorApprovalTimeouts(deps);
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.sendGroup).toHaveBeenCalledWith('cid-group', expect.stringContaining('未识别审批人'), [], chineseTitle);
  });

  it('routes to the current snapshot approver instead of a mismatched retained column or name', async () => {
    state.config.APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS = 'cid-group';
    const deps = dependencies(72, [candidate({ rawInstance: {
      tasks: [{ taskId: 'task-1', status: 'RUNNING', userId: 'current-approver' }],
    } })]);
    await monitorApprovalTimeouts(deps);
    expect(deps.send).toHaveBeenCalledWith(['current-approver'], expect.stringContaining('待审批人：current-approver'), chineseTitle);
    expect(deps.sendGroup).toHaveBeenCalledWith('cid-group', expect.not.stringContaining('测试审批人'), ['current-approver'], chineseTitle);
  });

  it('does not estimate node time from instance creation or accept invalid/future times', async () => {
    const deps = dependencies(72, [
      candidate({ taskStartTime: null, rawInstance: { createTime: '2020-01-01T00:00:00Z' } }),
      candidate({ taskStartTime: new Date('invalid') }), candidate({ taskStartTime: atHour(80) }),
    ]);
    await monitorApprovalTimeouts(deps);
    expect(deps.claimDeliveries).not.toHaveBeenCalled();
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

  it('uses the raw task name when its account matches the current approver and no profile exists', async () => {
    const deps = dependencies(72, [candidate({
      rawInstance: { tasks: [{ taskId: 'task-1', status: 'RUNNING', userId: 'approver-1' }] },
      rawTask: { userId: 'approver-1', userName: '同账号姓名' },
    })]);
    deps.findApproverProfiles.mockResolvedValue([]);
    await monitorApprovalTimeouts(deps);
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.send).toHaveBeenCalledWith(['approver-1'], expect.stringContaining('待审批人：同账号姓名'), chineseTitle);
  });

  it('distinguishes reentered tasks while keeping long task IDs within schema limits', async () => {
    const first = dependencies(96, [candidate({ taskId: 't'.repeat(128) })]);
    const next = dependencies(96, [candidate({ taskId: 't'.repeat(128), taskStartTime: atHour(24) })]);
    await monitorApprovalTimeouts(first);
    await monitorApprovalTimeouts(next);
    const phase = first.claimDeliveries.mock.calls[0][1][0].alertPhase;
    expect(phase.length).toBeLessThanOrEqual(64);
    expect(next.claimDeliveries.mock.calls[0][1][0].alertPhase).not.toBe(phase);
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
    deps.claimDeliveries.mockRejectedValueOnce(new Error('database unavailable'));
    expect((await monitorApprovalTimeouts(deps)).failed).toBe(1);
    expect(deps.sendGroup).toHaveBeenCalledTimes(1);
    deps.finishDeliveries.mockRejectedValueOnce(new Error('database unavailable'));
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
    expect(config.APPROVAL_TIMEOUT_ES_USER_IDS).toBe('');
    expect(config.APPROVAL_TIMEOUT_ZH_USER_IDS).toBe('');
  });

  it('wires the real monitor defaults to the 24-hour repeat claim and task recipient', async () => {
    const rows = [{
      corp_id: 'corp-1', process_instance_id: 'i', process_code: 'PROC-TEST', title: '测试审批',
      task_id: 't', start_time: new Date(0), approver_user_id: 'approver-1',
      node_name: null, task_raw_payload: {}, instance_raw_payload: {},
    }];
    state.query.mockResolvedValueOnce({ rows })
      .mockResolvedValueOnce({ rows: [{ userId: 'approver-1', name: '测试审批人' }] })
      .mockImplementationOnce(async (_sql, params) => ({ rows: JSON.parse(params[3]).map((item: object) => ({ ...item, attemptCount: 1 })) }))
      .mockResolvedValueOnce({ rows })
      .mockImplementationOnce(async (_sql, params) => ({ rows: JSON.parse(params[3]) }))
      .mockResolvedValueOnce({ rowCount: 1 });
    expect((await monitorApprovalTimeouts()).sent).toBe(1);
    expect(state.query.mock.calls[1][1]).toEqual(['corp-1', ['approver-1']]);
    expect(state.query.mock.calls[2][1][4]).toBe(1440);
    expect(state.query.mock.calls[3][1]).toEqual([['PROC-TEST'], 'corp-1', JSON.stringify([{ processInstanceId: 'i', taskId: 't' }])]);
    expect(state.query.mock.calls[4][0]).toContain("AND n.updated_at >= clock_timestamp() - interval '15 minutes'");
    expect(state.query.mock.calls[5][0]).toContain("SET status = $6::varchar, sent_at = CASE WHEN $6::varchar = 'sent'");
    expect(state.send).toHaveBeenCalledWith(['approver-1'], expect.stringContaining('待审批人：测试审批人'), chineseTitle);
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
