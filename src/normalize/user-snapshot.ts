import crypto from 'crypto';
import { getUser } from '../dingtalk/api-client.js';
import { upsertSnapshot, recordFetchFailure } from '../db/queries/user-snapshot.js';
import type { UserInfo } from '../dingtalk/types.js';

// 内存 LRU 缓存（1 小时 TTL）
const userCache = new Map<string, { data: UserInfo; expiresAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 小时
const MAX_CACHE_SIZE = 10000;

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

/**
 * 处理用户快照
 * 1. 计算用户核心字段 hash
 * 2. 查 is_current=true 的记录
 * 3. hash 相同则跳过
 * 4. hash 不同则关闭旧快照并插入新行
 */
export async function processUserSnapshot(
  corp_id: string,
  user_id: string
): Promise<void> {
  try {
    // 检查缓存
    let userInfo = getCachedUser(corp_id, user_id);

    if (!userInfo) {
      // 调用钉钉 API 获取用户信息
      try {
        userInfo = await getUser(user_id);
        setCachedUser(corp_id, user_id, userInfo);
      } catch (error: any) {
        // 人员兜底：getUser 失败时记录失败状态，不阻断审批归档
        console.warn(`[UserSnapshot] 获取用户信息失败: ${user_id}`, error.message);

        await recordFetchFailure({
          corp_id,
          user_id,
          fetch_status: error.message.includes('not found') ? 'not_found' : 'failed',
          fetch_error: error.message,
        });
        return;
      }
    }

    // 计算 hash
    const snapshot_hash = computeUserHash(userInfo);

    // 插入或更新快照
    await upsertSnapshot({
      corp_id,
      user_id,
      name: userInfo.name,
      dept_id_list: userInfo.dept_id_list,
      title: userInfo.title,
      avatar: userInfo.avatar,
      snapshot_hash,
      raw_payload: userInfo,
    });
  } catch (error) {
    console.error(`[UserSnapshot] 处理用户快照失败: ${user_id}`, error);
    // 不抛出异常，避免阻断审批归档
  }
}
