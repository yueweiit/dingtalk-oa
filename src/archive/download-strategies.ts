import type { PendingArchive } from './archive-job.js';

export type ArchiveMethod =
  | 'workflow_download'
  | 'legacy_file_url'
  | 'legacy_dentry_auth'
  | 'workflow_dentry_auth'
  | 'storage_dentry'
  | 'drive_download'
  | 'storage_thumbnail'
  | 'thumbnail_media'
  | 'minio_head_recovery';

export type ContentQuality = 'original' | 'preview';

export interface DownloadDiagnostic {
  strategy: string;
  ok: boolean;
  attemptedAt: string;
  errorCode?: string;
  message?: string;
}

export interface DownloadResource {
  uri: string;
  headers?: Record<string, string>;
}

export interface ResolvedDownload extends DownloadResource {
  archiveMethod: ArchiveMethod;
  contentQuality: ContentQuality;
  diagnostics: DownloadDiagnostic[];
}

export interface DownloadStrategy {
  name: ArchiveMethod;
  contentQuality: ContentQuality;
  run: (record: PendingArchive) => Promise<DownloadResource | null>;
}

function extractErrorCode(message: string): string | undefined {
  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;
    const value = parsed.code ?? parsed.errcode;
    if (value !== undefined && value !== null) return String(value);
  } catch {
    // DingTalk errors usually contain a JSON object inside a longer message.
  }
  const match = message.match(/(?:"(?:code|errcode)"\s*:\s*"?([^",}\s]+)|\b(userNotExist|noPermission)\b)/i);
  return match?.[1] || match?.[2];
}

export class AttachmentDownloadStrategiesError extends Error {
  readonly code = 'attachment_download_strategies_exhausted';

  constructor(readonly diagnostics: DownloadDiagnostic[]) {
    const last = diagnostics.at(-1);
    super(last?.message || '钉钉附件所有下载策略均失败');
    this.name = 'AttachmentDownloadStrategiesError';
  }
}

export async function resolveDownloadWithStrategies(
  record: PendingArchive,
  strategies: DownloadStrategy[],
): Promise<ResolvedDownload> {
  const diagnostics: DownloadDiagnostic[] = [];
  for (const strategy of strategies) {
    const attemptedAt = new Date().toISOString();
    try {
      const resource = await strategy.run(record);
      if (!resource?.uri) {
        diagnostics.push({ strategy: strategy.name, ok: false, attemptedAt, message: '未返回下载地址' });
        continue;
      }
      diagnostics.push({ strategy: strategy.name, ok: true, attemptedAt });
      return {
        uri: resource.uri,
        headers: resource.headers || {},
        archiveMethod: strategy.name,
        contentQuality: strategy.contentQuality,
        diagnostics,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push({
        strategy: strategy.name,
        ok: false,
        attemptedAt,
        ...(extractErrorCode(message) ? { errorCode: extractErrorCode(message) } : {}),
        message: message.slice(0, 1000),
      });
    }
  }
  throw new AttachmentDownloadStrategiesError(diagnostics);
}
