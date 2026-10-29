import { describe, expect, it } from 'vitest';
import { readApiClientsSchema } from './config.js';
import { decodeCursor, encodeCursor, timestampSchema } from './pagination.js';

const client = { clientId: 'erp', tokenSha256: 'a'.repeat(64), corpIds: ['corp-1'], processCodes: ['PROC-1'] };
describe('approval read credential configuration', () => {
  it('defaults to disabled and accepts only digests with explicit corporate access', () => {
    expect(readApiClientsSchema.parse(undefined)).toEqual([]);
    expect(readApiClientsSchema.parse(JSON.stringify([client]))).toEqual([client]);
    for (const value of ['{', '{}', JSON.stringify([{ ...client, tokenSha256: 'plaintext' }]),
      JSON.stringify([{ ...client, corpIds: [] }]), JSON.stringify([{ ...client, processCodes: [] }]),
      JSON.stringify([client, client]), JSON.stringify([{ ...client, token: 'do-not-echo' }])]) {
      const result = readApiClientsSchema.safeParse(value);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).not.toContain('do-not-echo');
    }
  });
  it('invalidates cursors when the caller or authorization policy changes', () => {
    const filters = { corpId: 'corp-1' };
    const cursor = encodeCursor(client, 'approvals', filters, '2026-10-29T00:00:00.999999Z', {
      updatedAt: '2026-10-29T00:00:00.123456Z', processInstanceId: 'a',
    }, 1000);
    expect(decodeCursor(cursor, client, 'approvals', filters, 0).position.updatedAt).toBe('2026-10-29T00:00:00.123456Z');
    for (const other of [{ ...client, clientId: 'other' }, { ...client, corpIds: ['corp-1', 'corp-2'] },
      { ...client, processCodes: ['PROC-2'] }, { ...client, tokenSha256: 'b'.repeat(64) }]) {
      expect(() => decodeCursor(cursor, other, 'approvals', filters, 0)).toThrow();
    }
  });
});

describe('approval read timestamps', () => {
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

});
