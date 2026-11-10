import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeTasks } from '../normalize/task-normalizer.js';
import type { ApprovalTask } from '../dingtalk/types.js';
import { upsertTask } from './queries/approval-task.js';
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
      );`);
  });
  afterAll(async () => { await state.client?.end(); state.client = null; });
  beforeEach(async () => {
    await state.client!.query('TRUNCATE pg_temp.ding_approval_task, pg_temp.ding_approval_instance');
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
  async function latestInstance(task: ApprovalTask) {
    await state.client!.query(`INSERT INTO ding_approval_instance
      (corp_id, process_instance_id, process_code, status, create_time, raw_payload)
      VALUES ('corp-test', 'instance-test', 'PROC-TEST', 'RUNNING', $1, $2)`,
    [initialStart, JSON.stringify({ tasks: [task] })]);
  }
  function reminderDependencies() {
    return {
      now: () => new Date('2026-11-10T08:00:00+08:00'), findCandidates: findRunningApprovalTimeoutCandidates,
      claimDelivery: vi.fn().mockResolvedValue(true), markSent: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined),
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
    expect(deps.send).toHaveBeenCalledWith(['current-user'], expect.any(String));
    expect(deps.sendGroup).toHaveBeenCalledWith('cid-test', expect.any(String), ['current-user']);
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
    expect(deps.sendGroup).toHaveBeenCalledWith('cid-test', expect.stringContaining('未识别审批人'), []);
  });
});
