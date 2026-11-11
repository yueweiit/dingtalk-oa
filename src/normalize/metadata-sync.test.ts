import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  users: vi.fn(), departments: vi.fn(), getUser: vi.fn(), upsert: vi.fn(), repair: vi.fn(), close: vi.fn(),
}));
vi.mock('../config/index.js', () => ({ getConfig: () => ({ DINGTALK_CORP_ID: 'corp-sync-test' }) }));
vi.mock('../db/pool.js', () => ({ getPool: () => ({}), closePool: state.close,
  withTransaction: async (run: (client: object) => Promise<unknown>) => run({}),
}));
vi.mock('../dingtalk/api-client.js', () => ({ getUser: state.getUser, listUsers: state.users,
  listDepartments: state.departments, listProcessTemplates: vi.fn(),
}));
vi.mock('../db/queries/user-snapshot.js', () => ({ upsertSnapshot: state.upsert, recordFetchFailure: vi.fn() }));
vi.mock('../organization/department-tree-sync.js', () => ({ syncDepartmentTree: vi.fn().mockResolvedValue(2) }));
vi.mock('./approval-metadata-backfill.js', () => ({ backfillApprovalMetadata: state.repair }));

const originalArgv = process.argv;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  process.argv = ['node', 'sync-metadata.ts', '--users'];
  state.departments.mockImplementation(async id => id === 1 ? [{ dept_id: 20, name: '部门' }] : []);
  state.users.mockResolvedValue({ list: [{ userid: 'user-a' }], hasMore: false, nextCursor: 0 });
  state.getUser.mockResolvedValue({ userid: 'user-a', name: '已有用户', dept_id_list: ['20'] });
  state.upsert.mockResolvedValue({ inserted: false, snapshot: {} });
  state.repair.mockResolvedValue({ scanned: 10, instances: 1, tasks: 2, dryRun: false });
});
afterEach(() => { process.argv = originalArgv; });

async function runScript() {
  const completed = new Promise<void>(resolve => { state.close.mockImplementation(async () => { resolve(); }); });
  // 计算 URL 避免将 scripts 纳入 src 的 TypeScript rootDir；所有网络和 DB 依赖已显式替换。
  await import(new URL('../../scripts/sync-metadata.ts', import.meta.url).href);
  await completed;
}

describe('manual user synchronization regression', () => {
  it('backfills approval blanks even when no user snapshot content changed and includes root-department members', async () => {
    await runScript();
    expect(state.upsert).toHaveBeenCalledOnce();
    expect(state.users).toHaveBeenCalledWith(1, 0);
    expect(state.users).toHaveBeenCalledWith(20, 0);
    expect(state.repair).toHaveBeenCalledWith('corp-sync-test', { dryRun: false });
    expect(state.repair.mock.invocationCallOrder[0]).toBeGreaterThan(state.upsert.mock.invocationCallOrder[0]);
  });
  it('can still repair from stored successful profiles when the user list is empty', async () => {
    state.users.mockResolvedValue({ list: [], hasMore: false, nextCursor: 0 });
    await runScript();
    expect(state.getUser).not.toHaveBeenCalled();
    expect(state.repair).toHaveBeenCalledWith('corp-sync-test', { dryRun: false });
  });
});
