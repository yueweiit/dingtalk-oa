import { archiveAttachment, type PendingArchive } from './archive-job.js';
import { resolveDingTalkArchiveDownload } from './dingtalk-download.js';
import { headArchivedObject, putArchivedObject } from './minio-archive.js';
import { getConfig } from '../config/index.js';
import { markAttachmentArchived, recordApiUsage } from '../db/queries/attachment-archive.js';
import {
  authorizeApprovalAttachmentDownload, authorizeLegacyApprovalAttachment,
  getApprovalAttachmentDownloadUrl, getDriveFileDownloadInfo,
  getLegacyApprovalAttachmentDownload, getLegacyApprovalAttachmentSpaceId,
  getStorageDentryDownloadInfo, getStorageThumbnailDownload, getThumbnailMediaDownload, getUserUnionId,
} from '../dingtalk/api-client.js';

export async function fetchArchiveContent(
  uri: string, headers: Record<string, string>, timeoutMs: number,
): Promise<{ body: Buffer; contentType: string }> {
  // Includes the body read, so a stalled transfer cannot monopolize the worker.
  const response = await fetch(uri, { redirect: 'follow', headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(new Error(`ATTACHMENT_DOWNLOAD_HTTP_${response.status}`), { code: 'attachment_content_http_error' });
  }
  return {
    body: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || 'application/octet-stream',
  };
}

/** Shared by the persistent worker and the exact/template recovery CLI. */
export async function archiveQueuedAttachment(record: PendingArchive, originalOnly = false): Promise<void> {
  const config = getConfig();
  await archiveAttachment(record, {
    headObject: async key => {
      const head = await headArchivedObject(key);
      return originalOnly && head.exists && head.contentQuality === 'preview' ? { exists: false } : head;
    },
    getDownload: item => resolveDingTalkArchiveDownload(item, {
      downloadUserId: config.DINGTALK_ARCHIVE_DOWNLOAD_USER_ID,
      configuredUnionId: config.DINGTALK_ARCHIVE_DOWNLOAD_UNION_ID,
      allowPreview: !originalOnly,
      api: {
        workflowDownload: async (instanceId, fileId, includeComments) => ({
          uri: await getApprovalAttachmentDownloadUrl(instanceId, fileId, includeComments), headers: {},
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
    fetchContent: (uri, headers) => fetchArchiveContent(uri, headers || {}, config.ARCHIVE_DOWNLOAD_TIMEOUT_MS),
    putObject: putArchivedObject,
    markArchived: (id, result) => markAttachmentArchived(id, result, record.objectKey, record.claimGeneration),
    recordApiCall: recordApiUsage,
  });
}
