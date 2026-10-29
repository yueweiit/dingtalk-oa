import { expect, it, vi } from 'vitest';

vi.mock('./config/index.js', () => ({ getConfig: () => ({
  LOG_LEVEL: 'silent', APPROVAL_READ_API_CLIENTS_JSON: [], APPROVAL_READ_API_REQUESTS_PER_MINUTE: 120,
}) }));
import { createApp } from './app.js';

it('registers all read routes as disabled by default without securing unrelated routes', async () => {
  const app = await createApp();
  try {
    for (const path of ['/api/v1/approvals', '/api/v1/attachments', '/api/v1/attachment-content']) {
      const response = await app.inject({ url: path });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ success: false, code: 'READ_API_DISABLED' });
    }
    expect((await app.inject('/health/live')).json()).toEqual({ status: 'ok' });
    expect((await app.inject({ method: 'POST', url: '/webhook/approval', payload: {} })).statusCode).toBe(503);
    expect((await app.inject({ method: 'POST', url: '/connector/approval/approvers', payload: {} })).statusCode).toBe(400);
  } finally {
    await app.close();
  }
});
