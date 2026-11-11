import { parseArgs } from 'node:util';
import { getConfig } from '../config/index.js';
import { closePool } from '../db/pool.js';
import { backfillUserDepartures } from '../db/queries/user-departure.js';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    'corp-id': { type: 'string' }, 'instance-id': { type: 'string' },
    'confirm-user-id': { type: 'string' }, apply: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('npm run backfill:departures -- [--corp-id <corpId>] [--instance-id <instanceId>] [--dry-run | --apply [--confirm-user-id <userId>]]');
    return;
  }
  if (values.apply && values['dry-run']) throw new Error('DEPARTURE_BACKFILL_MODE_CONFLICT');
  const corpId = (values['corp-id'] ?? getConfig().DINGTALK_CORP_ID)?.trim();
  if (!corpId) throw new Error('DEPARTURE_BACKFILL_CORP_REQUIRED');
  console.log(JSON.stringify(await backfillUserDepartures(corpId, {
    dryRun: !values.apply, instanceId: values['instance-id'], confirmedUserId: values['confirm-user-id'],
  })));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => closePool());
