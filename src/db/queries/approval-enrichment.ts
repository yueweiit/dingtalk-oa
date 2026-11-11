import type pg from 'pg';

// ECMAScript String.trim() 的空白和行终止字符，与 firstText 保持一致。
const trimCharacters = '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
const text = (expression: string) => `NULLIF(BTRIM(${expression}, $3), '')`;
const name = (expression: string) => `CASE WHEN LOWER(${text(expression)}) <> 'unknown' THEN ${text(expression)} END`;
const kept = (expression: string) => `CASE WHEN ${text(expression)} IS NOT NULL THEN ${expression} END`;

/** 部门 ID 来自审批本身。用户快照的采集时间仅用于选择姓名版本。 */
function statement(kind: 'instance' | 'task', dryRun: boolean): string {
  const instance = kind === 'instance';
  const table = instance ? 'ding_approval_instance' : 'ding_approval_task';
  const prefix = instance ? 'originator' : 'approver';
  const userId = `${prefix}_user_id`, userName = `${prefix}_user_name`;
  const deptId = `${prefix}_dept_id`, deptName = `${prefix}_dept_name`;
  const time = instance ? 'create_time' : 'start_time';
  const rawUserId = instance
    ? `COALESCE(${text("s.raw_payload#>>'{originator,userId}'")}, ${text("s.raw_payload->>'originatorUserId'")}, ${text("s.raw_payload->>'originatorId'")})`
    : text("s.raw_payload->>'userId'");
  const rootUserId = `COALESCE(${text("s.raw_payload->>'originatorUserId'")}, ${text("s.raw_payload->>'originatorId'")})`;
  const sameRootUser = `(${rootUserId} IS NULL OR ${rootUserId}=${rawUserId})`;
  const resolvedUserId = `COALESCE(${text(`s.${userId}`)}, ${rawUserId})`;
  // 原始任务已明确没有人员时，不用 COALESCE 遗留的旧人员列补姓名/部门。
  const profileUserId = instance ? resolvedUserId : `CASE
    WHEN s.raw_payload IS NULL OR s.raw_payload='{}'::jsonb THEN ${resolvedUserId}
    WHEN ${rawUserId}=${resolvedUserId} THEN ${resolvedUserId} END`;
  const rawDeptId = instance
    ? `COALESCE(${text("s.raw_payload#>>'{originator,deptId}'")}, CASE WHEN ${sameRootUser} THEN ${text("s.raw_payload->>'originatorDeptId'")} END)`
    : text("s.raw_payload->>'deptId'");
  const rawUserName = instance
    ? `COALESCE(${name("s.raw_payload#>>'{originator,name}'")}, CASE WHEN ${sameRootUser} THEN ${name("s.raw_payload->>'originatorUserName'")} END)`
    : name("s.raw_payload->>'userName'");
  const rawDeptName = instance
    ? `COALESCE(${text("s.raw_payload#>>'{originator,deptName}'")}, CASE WHEN ${sameRootUser}
      AND (${text("s.raw_payload->>'originatorDeptId'")} IS NULL OR ${text("s.raw_payload->>'originatorDeptId'")}=${rawDeptId})
      THEN ${text("s.raw_payload->>'originatorDeptName'")} END)`
    : text("s.raw_payload->>'deptName'");
  const fields = [userId, userName, deptId, deptName, ...(!instance ? ['node_name'] : [])];
  const sourceMatchesUser = instance ? '(d.raw_user_id IS NULL OR d.raw_user_id=d.user_id)' : 'd.raw_user_id=d.user_id';
  const tuple = (alias: string) => `ROW(${fields.map(field => `${alias}.${field}`).join(', ')})`;
  const original = `ROW(${fields.map(field => `c.stored_${field}`).join(', ')}, c.raw_payload, c.occurred_at)`;
  const current = `ROW(${fields.map(field => `t.${field}`).join(', ')}, t.raw_payload, t.${time})`;
  return `WITH base AS (
    SELECT s.id, s.corp_id, s.process_instance_id, s.raw_payload, s.${time} AS occurred_at,
      ${fields.map(field => `s.${field} AS stored_${field}`).join(', ')},
      ${profileUserId} AS user_id,
      ${rawUserId} AS raw_user_id, ${rawDeptId} AS raw_dept_id,
      ${rawUserName} AS raw_user_name, ${rawDeptName} AS raw_dept_name,
      COALESCE(${text(`s.${deptId}`)}, CASE WHEN ${rawUserId} IS NULL
        OR ${rawUserId}=COALESCE(${text(`s.${userId}`)}, ${rawUserId}) THEN ${rawDeptId} END) AS approval_dept_id
    FROM ${table} s WHERE s.corp_id=$1 AND s.process_instance_id=ANY($2::varchar[])
      ${instance ? 'AND s.deleted_at IS NULL' : `AND EXISTS (SELECT 1 FROM ding_approval_instance i
        WHERE i.corp_id=s.corp_id AND i.process_instance_id=s.process_instance_id AND i.deleted_at IS NULL)`}
  ), profiles AS (
    SELECT b.*, h.name AS historical_name, u.name AS current_name,
      ${instance ? 'b.approval_dept_id' : 'CASE WHEN b.user_id IS NOT NULL THEN b.approval_dept_id END'} AS resolved_dept_id
    FROM base b
    LEFT JOIN LATERAL (
      SELECT p.name
      FROM ding_user_snapshot p
      WHERE p.corp_id=b.corp_id AND p.user_id=b.user_id AND p.fetch_status='success'
        AND b.occurred_at IS NOT NULL AND p.valid_from<=b.occurred_at
        AND (p.valid_to IS NULL OR b.occurred_at<p.valid_to)
      ORDER BY p.valid_from DESC,p.id DESC LIMIT 1
    ) h ON true
    LEFT JOIN LATERAL (
      SELECT p.name FROM ding_user_snapshot p
      WHERE p.corp_id=b.corp_id AND p.user_id=b.user_id AND p.is_current=true AND p.fetch_status='success'
      ORDER BY p.valid_from DESC,p.id DESC LIMIT 1
    ) u ON true
  ), candidates AS (
    SELECT d.*, COALESCE(${kept(`d.stored_${userId}`)}, d.user_id) AS ${userId},
      COALESCE(${kept(`d.stored_${userName}`)},
        CASE WHEN ${sourceMatchesUser} THEN d.raw_user_name END,
        ${name('d.historical_name')}, ${name('d.current_name')}) AS ${userName},
      COALESCE(${kept(`d.stored_${deptId}`)}, d.resolved_dept_id) AS ${deptId},
      COALESCE(${kept(`d.stored_${deptName}`)},
        CASE WHEN (${sourceMatchesUser})
          AND (d.raw_dept_id IS NULL OR d.raw_dept_id=d.resolved_dept_id) THEN d.raw_dept_name END,
        CASE WHEN length(org.name)<=256 THEN ${text('org.name')} END) AS ${deptName}
      ${!instance ? `, COALESCE(${kept('d.stored_node_name')}, ${text("d.raw_payload->>'nodeName'")}, ${text("d.raw_payload->>'taskGroupName'")}) AS node_name` : ''}
    FROM profiles d LEFT JOIN ding_department_tree org
      ON org.corp_id=d.corp_id AND org.dept_id=d.resolved_dept_id AND org.parent_dept_id IS NOT NULL
  ) ${dryRun
    ? `SELECT count(*)::int AS n FROM candidates c WHERE ROW(${fields.map(field => `c.stored_${field}`).join(', ')}) IS DISTINCT FROM ${tuple('c')}`
    : `, changed AS (
      UPDATE ${table} t SET ${fields.map(field => `${field}=c.${field}`).join(', ')}, updated_at=clock_timestamp()
      FROM candidates c WHERE t.id=c.id AND t.corp_id=$1
        ${instance ? 'AND t.deleted_at IS NULL' : ''}
        AND ${current} IS NOT DISTINCT FROM ${original}
        AND ${tuple('t')} IS DISTINCT FROM ${tuple('c')}
      RETURNING t.id
    ) SELECT count(*)::int AS n FROM changed`}`;
}

/** 写入时复用调用方事务，预览只读。显式企业及有界实例集合，原始 payload 不会被改写。 */
export async function repairApprovalMetadata(
  client: pg.PoolClient, corpId: string, instanceIds: string[], dryRun = false,
): Promise<{ instances: number; tasks: number }> {
  if (!corpId.trim() || instanceIds.length > 200) throw new Error('APPROVAL_METADATA_SCOPE_INVALID');
  if (!instanceIds.length) return { instances: 0, tasks: 0 };
  let activeInstanceIds = instanceIds;
  if (!dryRun) {
    // 先锁父实例，即使实例字段无需补齐，软删除也必须等节点补全事务结束。
    const { rows } = await client.query<{ process_instance_id: string }>(
      `SELECT process_instance_id FROM ding_approval_instance
       WHERE corp_id=$1 AND process_instance_id=ANY($2::varchar[]) AND deleted_at IS NULL
       ORDER BY process_instance_id FOR NO KEY UPDATE`,
      [corpId, instanceIds],
    );
    activeInstanceIds = rows.map(row => row.process_instance_id);
    if (!activeInstanceIds.length) return { instances: 0, tasks: 0 };
  }
  const params = [corpId, activeInstanceIds, trimCharacters];
  const instances = await client.query<{ n: number }>(statement('instance', dryRun), params);
  const tasks = await client.query<{ n: number }>(statement('task', dryRun), params);
  return { instances: instances.rows[0].n, tasks: tasks.rows[0].n };
}

/** 元数据补全失败使用保存点隔离，不丢弃已成功归档的审批正文。 */
export async function tryRepairApprovalMetadata(client: pg.PoolClient, corpId: string, instanceIds: string[]): Promise<void> {
  await client.query('SAVEPOINT approval_metadata');
  try {
    await repairApprovalMetadata(client, corpId, instanceIds);
    await client.query('RELEASE SAVEPOINT approval_metadata');
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT approval_metadata');
    await client.query('RELEASE SAVEPOINT approval_metadata');
    console.warn('[ApprovalMetadata] APPROVAL_METADATA_ENRICHMENT_FAILED', error instanceof Error ? error.message : String(error));
  }
}
