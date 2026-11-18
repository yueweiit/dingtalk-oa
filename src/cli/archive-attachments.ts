import { parseArchiveTarget } from '../archive/archive-target.js';
import { archiveQueuedAttachment } from '../archive/archive-runtime.js';
import { getConfig } from '../config/index.js';
import {
  claimPendingAttachments,
  enqueueCorpAttachments,
  enqueueTemplateAttachments,
  isAttachmentCorpEnabled,
  isAttachmentTemplateEnabled,
  listWhitelistedInstances,
  markAttachmentFailed,
  updateArchiveHealth,
  synchronizeInstanceAttachments,
  retireIneligibleAttachments,
} from '../db/queries/attachment-archive.js';
import { closePool } from '../db/pool.js';

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function run(): Promise<void> {
  const target = parseArchiveTarget(process.argv.slice(2));
  const config = getConfig();
  const fileTarget = target && 'fileId' in target ? target : undefined;
  if (target && 'allTemplates' in target) {
    if (!await isAttachmentCorpEnabled(target.corpId)) {
      throw new Error('ATTACHMENT_CORP_SCOPE_DISABLED');
    }
    if (target.enqueueOnly) {
      const { scannedCount, candidateCount } = await enqueueCorpAttachments(target.corpId);
      console.log(`[Archive] 扫描 ${scannedCount} 张审批，识别 ${candidateCount} 个附件引用`);
      return;
    }
  }
  if (target && 'processCode' in target) {
    if (!await isAttachmentTemplateEnabled(target.corpId, target.processCode)) {
      throw new Error('[Archive] Attachment archiving is disabled for this corporation and process code.');
    }
    if (target.enqueueOnly) {
      const { scannedCount, candidateCount } = await enqueueTemplateAttachments(target.corpId, target.processCode);
      console.log(`[Archive] 扫描 ${scannedCount} 张审批，识别 ${candidateCount} 个附件引用`);
      return;
    }
  }
  const startedAt = new Date();
  let scannedCount = 0;
  let processedCount = 0;
  let failedCount = 0;
  await updateArchiveHealth({ startedAt, completed: false, success: false, scannedCount, processedCount });
  try {
    if (fileTarget) {
      await synchronizeInstanceAttachments(fileTarget.corpId, fileTarget.processInstanceId);
      scannedCount = 1;
    } else if (!target) {
      await retireIneligibleAttachments();
      const instances = await listWhitelistedInstances();
      scannedCount = instances.length;
      for (const instance of instances) {
        await synchronizeInstanceAttachments(instance.corp_id, instance.process_instance_id);
      }
    }

    const pending = await claimPendingAttachments(
      fileTarget ? 1 : config.ARCHIVE_BATCH_SIZE,
      config.ARCHIVE_RECOVERY_CANARY_ONLY,
      target,
    );
    if (fileTarget && !pending.length) {
      console.log('[Archive] Exact target was not claimed; inspect whether it is archived, ineligible, leased or awaiting retry.');
    }
    for (let index = 0; index < pending.length; index += 1) {
      const record = pending[index];
      try {
        await archiveQueuedAttachment(record);
        processedCount += 1;
      } catch (error) {
        failedCount += 1;
        // A recovery canary has already exhausted every configured strategy once;
        // do not let the normal timer repeat the same quota-consuming chain.
        await markAttachmentFailed(record.id, record.recoveryCanary ? 5 : record.attempts, error, record.objectKey, record.claimGeneration);
        console.error(`[Archive] ${record.processInstanceId}/${record.fileId} 归档失败:`, error);
      }
      if (index + 1 < pending.length) await delay(config.ARCHIVE_DELAY_MS);
    }

    await updateArchiveHealth({
      startedAt,
      completed: true,
      success: failedCount === 0,
      scannedCount,
      processedCount,
      ...(failedCount ? { error: new Error(`本批 ${failedCount} 个附件归档失败`) } : {}),
    });
    console.log(`[Archive] 扫描 ${scannedCount} 张审批，本批归档 ${processedCount}/${pending.length} 个附件`);
    if (failedCount) throw new Error(`本批 ${failedCount} 个附件归档失败`);
  } catch (error) {
    await updateArchiveHealth({
      startedAt,
      completed: true,
      success: false,
      scannedCount,
      processedCount,
      error,
    }).catch(() => undefined);
    throw error;
  }
}

run()
  .catch((error) => {
    console.error('[Archive] 归档任务失败:', error);
    process.exitCode = 1;
  })
  .finally(() => closePool());
