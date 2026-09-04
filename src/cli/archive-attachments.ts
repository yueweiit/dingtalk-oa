import { extractAttachmentCandidates } from '../archive/attachment-extractor.js';
import { archiveAttachment } from '../archive/archive-job.js';
import { resolveDingTalkArchiveDownload } from '../archive/dingtalk-download.js';
import { headArchivedObject, putArchivedObject } from '../archive/minio-archive.js';
import { getConfig } from '../config/index.js';
import {
  claimPendingAttachments,
  listWhitelistedInstances,
  markAttachmentArchived,
  markAttachmentFailed,
  recordApiUsage,
  updateArchiveHealth,
  upsertAttachmentCandidates,
} from '../db/queries/attachment-archive.js';
import { closePool } from '../db/pool.js';
import {
  authorizeApprovalAttachmentDownload,
  authorizeLegacyApprovalAttachment,
  getApprovalAttachmentDownloadUrl,
  getDriveFileDownloadInfo,
  getLegacyApprovalAttachmentDownload,
  getLegacyApprovalAttachmentSpaceId,
  getStorageDentryDownloadInfo,
  getStorageThumbnailDownload,
  getThumbnailMediaDownload,
  getUserUnionId,
} from '../dingtalk/api-client.js';

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchAttachment(
  uri: string,
  headers: Record<string, string> = {},
): Promise<{ body: Buffer; contentType: string }> {
  const response = await fetch(uri, { redirect: 'follow', headers });
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
  let failedCount = 0;
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

    const pending = await claimPendingAttachments(
      config.ARCHIVE_BATCH_SIZE,
      config.ARCHIVE_RECOVERY_CANARY_ONLY,
    );
    for (let index = 0; index < pending.length; index += 1) {
      const record = pending[index];
      try {
        await archiveAttachment(record, {
          headObject: headArchivedObject,
          getDownload: (item) => resolveDingTalkArchiveDownload(item, {
            downloadUserId: config.DINGTALK_ARCHIVE_DOWNLOAD_USER_ID,
            configuredUnionId: config.DINGTALK_ARCHIVE_DOWNLOAD_UNION_ID,
            api: {
              workflowDownload: async (processInstanceId, fileId) => ({
                uri: await getApprovalAttachmentDownloadUrl(processInstanceId, fileId),
                headers: {},
              }),
              legacyFileUrl: getLegacyApprovalAttachmentDownload,
              legacySpaceId: getLegacyApprovalAttachmentSpaceId,
              legacyAuthorize: authorizeLegacyApprovalAttachment,
              authorizeDownload: authorizeApprovalAttachmentDownload,
              userUnionId: getUserUnionId,
              storageDentryDownload: getStorageDentryDownloadInfo,
              driveDownload: getDriveFileDownloadInfo,
              storageThumbnail: getStorageThumbnailDownload,
              thumbnailMedia: getThumbnailMediaDownload,
            },
          }),
          fetchContent: fetchAttachment,
          putObject: putArchivedObject,
          markArchived: markAttachmentArchived,
          // API 客户端记录签名地址请求；这里单独记录文件内容请求。
          recordApiCall: recordApiUsage,
        });
        processedCount += 1;
      } catch (error) {
        failedCount += 1;
        await markAttachmentFailed(record.id, record.attempts, error);
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
