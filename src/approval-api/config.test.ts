import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, timestampSchema } from './pagination.js';
import { configSchema } from '../config/schema.js';
import { resolveCursorSecret } from './cursor-key.js';

const minimum = { PGUSER: 'synthetic', PGPASSWORD: 'synthetic', PGDATABASE: 'synthetic',
  DINGTALK_APP_KEY: 'synthetic', DINGTALK_APP_SECRET: 'synthetic' };
describe('approval read configuration and cursors', () => {
  it('derives the same internal signing key from existing application configuration', () => {
    const first = resolveCursorSecret(configSchema.parse(minimum));
    const restarted = resolveCursorSecret(configSchema.parse({ ...minimum }));
    expect(first).toHaveLength(32);
    expect(first.equals(restarted)).toBe(true);
    expect(first.equals(resolveCursorSecret(configSchema.parse({ ...minimum, DINGTALK_APP_SECRET: 'rotated' })))).toBe(false);
  });

  it('accepts an optional shared cursor secret independently from DingTalk credentials', () => {
    const explicit = { ...minimum, APPROVAL_READ_API_CURSOR_SECRET: 'a'.repeat(32) };
    const first = resolveCursorSecret(configSchema.parse(explicit));
    expect(first.equals(resolveCursorSecret(configSchema.parse({ ...explicit, DINGTALK_APP_SECRET: 'rotated' })))).toBe(true);
    expect(first.equals(resolveCursorSecret(configSchema.parse({ ...explicit, APPROVAL_READ_API_CURSOR_SECRET: 'b'.repeat(32) })))).toBe(false);
    expect(configSchema.parse({ ...minimum, APPROVAL_READ_API_CURSOR_SECRET: '' }).APPROVAL_READ_API_CURSOR_SECRET).toBeUndefined();
    for (const value of ['short', 'a'.repeat(257)]) {
      const result = configSchema.safeParse({ ...minimum, APPROVAL_READ_API_CURSOR_SECRET: value });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).not.toContain(value);
    }
    expect(() => resolveCursorSecret({ DINGTALK_APP_SECRET: '', APPROVAL_READ_API_CURSOR_SECRET: undefined })).toThrow('CURSOR_SIGNING_KEY_REQUIRED');
  });

  it('defaults to untrusted forwarding headers and accepts only explicit proxy IPs/CIDRs', () => {
    expect(configSchema.parse(minimum).HTTP_TRUSTED_PROXIES).toEqual([]);
    expect(configSchema.parse({ ...minimum, HTTP_TRUSTED_PROXIES: '127.0.0.1, ::1,10.2.3.0/24,2001:db8::/64' }).HTTP_TRUSTED_PROXIES)
      .toEqual(['127.0.0.1', '::1', '10.2.3.0/24', '2001:db8::/64']);
    for (const value of ['true', '*', '2', 'localhost', '127.0.0.1/0', '127.0.0.1/33', '::1/129', '127.0.0.1/24/8']) {
      expect(configSchema.safeParse({ ...minimum, HTTP_TRUSTED_PROXIES: value }).success).toBe(false);
    }
  });

  it('provides separate bounded source and query-total budgets', () => {
    const config = configSchema.parse(minimum);
    expect(config.APPROVAL_READ_API_REQUESTS_PER_MINUTE).toBe(120);
    expect(config.APPROVAL_READ_API_TOTAL_REQUESTS_PER_MINUTE).toBe(1200);
    for (const value of [0, -1, 'invalid', 1_000_001]) {
      expect(configSchema.safeParse({ ...minimum, APPROVAL_READ_API_TOTAL_REQUESTS_PER_MINUTE: value }).success).toBe(false);
    }
  });

  it.each([undefined, '[]', 'invalid legacy configuration'])('ignores obsolete caller credentials: %s', value => {
    const config = configSchema.parse({ ...minimum, APPROVAL_READ_API_CLIENTS_JSON: value });
    expect(config).not.toHaveProperty('APPROVAL_READ_API_CLIENTS_JSON');
  });
  it('preserves microseconds and rejects cursors after the signing key changes', () => {
    const secret = Buffer.alloc(32, 1);
    const filters = { corpId: 'corp-1' };
    const cursor = encodeCursor(secret, 'approvals', filters, '2026-10-29T00:00:00.999999Z', {
      updatedAt: '2026-10-29T00:00:00.123456Z', processInstanceId: 'a',
    }, 1000);
    expect(decodeCursor(cursor, secret, 'approvals', filters, 0).position.updatedAt).toBe('2026-10-29T00:00:00.123456Z');
    expect(() => decodeCursor(cursor, Buffer.alloc(32, 2), 'approvals', filters, 0)).toThrow();
    expect(() => decodeCursor(cursor, secret, 'approvals', { corpId: 'corp-2' }, 0)).toThrow();
  });
});

describe('approval read timestamps and transfer limits', () => {
  it.each(['2026-10-29T01:00:00+99:99', '2026-10-29T01:00:00+25:00',
    '2026-10-29T01:00:00+08:75', '2026-10-29T01:00:00-16:00',
    '2026-02-30T01:00:00Z', '0000-01-01T00:00:00Z', '2026-10-29T01:00:00'])
    ('rejects an invalid timestamp: %s', value => {
      expect(timestampSchema.safeParse(value).success).toBe(false);
    });

  it.each(['2026-10-29T01:00:00.123456Z', '2026-10-29T01:00:00.123456+08:00',
    '2026-10-29T01:00:00-05:30', '2026-10-29T01:00:00+15:59', '2024-02-29T01:00:00Z'])
    ('keeps valid timezone and microsecond input verbatim: %s', value => {
      expect(timestampSchema.parse(value)).toBe(value);
    });

  it('supplies bounded, nonzero transfer timeout defaults', () => {
    const config = configSchema.parse(minimum);
    expect(config.APPROVAL_READ_API_DOWNLOAD_OPEN_TIMEOUT_MS).toBe(10000);
    expect(config.APPROVAL_READ_API_DOWNLOAD_IDLE_TIMEOUT_MS).toBe(30000);
    expect(config.APPROVAL_READ_API_DOWNLOAD_TOTAL_TIMEOUT_MS).toBe(300000);
    for (const name of ['APPROVAL_READ_API_DOWNLOAD_OPEN_TIMEOUT_MS',
      'APPROVAL_READ_API_DOWNLOAD_IDLE_TIMEOUT_MS', 'APPROVAL_READ_API_DOWNLOAD_TOTAL_TIMEOUT_MS']) {
      expect(configSchema.safeParse({ ...minimum, [name]: 0 }).success).toBe(false);
      expect(configSchema.safeParse({ ...minimum, [name]: 'invalid' }).success).toBe(false);
      expect(configSchema.safeParse({ ...minimum, [name]: 3600001 }).success).toBe(false);
    }
  });
});
