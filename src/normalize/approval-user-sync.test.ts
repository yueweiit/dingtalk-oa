import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ process: vi.fn(), repair: vi.fn(), transaction: vi.fn(), client: {} }));
vi.mock('./user-snapshot.js', () => ({ processUserSnapshot: state.process }));
vi.mock('../db/queries/approval-enrichment.js', () => ({ repairApprovalMetadata: state.repair }));
vi.mock('../db/pool.js', () => ({ withTransaction: state.transaction }));
import { syncApprovalUsers } from './approval-user-sync.js';

describe('approval participant profile synchronization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.process.mockResolvedValue(undefined);
    state.repair.mockResolvedValue({ instances: 1, tasks: 2 });
    state.transaction.mockImplementation(run => run(state.client));
  });
  it('includes distinct approvers and re-reads stored profiles even after cached or unsuccessful API calls', async () => {
    await syncApprovalUsers('corp-a', 'instance-a', ['originator', 'approver', 'approver', '']);
    expect(state.process.mock.calls).toEqual([['corp-a', 'originator'], ['corp-a', 'approver']]);
    expect(state.repair).toHaveBeenCalledWith(state.client, 'corp-a', ['instance-a']);
    expect(state.repair.mock.invocationCallOrder[0]).toBeGreaterThan(state.process.mock.invocationCallOrder[1]);
  });
  it('still repairs from stored successful profiles if one participant refresh unexpectedly fails', async () => {
    state.process.mockRejectedValueOnce(new Error('synthetic refresh failure'));
    await syncApprovalUsers('corp-a', 'instance-a', ['failed-user', 'available-user']);
    expect(state.process).toHaveBeenCalledTimes(2);
    expect(state.repair).toHaveBeenCalledOnce();
  });
});
