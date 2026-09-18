import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getUser, upsertSnapshot, recordFetchFailure } = vi.hoisted(() => ({
  getUser: vi.fn(),
  upsertSnapshot: vi.fn(),
  recordFetchFailure: vi.fn(),
}));

vi.mock('../dingtalk/api-client.js', () => ({ getUser }));
vi.mock('../db/queries/user-snapshot.js', () => ({ upsertSnapshot, recordFetchFailure }));

import { extractUserUnionId, processUserSnapshot } from './user-snapshot.js';

describe('user snapshot unionId synchronization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    upsertSnapshot.mockResolvedValue({ inserted: true, snapshot: {} });
    recordFetchFailure.mockResolvedValue(undefined);
  });

  it.each([
    ['union_id', { union_id: 'snake-case' }, 'snake-case'],
    ['unionId', { unionId: 'camel-case' }, 'camel-case'],
    ['unionid', { unionid: 'legacy-case' }, 'legacy-case'],
  ])('extracts %s from a user payload', (_key, payload, expected) => {
    expect(extractUserUnionId(payload)).toBe(expected);
  });

  it('passes union_id to the snapshot writer', async () => {
    getUser.mockResolvedValue({
      userid: 'user-1',
      name: 'User 1',
      dept_id_list: ['1'],
      unionid: 'union-1',
    });

    await processUserSnapshot('corp-1', 'user-1');

    expect(upsertSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      corp_id: 'corp-1',
      user_id: 'user-1',
      union_id: 'union-1',
      raw_payload: expect.objectContaining({ unionid: 'union-1' }),
    }));
  });
});
