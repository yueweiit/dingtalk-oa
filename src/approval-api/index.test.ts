import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApprovalReadRoutes, type ReadApiDependencies } from './index.js';
import { resolveCursorSecret } from './cursor-key.js';
import type { ApprovalReadItem, AttachmentReadItem, DownloadAttachment } from '../db/queries/approval-read-api.js';

const token = 'legacy-credential-that-is-no-longer-required';
const updatedAt = '2026-10-29T01:02:03.123456Z';
const syncUntil = '2026-10-29T01:03:00.654321Z';
const approval = (id: string) => ({
  corpId: 'corp-1', processInstanceId: id, approvalNo: `20261029-${id}`,
  processCode: 'PROC-1', templateName: '运营支出 Gastos de Operación', updatedAt,
  deletedAt: null, rawPayload: { businessId: `20261029-${id}`, tasks: [{ taskId: 'task-1' }],
    operationRecords: [{ remark: 'comment', files: [{ fileId: 'file-1' }] }], extra: { nested: [1, 2] } },
  formComponentValues: [{ name: '费用', value: '[{"rowValue":[]}]' }],
} as unknown as ApprovalReadItem);
const attachment = (id = 'file-1'): DownloadAttachment => ({
  corpId: 'corp-1', processInstanceId: 'a', processCode: 'PROC-1', approvalNo: '20261029-a',
  templateName: '运营支出', fileId: id, fileName: '运费凭证.pdf', archiveStatus: 'archived',
  contentQuality: 'original', updatedAt, retiredAt: null, sourceDeletedAt: null,
  bucket: 'archive', objectKey: 'exact/stored/revision/key', actualSize: '6',
} as DownloadAttachment);

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

async function setup(overrides: Partial<ReadApiDependencies> = {}, logs?: string[]) {
  const dependencies: ReadApiDependencies = {
    cursorSecret: resolveCursorSecret({ DINGTALK_APP_SECRET: 'synthetic-application-secret', APPROVAL_READ_API_CURSOR_SECRET: undefined }),
    requestsPerMinute: 120,
    totalRequestsPerMinute: 1200,
    downloadOpenTimeoutMs: 10000, downloadIdleTimeoutMs: 30000, downloadTotalTimeoutMs: 300000,
    approvals: vi.fn().mockResolvedValue({ items: [approval('a')], syncUntil }),
    attachments: vi.fn().mockResolvedValue({ items: [], syncUntil }),
    attachment: vi.fn().mockResolvedValue(attachment()),
    openObject: vi.fn().mockImplementation(async () => Readable.from([Buffer.from('sample')])),
    now: () => Date.parse('2026-10-29T02:00:00Z'), ...overrides,
  };
  const app = Fastify({ forceCloseConnections: true,
    logger: logs ? { stream: { write: (line: string) => { logs.push(line); } } } : false });
  apps.push(app);
  await app.register(createApprovalReadRoutes(dependencies));
  // Read API hooks remain encapsulated from unrelated routes.
  app.get('/health', async () => ({ status: 'ok' }));
  return { app, dependencies };
}

describe('approval archive read API', () => {
  it.each([undefined, 'Bearer wrong', 'Basic legacy'])('reads approvals without requiring credentials: %s', async authorization => {
    const { app, dependencies } = await setup();
    const response = await app.inject({ url: '/api/v1/approvals?corpId=corp-1',
      headers: authorization ? { authorization } : {} });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([approval('a')]);
    expect(response.headers['www-authenticate']).toBeUndefined();
    expect(dependencies.approvals).toHaveBeenCalledOnce();
    expect((await app.inject('/health')).statusCode).toBe(200);
  });

  it('uses corporation and process query parameters without a caller allowlist', async () => {
    const { app, dependencies } = await setup();
    expect((await app.inject('/api/v1/approvals?corpId=corp-2&processCode=OTHER')).statusCode).toBe(200);
    expect(dependencies.approvals).toHaveBeenCalledWith(expect.objectContaining({
      filters: { corpId: 'corp-2', processCode: 'OTHER' },
    }));
    expect((await app.inject('/api/v1/attachments?corpId=corp-2')).statusCode).toBe(200);
    expect(dependencies.attachments).toHaveBeenCalledWith(expect.objectContaining({ filters: { corpId: 'corp-2' } }));
    expect((await app.inject('/api/v1/attachment-content?corpId=corp-2&processInstanceId=a&fileId=file-1')).statusCode).toBe(200);
    expect(dependencies.attachment).toHaveBeenCalledWith({ corpId: 'corp-2', processInstanceId: 'a' }, 'file-1');
  });

  it('rejects unknown query parameters before querying storage', async () => {
    const { app, dependencies } = await setup();
    const response = await app.inject('/api/v1/approvals?corpId=corp-1&token=legacy');
    expect(response.statusCode).toBe(400);
    expect(dependencies.approvals).not.toHaveBeenCalled();
  });

  it('keeps credentials and raw query strings out of automatic HTTP access logs', async () => {
    const logs: string[] = [];
    const { app } = await setup({}, logs);
    await app.inject({ url: `/api/v1/approvals?corpId=corp-1&token=${token}`, headers: { authorization: `Bearer ${token}` } });
    await app.inject({ url: '/api/v1/approvals?corpId=corp-1' });
    expect(logs.join('\n')).toContain('Approval read API');
    expect(logs.join('\n')).not.toContain(token);
    expect(logs.join('\n')).not.toContain('?corpId=');
    expect(logs.join('\n')).not.toContain('rawPayload');
  });

  it.each(['', '&limit=0', '&limit=201', '&limit=abc', '&updatedAfter=2026-10-29', '&limit=1.2'])
    ('validates bounded pagination and timezone-bearing timestamps: %s', async suffix => {
      const { app, dependencies } = await setup();
      const response = await app.inject({ url: suffix ? `/api/v1/approvals?corpId=corp-1${suffix}`
        : '/api/v1/approvals' });
      expect(response.statusCode).toBe(400);
      expect(dependencies.approvals).not.toHaveBeenCalled();
    });

  it('returns full source JSON, names, business IDs, tombstones and an exact microsecond cursor', async () => {
    const deleted = { ...approval('a'), deletedAt: updatedAt };
    const read = vi.fn().mockResolvedValueOnce({ items: [deleted, approval('b')], syncUntil })
      .mockResolvedValueOnce({ items: [approval('b')], syncUntil });
    const { app } = await setup({ approvals: read });
    const base = '/api/v1/approvals?corpId=corp-1&limit=1&updatedAfter=2026-10-01T00%3A00%3A00Z';
    const first = (await app.inject({ url: base })).json();
    expect(first.data).toEqual([deleted]);
    expect(first.pagination).toMatchObject({ limit: 1, hasMore: true, syncUntil });
    const second = (await app.inject({ url: `${base}&cursor=${first.pagination.nextCursor}` })).json();
    expect(read.mock.calls[1][0]).toMatchObject({
      filters: { corpId: 'corp-1', updatedAfter: '2026-10-01T00:00:00Z' },
      position: { updatedAt, processInstanceId: 'a' }, syncUntil,
    });
    expect(second.data.map((row: ApprovalReadItem) => row.processInstanceId)).toEqual(['b']);
    expect(second.pagination).toMatchObject({ nextCursor: null, hasMore: false, syncUntil });
  });

  it('rejects tampered, foreign-resource, foreign-filter and expired cursors before SQL', async () => {
    let now = Date.parse('2026-10-29T02:00:00Z');
    const read = vi.fn().mockResolvedValue({ items: [approval('a'), approval('b')], syncUntil });
    const { app } = await setup({ approvals: read, now: () => now });
    const first = (await app.inject({ url: '/api/v1/approvals?corpId=corp-1&limit=1' })).json();
    const cursor = first.pagination.nextCursor as string;
    for (const url of [
      `/api/v1/approvals?corpId=corp-1&cursor=${cursor.slice(0, -1)}${cursor.endsWith('0') ? '1' : '0'}`,
      `/api/v1/attachments?corpId=corp-1&cursor=${cursor}`,
      `/api/v1/approvals?corpId=corp-2&cursor=${cursor}`,
      `/api/v1/approvals?corpId=corp-1&processCode=PROC-1&cursor=${cursor}`,
      '/api/v1/approvals?corpId=corp-1&cursor=invalid',
    ]) {
      const response = await app.inject({ url });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('INVALID_CURSOR');
    }
    now += 24 * 60 * 60_000;
    expect((await app.inject({ url: `/api/v1/approvals?corpId=corp-1&cursor=${cursor}` })).json().code).toBe('INVALID_CURSOR');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('paginates tied attachment timestamps with file ID and retains retirement markers', async () => {
    const a = attachment('a');
    const retired = { ...attachment('b'), retiredAt: updatedAt };
    const read = vi.fn().mockResolvedValueOnce({ items: [a, retired], syncUntil })
      .mockResolvedValueOnce({ items: [retired], syncUntil });
    const { app } = await setup({ attachments: read });
    const base = '/api/v1/attachments?corpId=corp-1&limit=1';
    const first = await app.inject({ url: base });
    const payload = first.json();
    expect(payload.data[0].downloadPath).toContain('fileId=a');
    expect(first.headers['cache-control']).toBe('no-store');
    const second = (await app.inject({ url: `${base}&cursor=${payload.pagination.nextCursor}` })).json();
    expect(read.mock.calls[1][0].position).toEqual({ updatedAt, processInstanceId: 'a', fileId: 'a' });
    expect(second.data[0]).toMatchObject({ retiredAt: updatedAt, downloadPath: null });
  });

  it('continues a cursor after recreating the application with the same signing configuration', async () => {
    const firstApp = await setup({ approvals: vi.fn().mockResolvedValue({ items: [approval('a'), approval('b')], syncUntil }) });
    const first = (await firstApp.app.inject('/api/v1/approvals?corpId=corp-1&limit=1')).json();
    await firstApp.app.close();
    const other = await setup({ approvals: vi.fn().mockResolvedValue({ items: [approval('b')], syncUntil }) });
    const response = await other.app.inject(`/api/v1/approvals?corpId=corp-1&cursor=${first.pagination.nextCursor}`);
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([approval('b')]);
    expect(other.dependencies.approvals).toHaveBeenCalledWith(expect.objectContaining({
      position: { updatedAt, processInstanceId: 'a' }, syncUntil,
    }));
  });

  it('rejects a cursor if the shared signing configuration was rotated', async () => {
    const firstApp = await setup({ approvals: vi.fn().mockResolvedValue({ items: [approval('a'), approval('b')], syncUntil }) });
    const first = (await firstApp.app.inject('/api/v1/approvals?corpId=corp-1&limit=1')).json();
    const other = await setup({ cursorSecret: Buffer.alloc(32, 2) });
    const response = await other.app.inject(`/api/v1/approvals?corpId=corp-1&cursor=${first.pagination.nextCursor}`);
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('INVALID_CURSOR');
    expect(other.dependencies.approvals).not.toHaveBeenCalled();
  });

  it('streams an active archived object without credentials and exposes preview quality honestly', async () => {
    const item = { ...attachment(), contentQuality: 'preview' };
    const { app, dependencies } = await setup({ attachment: vi.fn().mockResolvedValue(item) });
    const response = await app.inject({ url: '/api/v1/attachment-content?corpId=corp-1&processInstanceId=a&fileId=file-1' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('sample');
    expect(response.headers['content-disposition']).toContain('attachment; filename*=UTF-8');
    expect(response.headers['x-content-quality']).toBe('preview');
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(dependencies.attachment).toHaveBeenCalledWith({ corpId: 'corp-1', processInstanceId: 'a' }, 'file-1');
    expect(dependencies.openObject).toHaveBeenCalledWith(item.bucket, item.objectKey, expect.any(AbortSignal));
  });

  it.each([
    [undefined, 404], [{ ...attachment(), retiredAt: updatedAt }, 404],
    [{ ...attachment(), sourceDeletedAt: updatedAt }, 404],
    [{ ...attachment(), archiveStatus: 'pending' }, 409],
  ])('refuses missing/retired/deleted/pending downloads', async (item, status) => {
    const { app, dependencies } = await setup({ attachment: vi.fn().mockResolvedValue(item) });
    const response = await app.inject({ url: '/api/v1/attachment-content?corpId=corp-1&processInstanceId=a&fileId=file-1' });
    expect(response.statusCode).toBe(status);
    expect(dependencies.openObject).not.toHaveBeenCalled();
  });

  it('returns stable errors without exposing SQL or storage failure details', async () => {
    const { app } = await setup({
      approvals: vi.fn().mockRejectedValue(new Error('private SQL/credential')),
      openObject: vi.fn().mockRejectedValue(new Error('private MinIO/credential')),
    });
    const failed = await app.inject({ url: '/api/v1/approvals?corpId=corp-1' });
    expect(failed.json()).toEqual({ success: false, code: 'READ_UNAVAILABLE' });
    expect(failed.statusCode).toBe(503);
    const download = await app.inject({ url: '/api/v1/attachment-content?corpId=corp-1&processInstanceId=a&fileId=file-1' });
    expect(download.json()).toEqual({ success: false, code: 'ATTACHMENT_UNAVAILABLE' });
  });

  it.each(['approvals', 'attachments'])('rejects invalid timezone offsets before %s SQL', async resource => {
    const { app, dependencies } = await setup();
    for (const stamp of ['2026-10-29T01:00:00+99:99', '2026-10-29T01:00:00+25:00',
      '2026-10-29T01:00:00+08:75', '2026-10-29T01:00:00+16:00']) {
      const query = new URLSearchParams({ corpId: 'corp-1', updatedAfter: stamp });
      const response = await app.inject({ url: `/api/v1/${resource}?${query}` });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ success: false, code: 'INVALID_REQUEST' });
    }
    expect(dependencies.approvals).not.toHaveBeenCalled();
    expect(dependencies.attachments).not.toHaveBeenCalled();
  });

  const downloadUrl = '/api/v1/attachment-content?corpId=corp-1&processInstanceId=a&fileId=file-1';

  it('sanitizes asynchronous stream failures before the first byte, including automatic logs', async () => {
    const logs: string[] = [];
    const source = new Readable({ read() { this.destroy(new Error('PRIVATE_STORAGE_DETAIL')); } });
    const { app } = await setup({ openObject: async () => source }, logs);
    const response = await app.inject({ url: downloadUrl });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ success: false, code: 'ATTACHMENT_UNAVAILABLE' });
    expect(response.headers['content-disposition']).toBeUndefined();
    expect(response.headers['x-content-quality']).toBeUndefined();
    expect(source.destroyed).toBe(true);
    expect(logs.join('')).not.toContain('PRIVATE_STORAGE_DETAIL');
  });

  it('terminates a partial download without appending JSON or logging raw stream errors', async () => {
    const logs: string[] = [];
    let started = false;
    const source = new Readable({ read() {
      if (started) return;
      started = true;
      this.push('first chunk');
      setImmediate(() => this.destroy(new Error('PRIVATE_LATE_STORAGE_DETAIL')));
    } });
    const { app } = await setup({ openObject: async () => source }, logs);
    await expect(app.inject({ url: downloadUrl })).rejects.toThrow();
    expect(source.destroyed).toBe(true);
    expect(logs.join('')).not.toContain('PRIVATE_LATE_STORAGE_DETAIL');
  });

  it('aborts a stalled object open and destroys a stream returned after timeout', async () => {
    let signal: AbortSignal | undefined;
    let resolveOpen!: (stream: Readable) => void;
    const { app } = await setup({ downloadOpenTimeoutMs: 20,
      openObject: async (_bucket, _key, abort) => {
        signal = abort;
        return new Promise<Readable>(resolve => { resolveOpen = resolve; });
      },
    });
    const response = await app.inject({ url: downloadUrl });
    expect(response.statusCode).toBe(504);
    expect(response.json()).toEqual({ success: false, code: 'ATTACHMENT_TIMEOUT' });
    expect(signal?.aborted).toBe(true);
    const late = new Readable({ read() {} });
    resolveOpen(late);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(late.destroyed).toBe(true);
  });

  it('aborts an idle stream before the first byte with a stable timeout response', async () => {
    let signal: AbortSignal | undefined;
    const source = new Readable({ read() {} });
    const { app } = await setup({ downloadIdleTimeoutMs: 20,
      openObject: async (_bucket, _key, abort) => { signal = abort; return source; } });
    const response = await app.inject({ url: downloadUrl });
    expect(response.statusCode).toBe(504);
    expect(response.json()).toEqual({ success: false, code: 'ATTACHMENT_TIMEOUT' });
    expect(signal?.aborted).toBe(true);
    expect(source.destroyed).toBe(true);
  });

  it('terminates a partial file when the source stops producing chunks', async () => {
    let signal: AbortSignal | undefined;
    let started = false;
    const source = new Readable({ read() {
      if (!started) { started = true; this.push('partial file'); }
    } });
    const { app } = await setup({ downloadIdleTimeoutMs: 20,
      openObject: async (_bucket, _key, abort) => { signal = abort; return source; } });
    await expect(app.inject({ url: downloadUrl })).rejects.toThrow();
    expect(signal?.aborted).toBe(true);
    expect(source.destroyed).toBe(true);
  });

  it('enforces a total transfer deadline even while chunks keep resetting the idle timeout', async () => {
    let signal: AbortSignal | undefined;
    const source = new Readable({ read() {} });
    let timer: NodeJS.Timeout | undefined;
    const { app } = await setup({ downloadIdleTimeoutMs: 1000, downloadTotalTimeoutMs: 40,
      openObject: async (_bucket, _key, abort) => {
        signal = abort;
        timer = setInterval(() => source.push('chunk'), 5);
        source.once('close', () => clearInterval(timer));
        return source;
      } });
    try {
      await expect(app.inject({ url: downloadUrl })).rejects.toThrow();
      expect(signal?.aborted).toBe(true);
      expect(source.destroyed).toBe(true);
    } finally {
      clearInterval(timer);
    }
  });

  it('clears transfer deadlines when a normal download completes', async () => {
    let signal: AbortSignal | undefined;
    const { app } = await setup({ downloadOpenTimeoutMs: 20, downloadIdleTimeoutMs: 20, downloadTotalTimeoutMs: 30,
      openObject: async (_bucket, _key, abort) => { signal = abort; return Readable.from(['complete']); } });
    const response = await app.inject({ url: downloadUrl });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('complete');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(signal?.aborted).toBe(false);
  });

  it.each(['opening', 'streaming'])('cancels storage when the HTTP caller disconnects while %s', async phase => {
    let signal: AbortSignal | undefined;
    let onOpened!: () => void;
    let onAborted!: () => void;
    const opened = new Promise<void>(resolve => { onOpened = resolve; });
    const aborted = new Promise<void>(resolve => { onAborted = resolve; });
    const source = new Readable({ read() {} });
    const { app } = await setup({ openObject: async (_bucket, _key, abort) => {
      signal = abort;
      abort.addEventListener('abort', onAborted, { once: true });
      onOpened();
      if (phase === 'opening') return new Promise<Readable>(() => undefined);
      setImmediate(() => source.push('first chunk'));
      return source;
    } });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const request = httpRequest(`${address}${downloadUrl}`, {});
    request.on('error', () => undefined);
    const firstChunk = new Promise<void>(resolve => request.on('response', response => {
      response.on('error', () => undefined);
      response.once('data', () => resolve());
    }));
    request.end();
    try {
      await opened;
      if (phase === 'streaming') await firstChunk;
      request.destroy();
      await aborted;
      expect(signal?.aborted).toBe(true);
      if (phase === 'streaming') expect(source.destroyed).toBe(true);
    } finally {
      request.destroy();
    }
  });

  it('shares the source quota across routes without blocking another source and recovers after the window', async () => {
    let now = 0;
    const { app, dependencies } = await setup({ requestsPerMinute: 1, now: () => now });
    const request = { url: '/api/v1/approvals?corpId=corp-1', remoteAddress: '198.51.100.10' };
    expect((await app.inject(request)).statusCode).toBe(200);
    const limited = await app.inject({ url: '/api/v1/attachments?corpId=corp-2', remoteAddress: request.remoteAddress });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    expect((await app.inject({ url: '/api/v1/attachments?corpId=corp-2', remoteAddress: '198.51.100.20' })).statusCode).toBe(200);
    now = 60_000;
    expect((await app.inject(request)).statusCode).toBe(200);
    expect(dependencies.approvals).toHaveBeenCalledTimes(2);
  });

  it.each(['/api/v1/approvals', '/api/v1/approvals?corpId=corp-1&cursor=invalid',
    '/api/v1/attachment-content?corpId=corp-1'])('invalid input only consumes its own source budget: %s', async url => {
    const { app, dependencies } = await setup({ requestsPerMinute: 1, totalRequestsPerMinute: 1 });
    expect((await app.inject({ url, remoteAddress: '198.51.100.10' })).statusCode).toBe(400);
    expect((await app.inject({ url, remoteAddress: '198.51.100.10' })).statusCode).toBe(429);
    expect((await app.inject({ url: '/api/v1/approvals?corpId=corp-1', remoteAddress: '198.51.100.20' })).statusCode).toBe(200);
    expect(dependencies.approvals).toHaveBeenCalledOnce();
  });

  it('retains a separate total query budget across sources, lists and downloads', async () => {
    let now = 0;
    const { app, dependencies } = await setup({ totalRequestsPerMinute: 2, now: () => now });
    expect((await app.inject({ url: '/api/v1/approvals?corpId=corp-1', remoteAddress: '198.51.100.10' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/v1/attachments?corpId=corp-1', remoteAddress: '198.51.100.20' })).statusCode).toBe(200);
    const limited = await app.inject({ url: downloadUrl, remoteAddress: '198.51.100.30' });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    expect(dependencies.attachment).not.toHaveBeenCalled();
    now = 60_000;
    expect((await app.inject({ url: downloadUrl, remoteAddress: '198.51.100.30' })).statusCode).toBe(200);
  });
});
