import { withClient } from '../pool.js';

// 用于存储 corp_id 的配置表
export async function ensureCorpConfigTable(): Promise<void> {
  await withClient(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ding_corp_config (
        id BIGSERIAL PRIMARY KEY,
        corp_id VARCHAR(64) NOT NULL UNIQUE,
        corp_name VARCHAR(256),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      )
    `);
  });
}

export async function getActiveCorpId(): Promise<string | null> {
  return withClient(async (client) => {
    const { rows } = await client.query<{ corp_id: string }>(
      `SELECT corp_id FROM ding_corp_config WHERE is_active = true ORDER BY created_at DESC LIMIT 1`
    );
    return rows[0]?.corp_id ?? null;
  });
}

export async function saveCorpId(corp_id: string, corp_name?: string): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO ding_corp_config (corp_id, corp_name)
       VALUES ($1, $2)
       ON CONFLICT (corp_id) DO UPDATE SET
         corp_name = COALESCE(EXCLUDED.corp_name, ding_corp_config.corp_name),
         is_active = true,
         updated_at = now()`,
      [corp_id, corp_name ?? null]
    );
  });
}

export async function getAllCorpIds(): Promise<{ corp_id: string; corp_name: string | null }[]> {
  return withClient(async (client) => {
    const { rows } = await client.query<{ corp_id: string; corp_name: string | null }>(
      `SELECT corp_id, corp_name FROM ding_corp_config WHERE is_active = true ORDER BY created_at`
    );
    return rows;
  });
}
