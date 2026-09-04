import * as Minio from 'minio';
import { getConfig } from '../config/index.js';

let client: Minio.Client | null = null;

export function getArchiveMinioClient(): Minio.Client {
  if (client) return client;
  const config = getConfig();
  if (!config.ARCHIVE_MINIO_ACCESS_KEY || !config.ARCHIVE_MINIO_SECRET_KEY) {
    throw new Error('MinIO 归档账号未配置');
  }
  client = new Minio.Client({
    endPoint: config.ARCHIVE_MINIO_ENDPOINT,
    port: config.ARCHIVE_MINIO_PORT,
    useSSL: config.ARCHIVE_MINIO_USE_SSL,
    accessKey: config.ARCHIVE_MINIO_ACCESS_KEY,
    secretKey: config.ARCHIVE_MINIO_SECRET_KEY,
  });
  return client;
}

export async function headArchivedObject(objectKey: string): Promise<
  | { exists: false }
  | { exists: true; size: number; etag: string; contentType: string; sha256: string }
> {
  const config = getConfig();
  try {
    const stat = await getArchiveMinioClient().statObject(config.ARCHIVE_MINIO_BUCKET, objectKey);
    const metadata = stat.metaData || {};
    return {
      exists: true,
      size: stat.size,
      etag: stat.etag,
      contentType: String(metadata['content-type'] || metadata['Content-Type'] || 'application/octet-stream'),
      sha256: String(metadata['x-amz-meta-sha256'] || metadata.sha256 || ''),
    };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'NoSuchKey' || code === 'NotFound' || code === 'NoSuchObject') return { exists: false };
    throw error;
  }
}

export async function putArchivedObject(
  objectKey: string,
  body: Buffer,
  metadata: Record<string, string>,
): Promise<{ etag: string }> {
  const config = getConfig();
  const result = await getArchiveMinioClient().putObject(
    config.ARCHIVE_MINIO_BUCKET,
    objectKey,
    body,
    body.length,
    metadata,
  );
  return { etag: result.etag };
}
