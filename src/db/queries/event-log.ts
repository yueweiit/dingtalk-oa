import { withClient } from '../pool.js';
import type { DingEventLog } from '../types.js';

export async function insertEvent(params: {
  corp_id: string;
  event_id?: string | null;
  event_type: string;
  source: string;
  process_instance_id?: string | null;
  process_code?: string | null;
  raw_event?: any;
}): Promise<{ event: DingEventLog; isDuplicate: boolean }> {
  return withClient(async (client) => {
    const { rows } = await client.query<DingEventLog>(
      `INSERT INTO ding_event_log (corp_id, event_id, event_type, source, process_instance_id, process_code, raw_event)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (corp_id, event_id) WHERE event_id IS NOT NULL DO NOTHING
       RETURNING *`,
      [
        params.corp_id,
        params.event_id ?? null,
        params.event_type,
        params.source,
        params.process_instance_id ?? null,
        params.process_code ?? null,
        params.raw_event ?? null,
      ]
    );

    if (rows.length > 0) {
      return { event: rows[0], isDuplicate: false };
    }

    // 冲突：查询已有记录
    const { rows: existing } = await client.query<DingEventLog>(
      `SELECT * FROM ding_event_log WHERE corp_id = $1 AND event_id = $2`,
      [params.corp_id, params.event_id]
    );
    return { event: existing[0], isDuplicate: true };
  });
}

export async function updateEventStatus(params: {
  id: bigint;
  status: string;
  processed_at?: Date;
  duration_ms?: number;
  error_message?: string;
  retry_count?: number;
}): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      `UPDATE ding_event_log SET
        status = $2,
        processed_at = COALESCE($3, processed_at),
        duration_ms = COALESCE($4, duration_ms),
        error_message = COALESCE($5, error_message),
        retry_count = COALESCE($6, retry_count)
       WHERE id = $1`,
      [
        params.id,
        params.status,
        params.processed_at ?? null,
        params.duration_ms ?? null,
        params.error_message ?? null,
        params.retry_count ?? null,
      ]
    );
  });
}

export async function findPendingEvents(limit = 100): Promise<DingEventLog[]> {
  return withClient(async (client) => {
    const { rows } = await client.query<DingEventLog>(
      `SELECT * FROM ding_event_log
       WHERE status = 'pending'
       ORDER BY received_at ASC
       LIMIT $1`,
      [limit]
    );
    return rows;
  });
}

export async function findFailedEvents(limit = 100): Promise<DingEventLog[]> {
  return withClient(async (client) => {
    const { rows } = await client.query<DingEventLog>(
      `SELECT * FROM ding_event_log
       WHERE status = 'failed'
       ORDER BY received_at DESC
       LIMIT $1`,
      [limit]
    );
    return rows;
  });
}

export async function cleanupOldEvents(retentionDays = 90): Promise<number> {
  return withClient(async (client) => {
    const { rowCount } = await client.query(
      `DELETE FROM ding_event_log
       WHERE received_at < now() - INTERVAL '1 day' * $1
         AND status = 'success'`,
      [retentionDays]
    );
    return rowCount ?? 0;
  });
}

export async function getEventStats(corp_id: string): Promise<{
  pending: number;
  processing: number;
  success: number;
  failed: number;
}> {
  return withClient(async (client) => {
    const { rows } = await client.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*) as count
       FROM ding_event_log
       WHERE corp_id = $1
       GROUP BY status`,
      [corp_id]
    );

    const stats = { pending: 0, processing: 0, success: 0, failed: 0 };
    for (const row of rows) {
      const count = parseInt(row.count, 10);
      if (row.status in stats) {
        stats[row.status as keyof typeof stats] = count;
      }
    }
    return stats;
  });
}
