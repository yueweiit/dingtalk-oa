import { describe, expect, it } from 'vitest';
import { syncDepartmentTree } from './department-tree-sync.js';

describe('syncDepartmentTree', () => {
  it('marks departments absent from a complete discovery as no longer current', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const executor = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
      },
    };

    await syncDepartmentTree(executor, 'corp-1', [
      { deptId: '100', parentDeptId: '1', name: 'YUEWEI' },
      { deptId: '101', parentDeptId: '100', name: '业务部门' },
    ]);

    expect(calls).toHaveLength(4);
    expect(calls.at(-1)).toMatchObject({
      sql: expect.stringContaining('SET is_current = false'),
      params: ['corp-1', ['1', '100', '101']],
    });
  });
});
