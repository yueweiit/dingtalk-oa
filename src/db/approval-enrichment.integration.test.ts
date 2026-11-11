import pg from 'pg';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { repairApprovalMetadata, tryRepairApprovalMetadata } from './queries/approval-enrichment.js';
import { upsertTask } from './queries/approval-task.js';

const require = createRequire(import.meta.url);
const Builder = require('node-pg-migrate/dist/migrationBuilder').default;
const databaseUrl = process.env.USER_SNAPSHOT_TEST_DATABASE_URL;
const schema = `approval_metadata_it_${process.pid}_${Date.now()}`;
let client: pg.Client | null = null;
let created = false;

describe.skipIf(!databaseUrl)('approval metadata enrichment (isolated PostgreSQL)', () => {
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || !/^\/user_snapshot_test(?:_[a-z0-9_]+)?$/.test(url.pathname)
      || [...url.searchParams.keys()].some(key => ['host', 'hostaddr', 'port', 'dbname', 'options', 'service'].includes(key.toLowerCase()))) {
      throw new Error('APPROVAL_METADATA_TEST_REQUIRES_DISPOSABLE_LOOPBACK_DATABASE');
    }
    client = new pg.Client({ connectionString: databaseUrl }); await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`); created = true;
    await client.query(`SET search_path TO "${schema}"`);
    for (const file of ['20260703000001_create_ding_approval_instance', '20260703000002_create_ding_approval_task',
      '20260703000003_create_ding_user_snapshot', '20260722000000_create_ding_department_tree']) {
      const builder = new Builder({ query() { throw new Error('NO_BUILDER_DATABASE'); } }, undefined, false, console);
      require(`../../migrations/${file}.cjs`).up(builder);
      await client.query(builder.getSql());
    }
  });
  afterAll(async () => {
    if (client && created) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await client?.end();
  });
  beforeEach(async () => {
    await client!.query(`TRUNCATE "${schema}".ding_approval_instance, "${schema}".ding_approval_task,
      "${schema}".ding_user_snapshot, "${schema}".ding_department_tree;
      INSERT INTO ding_approval_instance(corp_id,process_instance_id,process_code,create_time,raw_payload)
      VALUES ('corp-a','instance-a','PROC','2026-09-01','{"originatorUserId":"user-a","originatorDeptId":"20","originatorDeptName":"原部门"}');
      INSERT INTO ding_approval_task(corp_id,process_instance_id,task_id,approver_user_id,approver_user_name,start_time,raw_payload)
      VALUES ('corp-a','instance-a','task-a','user-a',' ','2026-09-01','{"userId":"user-a","nodeName":" ","taskGroupName":"历史节点"}');
      INSERT INTO ding_user_snapshot(corp_id,user_id,name,dept_id_list,snapshot_hash,valid_from)
      VALUES ('corp-a','user-a','用户甲','[20]','hash-a','2026-08-01');
      INSERT INTO ding_department_tree(corp_id,dept_id,parent_dept_id,name,path_ids,path_names)
      VALUES ('corp-a','20','1','部门二十','[]','[]');`);
  });
  const repair = async (dryRun = false) => {
    if (dryRun) return repairApprovalMetadata(client as unknown as pg.PoolClient, 'corp-a', ['instance-a'], true);
    await client!.query('BEGIN');
    try {
      const result = await repairApprovalMetadata(client as unknown as pg.PoolClient, 'corp-a', ['instance-a']);
      await client!.query('COMMIT'); return result;
    } catch (error) { await client!.query('ROLLBACK'); throw error; }
  };

  it('repairs API aliases, blank names, node groups and departments from the approval payload', async () => {
    await client!.query(`UPDATE ding_approval_task SET raw_payload=raw_payload || '{"deptId":20}'::jsonb`);
    const raw = (await client!.query('SELECT raw_payload FROM ding_approval_task')).rows[0].raw_payload;
    expect(await repair()).toEqual({ instances: 1, tasks: 1 });
    expect((await client!.query('SELECT * FROM ding_approval_instance')).rows[0]).toMatchObject({
      originator_user_id: 'user-a', originator_user_name: '用户甲', originator_dept_id: '20', originator_dept_name: '原部门',
    });
    expect((await client!.query('SELECT * FROM ding_approval_task')).rows[0]).toMatchObject({
      approver_user_name: '用户甲', node_name: '历史节点', approver_dept_id: '20', approver_dept_name: '部门二十', raw_payload: raw,
    });
    expect(await repair()).toEqual({ instances: 0, tasks: 0 });
  });

  it('previews counts without modifying original rows', async () => {
    const before = (await client!.query('SELECT to_jsonb(t) AS row FROM ding_approval_task t')).rows;
    expect(await repair(true)).toEqual({ instances: 1, tasks: 1 });
    expect((await client!.query('SELECT to_jsonb(t) AS row FROM ding_approval_task t')).rows).toEqual(before);
  });

  it.each([['[20]', '2026-08-01'], ['[20,30]', '2026-08-01'], ['[20]', '2026-10-01']])('does not infer historical department from a user snapshot: %s %s', async (departments, since) => {
    await client!.query('UPDATE ding_user_snapshot SET dept_id_list=$1::jsonb,valid_from=$2', [departments, since]);
    await repair();
    expect((await client!.query('SELECT * FROM ding_approval_task')).rows[0]).toMatchObject({
      approver_user_name: '用户甲', approver_dept_id: null, approver_dept_name: null,
    });
  });

  it('keeps department unknown when a transfer may have preceded the next profile capture', async () => {
    // 9 月审批前已经调岗，直到 10 月才抓到新资料。采集区间无法还原调岗日。
    await client!.query(`UPDATE ding_approval_instance SET raw_payload='{"originatorUserId":"user-a"}';
      UPDATE ding_user_snapshot SET is_current=false,valid_to='2026-10-01';
      INSERT INTO ding_user_snapshot(corp_id,user_id,name,dept_id_list,snapshot_hash,valid_from)
      VALUES ('corp-a','user-a','现在姓名','[30]','new-hash','2026-10-01')`);
    await repair();
    expect((await client!.query('SELECT * FROM ding_approval_instance')).rows[0]).toMatchObject({
      originator_user_name: '用户甲', originator_dept_id: null, originator_dept_name: null,
    });
    expect((await client!.query('SELECT * FROM ding_approval_task')).rows[0]).toMatchObject({
      approver_user_name: '用户甲', approver_dept_id: null, approver_dept_name: null,
    });
  });

  it.each(['\t', '\r\n', '\u3000', '\u00a0\ufeff'])('treats legacy and raw whitespace %j as empty', async blank => {
    await client!.query(`UPDATE ding_approval_instance SET originator_user_id=$1, originator_user_name=$1,
      originator_dept_id=$1, originator_dept_name=$1, raw_payload=$2::jsonb`, [blank, {
      originatorUserId: 'user-a', originatorUserName: blank, originatorDeptId: '20', originatorDeptName: blank,
    }]);
    await client!.query(`UPDATE ding_approval_task SET approver_user_id=$1, approver_user_name=$1,
      approver_dept_id=$1, approver_dept_name=$1, node_name=$1, raw_payload=$2::jsonb`, [blank, {
      userId: 'user-a', userName: blank, deptId: '20', deptName: blank, nodeName: blank, taskGroupName: `${blank}历史节点${blank}`,
    }]);
    expect(await repair(true)).toEqual({ instances: 1, tasks: 1 });
    expect(await repair()).toEqual({ instances: 1, tasks: 1 });
    expect((await client!.query('SELECT * FROM ding_approval_instance')).rows[0]).toMatchObject({
      originator_user_id: 'user-a', originator_user_name: '用户甲', originator_dept_id: '20', originator_dept_name: '部门二十',
    });
    expect((await client!.query('SELECT * FROM ding_approval_task')).rows[0]).toMatchObject({
      approver_user_id: 'user-a', approver_user_name: '用户甲', approver_dept_id: '20', approver_dept_name: '部门二十', node_name: '历史节点',
    });
  });

  it('preserves existing labels and isolates enterprise and deleted-instance scopes', async () => {
    await client!.query(`UPDATE ding_approval_task SET approver_user_name='原姓名',node_name='原节点',approver_dept_id='99',approver_dept_name='原部门';
      INSERT INTO ding_user_snapshot(corp_id,user_id,name,dept_id_list,snapshot_hash,valid_from)
      VALUES ('corp-b','user-a','其他企业姓名','[99]','other-hash','2026-08-01')`);
    await repair();
    expect((await client!.query('SELECT * FROM ding_approval_task')).rows[0]).toMatchObject({
      approver_user_name: '原姓名', node_name: '原节点', approver_dept_id: '99', approver_dept_name: '原部门',
    });
    await client!.query(`UPDATE ding_approval_instance SET deleted_at=now(); UPDATE ding_approval_task SET approver_user_name=NULL`);
    expect(await repair()).toEqual({ instances: 0, tasks: 0 });
  });

  it.each([false, true])('skips concurrent soft deletion even when only the task needs changes (instance complete: %s)', async instanceComplete => {
    if (instanceComplete) {
      await client!.query(`UPDATE ding_approval_instance SET originator_user_id='user-a', originator_user_name='用户甲',
        originator_dept_id='20', originator_dept_name='原部门'`);
    }
    const taskBefore = (await client!.query('SELECT to_jsonb(t) AS row FROM ding_approval_task t')).rows[0];
    const repairPid = (await client!.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const deleter = new pg.Client({ connectionString: databaseUrl });
    let pendingRepair: ReturnType<typeof repair> | undefined;
    try {
      await deleter.connect();
      await deleter.query(`SET search_path TO "${schema}"`);
      await deleter.query('BEGIN');
      const deleted = (await deleter.query(`UPDATE ding_approval_instance i SET deleted_at=now(), updated_at=now()
        WHERE i.corp_id='corp-a' AND i.process_instance_id='instance-a' RETURNING to_jsonb(i) AS row`)).rows[0];

      pendingRepair = repair();
      void pendingRepair.catch(() => undefined); // 清理前可能已失败，结果仍由下方断言检查。
      await expect.poll(async () => (await deleter.query(`SELECT pg_backend_pid()=ANY(pg_blocking_pids($1::int)) AS blocked`,
        [repairPid])).rows[0].blocked, { timeout: 2_000 }).toBe(true);
      await deleter.query('COMMIT');

      expect(await pendingRepair).toEqual({ instances: 0, tasks: 0 });
      expect((await client!.query('SELECT to_jsonb(i) AS row FROM ding_approval_instance i')).rows[0]).toEqual(deleted);
      expect((await client!.query('SELECT to_jsonb(t) AS row FROM ding_approval_task t')).rows[0]).toEqual(taskBefore);
    } finally {
      await deleter.end(); // 断言失败时也释放未提交删除持有的锁。
      await pendingRepair?.catch(() => undefined);
    }
  });

  it('does not retain a previous approver name or department after reassignment', async () => {
    await client!.query(`UPDATE ding_approval_task SET approver_user_name='旧审批人',approver_dept_id='20',approver_dept_name='旧部门'`);
    const row = await upsertTask({ corp_id: 'corp-a', process_instance_id: 'instance-a', task_id: 'task-a',
      approver_user_id: 'new-user', status: 'RUNNING' }, client as unknown as pg.PoolClient);
    expect(row).toMatchObject({ approver_user_id: 'new-user', approver_user_name: null, approver_dept_id: null, approver_dept_name: null });
  });

  it('does not enrich a retained old user when the latest raw task has no current approver', async () => {
    await client!.query(`UPDATE ding_approval_task SET raw_payload='{"userId":null,"taskGroupName":"无人节点"}'`);
    await repair();
    expect((await client!.query('SELECT * FROM ding_approval_task')).rows[0]).toMatchObject({
      approver_user_name: null, approver_dept_id: null, approver_dept_name: null, node_name: '无人节点',
    });
  });

  it('rolls back partial enrichment to a savepoint while preserving the approval body transaction', async () => {
    await client!.query('ALTER TABLE ding_approval_task RENAME COLUMN node_name TO unavailable_node_name');
    try {
      await client!.query('BEGIN');
      await client!.query("UPDATE ding_approval_instance SET title='正文已归档'");
      await tryRepairApprovalMetadata(client as unknown as pg.PoolClient, 'corp-a', ['instance-a']);
      await client!.query('COMMIT');
      expect((await client!.query('SELECT title,originator_user_name FROM ding_approval_instance')).rows[0])
        .toEqual({ title: '正文已归档', originator_user_name: null });
    } finally {
      await client!.query('ROLLBACK');
      await client!.query('ALTER TABLE ding_approval_task RENAME COLUMN unavailable_node_name TO node_name');
    }
  });
});
