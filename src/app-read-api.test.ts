import { afterEach, expect, it, vi } from 'vitest';

const { config } = vi.hoisted(() => ({ config: {
  LOG_LEVEL: 'silent', APPROVAL_READ_API_REQUESTS_PER_MINUTE: 120,
  APPROVAL_READ_API_TOTAL_REQUESTS_PER_MINUTE: 1200,
  DINGTALK_APP_SECRET: 'synthetic-application-secret', HTTP_TRUSTED_PROXIES: [] as string[],
} }));
vi.mock('./config/index.js', () => ({ getConfig: () => config }));
vi.mock('./db/queries/approval-read-api.js', () => ({
  listReadApprovals: vi.fn().mockResolvedValue({ items: [], syncUntil: '2026-10-30T00:00:00.123456Z' }),
  listReadAttachments: vi.fn().mockResolvedValue({ items: [], syncUntil: '2026-10-30T00:00:00.123456Z' }),
  findReadAttachment: vi.fn().mockResolvedValue(undefined),
}));
import { createApp } from './app.js';

afterEach(() => { config.HTTP_TRUSTED_PROXIES = []; config.APPROVAL_READ_API_REQUESTS_PER_MINUTE = 120; });

it('registers all read routes without credentials and retains unrelated route behavior', async () => {
  const app = await createApp();
  try {
    for (const path of ['/api/v1/approvals?corpId=corp-1', '/api/v1/attachments?corpId=corp-1']) {
      const response = await app.inject({ url: path });
      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
      expect(response.headers['www-authenticate']).toBeUndefined();
    }
    expect((await app.inject('/api/v1/attachment-content?corpId=corp-1&processInstanceId=a&fileId=file-1')).statusCode).toBe(404);
    expect((await app.inject('/health/live')).json()).toEqual({ status: 'ok' });
    expect((await app.inject({ method: 'POST', url: '/webhook/approval', payload: {} })).statusCode).toBe(503);
    expect((await app.inject({ method: 'POST', url: '/connector/approval/approvers', payload: {} })).statusCode).toBe(400);
  } finally {
    await app.close();
  }
});

it('ignores forged forwarding headers by default, including on loopback connections', async () => {
  config.APPROVAL_READ_API_REQUESTS_PER_MINUTE = 1;
  const app = await createApp();
  const url = '/api/v1/approvals?corpId=corp-1';
  try {
    expect((await app.inject({ url, remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '198.51.100.10' } })).statusCode).toBe(200);
    expect((await app.inject({ url, remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '198.51.100.20' } })).statusCode).toBe(429);
    expect((await app.inject({ url, remoteAddress: '198.51.100.30' })).statusCode).toBe(200);
  } finally { await app.close(); }
});

it('isolates forwarded callers only through the configured trusted proxy and ignores forged prefixes', async () => {
  config.APPROVAL_READ_API_REQUESTS_PER_MINUTE = 1;
  config.HTTP_TRUSTED_PROXIES = ['127.0.0.1'];
  const app = await createApp();
  const url = '/api/v1/approvals?corpId=corp-1';
  try {
    expect((await app.inject({ url, remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '192.0.2.10, 198.51.100.10' } })).statusCode).toBe(200);
    expect((await app.inject({ url, remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '192.0.2.20, 198.51.100.10' } })).statusCode).toBe(429);
    expect((await app.inject({ url, remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '198.51.100.20' } })).statusCode).toBe(200);
    expect((await app.inject({ url, remoteAddress: '203.0.113.10', headers: { 'x-forwarded-for': '198.51.100.30' } })).statusCode).toBe(200);
    expect((await app.inject({ url, remoteAddress: '203.0.113.10', headers: { 'x-forwarded-for': '198.51.100.40' } })).statusCode).toBe(429);
  } finally { await app.close(); }
});
