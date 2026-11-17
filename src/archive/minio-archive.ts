import * as Minio from 'minio';
import * as http from 'node:http';
import * as https from 'node:https';
import { getConfig } from '../config/index.js';

let client: Minio.Client | null = null;

export function getArchiveMinioClient(): Minio.Client {
  if (client) return client;
  client = createArchiveMinioClient();
  return client;
}

function createArchiveMinioClient(transport?: Minio.ClientOptions['transport']): Minio.Client {
  const config = getConfig();
  if (!config.ARCHIVE_MINIO_ACCESS_KEY || !config.ARCHIVE_MINIO_SECRET_KEY) {
    throw new Error('MinIO 归档账号未配置');
  }
  return new Minio.Client({
    endPoint: config.ARCHIVE_MINIO_ENDPOINT,
    port: config.ARCHIVE_MINIO_PORT,
    useSSL: config.ARCHIVE_MINIO_USE_SSL,
    accessKey: config.ARCHIVE_MINIO_ACCESS_KEY,
    secretKey: config.ARCHIVE_MINIO_SECRET_KEY,
    transport,
  });
}

async function withStorageDeadline<T>(run: (storage: Minio.Client) => Promise<T>): Promise<T> {
  const config = getConfig();
  const controller = new AbortController();
  const timeoutError = Object.assign(new Error('ATTACHMENT_STORAGE_TIMEOUT'), { code: 'attachment_storage_timeout' });
  const timer = setTimeout(() => controller.abort(timeoutError), config.ARCHIVE_STORAGE_TIMEOUT_MS);
  timer.unref();
  const transport = config.ARCHIVE_MINIO_USE_SSL ? https : http;
  // MinIO calls transport.request(options, callback). All requests of this operation,
  // including region discovery and multipart requests, share one cancellable deadline.
  // Keep this client isolated from packing snapshots and other concurrent transfers.
  try {
    const storage = createArchiveMinioClient({
      request: ((options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) =>
        transport.request({ ...options, signal: controller.signal }, callback)) as typeof http.request,
    });
    return await run(storage);
  } catch (error) {
    if (controller.signal.aborted) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function headArchivedObject(objectKey: string): Promise<
  | { exists: false }
  | {
    exists: true;
    size: number;
    etag: string;
    contentType: string;
    sha256: string;
    archiveMethod?: import('./download-strategies.js').ArchiveMethod;
    contentQuality?: import('./download-strategies.js').ContentQuality;
  }
> {
  const config = getConfig();
  try {
    const stat = await withStorageDeadline(storage => storage.statObject(config.ARCHIVE_MINIO_BUCKET, objectKey));
    const metadata = stat.metaData || {};
    return {
      exists: true,
      size: stat.size,
      etag: stat.etag,
      contentType: String(metadata['content-type'] || metadata['Content-Type'] || 'application/octet-stream'),
      sha256: String(metadata['x-amz-meta-sha256'] || metadata.sha256 || ''),
      archiveMethod: String(
        metadata['x-amz-meta-archive-method'] || metadata['archive-method'] || '',
      ) as import('./download-strategies.js').ArchiveMethod || undefined,
      contentQuality: String(
        metadata['x-amz-meta-content-quality'] || metadata['content-quality'] || '',
      ) as import('./download-strategies.js').ContentQuality || undefined,
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
  const result = await withStorageDeadline(storage => storage.putObject(
    config.ARCHIVE_MINIO_BUCKET,
    objectKey,
    body,
    body.length,
    metadata,
  ));
  return { etag: result.etag };
}
