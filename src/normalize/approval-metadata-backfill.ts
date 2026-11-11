import { withClient, withTransaction } from '../db/pool.js';
import { repairApprovalMetadata } from '../db/queries/approval-enrichment.js';

/** 仅使用本地数据；按稳定实例 ID 分批扫描，无法补齐的行也会推进游标。 */
export async function backfillApprovalMetadata(corpId: string, options: {
  dryRun?: boolean; instanceId?: string; batchSize?: number;
} = {}): Promise<{ scanned: number; instances: number; tasks: number; dryRun: boolean }> {
  const batchSize = options.batchSize ?? 100;
  if (!corpId.trim() || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 200) {
    throw new Error('APPROVAL_METADATA_SCOPE_INVALID');
  }
  const dryRun = options.dryRun ?? true;
  const result = { scanned: 0, instances: 0, tasks: 0, dryRun };
  let cursor = '';
  while (true) {
    const rows = await withClient(async client => (await client.query<{ process_instance_id: string }>(
      `SELECT process_instance_id FROM ding_approval_instance
       WHERE corp_id=$1 AND deleted_at IS NULL AND process_instance_id>$2
         AND ($3::text IS NULL OR process_instance_id=$3)
       ORDER BY process_instance_id LIMIT $4`, [corpId, cursor, options.instanceId ?? null, batchSize],
    )).rows);
    if (!rows.length) break;
    const ids = rows.map(row => row.process_instance_id);
    const run = (client: import('pg').PoolClient) => repairApprovalMetadata(client, corpId, ids, dryRun);
    const updated = await (dryRun ? withClient(run) : withTransaction(run));
    result.scanned += ids.length;
    result.instances += updated.instances;
    result.tasks += updated.tasks;
    cursor = ids[ids.length - 1];
  }
  return result;
}
