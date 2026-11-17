import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type RequestListener, type Server } from 'node:http';
import { once } from 'node:events';
import { headArchivedObject, putArchivedObject } from './minio-archive.js';
import { createAttachmentArchiveWorker } from '../jobs/attachment-archive-worker.js';
import type { PendingArchive } from './archive-job.js';

const config = vi.hoisted(() => ({
  ARCHIVE_MINIO_ENDPOINT: '127.0.0.1', ARCHIVE_MINIO_PORT: 1, ARCHIVE_MINIO_USE_SSL: false,
  ARCHIVE_MINIO_ACCESS_KEY: 'synthetic', ARCHIVE_MINIO_SECRET_KEY: 'synthetic',
  ARCHIVE_MINIO_BUCKET: 'test-archive', ARCHIVE_STORAGE_TIMEOUT_MS: 150,
}));
vi.mock('../config/index.js', () => ({ getConfig: () => config }));
let server: Server | undefined;
async function startServer(handle: RequestListener) {
  server = createServer(handle);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  config.ARCHIVE_MINIO_PORT = (server.address() as { port: number }).port;
}
const location = '<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">us-east-1</LocationConstraint>';
afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
});

describe('bounded archive storage operations', () => {
  it.each(['region', 'region-body', 'head', 'put'] as const)('aborts a stalled %s request and closes its connection', async phase => {
    let closed = false;
    let targetSeen = false;
    await startServer((request, response) => {
      if (request.url?.includes('location') && phase !== 'region' && phase !== 'region-body') {
        response.end(location);
        return;
      }
      targetSeen = true;
      response.on('close', () => { closed = true; });
      request.resume();
      if (phase === 'region-body') {
        response.writeHead(200);
        response.write('<LocationConstraint>');
      }
    });
    const operation = phase === 'put'
      ? putArchivedObject('test.pdf', Buffer.from('pdf'), { 'Content-Type': 'application/pdf' })
      : headArchivedObject('test.pdf');
    await expect(operation).rejects.toMatchObject({ code: 'attachment_storage_timeout', message: 'ATTACHMENT_STORAGE_TIMEOUT' });
    expect(targetSeen).toBe(true);
    await vi.waitFor(() => expect(closed).toBe(true));
  });

  it('preserves uploaded bytes, metadata, missing keys and HEAD evidence', async () => {
    let uploaded = Buffer.alloc(0);
    let contentType: string | undefined;
    await startServer((request, response) => {
      if (request.url?.includes('location')) { response.end(location); return; }
      if (request.url?.endsWith('/missing.pdf')) { response.writeHead(404); response.end(); return; }
      if (request.method === 'PUT') {
        contentType = request.headers['content-type'];
        request.on('data', chunk => { uploaded = Buffer.concat([uploaded, chunk]); });
        request.on('end', () => { response.setHeader('etag', '"uploaded"'); response.end(); });
      } else {
        response.writeHead(200, { 'content-length': '3', etag: '"uploaded"', 'content-type': 'application/pdf',
          'x-amz-meta-sha256': 'synthetic-digest', 'x-amz-meta-content-quality': 'original' });
        response.end();
      }
    });
    expect(await putArchivedObject('test.pdf', Buffer.from('pdf'), { 'Content-Type': 'application/pdf' })).toEqual({ etag: 'uploaded' });
    expect(uploaded.toString()).toBe('pdf');
    expect(contentType).toBe('application/pdf');
    expect(await headArchivedObject('test.pdf')).toMatchObject({ exists: true, size: 3, etag: 'uploaded',
      sha256: 'synthetic-digest', contentQuality: 'original' });
    expect(await headArchivedObject('missing.pdf')).toEqual({ exists: false });
  });

  it('continues to the next attachment after a real storage timeout and can stop', async () => {
    await startServer((request, response) => {
      if (request.url?.includes('location')) { response.end(location); return; }
      if (request.url?.endsWith('/second.pdf')) { response.writeHead(404); response.end(); }
    });
    const record: PendingArchive = { id: 1, corpId: 'corp', processInstanceId: 'instance', processCode: 'OPS',
      origin: 'form', fileId: 'file', spaceId: 'space', fileName: 'first.pdf', declaredSize: 3,
      objectKey: 'first.pdf', attempts: 1, claimGeneration: '1' };
    const pending = [record, { ...record, id: 2, objectKey: 'second.pdf' }];
    const fail = vi.fn();
    let finish!: () => void;
    const completed = new Promise<void>(resolve => { finish = resolve; });
    const report = vi.fn(async () => { finish(); });
    const worker = createAttachmentArchiveWorker({ pollMs: 5000, batchSize: 2, delayMs: 1 }, {
      retire: async () => 0, claim: async () => pending.shift(),
      archive: async item => { await headArchivedObject(item.objectKey); },
      fail, report, onError: vi.fn(),
    });
    try {
      worker.start();
      await completed;
      expect(fail).toHaveBeenCalledTimes(1);
      expect(fail).toHaveBeenCalledWith(record, expect.objectContaining({ code: 'attachment_storage_timeout' }));
      expect(report).toHaveBeenCalledWith(expect.objectContaining({ processedCount: 1, failedCount: 1, success: false }));
    } finally { await worker.stop(); }
  });
});
