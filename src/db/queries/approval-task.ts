import { withClient } from '../pool.js';
import type { DingApprovalTask } from '../types.js';
import type pg from 'pg';

function safeJsonb(value: any): string | null {
  if (value == null) return null;
  try { return JSON.stringify(value); } catch { return null; }
}

export async function upsertTask(params: {
  corp_id: string;
  process_instance_id: string;
  task_id: string;
  task_order?: number | null;
  activity_id?: string | null;
  node_name?: string | null;
  status?: string | null;
  result?: string | null;
  approver_user_id?: string | null;
  approver_user_name?: string | null;
  approver_dept_id?: string | null;
  approver_dept_name?: string | null;
  start_time?: Date | null;
  end_time?: Date | null;
  remark?: string | null;
  raw_payload?: any;
}, client?: pg.PoolClient): Promise<DingApprovalTask> {
  const run = async (c: pg.PoolClient) => {
    const { rows } = await c.query<DingApprovalTask>(
      `INSERT INTO ding_approval_task (
        corp_id, process_instance_id, task_id, task_order, activity_id, node_name,
        status, result, approver_user_id, approver_user_name, approver_dept_id, approver_dept_name,
        start_time, end_time, remark, raw_payload
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT (corp_id, process_instance_id, task_id)
      DO UPDATE SET
        task_order = COALESCE(EXCLUDED.task_order, ding_approval_task.task_order),
        activity_id = COALESCE(EXCLUDED.activity_id, ding_approval_task.activity_id),
        node_name = COALESCE(EXCLUDED.node_name, ding_approval_task.node_name),
        status = COALESCE(EXCLUDED.status, ding_approval_task.status),
        result = COALESCE(EXCLUDED.result, ding_approval_task.result),
        approver_user_id = COALESCE(EXCLUDED.approver_user_id, ding_approval_task.approver_user_id),
        approver_user_name = COALESCE(EXCLUDED.approver_user_name, ding_approval_task.approver_user_name),
        approver_dept_id = COALESCE(EXCLUDED.approver_dept_id, ding_approval_task.approver_dept_id),
        approver_dept_name = COALESCE(EXCLUDED.approver_dept_name, ding_approval_task.approver_dept_name),
        start_time = COALESCE(EXCLUDED.start_time, ding_approval_task.start_time),
        end_time = COALESCE(EXCLUDED.end_time, ding_approval_task.end_time),
        remark = COALESCE(EXCLUDED.remark, ding_approval_task.remark),
        raw_payload = COALESCE(EXCLUDED.raw_payload, ding_approval_task.raw_payload),
        updated_at = now()
      RETURNING *`,
      [
        params.corp_id,
        params.process_instance_id,
        params.task_id,
        params.task_order ?? null,
        params.activity_id ?? null,
        params.node_name ?? null,
        params.status ?? null,
        params.result ?? null,
        params.approver_user_id ?? null,
        params.approver_user_name ?? null,
        params.approver_dept_id ?? null,
        params.approver_dept_name ?? null,
        params.start_time ?? null,
        params.end_time ?? null,
        params.remark ?? null,
        safeJsonb(params.raw_payload),
      ]
    );
    return rows[0];
  };
  return client ? run(client) : withClient(run);
}

export async function findByInstanceId(
  corp_id: string,
  process_instance_id: string
): Promise<DingApprovalTask[]> {
  return withClient(async (client) => {
    const { rows } = await client.query<DingApprovalTask>(
      `SELECT * FROM ding_approval_task
       WHERE corp_id = $1 AND process_instance_id = $2
       ORDER BY task_order NULLS LAST, created_at`,
      [corp_id, process_instance_id]
    );
    return rows;
  });
}

export async function findByTaskId(
  corp_id: string,
  process_instance_id: string,
  task_id: string
): Promise<DingApprovalTask | null> {
  return withClient(async (client) => {
    const { rows } = await client.query<DingApprovalTask>(
      `SELECT * FROM ding_approval_task
       WHERE corp_id = $1 AND process_instance_id = $2 AND task_id = $3`,
      [corp_id, process_instance_id, task_id]
    );
    return rows[0] ?? null;
  });
}
