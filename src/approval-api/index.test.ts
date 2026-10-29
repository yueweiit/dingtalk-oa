import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApprovalReadRoutes, type ReadApiDependencies } from './index.js';
import type { ApprovalReadItem, AttachmentReadItem, DownloadAttachment } from '../db/queries/approval-read-api.js';
import type { ReadApiClient } from './config.js';

const token = 'a'.repeat(43);
const client: ReadApiClient = {
  clientId: 'erp', tokenSha256: createHash('sha256').update(token).digest('hex'),
  corpIds: ['corp-1'], processCodes: ['PROC-1'],
};
const updatedAt = '2026-10-29T01:02:03.123456Z';
const syncUntil = '2026-10-29T01:03:00.654321Z';
const authorization = { authorization: `Bearer ${token}` };
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
    clients: [client], requestsPerMinute: 120,
    approvals: vi.fn().mockResolvedValue({ items: [approval('a')], syncUntil }),
    attachments: vi.fn().mockResolvedValue({ items: [], syncUntil }),
    attachment: vi.fn().mockResolvedValue(attachment()),
    openObject: vi.fn().mockImplementation(async () => Readable.from([Buffer.from('sample')])),
    now: () => Date.parse('2026-10-29T02:00:00Z'), ...overrides,
  };
  const app = Fastify({ logger: logs ? { stream: { write: (line: string) => { logs.push(line); } } } : false });
  apps.push(app);
  await app.register(createApprovalReadRoutes(dependencies));
  // The auth hook is encapsulated, so unrelated routes retain their previous behavior.
  app.get('/health', async () => ({ status: 'ok' }));
  return { app, dependencies };
}

describe('approval archive read API', () => {
  it('fails closed when disabled and never queries storage before authentication', async () => {
    const { app, dependencies } = await setup({ clients: [] });
    expect((await app.inject('/api/v1/approvals?corpId=corp-1')).statusCode).toBe(503);
    expect(dependencies.approvals).not.toHaveBeenCalled();
    expect((await app.inject('/health')).statusCode).toBe(200);
  });

  it.each([
    undefined, 'Bearer wrong', `Basic ${token}`, `Bearer ${'b'.repeat(43)}`,
  ])('rejects missing or incorrect bearer credentials: %s', async value => {
    const { app, dependencies } = await setup();
    const response = await app.inject({ url: '/api/v1/approvals?corpId=corp-1',
      headers: value ? { authorization: value } : {} });
    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toContain('Bearer');
    expect(dependencies.approvals).not.toHaveBeenCalled();
  });

  it('rejects credentials in query strings and restricts both corp and process filters', async () => {
    const { app, dependencies } = await setup();
    for (const url of ['/api/v1/approvals?corpId=corp-2',
      '/api/v1/attachments?corpId=corp-1&processCode=PRIVATE',
      '/api/v1/attachment-content?corpId=corp-2&processInstanceId=a&fileId=file-1']) {
      expect((await app.inject({ url, headers: authorization })).statusCode).toBe(403);
    }
    expect((await app.inject({ url: `/api/v1/approvals?corpId=corp-1&token=${token}`,
      headers: authorization })).statusCode).toBe(400);
    expect(dependencies.approvals).not.toHaveBeenCalled();
    expect(dependencies.attachments).not.toHaveBeenCalled();
    expect(dependencies.attachment).not.toHaveBeenCalled();
  });

  it('keeps credentials and raw query strings out of automatic HTTP access logs', async () => {
    const logs: string[] = [];
    const { app } = await setup({}, logs);
    await app.inject({ url: `/api/v1/approvals?corpId=corp-1&token=${token}`, headers: authorization });
    await app.inject({ url: '/api/v1/approvals?corpId=corp-1', headers: authorization });
    expect(logs.join('\n')).toContain('Approval read API');
    expect(logs.join('\n')).not.toContain(token);
    expect(logs.join('\n')).not.toContain('?corpId=');
    expect(logs.join('\n')).not.toContain('rawPayload');
  });

  it.each(['', '&limit=0', '&limit=201', '&limit=abc', '&updatedAfter=2026-10-29', '&limit=1.2'])
    ('validates bounded pagination and timezone-bearing timestamps: %s', async suffix => {
      const { app, dependencies } = await setup();
      const response = await app.inject({ url: suffix ? `/api/v1/approvals?corpId=corp-1${suffix}`
        : '/api/v1/approvals', headers: authorization });
      expect(response.statusCode).toBe(400);
      expect(dependencies.approvals).not.toHaveBeenCalled();
    });

  it('returns full source JSON, names, business IDs, tombstones and an exact microsecond cursor', async () => {
    const deleted = { ...approval('a'), deletedAt: updatedAt };
    const read = vi.fn().mockResolvedValueOnce({ items: [deleted, approval('b')], syncUntil })
      .mockResolvedValueOnce({ items: [approval('b')], syncUntil });
    const { app } = await setup({ approvals: read });
    const base = '/api/v1/approvals?corpId=corp-1&limit=1&updatedAfter=2026-10-01T00%3A00%3A00Z';
    const first = (await app.inject({ url: base, headers: authorization })).json();
    expect(first.data).toEqual([deleted]);
    expect(first.pagination).toMatchObject({ limit: 1, hasMore: true, syncUntil });
    const second = (await app.inject({ url: `${base}&cursor=${first.pagination.nextCursor}`, headers: authorization })).json();
    expect(read.mock.calls[1][0]).toMatchObject({
      client, filters: { corpId: 'corp-1', updatedAfter: '2026-10-01T00:00:00Z' },
      position: { updatedAt, processInstanceId: 'a' }, syncUntil,
    });
    expect(second.data.map((row: ApprovalReadItem) => row.processInstanceId)).toEqual(['b']);
    expect(second.pagination).toMatchObject({ nextCursor: null, hasMore: false, syncUntil });
  });

  it('rejects tampered, foreign-resource, foreign-filter and expired cursors before SQL', async () => {
    let now = Date.parse('2026-10-29T02:00:00Z');
    const read = vi.fn().mockResolvedValue({ items: [approval('a'), approval('b')], syncUntil });
    const { app } = await setup({ approvals: read, now: () => now });
    const first = (await app.inject({ url: '/api/v1/approvals?corpId=corp-1&limit=1', headers: authorization })).json();
    const cursor = first.pagination.nextCursor as string;
    for (const url of [
      `/api/v1/approvals?corpId=corp-1&cursor=${cursor.slice(0, -1)}${cursor.endsWith('0') ? '1' : '0'}`,
      `/api/v1/attachments?corpId=corp-1&cursor=${cursor}`,
      `/api/v1/approvals?corpId=corp-1&processCode=PROC-1&cursor=${cursor}`,
      '/api/v1/approvals?corpId=corp-1&cursor=invalid',
    ]) {
      const response = await app.inject({ url, headers: authorization });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('INVALID_CURSOR');
    }
    now += 24 * 60 * 60_000;
    expect((await app.inject({ url: `/api/v1/approvals?corpId=corp-1&cursor=${cursor}`,
      headers: authorization })).json().code).toBe('INVALID_CURSOR');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('paginates tied attachment timestamps with file ID and retains retirement markers', async () => {
    const a = attachment('a');
    const retired = { ...attachment('b'), retiredAt: updatedAt };
    const read = vi.fn().mockResolvedValueOnce({ items: [a, retired], syncUntil })
      .mockResolvedValueOnce({ items: [retired], syncUntil });
    const { app } = await setup({ attachments: read });
    const base = '/api/v1/attachments?corpId=corp-1&limit=1';
    const first = await app.inject({ url: base, headers: authorization });
    const payload = first.json();
    expect(payload.data[0].downloadPath).toContain('fileId=a');
    expect(first.headers['cache-control']).toBe('no-store');
    const second = (await app.inject({ url: `${base}&cursor=${payload.pagination.nextCursor}`, headers: authorization })).json();
    expect(read.mock.calls[1][0].position).toEqual({ updatedAt, processInstanceId: 'a', fileId: 'a' });
    expect(second.data[0]).toMatchObject({ retiredAt: updatedAt, downloadPath: null });
  });

  it('streams only an authorized active archived object and exposes preview quality honestly', async () => {
    const item = { ...attachment(), contentQuality: 'preview' };
    const { app, dependencies } = await setup({ attachment: vi.fn().mockResolvedValue(item) });
    const response = await app.inject({ url: '/api/v1/attachment-content?corpId=corp-1&processInstanceId=a&fileId=file-1',
      headers: authorization });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('sample');
    expect(response.headers['content-disposition']).toContain('attachment; filename*=UTF-8');
    expect(response.headers['x-content-quality']).toBe('preview');
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(dependencies.attachment).toHaveBeenCalledWith(client, { corpId: 'corp-1', processInstanceId: 'a' }, 'file-1');
    expect(dependencies.openObject).toHaveBeenCalledWith(item.bucket, item.objectKey);
  });

  it.each([
    [undefined, 404], [{ ...attachment(), retiredAt: updatedAt }, 404],
    [{ ...attachment(), sourceDeletedAt: updatedAt }, 404],
    [{ ...attachment(), archiveStatus: 'pending' }, 409],
  ])('refuses missing/retired/deleted/pending downloads', async (item, status) => {
    const { app, dependencies } = await setup({ attachment: vi.fn().mockResolvedValue(item) });
    const response = await app.inject({ url: '/api/v1/attachment-content?corpId=corp-1&processInstanceId=a&fileId=file-1',
      headers: authorization });
    expect(response.statusCode).toBe(status);
    expect(dependencies.openObject).not.toHaveBeenCalled();
  });

  it('returns stable errors without exposing SQL or storage failure details', async () => {
    const { app } = await setup({
      approvals: vi.fn().mockRejectedValue(new Error('private SQL/credential')),
      openObject: vi.fn().mockRejectedValue(new Error('private MinIO/credential')),
    });
    const failed = await app.inject({ url: '/api/v1/approvals?corpId=corp-1', headers: authorization });
    expect(failed.json()).toEqual({ success: false, code: 'READ_UNAVAILABLE' });
    expect(failed.statusCode).toBe(503);
    const download = await app.inject({ url: '/api/v1/attachment-content?corpId=corp-1&processInstanceId=a&fileId=file-1',
      headers: authorization });
    expect(download.json()).toEqual({ success: false, code: 'ATTACHMENT_UNAVAILABLE' });
  });

  it('enforces a per-client request quota and recovers after the window', async () => {
    let now = 0;
    const { app, dependencies } = await setup({ requestsPerMinute: 1, now: () => now });
    const request = { url: '/api/v1/approvals?corpId=corp-1', headers: authorization };
    expect((await app.inject(request)).statusCode).toBe(200);
    const limited = await app.inject(request);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    now = 60_000;
    expect((await app.inject(request)).statusCode).toBe(200);
    expect(dependencies.approvals).toHaveBeenCalledTimes(2);
  });
});
