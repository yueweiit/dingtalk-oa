import type pg from 'pg';
import { withClient, withTransaction } from '../pool.js';
import type { JsonValue } from '../json-types.js';

export interface DingEventOutbox {
  id: bigint;
  corp_id: string;
  event_id: string;
  event_key: string;
  topic: string;
  event_type: string;
  source: string;
  process_instance_id: string | null;
  process_code: string | null;
  payload: JsonValue;
  status: string;
  attempt_count: number;
  next_attempt_at: Date;
  last_error: string | null;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface EnqueueOutboxEventParams {
  corp_id: string;
  event_id: string;
  event_key: string;
  topic: string;
  event_type: string;
  source: string;
  process_instance_id?: string | null;
  process_code?: string | null;
  payload: JsonValue;
}

export async function enqueueOutboxEvent(
  params: EnqueueOutboxEventParams,
  client?: pg.PoolClient
): Promise<{ event: DingEventOutbox; isDuplicate: boolean }> {
  const run = async (c: pg.PoolClient) => {
    const { rows } = await c.query<DingEventOutbox>(
      `INSERT INTO ding_event_outbox (
         corp_id, event_id, event_key, topic, event_type, source,
         process_instance_id, process_code, payload
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (corp_id, event_id) DO NOTHING
       RETURNING *`,
      [
        params.corp_id,
        params.event_id,
        params.event_key,
        params.topic,
        params.event_type,
        params.source,
        params.process_instance_id ?? null,
        params.process_code ?? null,
        params.payload,
      ]
    );

    if (rows.length > 0) return { event: rows[0], isDuplicate: false };

    const { rows: existing } = await c.query<DingEventOutbox>(
      `SELECT * FROM ding_event_outbox WHERE corp_id = $1 AND event_id = $2`,
      [params.corp_id, params.event_id]
    );
    if (!existing[0]) throw new Error(`Outbox event not found after duplicate insert: ${params.event_id}`);
    return { event: existing[0], isDuplicate: true };
  };

  return client ? run(client) : withClient(run);
}

export async function claimPendingOutboxEvents(limit = 100): Promise<DingEventOutbox[]> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<DingEventOutbox>(
      `WITH candidates AS (
         SELECT id
         FROM ding_event_outbox
         WHERE (
           status = 'pending' AND next_attempt_at <= now()
         ) OR (
           status = 'publishing' AND updated_at < now() - INTERVAL '1 minute'
         )
         ORDER BY id ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE ding_event_outbox AS outbox
       SET status = 'publishing', updated_at = now()
       FROM candidates
       WHERE outbox.id = candidates.id
       RETURNING outbox.*`,
      [limit]
    );
    return rows;
  });
}

export async function markOutboxPublished(id: bigint): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      `UPDATE ding_event_outbox
       SET status = 'published', published_at = now(), updated_at = now(), last_error = NULL
       WHERE id = $1`,
      [id]
    );
  });
}

export async function markOutboxFailed(id: bigint, error: string): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      `UPDATE ding_event_outbox
       SET status = 'pending',
           next_attempt_at = now() + (LEAST(300, GREATEST(2, power(2, LEAST(attempt_count + 1, 8)))) * INTERVAL '1 second'),
           attempt_count = attempt_count + 1,
           last_error = $2,
           updated_at = now()
       WHERE id = $1`,
      [id, error.slice(0, 2000)]
    );
  });
}

export async function getOutboxStats(): Promise<Record<string, number>> {
  return withClient(async (client) => {
    const { rows } = await client.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::text AS count FROM ding_event_outbox GROUP BY status`
    );
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
  });
}
