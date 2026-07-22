export interface DepartmentTreeEdge {
  parentDeptId: string;
  deptId: string;
  name: string;
}

export interface DepartmentTreeRow {
  corpId: string;
  deptId: string;
  parentDeptId: string | null;
  name: string;
  pathIds: string[];
  pathNames: string[];
}

export function buildDepartmentTreeRows(input: {
  corpId: string;
  root: { deptId: string; name: string };
  edges: DepartmentTreeEdge[];
}): DepartmentTreeRow[] {
  const root: DepartmentTreeRow = {
    corpId: input.corpId,
    deptId: input.root.deptId,
    parentDeptId: null,
    name: input.root.name,
    pathIds: [input.root.deptId],
    pathNames: [input.root.name],
  };
  const rows = [root];
  const byId = new Map([[root.deptId, root]]);
  const remaining = [...input.edges];

  while (remaining.length > 0) {
    let added = 0;
    for (let index = remaining.length - 1; index >= 0; index--) {
      const edge = remaining[index];
      const parent = byId.get(edge.parentDeptId);
      if (!parent) continue;

      const row: DepartmentTreeRow = {
        corpId: input.corpId,
        deptId: edge.deptId,
        parentDeptId: edge.parentDeptId,
        name: edge.name,
        pathIds: [...parent.pathIds, edge.deptId],
        pathNames: [...parent.pathNames, edge.name],
      };
      rows.push(row);
      byId.set(row.deptId, row);
      remaining.splice(index, 1);
      added++;
    }
    if (added === 0) {
      throw new Error(`parent department not found: ${remaining[0].parentDeptId}`);
    }
  }

  return rows;
}
