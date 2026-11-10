import type pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { client, withTransaction, withClient } = vi.hoisted(() => ({
  client: { query: vi.fn() }, withTransaction: vi.fn(), withClient: vi.fn(),
}));
vi.mock('../pool.js', () => ({ withTransaction, withClient }));
import { getCurrentSnapshot, recordFetchFailure, upsertSnapshot } from './user-snapshot.js';

const failure = { corp_id: 'corp-test', user_id: 'user-test', fetch_status: 'not_found',
  fetch_error: 'oapi 错误: 60121 The user could not be found' };
const profile = { corp_id: 'corp-test', user_id: 'user-test', name: '测试人员', snapshot_hash: 'hash-new' };
const changedAt = '2026-11-10 08:00:00.123456+08';

beforeEach(() => {
  client.query.mockReset();
  withTransaction.mockReset().mockImplementation(run => run(client));
  withClient.mockReset().mockImplementation(run => run(client));
});

describe('successful user snapshots', () => {
  it('uses a transaction and user lock before comparing the existing successful version', async () => {
    const current = { id: 1, snapshot_hash: profile.snapshot_hash, union_id: null };
    client.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [current] });
    expect(await upsertSnapshot(profile)).toEqual({ inserted: false, snapshot: current });
    expect(withTransaction).toHaveBeenCalledOnce();
    expect(withClient).not.toHaveBeenCalled();
    expect(client.query.mock.calls[0]).toEqual([
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', ['corp-test', 'user-test'],
    ]);
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.query.mock.calls[1][0]).toContain("fetch_status = 'success'");
  });

  it('inserts the first successful version without failure placeholders', async () => {
    client.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ changed_at: changedAt }] }).mockResolvedValueOnce({ rows: [{ id: 2 }] });
    expect((await upsertSnapshot(profile)).inserted).toBe(true);
    const [sql, values] = client.query.mock.calls[3];
    expect(sql).toContain('INSERT INTO ding_user_snapshot');
    expect(values.slice(8, 10)).toEqual(['success', null]);
    expect(values[11]).toBe(changedAt);
    expect(client.query.mock.calls.some(([statement]) => statement.includes('ding_user_fetch_failure'))).toBe(false);
  });

  it('switches versions at the same timestamp inside the transaction and retains a known unionId', async () => {
    client.query.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 1, snapshot_hash: 'hash-old', union_id: 'known-union' }] })
      .mockResolvedValueOnce({ rows: [{ changed_at: changedAt }] }).mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 2 }] });
    await upsertSnapshot(profile);
    expect(client.query.mock.calls[3][1]).toEqual([1, changedAt]);
    expect(client.query.mock.calls[4][1][2]).toBe('known-union');
    expect(client.query.mock.calls[4][1][11]).toBe(changedAt);
  });

  it('adds unionId without manufacturing another content version', async () => {
    client.query.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 1, snapshot_hash: profile.snapshot_hash, union_id: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 1, union_id: 'new-union' }] });
    expect(await upsertSnapshot({ ...profile, union_id: 'new-union' })).toMatchObject({
      inserted: false, unionIdUpdated: true, snapshot: { id: 1, union_id: 'new-union' },
    });
    expect(client.query).toHaveBeenCalledTimes(3);
  });

  it('propagates an insert failure to the transaction wrapper so closing the old row can roll back', async () => {
    client.query.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 1, snapshot_hash: 'old' }] })
      .mockResolvedValueOnce({ rows: [{ changed_at: changedAt }] }).mockResolvedValueOnce({ rowCount: 1 })
      .mockRejectedValueOnce(new Error('insert failed'));
    await expect(upsertSnapshot(profile)).rejects.toThrow('insert failed');
    expect(withTransaction).toHaveBeenCalledOnce();
  });

  it('reuses an explicitly supplied transaction client', async () => {
    client.query.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 1, snapshot_hash: profile.snapshot_hash }] });
    await upsertSnapshot(profile, client as unknown as pg.PoolClient);
    expect(withTransaction).not.toHaveBeenCalled();
    expect(withClient).not.toHaveBeenCalled();
  });

  it('rejects attempts to put failures back into the snapshot table', async () => {
    await expect(upsertSnapshot({ ...profile, fetch_status: 'failed' })).rejects.toThrow('USER_SNAPSHOT_REQUIRES_SUCCESS');
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('reads only a successful current profile, preserving the public return contract', async () => {
    client.query.mockResolvedValue({ rows: [{ id: 1, name: '测试人员' }] });
    expect(await getCurrentSnapshot('corp-test', 'user-test')).toMatchObject({ id: 1 });
    expect(client.query.mock.calls[0][1]).toEqual(['corp-test', 'user-test']);
    expect(client.query.mock.calls[0][0]).toContain("is_current = true AND fetch_status = 'success'");
  });
});

describe('separate user fetch failure history', () => {
  it('increments the latest identical failure without modifying the last successful profile', async () => {
    client.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [{ id: '42', fetch_status: failure.fetch_status, fetch_error: failure.fetch_error }],
    }).mockResolvedValueOnce({ rowCount: 1 });
    await recordFetchFailure(failure);
    expect(client.query).toHaveBeenCalledTimes(3);
    expect(client.query.mock.calls[2][0]).toContain('failure_count = failure_count + 1');
    for (const [sql] of client.query.mock.calls) expect(sql).not.toContain('ding_user_snapshot');
  });

  it.each([[], [{ id: '41', fetch_status: 'failed', fetch_error: 'earlier error' }]])(
    'retains error changes as another failure entry: %j', async (...rows) => {
      client.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows }).mockResolvedValueOnce({ rowCount: 1 });
      await recordFetchFailure(failure);
      expect(client.query.mock.calls[2][0]).toContain('INSERT INTO ding_user_fetch_failure');
      expect(client.query.mock.calls[2][1]).toEqual([
        failure.corp_id, failure.user_id, failure.fetch_status, failure.fetch_error,
      ]);
      for (const [sql] of client.query.mock.calls) expect(sql).not.toContain('ding_user_snapshot');
    });

  it('rejects success statuses in the failure log', async () => {
    await expect(recordFetchFailure({ ...failure, fetch_status: 'success' })).rejects.toThrow('USER_FETCH_FAILURE_STATUS_INVALID');
    expect(withTransaction).not.toHaveBeenCalled();
  });
});
