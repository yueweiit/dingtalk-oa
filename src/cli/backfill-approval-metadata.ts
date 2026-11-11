import { parseArgs } from 'node:util';
import { getConfig } from '../config/index.js';
import { closePool } from '../db/pool.js';
import { backfillApprovalMetadata } from '../normalize/approval-metadata-backfill.js';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    'corp-id': { type: 'string' }, 'instance-id': { type: 'string' },
    'batch-size': { type: 'string', default: '100' }, apply: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('npm run backfill:metadata -- [--corp-id <corpId>] [--instance-id <instanceId>] [--batch-size 1..200] [--dry-run | --apply]');
    return;
  }
  if (values.apply && values['dry-run']) throw new Error('APPROVAL_METADATA_MODE_CONFLICT');
  const corpId = (values['corp-id'] ?? getConfig().DINGTALK_CORP_ID)?.trim();
  if (!corpId) throw new Error('APPROVAL_METADATA_CORP_REQUIRED');
  console.log(JSON.stringify(await backfillApprovalMetadata(corpId, {
    dryRun: !values.apply, instanceId: values['instance-id'], batchSize: Number(values['batch-size']),
  })));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => closePool());
