import { buildDepartmentTreeRows, type DepartmentTreeEdge } from './department-tree.js';

export interface DepartmentTreeExecutor {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export interface DiscoveredDepartment {
  deptId: string;
  parentDeptId: string;
  name: string;
}

export async function syncDepartmentTree(
  executor: DepartmentTreeExecutor,
  corpId: string,
  departments: DiscoveredDepartment[]
): Promise<number> {
  const rows = buildDepartmentTreeRows({
    corpId,
    root: { deptId: '1', name: 'ROOT' },
    edges: departments.map((department): DepartmentTreeEdge => ({
      parentDeptId: department.parentDeptId,
      deptId: department.deptId,
      name: department.name,
    })),
  });

  for (const row of rows) {
    await executor.query(
      `INSERT INTO ding_department_tree
         (corp_id, dept_id, parent_dept_id, name, path_ids, path_names, is_current, last_sync_at)
       VALUES ($1, $2, $3, $4, $5, $6, true, now())
       ON CONFLICT (corp_id, dept_id) DO UPDATE SET
         parent_dept_id = EXCLUDED.parent_dept_id,
         name = EXCLUDED.name,
         path_ids = EXCLUDED.path_ids,
         path_names = EXCLUDED.path_names,
         is_current = true,
         last_sync_at = now(),
         updated_at = now()`,
      [
        row.corpId,
        row.deptId,
        row.parentDeptId,
        row.name,
        JSON.stringify(row.pathIds),
        JSON.stringify(row.pathNames),
      ]
    );
  }

  await executor.query(
    `UPDATE ding_department_tree
     SET is_current = false, updated_at = now()
     WHERE corp_id = $1
       AND is_current = true
       AND NOT (dept_id = ANY($2::varchar[]))`,
    [corpId, rows.map((row) => row.deptId)]
  );

  return rows.length;
}
