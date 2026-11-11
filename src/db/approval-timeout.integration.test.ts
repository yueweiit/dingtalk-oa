import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeTasks } from '../normalize/task-normalizer.js';
import type { ApprovalTask } from '../dingtalk/types.js';
import { upsertTask } from './queries/approval-task.js';
import { claimAlertDeliveryBatch, finishAlertDeliveryBatch, renewAlertDeliveryBatch, type AlertDeliveryClaim, type AlertDeliveryTarget } from './queries/alert-notification.js';
import { findCurrentSnapshotNames } from './queries/user-snapshot.js';
import { findRunningApprovalTimeoutCandidates, monitorApprovalTimeouts } from '../jobs/approval-timeout-monitor.js';

const state = vi.hoisted(() => ({ client: null as pg.Client | null }));
vi.mock('./pool.js', () => ({
  withClient: (run: (client: pg.Client) => unknown) => {
    if (!state.client) throw new Error('APPROVAL_TIMEOUT_TEST_DATABASE_NOT_CONNECTED');
    return run(state.client);
  },
}));
vi.mock('../config/index.js', () => ({ getConfig: () => ({
  DINGTALK_CORP_ID: 'corp-test', APPROVAL_TIMEOUT_PROCESS_CODES: 'PROC-TEST',
  APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS: 'cid-test', APPROVAL_TIMEOUT_MINUTES: 4320,
  APPROVAL_TIMEOUT_ES_USER_IDS: '',
  APPROVAL_TIMEOUT_ZH_USER_IDS: '',
}) }));

// 仅显式提供获准的一次性 loopback 测试库时运行。只创建会话临时表，不运行迁移或触碰 public 表。
const databaseUrl = process.env.APPROVAL_TIMEOUT_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('approval timeout task persistence (isolated PostgreSQL)', () => {
  beforeAll(async () => {
    let url: URL;
    try { url = new URL(databaseUrl!); } catch { throw new Error('APPROVAL_TIMEOUT_TEST_DATABASE_URL_INVALID'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || !/^\/approval_timeout_test(?:_[a-z0-9_]+)?$/.test(url.pathname)
      || [...url.searchParams.keys()].some(key => ['host', 'hostaddr', 'port', 'dbname', 'options', 'service'].includes(key.toLowerCase()))) {
      throw new Error('APPROVAL_TIMEOUT_TEST_REQUIRES_DISPOSABLE_LOOPBACK_DATABASE');
    }
    state.client = new pg.Client({ connectionString: databaseUrl });
    await state.client.connect();
    await state.client.query(`SET search_path TO pg_temp;
      CREATE TEMP TABLE ding_approval_task (
        id BIGSERIAL PRIMARY KEY, corp_id VARCHAR(64) NOT NULL, process_instance_id VARCHAR(128) NOT NULL,
        task_id VARCHAR(128) NOT NULL, task_order INTEGER, activity_id VARCHAR(128), node_name VARCHAR(256),
        status VARCHAR(32), result VARCHAR(32), approver_user_id VARCHAR(128), approver_user_name VARCHAR(256),
        approver_dept_id VARCHAR(128), approver_dept_name VARCHAR(256), start_time TIMESTAMPTZ,
        end_time TIMESTAMPTZ, remark TEXT, raw_payload JSONB, updated_at TIMESTAMPTZ DEFAULT now(),
        created_at TIMESTAMPTZ DEFAULT now(), UNIQUE(corp_id, process_instance_id, task_id)
      );
      CREATE TEMP TABLE ding_approval_instance (
        corp_id VARCHAR(64), process_instance_id VARCHAR(128), process_code VARCHAR(128), title TEXT,
        status VARCHAR(32), deleted_at TIMESTAMPTZ, create_time TIMESTAMPTZ, raw_payload JSONB
      );
      CREATE TEMP TABLE ding_user_snapshot (
        corp_id VARCHAR(64), user_id VARCHAR(128), name VARCHAR(256), is_current BOOLEAN, fetch_status VARCHAR(32)
      );
      CREATE TEMP TABLE ding_alert_notification (
        id BIGSERIAL PRIMARY KEY,
        corp_id VARCHAR(64) NOT NULL, process_instance_id VARCHAR(128) NOT NULL, alert_type VARCHAR(64) NOT NULL,
        alert_phase VARCHAR(64) NOT NULL, recipient_user_id VARCHAR(128) NOT NULL, status VARCHAR(32) NOT NULL,
        attempt_count INTEGER NOT NULL, payload JSONB, last_error TEXT, sent_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(corp_id, process_instance_id, alert_type, alert_phase, recipient_user_id)
      );`);
  });
  afterAll(async () => { await state.client?.end(); state.client = null; });
  beforeEach(async () => {
    await state.client!.query('TRUNCATE pg_temp.ding_approval_task, pg_temp.ding_approval_instance, pg_temp.ding_alert_notification, pg_temp.ding_user_snapshot');
  });

  const initialStart = '2026-11-01T08:00:00+08:00';
  const initialEnd = '2026-11-02T08:00:00+08:00';
  const nextStart = '2026-11-03T08:00:00+08:00';
  async function persist(task: ApprovalTask) {
    const [normalized] = normalizeTasks('corp-test', 'instance-test', [task]);
    return upsertTask(normalized, state.client! as unknown as pg.PoolClient);
  }
  async function completedTask() {
    await persist({ taskId: 'task-test', status: 'COMPLETED', userId: 'previous-user',
      startTime: initialStart, endTime: initialEnd });
  }
  async function latestInstance(...tasks: ApprovalTask[]) {
    await state.client!.query(`INSERT INTO ding_approval_instance
      (corp_id, process_instance_id, process_code, status, create_time, raw_payload)
      VALUES ('corp-test', 'instance-test', 'PROC-TEST', 'RUNNING', $1, $2)`,
    [initialStart, JSON.stringify({ tasks })]);
  }
  function reminderDependencies() {
    return {
      now: () => new Date('2026-11-10T08:00:00+08:00'), findCandidates: findRunningApprovalTimeoutCandidates,
      findApproverProfiles: findCurrentSnapshotNames,
      claimDeliveries: (target: AlertDeliveryTarget, items: AlertDeliveryClaim[]) => claimAlertDeliveryBatch(target, items, 1440),
      renewDeliveries: renewAlertDeliveryBatch,
      finishDeliveries: finishAlertDeliveryBatch, send: vi.fn().mockResolvedValue(undefined),
      sendGroup: vi.fn().mockResolvedValue(undefined),
    };
  }

  it.each([nextStart, initialEnd])('clears an old end time for a later task cycle (%s) and includes it in reminders', async (startTime) => {
    await completedTask();
    const task = { taskId: 'task-test', status: 'RUNNING', userId: 'current-user', startTime, endTime: null };
    const row = await persist(task);
    expect(row.end_time).toBeNull();
    await latestInstance(task);
    const deps = reminderDependencies();
    expect((await monitorApprovalTimeouts(deps)).sent).toBe(2);
    expect(deps.send).toHaveBeenCalledWith(['current-user'], expect.any(String), '审批超时汇总');
    expect(deps.sendGroup).toHaveBeenCalledWith('cid-test', expect.any(String), ['current-user'], '审批超时汇总');
  });

  it('self-corrects a retained end time after the later start time was already persisted', async () => {
    await completedTask();
    await state.client!.query(`UPDATE pg_temp.ding_approval_task SET status = 'RUNNING', start_time = $1`, [nextStart]);
    const row = await persist({ taskId: 'task-test', status: 'RUNNING', userId: 'current-user', startTime: nextStart });
    expect(row.end_time).toBeNull();
  });

  it.each([
    { status: 'RUNNING' },
    { status: 'RUNNING', startTime: initialStart },
    { status: 'COMPLETED', startTime: nextStart },
  ])('preserves an old end time without evidence of an unfinished new cycle: %j', async (update) => {
    await completedTask();
    const row = await persist({ taskId: 'task-test', ...update });
    expect(row.end_time).toEqual(new Date(initialEnd));
  });

  it('does not replace an explicitly supplied new end time', async () => {
    await completedTask();
    const row = await persist({ taskId: 'task-test', status: 'RUNNING', startTime: nextStart,
      endTime: '2026-11-04T08:00:00+08:00' });
    expect(row.end_time).toEqual(new Date('2026-11-04T08:00:00+08:00'));
  });

  it('does not notify a retained old approver after persisting a task with missing userId', async () => {
    await persist({ taskId: 'task-test', status: 'RUNNING', userId: 'previous-user', startTime: initialStart });
    const task = { taskId: 'task-test', status: 'RUNNING', userId: null, startTime: initialStart };
    const row = await persist(task);
    expect(row.approver_user_id).toBe('previous-user');
    await latestInstance(task);
    const deps = reminderDependencies();
    expect((await monitorApprovalTimeouts(deps)).sent).toBe(1);
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.sendGroup).toHaveBeenCalledWith('cid-test', expect.stringContaining('未识别审批人'), [], '审批超时汇总');
  });

  it('records one message batch for every included task and deduplicates the next scan', async () => {
    const tasks = ['task-1', 'task-2'].map(taskId => ({ taskId, status: 'RUNNING', userId: 'current-user', startTime: initialStart }));
    for (const task of tasks) await persist(task);
    await latestInstance(...tasks);
    const deps = reminderDependencies();
    expect(await monitorApprovalTimeouts(deps)).toEqual({ scanned: 2, eligible: 2, sent: 2, failed: 0 });
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.sendGroup).toHaveBeenCalledTimes(1);
    const { rows } = await state.client!.query(`SELECT status, payload->>'channel' AS channel,
      payload->>'batchId' AS batch_id, sent_at FROM pg_temp.ding_alert_notification ORDER BY channel`);
    expect(rows).toHaveLength(4);
    expect(rows.every(row => row.status === 'sent' && row.batch_id && row.sent_at)).toBe(true);
    expect(rows[0]).toEqual(rows[1]);
    expect(rows[2]).toEqual(rows[3]);
    expect(rows[0].batch_id).not.toBe(rows[2].batch_id);
    expect((await monitorApprovalTimeouts(deps)).sent).toBe(0);
  });

  it('uses the current approver’s successful profile in the configured enterprise for name and language', async () => {
    await persist({ taskId: 'task-test', status: 'RUNNING', userId: 'previous-user', userName: '旧审批人', startTime: initialStart });
    await latestInstance({ taskId: 'task-test', status: 'RUNNING', userId: 'current-user', startTime: initialStart });
    await state.client!.query(`INSERT INTO pg_temp.ding_user_snapshot VALUES
      ('corp-test','current-user','Lucía Gómez（露西亚）',true,'success'),
      ('corp-test','current-user','旧资料',false,'success'),
      ('corp-test','current-user','unknown',false,'failed'),
      ('other-corp','current-user','另一企业人员',true,'success')`);
    const deps = reminderDependencies();
    expect((await monitorApprovalTimeouts(deps)).sent).toBe(2);
    expect(deps.send).toHaveBeenCalledWith(['current-user'], expect.stringContaining('Responsable: Lucía Gómez（露西亚）'), 'Aprobaciones vencidas');
    expect(deps.sendGroup).toHaveBeenCalledWith('cid-test', expect.not.stringContaining('旧审批人'), ['current-user'], 'Aprobaciones vencidas');
  });

  it('does not display a legacy stored name when only the new approver ID is verifiable', async () => {
    await persist({ taskId: 'task-test', status: 'RUNNING', userId: 'previous-user', userName: '旧审批人', startTime: initialStart });
    const task = { taskId: 'task-test', status: 'RUNNING', userId: 'current-user', startTime: initialStart };
    await state.client!.query(`UPDATE pg_temp.ding_approval_task SET approver_user_id=$1, raw_payload=$2::jsonb
      WHERE task_id='task-test'`, [task.userId, JSON.stringify(task)]);
    await latestInstance(task);
    const deps = reminderDependencies();
    expect((await monitorApprovalTimeouts(deps)).sent).toBe(2);
    expect(deps.send).toHaveBeenCalledWith(['current-user'], expect.stringContaining('待审批人：current-user'), '审批超时汇总');
    expect(deps.sendGroup).toHaveBeenCalledWith('cid-test', expect.not.stringContaining('旧审批人'), ['current-user'], '审批超时汇总');
  });

  it('reclaims only an individually due task and ignores an old attempt result', async () => {
    const target = { corpId: 'corp-test', alertType: 'approval_timeout', recipientUserId: 'current-user' };
    const items = ['i-1', 'i-2'].map(processInstanceId => ({ processInstanceId, alertPhase: 'daily:test', payload: {} }));
    const first = await claimAlertDeliveryBatch(target, items, 1440);
    await finishAlertDeliveryBatch(target, first, 'first');
    await state.client!.query(`UPDATE pg_temp.ding_alert_notification SET sent_at = now() - interval '24 hours'
      WHERE process_instance_id = 'i-2'`);
    const next = await claimAlertDeliveryBatch(target, items, 1440);
    expect(next).toEqual([{ processInstanceId: 'i-2', alertPhase: 'daily:test', attemptCount: 2 }]);
    await finishAlertDeliveryBatch(target, first, 'stale', 'late failure');
    await finishAlertDeliveryBatch(target, next, 'second', 'HTTP 429');
    const { rows } = await state.client!.query(`SELECT process_instance_id, status, last_error, sent_at IS NOT NULL AS sent_before,
      payload->>'batchId' AS batch_id FROM pg_temp.ding_alert_notification ORDER BY process_instance_id`);
    expect(rows).toEqual([
      { process_instance_id: 'i-1', status: 'sent', last_error: null, sent_before: true, batch_id: 'first' },
      { process_instance_id: 'i-2', status: 'failed', last_error: 'HTTP 429', sent_before: true, batch_id: 'second' },
    ]);
  });

  it('only renews live leases and refuses the previous worker after reclamation', async () => {
    const target = { corpId: 'corp-test', alertType: 'approval_timeout', recipientUserId: 'current-user' };
    const items = ['i-1', 'i-2'].map(processInstanceId => ({ processInstanceId, alertPhase: 'daily:test', payload: {} }));
    const first = await claimAlertDeliveryBatch(target, items, 1440);
    await state.client!.query(`UPDATE pg_temp.ding_alert_notification SET updated_at = now() - interval '16 minutes'
      WHERE process_instance_id = 'i-2'`);
    expect(await renewAlertDeliveryBatch(target, first)).toEqual([expect.objectContaining({ processInstanceId: 'i-1', attemptCount: 1 })]);

    const replacement = await claimAlertDeliveryBatch(target, items, 1440);
    expect(replacement).toEqual([{ processInstanceId: 'i-2', alertPhase: 'daily:test', attemptCount: 2 }]);
    expect(await renewAlertDeliveryBatch(target, first.filter(item => item.processInstanceId === 'i-2'))).toEqual([]);
    expect(await renewAlertDeliveryBatch(target, replacement)).toEqual(replacement);
    await finishAlertDeliveryBatch(target, replacement, 'replacement');
    expect(await renewAlertDeliveryBatch(target, replacement)).toEqual([]);
  });
});
