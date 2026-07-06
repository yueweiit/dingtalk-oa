import { withClient, withTransaction } from '../pool.js';
import type { DingProcessTemplate } from '../types.js';

export async function upsertProcessTemplate(params: {
  corp_id: string;
  process_code: string;
  name?: string | null;
  enabled?: boolean;
}): Promise<DingProcessTemplate> {
  return withClient(async (client) => {
    const { rows } = await client.query<DingProcessTemplate>(
      `INSERT INTO ding_process_template (corp_id, process_code, name, enabled)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (corp_id, process_code)
       DO UPDATE SET
         name = COALESCE(EXCLUDED.name, ding_process_template.name),
         updated_at = now()
       RETURNING *`,
      [params.corp_id, params.process_code, params.name ?? null, params.enabled ?? true]
    );
    return rows[0];
  });
}

export async function findByCorpAndProcessCode(
  corp_id: string,
  process_code: string
): Promise<DingProcessTemplate | null> {
  return withClient(async (client) => {
    const { rows } = await client.query<DingProcessTemplate>(
      `SELECT * FROM ding_process_template WHERE corp_id = $1 AND process_code = $2`,
      [corp_id, process_code]
    );
    return rows[0] ?? null;
  });
}

export async function findEnabledTemplates(corp_id: string): Promise<DingProcessTemplate[]> {
  return withClient(async (client) => {
    const { rows } = await client.query<DingProcessTemplate>(
      `SELECT * FROM ding_process_template WHERE corp_id = $1 AND enabled = true AND is_deleted = false ORDER BY process_code`,
      [corp_id]
    );
    return rows;
  });
}

export async function markAsDeleted(corp_id: string, process_code: string): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      `UPDATE ding_process_template SET is_deleted = true, updated_at = now() WHERE corp_id = $1 AND process_code = $2`,
      [corp_id, process_code]
    );
  });
}

export async function updateLastSyncAt(corp_id: string, process_code: string): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      `UPDATE ding_process_template SET last_sync_at = now(), updated_at = now() WHERE corp_id = $1 AND process_code = $2`,
      [corp_id, process_code]
    );
  });
}

export async function updateTemplateName(
  corp_id: string,
  process_code: string,
  name: string
): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      `UPDATE ding_process_template SET name = $3, updated_at = now() WHERE corp_id = $1 AND process_code = $2`,
      [corp_id, process_code, name]
    );
  });
}

export async function findAllTemplates(corp_id: string): Promise<DingProcessTemplate[]> {
  return withClient(async (client) => {
    const { rows } = await client.query<DingProcessTemplate>(
      `SELECT * FROM ding_process_template WHERE corp_id = $1 ORDER BY process_code`,
      [corp_id]
    );
    return rows;
  });
}
