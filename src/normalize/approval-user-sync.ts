import { processUserSnapshot } from './user-snapshot.js';
import { repairApprovalMetadata } from '../db/queries/approval-enrichment.js';
import { withTransaction } from '../db/pool.js';

/** 网络请求始终在审批事务外，资料获取失败仍可使用最后成功资料补全。 */
export async function syncApprovalUsers(corpId: string, instanceId: string, userIds: string[]): Promise<void> {
  const results = await Promise.allSettled([...new Set(userIds.filter(Boolean))].map(userId => processUserSnapshot(corpId, userId)));
  if (results.some(result => result.status === 'rejected')) console.warn('[ApprovalMetadata] APPROVAL_USER_PROFILE_SYNC_FAILED');
  await withTransaction(client => repairApprovalMetadata(client, corpId, [instanceId]));
}
