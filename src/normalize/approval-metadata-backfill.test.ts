import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ query: vi.fn(), repair: vi.fn(), withClient: vi.fn(), transaction: vi.fn() }));
vi.mock('../db/pool.js', () => ({ withClient: state.withClient, withTransaction: state.transaction }));
vi.mock('../db/queries/approval-enrichment.js', () => ({ repairApprovalMetadata: state.repair }));
import { backfillApprovalMetadata } from './approval-metadata-backfill.js';

describe('bounded approval metadata backfill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.withClient.mockImplementation(run => run({ query: state.query }));
    state.transaction.mockImplementation(run => run({ query: state.query }));
    state.repair.mockResolvedValue({ instances: 0, tasks: 0 });
  });
  it('defaults to preview and advances past unrepairable rows without an endless loop', async () => {
    state.query.mockResolvedValueOnce({ rows: [{ process_instance_id: 'a' }] })
      .mockResolvedValueOnce({ rows: [{ process_instance_id: 'b' }] }).mockResolvedValueOnce({ rows: [] });
    expect(await backfillApprovalMetadata('corp-a', { batchSize: 1 })).toEqual({ scanned: 2, instances: 0, tasks: 0, dryRun: true });
    expect(state.transaction).not.toHaveBeenCalled();
    expect(state.query.mock.calls.map(call => call[1])).toEqual([['corp-a', '', null, 1], ['corp-a', 'a', null, 1], ['corp-a', 'b', null, 1]]);
    expect(state.repair).toHaveBeenLastCalledWith(expect.anything(), 'corp-a', ['b'], true);
  });
  it('uses transactions only when applying an explicitly scoped repair', async () => {
    state.query.mockResolvedValueOnce({ rows: [{ process_instance_id: 'a' }] }).mockResolvedValueOnce({ rows: [] });
    state.repair.mockResolvedValue({ instances: 1, tasks: 3 });
    expect(await backfillApprovalMetadata('corp-a', { dryRun: false, instanceId: 'a' })).toMatchObject({ instances: 1, tasks: 3 });
    expect(state.transaction).toHaveBeenCalledOnce();
    expect(state.query.mock.calls[0][1]).toEqual(['corp-a', '', 'a', 100]);
  });
  it('rejects missing enterprise scopes and unbounded batches before accessing the database', async () => {
    await expect(backfillApprovalMetadata('')).rejects.toThrow('APPROVAL_METADATA_SCOPE_INVALID');
    await expect(backfillApprovalMetadata('corp-a', { batchSize: 201 })).rejects.toThrow('APPROVAL_METADATA_SCOPE_INVALID');
    expect(state.withClient).not.toHaveBeenCalled();
  });
});
