import { withClient, withTransaction } from '../pool.js';
import type { DingApprovalInstance } from '../types.js';
import type pg from 'pg';
import { synchronizeInstanceAttachments } from './attachment-archive.js';

/**
 * 安全地将值转换为可写入 JSONB 列的格式
 * 先 JSON.stringify 再 JSON.parse 确保是纯数据对象（去掉函数、undefined 等）
 */
function safeJsonb(value: any): string | null {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}
export async function upsertInstance(params: {
  corp_id: string;
  process_instance_id: string;
  process_code: string;
  title?: string | null;
  status?: string | null;
  result?: string | null;
  originator_user_id?: string | null;
  originator_user_name?: string | null;
  originator_dept_id?: string | null;
  originator_dept_name?: string | null;
  create_time?: Date | null;
  finish_time?: Date | null;
  form_component_values?: any;
  raw_payload?: any;
  last_event_time?: Date | null;
}, client?: pg.PoolClient): Promise<DingApprovalInstance> {
  const run = async (c: pg.PoolClient) => {
    const { rows } = await c.query<DingApprovalInstance>(
      `INSERT INTO ding_approval_instance (
        corp_id, process_instance_id, process_code, title, status, result,
        originator_user_id, originator_user_name, originator_dept_id, originator_dept_name,
        create_time, finish_time, form_component_values, raw_payload, last_event_time
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT (corp_id, process_instance_id)
      DO UPDATE SET
        process_code = EXCLUDED.process_code,
        title = COALESCE(EXCLUDED.title, ding_approval_instance.title),
        status = COALESCE(EXCLUDED.status, ding_approval_instance.status),
        result = COALESCE(EXCLUDED.result, ding_approval_instance.result),
        originator_user_id = COALESCE(EXCLUDED.originator_user_id, ding_approval_instance.originator_user_id),
        originator_user_name = COALESCE(EXCLUDED.originator_user_name, ding_approval_instance.originator_user_name),
        originator_dept_id = COALESCE(EXCLUDED.originator_dept_id, ding_approval_instance.originator_dept_id),
        originator_dept_name = COALESCE(EXCLUDED.originator_dept_name, ding_approval_instance.originator_dept_name),
        create_time = COALESCE(EXCLUDED.create_time, ding_approval_instance.create_time),
        finish_time = COALESCE(EXCLUDED.finish_time, ding_approval_instance.finish_time),
        form_component_values = COALESCE(EXCLUDED.form_component_values, ding_approval_instance.form_component_values),
        raw_payload = COALESCE(EXCLUDED.raw_payload, ding_approval_instance.raw_payload),
        last_event_time = CASE
          WHEN ding_approval_instance.last_event_time IS NULL
            OR EXCLUDED.last_event_time > ding_approval_instance.last_event_time THEN EXCLUDED.last_event_time
          ELSE ding_approval_instance.last_event_time
        END,
        updated_at = now()
      RETURNING *`,
      [
        params.corp_id,
        params.process_instance_id,
        params.process_code,
        params.title ?? null,
        params.status ?? null,
        params.result ?? null,
        params.originator_user_id ?? null,
        params.originator_user_name ?? null,
        params.originator_dept_id ?? null,
        params.originator_dept_name ?? null,
        params.create_time ?? null,
        params.finish_time ?? null,
        safeJsonb(params.form_component_values),
        safeJsonb(params.raw_payload),
        params.last_event_time ?? null,
      ]
    );
    await synchronizeInstanceAttachments(params.corp_id, params.process_instance_id, c);
    return rows[0];
  };
  return client ? run(client) : withTransaction(run);
}

export async function findByCorpAndInstanceId(
  corp_id: string,
  process_instance_id: string
): Promise<DingApprovalInstance | null> {
  return withClient(async (client) => {
    const { rows } = await client.query<DingApprovalInstance>(
      `SELECT * FROM ding_approval_instance WHERE corp_id = $1 AND process_instance_id = $2`,
      [corp_id, process_instance_id]
    );
    return rows[0] ?? null;
  });
}

export async function findByProcessCode(
  corp_id: string,
  process_code: string,
  options?: { limit?: number; offset?: number }
): Promise<DingApprovalInstance[]> {
  return withClient(async (client) => {
    const { rows } = await client.query<DingApprovalInstance>(
      `SELECT * FROM ding_approval_instance
       WHERE corp_id = $1 AND process_code = $2
       ORDER BY create_time DESC
       LIMIT $3 OFFSET $4`,
      [corp_id, process_code, options?.limit ?? 100, options?.offset ?? 0]
    );
    return rows;
  });
}

/**
 * 返回最久未同步的审批中实例，供定时状态核对兜底使用。
 * 成功刷新后 last_event_time 会推进；源 updated_at 仅在内容变化时推进。
 */
export async function findRunningApprovalInstances(limit: number): Promise<DingApprovalInstance[]> {
  return withClient(async (client) => {
    const { rows } = await client.query<DingApprovalInstance>(
      `SELECT * FROM ding_approval_instance
       WHERE deleted_at IS NULL AND UPPER(COALESCE(status, '')) = 'RUNNING'
       ORDER BY COALESCE(last_event_time, updated_at) ASC, corp_id, process_instance_id
       LIMIT $1`,
      [limit]
    );
    return rows;
  });
}

export async function markAsDeleted(corp_id: string, process_instance_id: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE ding_approval_instance SET deleted_at = now(), updated_at = now()
       WHERE corp_id = $1 AND process_instance_id = $2`,
      [corp_id, process_instance_id]
    );
    await synchronizeInstanceAttachments(corp_id, process_instance_id, client);
  });
}

export async function countByProcessCode(corp_id: string, process_code: string): Promise<number> {
  return withClient(async (client) => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM ding_approval_instance
       WHERE corp_id = $1 AND process_code = $2 AND deleted_at IS NULL`,
      [corp_id, process_code]
    );
    return parseInt(rows[0].count, 10);
  });
}


export interface CompletedApprovalRefreshInstance extends DingApprovalInstance {
  refresh_generation: string;
}

/** Advance the durable rotation before the API call, including failed/crashed attempts. */
export async function claimCompletedApprovalRefresh(
  limit: number, minIntervalSeconds: number,
): Promise<CompletedApprovalRefreshInstance[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isFinite(minIntervalSeconds) || minIntervalSeconds < 0) {
    throw new Error('Invalid completed approval refresh limits');
  }
  return withTransaction(async (client) => {
    await client.query(`INSERT INTO costing_read.completed_approval_refresh(corp_id, process_instance_id)
      SELECT corp_id, process_instance_id FROM costing_read.eligible_attachment_instances
      WHERE UPPER(COALESCE(status, '')) = 'COMPLETED'
      ON CONFLICT (corp_id, process_instance_id) DO NOTHING`);
    const { rows } = await client.query<CompletedApprovalRefreshInstance>(`WITH picked AS (
      SELECT r.corp_id, r.process_instance_id
      FROM costing_read.completed_approval_refresh r
      JOIN costing_read.eligible_attachment_instances i USING (corp_id, process_instance_id)
      WHERE UPPER(COALESCE(i.status, '')) = 'COMPLETED'
        AND (r.lease_until IS NULL OR r.lease_until <= clock_timestamp())
        AND (r.last_checked_at IS NULL OR r.last_checked_at <= clock_timestamp() - $2 * interval '1 second')
      ORDER BY r.last_checked_at ASC NULLS FIRST, r.corp_id, r.process_instance_id
      FOR UPDATE OF r SKIP LOCKED LIMIT $1
    ), claimed AS (
      UPDATE costing_read.completed_approval_refresh r
      SET last_checked_at=clock_timestamp(), lease_until=clock_timestamp() + interval '15 minutes',
          lease_generation=r.lease_generation + 1
      FROM picked p WHERE r.corp_id=p.corp_id AND r.process_instance_id=p.process_instance_id
      RETURNING r.*
    )
    SELECT i.*, r.lease_generation AS refresh_generation
    FROM claimed r JOIN costing_read.eligible_attachment_instances i USING (corp_id, process_instance_id)
    ORDER BY r.last_checked_at, r.corp_id, r.process_instance_id`, [limit, minIntervalSeconds]);
    return rows;
  });
}

export async function finishCompletedApprovalRefresh(
  instance: Pick<CompletedApprovalRefreshInstance, 'corp_id' | 'process_instance_id' | 'refresh_generation'>,
  error?: unknown,
): Promise<void> {
  const message = error === undefined ? null : error instanceof Error ? error.message : String(error);
  await withClient(async (client) => {
    await client.query(`UPDATE costing_read.completed_approval_refresh
      SET lease_until=NULL, last_error=$4,
          last_success_at=CASE WHEN $4::text IS NULL THEN clock_timestamp() ELSE last_success_at END
      WHERE corp_id=$1 AND process_instance_id=$2 AND lease_generation=$3`,
    [instance.corp_id, instance.process_instance_id, instance.refresh_generation, message?.slice(0, 4000) ?? null]);
  });
}
