import {
  requeueHistoricalRecoveryCanaries,
  requeueSuccessfulRecoveryRemainders,
} from '../db/queries/attachment-archive.js';
import { closePool } from '../db/pool.js';

async function run(): Promise<void> {
  const mode = process.argv[2];
  if (mode === 'canaries') {
    const count = await requeueHistoricalRecoveryCanaries(5);
    console.log(`[Archive recovery] 已为 ${count} 个流程各排入 1 个受控样本。`);
    return;
  }
  if (mode === 'successful-remainders') {
    const count = await requeueSuccessfulRecoveryRemainders();
    console.log(`[Archive recovery] 已排入 ${count} 个样本成功流程的剩余历史附件。`);
    return;
  }
  throw new Error('用法: prepare-archive-recovery.ts canaries|successful-remainders');
}

run()
  .catch((error) => {
    console.error('[Archive recovery] 准备失败:', error);
    process.exitCode = 1;
  })
  .finally(() => closePool());
