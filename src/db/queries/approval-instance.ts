import { withClient } from '../pool.js';
import type { DingApprovalInstance } from '../types.js';
import type pg from 'pg';

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
          WHEN EXCLUDED.last_event_time > ding_approval_instance.last_event_time THEN EXCLUDED.last_event_time
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
    return rows[0];
  };
  return client ? run(client) : withClient(run);
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

export async function markAsDeleted(corp_id: string, process_instance_id: string): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      `UPDATE ding_approval_instance SET deleted_at = now(), updated_at = now()
       WHERE corp_id = $1 AND process_instance_id = $2`,
      [corp_id, process_instance_id]
    );
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

export async function findAnyOriginatorUserId(): Promise<string | null> {
  return withClient(async (client) => {
    // 优先从审批实例取（该用户肯定有 OA 权限）
    const { rows } = await client.query<{ originator_user_id: string }>(
      `SELECT originator_user_id FROM ding_approval_instance
       WHERE originator_user_id IS NOT NULL AND originator_user_id != ''
       LIMIT 1`
    );
    if (rows[0]?.originator_user_id) return rows[0].originator_user_id;

    // 兜底：从用户快照取
    const { rows: userRows } = await client.query<{ user_id: string }>(
      `SELECT user_id FROM ding_user_snapshot
       WHERE fetch_status = 'success'
       LIMIT 1`
    );
    return userRows[0]?.user_id ?? null;
  });
}
