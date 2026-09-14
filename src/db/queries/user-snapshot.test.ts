import { beforeEach, describe, expect, it, vi } from 'vitest';

const { client, withTransaction } = vi.hoisted(() => ({
  client: { query: vi.fn() },
  withTransaction: vi.fn(),
}));

vi.mock('../pool.js', () => ({ withTransaction }));

import { recordFetchFailure } from './user-snapshot.js';

const failure = {
  corp_id: 'corp-1',
  user_id: 'user-1',
  fetch_status: 'not_found',
  fetch_error: 'oapi 错误: 60121 The user could not be found',
};

describe('recordFetchFailure', () => {
  beforeEach(() => {
    client.query.mockReset();
    withTransaction.mockReset();
    withTransaction.mockImplementation(async (run: (dbClient: typeof client) => Promise<unknown>) => {
      await run(client);
    });
  });

  it('相同用户和错误已有当前失败快照时只更新时间', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [] }) // advisory lock
      .mockResolvedValueOnce({
        rows: [{ id: 42, fetch_status: failure.fetch_status, fetch_error: failure.fetch_error }],
      })
      .mockResolvedValueOnce({ rowCount: 1 });

    await recordFetchFailure(failure);

    expect(client.query).toHaveBeenCalledTimes(3);
    expect(client.query.mock.calls[2][0]).toContain('SET updated_at = now()');
    expect(client.query.mock.calls[2][0]).not.toContain('valid_to');
  });

  it('没有相同当前失败快照时关闭旧记录并插入新失败快照', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [] }) // advisory lock
      .mockResolvedValueOnce({ rows: [{ id: 41, fetch_status: 'success', fetch_error: null }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });

    await recordFetchFailure(failure);

    expect(client.query).toHaveBeenCalledTimes(4);
    expect(client.query.mock.calls[2][0]).toContain('valid_to = now()');
    expect(client.query.mock.calls[3][0]).toContain('INSERT INTO ding_user_snapshot');
  });
});
