import { createHash } from 'node:crypto';
import { getArchiveMinioClient } from '../archive/minio-archive.js';
import { getConfig } from '../config/index.js';

export interface PackingSheetPayload {
  schemaVersion: 1;
  workbookId: string;
  sheetId: string;
  sheetName: string;
  rangeAddress: string | null;
  captureStartedAt: string;
  captureFinishedAt: string;
  mergeRangesAvailable: false;
  chunks: Array<{
    rangeAddress: string;
    values: unknown[][];
    displayValues: string[][];
    formulas: string[][];
  }>;
}

interface ExistingObject {
  exists: true;
  size: number;
  sha256: string;
  etag: string;
}

export interface PackingSnapshotStoreDependencies {
  bucket: string;
  headObject: (objectKey: string) => Promise<{ exists: false } | ExistingObject>;
  putObject: (
    objectKey: string,
    body: Buffer,
    metadata: Record<string, string>,
  ) => Promise<{ etag?: string } | void>;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

export function canonicalSnapshotJson(payload: PackingSheetPayload): string {
  return JSON.stringify(canonicalValue(payload));
}

function keySegment(value: string): string {
  return encodeURIComponent(value).replace(/%/g, '_');
}

export async function storePackingSnapshot(
  corpId: string,
  payload: PackingSheetPayload,
  dependencies: PackingSnapshotStoreDependencies,
): Promise<{ bucket: string; objectKey: string; sha256: string; size: number; etag: string }> {
  const body = Buffer.from(canonicalSnapshotJson(payload), 'utf8');
  const sha256 = createHash('sha256').update(body).digest('hex');
  const objectKey = [corpId, payload.workbookId, payload.sheetId]
    .map(keySegment)
    .concat(`${sha256}.json`)
    .join('/');
  const existing = await dependencies.headObject(objectKey);
  if (existing.exists) {
    if (existing.size !== body.length || existing.sha256 !== sha256) {
      throw Object.assign(new Error('packing snapshot object integrity mismatch'), {
        code: 'packing_snapshot_integrity_mismatch',
      });
    }
    return {
      bucket: dependencies.bucket, objectKey, sha256, size: body.length, etag: existing.etag,
    };
  }
  const uploaded = await dependencies.putObject(objectKey, body, {
    'Content-Type': 'application/json',
    'x-amz-meta-sha256': sha256,
    'x-amz-meta-schema-version': '1',
    'x-amz-meta-workbook-id': encodeURIComponent(payload.workbookId),
    'x-amz-meta-sheet-id': encodeURIComponent(payload.sheetId),
  });
  return {
    bucket: dependencies.bucket,
    objectKey,
    sha256,
    size: body.length,
    etag: uploaded?.etag || '',
  };
}

export async function storePackingSnapshotInMinio(
  corpId: string,
  payload: PackingSheetPayload,
): Promise<{ bucket: string; objectKey: string; sha256: string; size: number; etag: string }> {
  const config = getConfig();
  const bucket = config.PACKING_SNAPSHOT_MINIO_BUCKET;
  const client = getArchiveMinioClient();
  return storePackingSnapshot(corpId, payload, {
    bucket,
    headObject: async (objectKey) => {
      try {
        const stat = await client.statObject(bucket, objectKey);
        const metadata = stat.metaData || {};
        return {
          exists: true,
          size: stat.size,
          sha256: String(metadata['x-amz-meta-sha256'] || metadata.sha256 || ''),
          etag: stat.etag,
        };
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'NoSuchKey' || code === 'NotFound' || code === 'NoSuchObject') return { exists: false };
        throw error;
      }
    },
    putObject: async (objectKey, body, metadata) => client.putObject(
      bucket, objectKey, body, body.length, metadata,
    ),
  });
}
