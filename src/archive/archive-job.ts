import { createHash } from 'node:crypto';
import type {
  ArchiveMethod,
  ContentQuality,
  DownloadDiagnostic,
  ResolvedDownload,
} from './download-strategies.js';

export interface PendingArchive {
  id: number;
  corpId: string;
  processInstanceId: string;
  processCode: string;
  origin: 'form' | 'comment';
  fileId: string;
  spaceId: string;
  fileName: string;
  declaredSize: number | null;
  objectKey: string;
  attempts: number;
  thumbnailMediaId?: string;
}

interface ObjectHeadMissing {
  exists: false;
}

interface ObjectHeadPresent {
  exists: true;
  size: number;
  etag: string;
  contentType: string;
  sha256: string;
  archiveMethod?: ArchiveMethod;
  contentQuality?: ContentQuality;
}

interface ArchiveResult {
  actualSize: number;
  etag: string;
  contentType: string;
  sha256: string;
  archiveMethod?: ArchiveMethod;
  contentQuality?: ContentQuality;
  diagnostics?: DownloadDiagnostic[];
}

export interface ArchiveDependencies {
  headObject: (objectKey: string) => Promise<ObjectHeadMissing | ObjectHeadPresent>;
  getDownload: (record: PendingArchive) => Promise<ResolvedDownload>;
  fetchContent: (uri: string, headers?: Record<string, string>) => Promise<{ body: Buffer; contentType: string }>;
  putObject: (
    objectKey: string,
    body: Buffer,
    metadata: Record<string, string>,
  ) => Promise<{ etag?: string } | void>;
  markArchived: (id: number, result: ArchiveResult) => Promise<void> | void;
  recordApiCall: (apiName: string, success: boolean) => Promise<void> | void;
}

const PERMANENT_DINGTALK_FAILURES = [
  'noPermission',
  'invalidFileId',
  'processInstNotExist',
  'processNotExist',
  'processGetFailedByParameter',
  'permissionDenied',
  'dentryNotExist',
  'object.not.exist',
];

export function failureState(attempts: number, error?: unknown): 'retry' | 'manual_required' {
  const message = error instanceof Error ? error.message : String(error || '');
  const diagnostics = error && typeof error === 'object' && 'diagnostics' in error && Array.isArray(error.diagnostics)
    ? error.diagnostics as Array<{ errorCode?: string; message?: string }>
    : [];
  const combined = [message, ...diagnostics.flatMap((item) => [item.errorCode || '', item.message || ''])]
    .join('\n')
    .toLowerCase();
  if (PERMANENT_DINGTALK_FAILURES.some((code) => combined.includes(code.toLowerCase()))) {
    return 'manual_required';
  }
  return attempts >= 5 ? 'manual_required' : 'retry';
}

export async function archiveAttachment(
  record: PendingArchive,
  dependencies: ArchiveDependencies,
): Promise<void> {
  const existing = await dependencies.headObject(record.objectKey);
  if (existing.exists) {
    await dependencies.markArchived(record.id, {
      actualSize: existing.size,
      etag: existing.etag,
      contentType: existing.contentType,
      sha256: existing.sha256,
      archiveMethod: existing.archiveMethod || 'minio_head_recovery',
      contentQuality: existing.contentQuality || 'original',
    });
    return;
  }

  let download: ResolvedDownload;
  download = await dependencies.getDownload(record);

  let downloaded: { body: Buffer; contentType: string };
  const contentCallName = `attachment_content:${download.archiveMethod}`;
  try {
    downloaded = await dependencies.fetchContent(download.uri, download.headers || {});
    await Promise.resolve(dependencies.recordApiCall(contentCallName, true)).catch(() => undefined);
  } catch (error) {
    await Promise.resolve(dependencies.recordApiCall(contentCallName, false)).catch(() => undefined);
    if (error && typeof error === 'object') {
      Object.assign(error, { diagnostics: download.diagnostics, archiveMethod: download.archiveMethod });
    }
    throw error;
  }
  if (
    download.contentQuality === 'original'
    && record.declaredSize !== null
    && downloaded.body.length !== record.declaredSize
  ) {
    const error = new Error(
      `attachment size mismatch: declared=${record.declaredSize} actual=${downloaded.body.length}`,
    );
    Object.assign(error, { code: 'attachment_size_mismatch', diagnostics: download.diagnostics, archiveMethod: download.archiveMethod });
    throw error;
  }
  const sha256 = createHash('sha256').update(downloaded.body).digest('hex');
  const metadata = {
    'Content-Type': downloaded.contentType || 'application/octet-stream',
    // S3 user metadata is serialized as HTTP headers; encode Unicode names so
    // Node never emits invalid non-ASCII header bytes. The manifest retains the
    // original display name verbatim.
    'x-amz-meta-original-filename': encodeURIComponent(record.fileName),
    'x-amz-meta-sha256': sha256,
    'x-amz-meta-process-instance-id': record.processInstanceId,
    'x-amz-meta-file-id': record.fileId,
    'x-amz-meta-archive-method': download.archiveMethod,
    'x-amz-meta-content-quality': download.contentQuality,
  };
  let uploaded: { etag?: string } | void;
  try {
    uploaded = await dependencies.putObject(record.objectKey, downloaded.body, metadata);
  } catch (error) {
    if (error && typeof error === 'object') {
      Object.assign(error, { diagnostics: download.diagnostics, archiveMethod: download.archiveMethod });
    }
    throw error;
  }
  await dependencies.markArchived(record.id, {
    actualSize: downloaded.body.length,
    etag: uploaded?.etag ?? '',
    contentType: downloaded.contentType || 'application/octet-stream',
    sha256,
    archiveMethod: download.archiveMethod,
    contentQuality: download.contentQuality,
    diagnostics: download.diagnostics,
  });
}
