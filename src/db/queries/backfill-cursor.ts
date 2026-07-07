import { withClient } from '../pool.js';
import type { BackfillCursor } from '../types.js';

export async function createCursor(params: {
  corp_id: string;
  process_code: string;
  window_start: Date;
  window_end: Date;
}): Promise<BackfillCursor> {
  return withClient(async (client) => {
    const { rows } = await client.query<BackfillCursor>(
      `INSERT INTO backfill_cursor (corp_id, process_code, window_start, window_end, status)
       VALUES ($1, $2, $3, $4, 'running')
       ON CONFLICT (corp_id, process_code, window_start, window_end)
       DO UPDATE SET status = 'running', error_message = NULL, finished_at = NULL,
                     cursor_offset = 0, processed_count = 0, created_at = now()
       RETURNING *`,
      [params.corp_id, params.process_code, params.window_start, params.window_end]
    );
    return rows[0];
  });
}

export async function updateCursor(params: {
  id: bigint;
  status?: string;
  cursor_offset?: number;
  processed_count?: number;
  finished_at?: Date;
  error_message?: string;
}): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      `UPDATE backfill_cursor SET
        status = COALESCE($2, status),
        cursor_offset = COALESCE($3, cursor_offset),
        processed_count = COALESCE($4, processed_count),
        finished_at = COALESCE($5, finished_at),
        error_message = COALESCE($6, error_message)
       WHERE id = $1`,
      [
        params.id,
        params.status ?? null,
        params.cursor_offset ?? null,
        params.processed_count ?? null,
        params.finished_at ?? null,
        params.error_message ?? null,
      ]
    );
  });
}

const STALE_CURSOR_TIMEOUT_HOURS = 24;

export async function findRunningCursor(
  corp_id: string,
  process_code: string
): Promise<BackfillCursor | null> {
  return withClient(async (client) => {
    // 查找仍在运行且未超时的游标
    const { rows } = await client.query<BackfillCursor>(
      `SELECT * FROM backfill_cursor
       WHERE corp_id = $1 AND process_code = $2 AND status = 'running'
         AND created_at > now() - INTERVAL '1 hour' * $3
       ORDER BY created_at DESC
       LIMIT 1`,
      [corp_id, process_code, STALE_CURSOR_TIMEOUT_HOURS]
    );

    if (rows.length > 0) {
      return rows[0];
    }

    // 将超时的 running 游标标记为 failed（进程崩溃恢复）
    await client.query(
      `UPDATE backfill_cursor
       SET status = 'failed',
           finished_at = now(),
           error_message = '进程崩溃或超时，自动标记为失败'
       WHERE corp_id = $1 AND process_code = $2 AND status = 'running'
         AND created_at <= now() - INTERVAL '1 hour' * $3`,
      [corp_id, process_code, STALE_CURSOR_TIMEOUT_HOURS]
    );

    return null;
  });
}

export async function findCursorByWindow(
  corp_id: string,
  process_code: string,
  window_start: Date,
  window_end: Date
): Promise<BackfillCursor | null> {
  return withClient(async (client) => {
    const { rows } = await client.query<BackfillCursor>(
      `SELECT * FROM backfill_cursor
       WHERE corp_id = $1 AND process_code = $2 AND window_start = $3 AND window_end = $4`,
      [corp_id, process_code, window_start, window_end]
    );
    return rows[0] ?? null;
  });
}

export async function getCursorsByProcessCode(
  corp_id: string,
  process_code: string,
  limit = 50
): Promise<BackfillCursor[]> {
  return withClient(async (client) => {
    const { rows } = await client.query<BackfillCursor>(
      `SELECT * FROM backfill_cursor
       WHERE corp_id = $1 AND process_code = $2
       ORDER BY window_start DESC
       LIMIT $3`,
      [corp_id, process_code, limit]
    );
    return rows;
  });
}
