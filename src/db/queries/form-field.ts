import { withClient } from '../pool.js';
import type { DingFormField } from '../types.js';
import type pg from 'pg';

function safeJsonb(value: any): string | null {
  if (value == null) return null;
  try { return JSON.stringify(value); } catch { return null; }
}

export async function upsertFormField(params: {
  corp_id: string;
  process_code: string;
  field_id: string;
  field_name?: string | null;
  field_type?: string | null;
  raw_payload?: any;
}, client?: pg.PoolClient): Promise<DingFormField> {
  const run = async (c: pg.PoolClient) => {
    const { rows } = await c.query<DingFormField>(
      `INSERT INTO ding_form_field (corp_id, process_code, field_id, field_name, field_type, raw_payload)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (corp_id, process_code, field_id)
       DO UPDATE SET
         field_name = COALESCE(EXCLUDED.field_name, ding_form_field.field_name),
         field_type = COALESCE(EXCLUDED.field_type, ding_form_field.field_type),
         raw_payload = COALESCE(EXCLUDED.raw_payload, ding_form_field.raw_payload),
         updated_at = now()
       RETURNING *`,
      [
        params.corp_id,
        params.process_code,
        params.field_id,
        params.field_name ?? null,
        params.field_type ?? null,
        safeJsonb(params.raw_payload),
      ]
    );
    return rows[0];
  };
  return client ? run(client) : withClient(run);
}

export async function findByProcessCode(
  corp_id: string,
  process_code: string
): Promise<DingFormField[]> {
  return withClient(async (client) => {
    const { rows } = await client.query<DingFormField>(
      `SELECT * FROM ding_form_field
       WHERE corp_id = $1 AND process_code = $2 AND is_deleted = false
       ORDER BY field_id`,
      [corp_id, process_code]
    );
    return rows;
  });
}

export async function markAsDeleted(
  corp_id: string,
  process_code: string,
  field_id: string
): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      `UPDATE ding_form_field SET is_deleted = true, updated_at = now()
       WHERE corp_id = $1 AND process_code = $2 AND field_id = $3`,
      [corp_id, process_code, field_id]
    );
  });
}
