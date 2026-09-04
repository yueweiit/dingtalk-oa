import { createHash } from 'node:crypto';

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
}

interface ArchiveResult {
  actualSize: number;
  etag: string;
  contentType: string;
  sha256: string;
}

export interface ArchiveDependencies {
  headObject: (objectKey: string) => Promise<ObjectHeadMissing | ObjectHeadPresent>;
  getDownloadUri: (record: PendingArchive) => Promise<string>;
  fetchContent: (uri: string) => Promise<{ body: Buffer; contentType: string }>;
  putObject: (
    objectKey: string,
    body: Buffer,
    metadata: Record<string, string>,
  ) => Promise<{ etag?: string } | void>;
  markArchived: (id: number, result: ArchiveResult) => Promise<void> | void;
  recordApiCall: (apiName: string, success: boolean) => Promise<void> | void;
}

const PERMANENT_DINGTALK_FAILURES = [
  'userNotExist',
  'noPermission',
  'invalidFileId',
  'processInstNotExist',
  'processNotExist',
  'processGetFailedByParameter',
];

export function failureState(attempts: number, error?: unknown): 'retry' | 'manual_required' {
  const message = error instanceof Error ? error.message : String(error || '');
  if (PERMANENT_DINGTALK_FAILURES.some((code) => message.includes(`"code":"${code}"`))) {
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
    });
    return;
  }

  let downloadUri: string;
  try {
    downloadUri = await dependencies.getDownloadUri(record);
    await dependencies.recordApiCall('approval_attachment_download_url', true);
  } catch (error) {
    await dependencies.recordApiCall('approval_attachment_download_url', false);
    throw error;
  }

  const downloaded = await dependencies.fetchContent(downloadUri);
  if (record.declaredSize !== null && downloaded.body.length !== record.declaredSize) {
    throw new Error(
      `attachment size mismatch: declared=${record.declaredSize} actual=${downloaded.body.length}`,
    );
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
  };
  const uploaded = await dependencies.putObject(record.objectKey, downloaded.body, metadata);
  await dependencies.markArchived(record.id, {
    actualSize: downloaded.body.length,
    etag: uploaded?.etag ?? '',
    contentType: downloaded.contentType || 'application/octet-stream',
    sha256,
  });
}
