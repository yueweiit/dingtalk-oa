import { extractAttachmentCandidates } from '../archive/attachment-extractor.js';
import { archiveAttachment } from '../archive/archive-job.js';
import { headArchivedObject, putArchivedObject } from '../archive/minio-archive.js';
import { getConfig } from '../config/index.js';
import {
  claimPendingAttachments,
  listWhitelistedInstances,
  markAttachmentArchived,
  markAttachmentFailed,
  updateArchiveHealth,
  upsertAttachmentCandidates,
} from '../db/queries/attachment-archive.js';
import { closePool } from '../db/pool.js';
import { getApprovalAttachmentDownloadUrl } from '../dingtalk/api-client.js';

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchAttachment(uri: string): Promise<{ body: Buffer; contentType: string }> {
  const response = await fetch(uri, { redirect: 'follow' });
  if (!response.ok) throw new Error(`附件下载失败: HTTP ${response.status}`);
  return {
    body: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || 'application/octet-stream',
  };
}

async function run(): Promise<void> {
  const config = getConfig();
  const startedAt = new Date();
  let scannedCount = 0;
  let processedCount = 0;
  await updateArchiveHealth({ startedAt, completed: false, success: false, scannedCount, processedCount });
  try {
    const instances = await listWhitelistedInstances();
    scannedCount = instances.length;
    for (const instance of instances) {
      const candidates = extractAttachmentCandidates({
        corpId: instance.corp_id,
        processInstanceId: instance.process_instance_id,
        processCode: instance.process_code,
        rawPayload: instance.raw_payload,
      });
      await upsertAttachmentCandidates(candidates);
    }

    const pending = await claimPendingAttachments(config.ARCHIVE_BATCH_SIZE);
    for (let index = 0; index < pending.length; index += 1) {
      const record = pending[index];
      try {
        await archiveAttachment(record, {
          headObject: headArchivedObject,
          getDownloadUri: (item) => getApprovalAttachmentDownloadUrl(item.processInstanceId, item.fileId),
          fetchContent: fetchAttachment,
          putObject: putArchivedObject,
          markArchived: markAttachmentArchived,
          // The shared API client records each real HTTP attempt. Keep the
          // archive core callback as a no-op here to avoid double-counting.
          recordApiCall: async () => undefined,
        });
        processedCount += 1;
      } catch (error) {
        await markAttachmentFailed(record.id, record.attempts, error);
        console.error(`[Archive] ${record.processInstanceId}/${record.fileId} 归档失败:`, error);
      }
      if (index + 1 < pending.length) await delay(config.ARCHIVE_DELAY_MS);
    }

    await updateArchiveHealth({
      startedAt,
      completed: true,
      success: true,
      scannedCount,
      processedCount,
    });
    console.log(`[Archive] 扫描 ${scannedCount} 张审批，本批归档 ${processedCount}/${pending.length} 个附件`);
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
