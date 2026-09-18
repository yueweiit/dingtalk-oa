import { createHash } from 'node:crypto';
import { getConfig } from '../config/index.js';
import { closePool } from '../db/pool.js';
import {
  enqueueWorkbookIndexRefresh,
  syncAllowedPackingWorkbooks,
} from '../db/queries/packing-workbook.js';

async function main(): Promise<void> {
  const config = getConfig();
  if (!config.DINGTALK_CORP_ID) throw new Error('DINGTALK_CORP_ID is required');
  await syncAllowedPackingWorkbooks(config.DINGTALK_CORP_ID, config.DINGTALK_PACKING_WORKBOOKS_JSON);
  for (const workbook of config.DINGTALK_PACKING_WORKBOOKS_JSON) {
    const requestKey = createHash('sha256')
      .update(`packing-workbook-index:${config.DINGTALK_CORP_ID}:${workbook.workbookId}:${Date.now()}`)
      .digest('hex');
    await enqueueWorkbookIndexRefresh({
      corpId: config.DINGTALK_CORP_ID,
      workbookId: workbook.workbookId,
      requestKey,
      requestedBy: 'packing-workbook-config-sync',
    });
  }
  console.log(`已同步 ${config.DINGTALK_PACKING_WORKBOOKS_JSON.length} 个装箱工作簿白名单`);
}

main()
  .catch((error) => {
    console.error('同步装箱工作簿白名单失败:', error);
    process.exitCode = 1;
  })
  .finally(() => closePool());
