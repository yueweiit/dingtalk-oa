import { describe, expect, it } from 'vitest';
import { buildDepartmentTreeRows } from './department-tree.js';

describe('buildDepartmentTreeRows', () => {
  it('keeps duplicate department names separate by id and parent path', () => {
    const rows = buildDepartmentTreeRows({
      corpId: 'corp-1',
      root: { deptId: '1', name: 'Root' },
      edges: [
        { parentDeptId: '1', deptId: '100', name: 'YUEWEI' },
        { parentDeptId: '100', deptId: '101', name: '业务及生产执行单元' },
        { parentDeptId: '100', deptId: '102', name: '悦为智能 YW Tech_Ai' },
        { parentDeptId: '101', deptId: '201', name: 'CEO' },
        { parentDeptId: '102', deptId: '202', name: 'CEO' },
      ],
    });

    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        corpId: 'corp-1',
        deptId: '201',
        parentDeptId: '101',
        pathIds: ['1', '100', '101', '201'],
        pathNames: ['Root', 'YUEWEI', '业务及生产执行单元', 'CEO'],
      }),
      expect.objectContaining({
        corpId: 'corp-1',
        deptId: '202',
        parentDeptId: '102',
        pathIds: ['1', '100', '102', '202'],
        pathNames: ['Root', 'YUEWEI', '悦为智能 YW Tech_Ai', 'CEO'],
      }),
    ]));
  });

  it('rejects an edge whose parent is absent from the discovered tree', () => {
    expect(() => buildDepartmentTreeRows({
      corpId: 'corp-1',
      root: { deptId: '1', name: 'Root' },
      edges: [{ parentDeptId: '404', deptId: '201', name: '孤立部门' }],
    })).toThrow('parent department not found: 404');
  });
});
