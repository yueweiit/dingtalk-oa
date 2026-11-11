import crypto from 'crypto';
import { getUser } from '../dingtalk/api-client.js';
import { upsertSnapshot, recordFetchFailure } from '../db/queries/user-snapshot.js';
import type { UserInfo } from '../dingtalk/types.js';

// 内存 LRU 缓存（1 小时 TTL）
const userCache = new Map<string, { data: UserInfo; expiresAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 小时
const MAX_CACHE_SIZE = 10000;
const pendingUsers = new Map<string, Promise<void>>();
const waitingUsers: Array<() => void> = [];
let activeUsers = 0;

const UNION_ID_KEYS = ['union_id', 'unionId', 'unionid'] as const;

/** 从钉钉用户响应中提取 unionId，兼容不同 API/历史 payload 命名。 */
export function extractUserUnionId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  for (const key of UNION_ID_KEYS) {
    const value = record[key];
    if (value == null) continue;
    const unionId = String(value).trim();
    if (unionId) return unionId;
  }
  return null;
}

function getCachedUser(corp_id: string, user_id: string): UserInfo | null {
  const key = `${corp_id}:${user_id}`;
  const cached = userCache.get(key);

  if (cached && Date.now() < cached.expiresAt) {
    // LRU: 访问时删除再重新插入，将条目移到 Map 末尾
    userCache.delete(key);
    userCache.set(key, cached);
    return cached.data;
  }

  if (cached) {
    userCache.delete(key);
  }

  return null;
}

function setCachedUser(corp_id: string, user_id: string, data: UserInfo): void {
  const key = `${corp_id}:${user_id}`;

  // LRU：如果缓存满了，删除最久未访问的条目（Map 迭代顺序中最早的）
  if (userCache.size >= MAX_CACHE_SIZE) {
    const firstKey = userCache.keys().next().value;
    if (firstKey) {
      userCache.delete(firstKey);
    }
  }

  userCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * 计算用户核心字段的 hash
 */
export function computeUserHash(user: UserInfo): string {
  const hashInput = JSON.stringify({
    name: user.name || '',
    dept_id_list: user.dept_id_list || [],
    title: user.title || '',
    avatar: user.avatar || '',
  });

  return crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 64);
}

export function classifyUserFetchFailure(error: unknown): { fetch_status: 'not_found' | 'failed'; fetch_error: string } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    fetch_status: /not\s+(?:be\s+)?found/i.test(message) ? 'not_found' : 'failed',
    fetch_error: message,
  };
}

/**
 * 处理用户快照
 * 1. 计算用户核心字段 hash
 * 2. 查 is_current=true 的记录
 * 3. hash 相同则跳过
 * 4. hash 不同则关闭旧快照并插入新行
 */
async function saveUserSnapshot(
  corp_id: string,
  user_id: string
): Promise<void> {
  try {
    // 检查缓存
    const cached = getCachedUser(corp_id, user_id);
    // 缓存命中意味着该响应已成功落库，不重放旧资料覆盖其他进程较新的成功快照。
    if (cached) return;
    let userInfo: UserInfo;

    // 调用钉钉 API 获取用户信息
    try {
      userInfo = await getUser(user_id);
    } catch (error: unknown) {
      // 人员兜底：getUser 失败时只记录失败历史，不阻断审批归档。
      const failure = classifyUserFetchFailure(error);
      console.warn(`[UserSnapshot] 获取用户信息失败: ${user_id}`, failure.fetch_error);
      await recordFetchFailure({ corp_id, user_id, ...failure });
      return;
    }

    // 计算 hash
    const snapshot_hash = computeUserHash(userInfo);

    // 插入或更新快照
    await upsertSnapshot({
      corp_id,
      user_id,
      union_id: extractUserUnionId(userInfo),
      name: userInfo.name,
      dept_id_list: userInfo.dept_id_list,
      title: userInfo.title,
      avatar: userInfo.avatar,
      snapshot_hash,
      raw_payload: userInfo,
    });
    // 数据库写入失败不能建立缓存，否则后续事件将无法及时重试保存。
    setCachedUser(corp_id, user_id, userInfo);
  } catch (error) {
    console.error(`[UserSnapshot] 处理用户快照失败: ${user_id}`, error);
    // 不抛出异常，避免阻断审批归档
  }
}

/** 同用户并发请求合并，全进程最多两个用户 API 请求，避免审批节点补全放大调用量。 */
export function processUserSnapshot(corpId: string, userId: string): Promise<void> {
  const key = `${corpId}:${userId}`;
  const pending = pendingUsers.get(key);
  if (pending) return pending;
  if (getCachedUser(corpId, userId)) return Promise.resolve();
  if (pendingUsers.size >= MAX_CACHE_SIZE) {
    console.warn('[UserSnapshot] USER_SNAPSHOT_QUEUE_FULL');
    return Promise.resolve();
  }
  const work = (async () => {
    if (activeUsers < 2) activeUsers++;
    else await new Promise<void>(resolve => waitingUsers.push(resolve));
    try { await saveUserSnapshot(corpId, userId); }
    finally {
      const next = waitingUsers.shift();
      if (next) next(); else activeUsers--;
    }
  })().finally(() => { pendingUsers.delete(key); });
  pendingUsers.set(key, work);
  return work;
}
