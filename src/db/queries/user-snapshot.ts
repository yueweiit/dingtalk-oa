import { withClient } from '../pool.js';
import type { DingUserSnapshot } from '../types.js';
import type pg from 'pg';

const UNION_ID_KEYS = ['union_id', 'unionId', 'unionid'] as const;

function normalizeUnionId(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function extractUnionId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  for (const key of UNION_ID_KEYS) {
    const unionId = normalizeUnionId(record[key]);
    if (unionId) return unionId;
  }
  return null;
}

function safeJsonb(value: any): string | null {
  if (value == null) return null;
  try { return JSON.stringify(value); } catch { return null; }
}

export async function getCurrentSnapshot(
  corp_id: string,
  user_id: string,
  client?: pg.PoolClient
): Promise<DingUserSnapshot | null> {
  const run = async (c: pg.PoolClient) => {
    const { rows } = await c.query<DingUserSnapshot>(
      `SELECT id, corp_id, user_id,
              COALESCE(
                NULLIF(union_id, ''),
                NULLIF(raw_payload->>'union_id', ''),
                NULLIF(raw_payload->>'unionId', ''),
                NULLIF(raw_payload->>'unionid', '')
              ) AS union_id,
              name, dept_id_list, title, avatar,
              snapshot_hash, valid_from, valid_to, is_current, fetch_status,
              fetch_error, raw_payload, updated_at
         FROM ding_user_snapshot
       WHERE corp_id = $1 AND user_id = $2 AND is_current = true
       LIMIT 1`,
      [corp_id, user_id]
    );
    return rows[0] ?? null;
  };
  return client ? run(client) : withClient(run);
}

export async function upsertSnapshot(params: {
  corp_id: string;
  user_id: string;
  union_id?: string | null;
  name?: string | null;
  dept_id_list?: any;
  title?: string | null;
  avatar?: string | null;
  snapshot_hash: string;
  fetch_status?: string;
  fetch_error?: string | null;
  raw_payload?: any;
}, client?: pg.PoolClient): Promise<{ inserted: boolean; snapshot: DingUserSnapshot }> {
  const run = async (c: pg.PoolClient) => {
    const unionId = normalizeUnionId(params.union_id) ?? extractUnionId(params.raw_payload);

    // 检查当前快照是否相同
    const current = await getCurrentSnapshot(params.corp_id, params.user_id, c);

    if (current && current.snapshot_hash === params.snapshot_hash) {
      // unionId 可能是在旧快照中缺失，或 API 返回了新的命名形式；同步时补齐当前记录。
      if (unionId && current.union_id !== unionId) {
        const { rows } = await c.query<DingUserSnapshot>(
          `UPDATE ding_user_snapshot
           SET union_id = $2, raw_payload = COALESCE($3, raw_payload), updated_at = now()
           WHERE id = $1
           RETURNING *`,
          [current.id, unionId, safeJsonb(params.raw_payload)]
        );
        return { inserted: false, snapshot: rows[0] };
      }
      return { inserted: false, snapshot: current };
    }

    // 关闭旧快照
    if (current) {
      await c.query(
        `UPDATE ding_user_snapshot
         SET valid_to = now(), is_current = false, updated_at = now()
         WHERE id = $1`,
        [current.id]
      );
    }

    // 插入新快照
    const { rows } = await c.query<DingUserSnapshot>(
      `INSERT INTO ding_user_snapshot (
        corp_id, user_id, union_id, name, dept_id_list, title, avatar,
        snapshot_hash, fetch_status, fetch_error, raw_payload
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *`,
      [
        params.corp_id,
        params.user_id,
        unionId,
        params.name ?? null,
        safeJsonb(params.dept_id_list),
        params.title ?? null,
        params.avatar ?? null,
        params.snapshot_hash,
        params.fetch_status ?? 'success',
        params.fetch_error ?? null,
        safeJsonb(params.raw_payload),
      ]
    );

    return { inserted: true, snapshot: rows[0] };
  };
  return client ? run(client) : withClient(run);
}

export async function findAnyUserId(): Promise<string | null> {
  return withClient(async (client) => {
    const { rows } = await client.query<{ user_id: string }>(
      `SELECT user_id FROM ding_user_snapshot
       WHERE fetch_status = 'success'
       LIMIT 1`
    );
    return rows[0]?.user_id ?? null;
  });
}

export async function recordFetchFailure(params: {
  corp_id: string;
  user_id: string;
  fetch_status: string;
  fetch_error: string;
}): Promise<void> {
  await withClient(async (client) => {
    // 关闭可能存在的当前快照
    await client.query(
      `UPDATE ding_user_snapshot
       SET valid_to = now(), is_current = false, updated_at = now()
       WHERE corp_id = $1 AND user_id = $2 AND is_current = true`,
      [params.corp_id, params.user_id]
    );

    // 插入失败记录
    await client.query(
      `INSERT INTO ding_user_snapshot (
        corp_id, user_id, name, snapshot_hash, fetch_status, fetch_error, is_current
      ) VALUES ($1, $2, 'unknown', $3, $4, $5, true)`,
      [
        params.corp_id,
        params.user_id,
        `failed_${Date.now()}`,
        params.fetch_status,
        params.fetch_error,
      ]
    );
  });
}
