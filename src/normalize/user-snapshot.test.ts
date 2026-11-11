import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getUser, upsertSnapshot, recordFetchFailure, hasEffectiveUserDeparture } = vi.hoisted(() => ({
  getUser: vi.fn(),
  upsertSnapshot: vi.fn(),
  recordFetchFailure: vi.fn(),
  hasEffectiveUserDeparture: vi.fn(),
}));

vi.mock('../dingtalk/api-client.js', () => ({ getUser }));
vi.mock('../db/queries/user-snapshot.js', () => ({ upsertSnapshot, recordFetchFailure }));
vi.mock('../db/queries/user-departure.js', () => ({ hasEffectiveUserDeparture }));

import { classifyUserFetchFailure, extractUserUnionId, processUserSnapshot } from './user-snapshot.js';

afterEach(() => vi.useRealTimers());

describe('user snapshot unionId synchronization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    upsertSnapshot.mockResolvedValue({ inserted: true, snapshot: {} });
    recordFetchFailure.mockResolvedValue(undefined);
    hasEffectiveUserDeparture.mockReset().mockResolvedValue(false);
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

  it('classifies the observed 60121 could-not-be-found wording without recording a failed profile', async () => {
    getUser.mockRejectedValueOnce(new Error('oapi 错误: 60121 The user could not be found'));
    await processUserSnapshot('corp-test', 'not-found-user');
    expect(recordFetchFailure).toHaveBeenCalledWith(expect.objectContaining({ fetch_status: 'not_found' }));
    expect(upsertSnapshot).not.toHaveBeenCalled();
    expect(classifyUserFetchFailure(new Error('HTTP 500')).fetch_status).toBe('failed');
  });

  it('does not replay cached user data over a newer profile written elsewhere', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-10T00:00:00Z'));
    getUser.mockResolvedValue({ userid: 'cache-user', name: '旧资料' });
    await processUserSnapshot('corp-test', 'cache-user');
    await processUserSnapshot('corp-test', 'cache-user');
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(upsertSnapshot).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3_600_001);
    getUser.mockResolvedValue({ userid: 'cache-user', name: '新资料' });
    await processUserSnapshot('corp-test', 'cache-user');
    expect(upsertSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ name: '新资料' }));
  });

  it('coalesces simultaneous fetches for one user and caps global API concurrency at two', async () => {
    let active = 0, peak = 0;
    getUser.mockImplementation(async (userid: string) => {
      active++; peak = Math.max(peak, active);
      await new Promise<void>(resolve => setImmediate(resolve));
      active--; return { userid, name: userid };
    });
    await Promise.all(['queue-a', 'queue-a', 'queue-b', 'queue-c', 'queue-d'].map(id => processUserSnapshot('corp-queue', id)));
    expect(getUser).toHaveBeenCalledTimes(4);
    expect(peak).toBe(2);
  });

  it('retries saving after a database failure instead of caching unsaved data', async () => {
    getUser.mockResolvedValue({ userid: 'retry-user', name: '测试资料' });
    upsertSnapshot.mockRejectedValueOnce(new Error('database unavailable'));
    await processUserSnapshot('corp-test', 'retry-user');
    await processUserSnapshot('corp-test', 'retry-user');
    expect(getUser).toHaveBeenCalledTimes(2);
    expect(upsertSnapshot).toHaveBeenCalledTimes(2);
    expect(recordFetchFailure).not.toHaveBeenCalled();
  });

  it('skips requests and writes for an effective departure while refreshing the same ID in another enterprise', async () => {
    hasEffectiveUserDeparture.mockImplementation(async corpId => corpId === 'corp-departure');
    getUser.mockResolvedValue({ userid: 'departed-user', name: 'Other enterprise' });
    await processUserSnapshot('corp-departure', 'departed-user');
    expect(getUser).not.toHaveBeenCalled();
    expect(upsertSnapshot).not.toHaveBeenCalled();
    expect(recordFetchFailure).not.toHaveBeenCalled();

    await processUserSnapshot('corp-other', 'departed-user');
    expect(getUser).toHaveBeenCalledOnce();
    expect(upsertSnapshot).toHaveBeenCalledWith(expect.objectContaining({ corp_id: 'corp-other' }));
  });

  it.each(['success', 'failed'])('discards a %s response when departure takes effect during the request', async status => {
    hasEffectiveUserDeparture.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    if (status === 'success') getUser.mockResolvedValueOnce({ userid: 'during-request', name: 'Old name' });
    else getUser.mockRejectedValueOnce(new Error('oapi 错误: 60121 The user could not be found'));
    await processUserSnapshot('corp-departure', 'during-request');
    expect(getUser).toHaveBeenCalledOnce();
    expect(upsertSnapshot).not.toHaveBeenCalled();
    expect(recordFetchFailure).not.toHaveBeenCalled();
  });
});
