import type { PendingArchive } from './archive-job.js';
import {
  resolveDownloadWithStrategies,
  type DownloadResource,
  type DownloadStrategy,
  type ResolvedDownload,
} from './download-strategies.js';

export interface DingTalkArchiveApi {
  workflowDownload: (processInstanceId: string, fileId: string) => Promise<DownloadResource>;
  legacyFileUrl: (processInstanceId: string, fileId: string) => Promise<DownloadResource>;
  legacySpaceId: (processInstanceId: string, fileId: string, userId: string) => Promise<string>;
  legacyAuthorize: (fileId: string, spaceId: string, userId: string) => Promise<void>;
  authorizeDownload: (fileId: string, spaceId: string, userId: string) => Promise<void>;
  userUnionId: (userId: string) => Promise<string>;
  storageDentryDownload: (spaceId: string, dentryId: string, unionId: string) => Promise<DownloadResource>;
  driveDownload: (spaceId: string, fileId: string, unionId: string) => Promise<DownloadResource>;
  storageThumbnail: (spaceId: string, dentryId: string, unionId: string) => Promise<DownloadResource>;
  thumbnailMedia: (mediaId: string) => Promise<DownloadResource>;
}

interface ResolveOptions {
  api: DingTalkArchiveApi;
  downloadUserId?: string;
  configuredUnionId?: string;
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp', '.tif', '.tiff']);

function isImageFile(fileName: string): boolean {
  const normalized = fileName.trim().toLowerCase();
  const dot = normalized.lastIndexOf('.');
  return dot >= 0 && IMAGE_EXTENSIONS.has(normalized.slice(dot));
}

export async function resolveDingTalkArchiveDownload(
  record: PendingArchive,
  options: ResolveOptions,
): Promise<ResolvedDownload> {
  const { api } = options;
  const downloadUserId = String(options.downloadUserId || '').trim();
  let spaceId = String(record.spaceId || '').trim();
  let unionId = String(options.configuredUnionId || '').trim();

  const ensureSpaceId = async (): Promise<string> => {
    if (spaceId) return spaceId;
    if (!downloadUserId) throw new Error('附件恢复缺少 DINGTALK_ARCHIVE_DOWNLOAD_USER_ID');
    spaceId = await api.legacySpaceId(record.processInstanceId, record.fileId, downloadUserId);
    if (!spaceId) throw new Error('钉钉 cspace 接口未返回 spaceId');
    return spaceId;
  };

  const ensureUnionId = async (): Promise<string> => {
    if (unionId) return unionId;
    if (!downloadUserId) throw new Error('附件恢复缺少下载用户，无法解析 unionId');
    unionId = await api.userUnionId(downloadUserId);
    return unionId;
  };

  const strategies: DownloadStrategy[] = [
    {
      name: 'workflow_download',
      contentQuality: 'original',
      run: () => api.workflowDownload(record.processInstanceId, record.fileId),
    },
    {
      name: 'legacy_file_url',
      contentQuality: 'original',
      run: () => api.legacyFileUrl(record.processInstanceId, record.fileId),
    },
  ];

  if (downloadUserId) {
    strategies.push({
      name: 'legacy_dentry_auth',
      contentQuality: 'original',
      run: async () => {
        const resolvedSpaceId = await ensureSpaceId();
        await api.legacyAuthorize(record.fileId, resolvedSpaceId, downloadUserId);
        return api.legacyFileUrl(record.processInstanceId, record.fileId);
      },
    });
    strategies.push({
      name: 'workflow_dentry_auth',
      contentQuality: 'original',
      run: async () => {
        const resolvedSpaceId = await ensureSpaceId();
        await api.authorizeDownload(record.fileId, resolvedSpaceId, downloadUserId);
        return api.workflowDownload(record.processInstanceId, record.fileId);
      },
    });
  }

  strategies.push(
    {
      name: 'storage_dentry',
      contentQuality: 'original',
      run: async () => {
        const resolvedSpaceId = await ensureSpaceId();
        const resolvedUnionId = await ensureUnionId();
        // Never fall back by filename: names are neither unique nor stable and can archive the wrong file.
        return api.storageDentryDownload(resolvedSpaceId, record.fileId, resolvedUnionId);
      },
    },
    {
      name: 'drive_download',
      contentQuality: 'original',
      run: async () => api.driveDownload(await ensureSpaceId(), record.fileId, await ensureUnionId()),
    },
  );

  if (isImageFile(record.fileName)) {
    strategies.push(
      {
        name: 'storage_thumbnail',
        contentQuality: 'preview',
        run: async () => api.storageThumbnail(await ensureSpaceId(), record.fileId, await ensureUnionId()),
      },
      {
        name: 'thumbnail_media',
        contentQuality: 'preview',
        run: () => record.thumbnailMediaId ? api.thumbnailMedia(record.thumbnailMediaId) : Promise.resolve(null),
      },
    );
  }

  return resolveDownloadWithStrategies(record, strategies);
}
