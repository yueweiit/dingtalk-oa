import { withClient, withTransaction } from '../pool.js';
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
       WHERE corp_id = $1 AND user_id = $2 AND is_current = true AND fetch_status = 'success'
       ORDER BY valid_from DESC, id DESC
       LIMIT 1`,
      [corp_id, user_id]
    );
    return rows[0] ?? null;
  };
  return client ? run(client) : withClient(run);
}

/** 批量查询同企业、指定账号的当前成功姓名。 */
export async function findCurrentSnapshotNames(
  corpId: string, userIds: string[],
): Promise<Array<{ userId: string; name: string }>> {
  if (!userIds.length) return [];
  return withClient(async client => (await client.query<{ userId: string; name: string }>(
    `SELECT user_id AS "userId", BTRIM(name) AS name
     FROM ding_user_snapshot
     WHERE corp_id = $1 AND is_current = true AND fetch_status = 'success'
       AND NULLIF(BTRIM(name), '') IS NOT NULL AND LOWER(BTRIM(name)) <> 'unknown'
       AND user_id = ANY($2::varchar[])`,
    [corpId, userIds],
  )).rows);
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
}, client?: pg.PoolClient): Promise<{ inserted: boolean; snapshot: DingUserSnapshot; unionIdUpdated?: boolean }> {
  if (params.fetch_status !== undefined && params.fetch_status !== 'success') {
    throw new Error('USER_SNAPSHOT_REQUIRES_SUCCESS');
  }
  const run = async (c: pg.PoolClient) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [params.corp_id, params.user_id]);

    // 检查当前快照是否相同
    const current = await getCurrentSnapshot(params.corp_id, params.user_id, c);
    const unionId = normalizeUnionId(params.union_id) ?? extractUnionId(params.raw_payload) ?? current?.union_id ?? null;

    if (current && current.snapshot_hash === params.snapshot_hash) {
      // unionId 可能是在旧快照中缺失，或 API 返回了新的命名形式；同步时补齐当前记录。
      if (unionId && current.union_id !== unionId) {
        const { rows } = await c.query<DingUserSnapshot>(
          `UPDATE ding_user_snapshot
           SET union_id = $2, raw_payload = COALESCE($3, raw_payload), updated_at = clock_timestamp()
           WHERE id = $1
           RETURNING *`,
          [current.id, unionId, safeJsonb(params.raw_payload)]
        );
        return { inserted: false, snapshot: rows[0], unionIdUpdated: true };
      }
      return { inserted: false, snapshot: current };
    }

    // 锁等待可能跨越事务开始时间；以取得锁后的同一切换时刻关闭/开启版本。
    const { rows: times } = await c.query<{ changed_at: string }>('SELECT clock_timestamp()::text AS changed_at');
    const changedAt = times[0].changed_at;
    // 关闭旧成功快照，失败记录不会参与此版本链。
    if (current) {
      await c.query(
        `UPDATE ding_user_snapshot
         SET valid_to = $2::timestamptz, is_current = false, updated_at = clock_timestamp()
         WHERE id = $1`,
        [current.id, changedAt]
      );
    }

    // 插入新快照
    const { rows } = await c.query<DingUserSnapshot>(
      `INSERT INTO ding_user_snapshot (
        corp_id, user_id, union_id, name, dept_id_list, title, avatar,
        snapshot_hash, fetch_status, fetch_error, raw_payload, valid_from, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, clock_timestamp())
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
        'success',
        null,
        safeJsonb(params.raw_payload),
        changedAt,
      ]
    );

    return { inserted: true, snapshot: rows[0] };
  };
  // 传入 client 的调用方负责已开启事务；默认入口始终包裹完整事务。
  return client ? run(client) : withTransaction(run);
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
  if (!params.fetch_status || params.fetch_status === 'success') throw new Error('USER_FETCH_FAILURE_STATUS_INVALID');
  await withTransaction(async (client) => {
    // 与成功快照使用相同用户锁；重复失败合并计数，错误变化保留独立历史。
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [params.corp_id, params.user_id]
    );

    const { rows } = await client.query<{
      id: string;
      fetch_status: string | null;
      fetch_error: string | null;
    }>(
      `SELECT id, fetch_status, fetch_error
         FROM ding_user_fetch_failure
        WHERE corp_id = $1 AND user_id = $2
        ORDER BY last_failed_at DESC, id DESC
        LIMIT 1
        FOR UPDATE`,
      [params.corp_id, params.user_id]
    );
    const current = rows[0];

    // 相同的最近错误只增加次数；失败日志不是当前用户资料状态。
    if (
      current &&
      current.fetch_status === params.fetch_status &&
      current.fetch_error === params.fetch_error
    ) {
      await client.query(
        `UPDATE ding_user_fetch_failure
         SET failure_count = failure_count + 1, last_failed_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE id = $1`,
        [current.id]
      );
      return;
    }

    await client.query(
      `INSERT INTO ding_user_fetch_failure (corp_id, user_id, fetch_status, fetch_error)
       VALUES ($1, $2, $3, $4)`,
      [
        params.corp_id,
        params.user_id,
        params.fetch_status,
        params.fetch_error,
      ]
    );
  });
}
