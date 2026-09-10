import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from './pool.js';
import { upsertInstance, markAsDeleted } from './queries/approval-instance.js';
import {registerDiscoveredFinancialTemplate} from './queries/financial-template-discovery.js';
import * as financialQueries from './queries/financial-backfill.js';
import { findBackfillTemplates } from './queries/process-template.js';
import { claimCompletedApprovalRefresh } from './queries/approval-instance.js';
import { claimPendingAttachments, synchronizeInstanceAttachments } from './queries/attachment-archive.js';

const databaseUrl = process.env.FINANCIAL_TEST_DATABASE_URL;
const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));
const migrationName = '20260910010000_financial_source_scope';
const projectionMigration = '20260910020000_financial_source_projection';
let client: pg.Client;
const category = [{ name: '服务类采购', value: '物流及运输服务' }];
const freight = [{ name: '采购分类', value: '商品采购' }, { name: '说明', value: '国际海运费及燃油附加费' }];
const file = { fileId: 'synthetic-file', fileName: 'invoice.pdf' };
async function template(code: string, name: string, corp = 'corp-1') {
  await client.query(`INSERT INTO ding_process_template(corp_id,process_code,name,enabled,is_deleted)
    VALUES ($1,$2,$3,false,true)`, [corp, code, name]);
}
async function approval(id: string, code: string, fields: unknown, status = 'COMPLETED', result = 'agree') {
  await upsertInstance({ corp_id: 'corp-1', process_instance_id: id, process_code: code, status, result,
    form_component_values: fields, raw_payload: { formComponentValues: fields, operationRecords: [{ files: [file] }] } });
}

describe.runIf(Boolean(databaseUrl))('broad financial contract (disposable PostgreSQL)', () => {
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.startsWith('/settlement_test_financial')) {
      throw new Error('Use a disposable loopback settlement_test_financial* database');
    }
    Object.assign(process.env, { PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: url.username,
      PGPASSWORD: url.password, PGDATABASE: url.pathname.slice(1), DINGTALK_APP_KEY: 'local-test', DINGTALK_APP_SECRET: 'local-test' });
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='costing_reader') THEN CREATE ROLE costing_reader; END IF; END $$`);
    for (const name of ['20260703000000_create_ding_process_template', '20260703000001_create_ding_approval_instance',
      '20260703000003_create_ding_user_snapshot', '1788492000000_create_costing_archive',
      '1788492060000_limit_archive_to_logistics', '1788505200000_add_archive_diagnostics',
      '1788508800000_create_costing_actor_names_view', '1788856369000_create_approval_repair_queue',
      '20260909000000_logistics_settlement_archive', '20260910000000_purchase_template_scope', migrationName, projectionMigration]) {
      await runner({ dbClient: client, dir: migrationsDir, file: name, checkOrder: false,
        migrationsTable: 'financial_test_migrations', direction: 'up', log: () => undefined });
    }
  });
  beforeEach(async () => {
    await client.query(`TRUNCATE ding_process_template,ding_approval_instance,costing_read.allowed_process_template,
      costing_read.attachment_archive,costing_read.purchase_template_scope,costing_read.purchase_approval_exposure,
      costing_read.financial_template_scope,costing_read.financial_source_exposure,
      costing_read.financial_template_discovery,costing_read.completed_approval_refresh,costing_read.financial_backfill_window RESTART IDENTITY CASCADE`);
    await client.query(`INSERT INTO costing_read.allowed_process_template(process_code,purpose,archive_attachments)
      VALUES ('LOG','international_logistics',true), ('BUY','purchase_expense',false)`);
  });
  afterAll(async () => { await closePool(); await client?.end(); });

  it('discovers all financial template families including disabled historical BU while preserving tenant scope', async () => {
    for (const [code, name] of [['NEWBUY','采购付款'], ['OPS','运营支出'], ['BU','Example-BU'], ['MONTH','月度付款'], ['REIM','差旅费用报销']]) {
      await template(code!, name!);
      await approval(code!, code!, []);
    }
    await template('OPS','普通审批','corp-2');
    await client.query(`INSERT INTO ding_approval_instance(corp_id,process_instance_id,process_code) VALUES ('corp-2','private','OPS')`);
    expect((await client.query('SELECT process_instance_id FROM costing_read.approval_instances_v2 ORDER BY 1')).rows.map(r => r.process_instance_id))
      .toEqual(['BU','MONTH','NEWBUY','OPS','REIM']);
    await client.query(`UPDATE ding_process_template SET name='历史记录'; DELETE FROM ding_process_template`);
    expect((await client.query('SELECT count(*) FROM costing_read.financial_sources_v1')).rows[0].count).toBe('5');
  });

  it('queues wrong-category freight, surcharges, comments and explicit references without archiving irrelevant finance', async () => {
    await template('OPS', '运营支出');
    await approval('wrong-category','OPS',freight);
    await approval('surcharge','OPS',[{ name: '用途', value: '港口滞箱费、压车费' }]);
    await approval('reference','OPS',[{ name: '关联国际物流审批', value: 'synthetic-logistics-id' }]);
    await approval('label-only','OPS',[{ name: '海运费', value: '' }]);
    await approval('irrelevant','OPS',[{ name: '用途', value: '办公室租金' }]);
    await approval('category','BUY',category);
    await approval('comment','OPS',[]);
    await client.query(`UPDATE ding_approval_instance SET raw_payload=jsonb_set(raw_payload,'{operationRecords,0,remark}','"补付头程运输费用"') WHERE process_instance_id='comment'`);
    await synchronizeInstanceAttachments('corp-1','comment');
    expect((await client.query('SELECT process_instance_id FROM costing_read.eligible_attachment_instances ORDER BY 1')).rows.map(r => r.process_instance_id))
      .toEqual(['category','comment','reference','surcharge','wrong-category']);
    expect((await client.query('SELECT count(*) FROM costing_read.attachment_archive WHERE retired_at IS NULL')).rows[0].count).toBe('5');
  });

  it('accepts a financial form under an unrelated name only with transport evidence and retains invalidation', async () => {
    await template('ODD','通用申请');
    const fields = [{ name: '付款金额', value: '500' }, { name: '用途', value: '海运费' }];
    await approval('qualified','ODD',fields);
    await approval('nonfinancial','ODD',[{ name: '备注', value: '海运费' }]);
    await approval('emptyamount','ODD',[{ name: '付款金额', value: '' }, { name: '备注', value: '海运费' }]);
    expect((await client.query('SELECT process_instance_id FROM costing_read.approval_instances_v2')).rows.map(r => r.process_instance_id)).toEqual(['qualified']);
    await approval('qualified','ODD',[], 'WITHDRAWN');
    expect((await client.query('SELECT status,eligible_for_adoption FROM costing_read.financial_sources_v1')).rows)
      .toEqual([{ status: 'WITHDRAWN', eligible_for_adoption: false }]);
    expect((await client.query('SELECT retired_at IS NOT NULL AS retired FROM costing_read.attachment_archives_v2')).rows[0].retired).toBe(true);
  });

  it('excludes invalid approvals and customs/tax/last-mile-only charges from adoption but retains audit rows', async () => {
    await template('OPS','费用报销');
    for (const status of ['REJECTED','TERMINATED','WITHDRAWN','CANCELED']) await approval(status,'OPS',freight,status);
    await approval('refused','OPS',freight,'COMPLETED','refuse');
    await approval('deleted','OPS',freight); await markAsDeleted('corp-1','deleted');
    for (const [id,value] of [['tax','进口关税'],['customs','报关清关费用'],['last-mile','尾程运费']]) {
      await approval(id!, 'OPS', [{name:'说明',value}]);
    }
    expect((await client.query('SELECT count(*) FROM costing_read.financial_sources_v1')).rows[0].count).toBe('9');
    expect((await client.query('SELECT count(*) FROM costing_read.financial_sources_v1 WHERE eligible_for_adoption')).rows[0].count).toBe('0');
    expect((await client.query('SELECT count(*) FROM costing_read.eligible_attachment_instances')).rows[0].count).toBe('0');
  });

  it('does not let a logistics category or generic international wording make excluded charges adoptable', async () => {
    await template('OPS','运营支出');
    for (const [id,value] of [['tax-context','进口关税'],['customs-context','国际物流清关费用'],['lastmile-context','尾程运费']]) {
      await approval(id!, 'OPS', [...category,{name:'说明',value}]);
    }
    await approval('transport-category-tax','OPS',[{name:'付款分类',value:'运输费用'},{name:'说明',value:'进口关税'}]);
    await approval('zero-freight-tax','OPS',[{name:'海运费',value:'0'},{name:'关税',value:'500'}]);
    expect((await client.query('SELECT count(*) FROM costing_read.financial_sources_v1 WHERE eligible_for_adoption')).rows[0].count).toBe('0');
    await approval('mixed','OPS',[...category,{name:'说明',value:'尾程运费及海运费'}]);
    expect((await client.query("SELECT eligible_for_adoption FROM costing_read.financial_sources_v1 WHERE process_instance_id='mixed'")).rows[0].eligible_for_adoption).toBe(true);
  });

  it('keeps new current financial templates active without re-enabling already disabled metadata', async () => {
    await registerDiscoveredFinancialTemplate('corp-1','CURRENT','月度付款',true);
    await template('DISABLED','费用报销');
    await registerDiscoveredFinancialTemplate('corp-1','DISABLED','费用报销',true);
    await registerDiscoveredFinancialTemplate('corp-1','HIST','Example-BU');
    expect((await client.query('SELECT process_code,enabled FROM ding_process_template ORDER BY process_code')).rows)
      .toEqual([{process_code:'CURRENT',enabled:true},{process_code:'DISABLED',enabled:false},{process_code:'HIST',enabled:false}]);
  });

  it('qualifies populated freight/surcharge fields and a monthly logistics payment statement', async () => {
    await template('MONTH','月结付款');
    await approval('freight-field','MONTH',[{name:'海运费',value:'12000'}]);
    await approval('surcharge-field','MONTH',[{name:'明细',value:JSON.stringify([{name:'燃油附加费',value:'500'}])}]);
    await approval('monthly','MONTH',[{name:'付款事由',value:'Example月结账单'},{name:'付款分类',value:'物流费用'},
      {name:'金额',value:'12345'},{name:'关联审批',componentType:'RelateField',value:JSON.stringify(['synthetic-international-instance'])}]);
    expect((await client.query('SELECT process_instance_id FROM costing_read.eligible_attachment_instances ORDER BY 1')).rows.map(r=>r.process_instance_id))
      .toEqual(['freight-field','monthly','surcharge-field']);
    expect((await client.query("SELECT transport_evidence FROM costing_read.financial_sources_v1 WHERE process_instance_id='monthly'")).rows[0].transport_evidence)
      .toContain('logistics_category');
  });

  it('recognizes exact known international-approval references from generic RelateField values within the same corporation', async () => {
    await approval('synthetic-international','LOG',[]);
    await client.query(`INSERT INTO ding_approval_instance(corp_id,process_instance_id,process_code) VALUES('corp-2','private-international','LOG')`);
    await template('ODD','通用申请');
    for(const [id,reference] of [['linked','synthetic-international'],['other-tenant','private-international'],['substring','prefix-synthetic-international']]) {
      await approval(id!, 'ODD',[{name:'金额',value:'500'},{name:'关联审批',componentType:'RelateField',value:JSON.stringify([reference])}]);
    }
    expect((await client.query('SELECT process_instance_id,transport_evidence FROM costing_read.financial_sources_v1')).rows)
      .toEqual([{process_instance_id:'linked',transport_evidence:['logistics_reference']}]);
  });

  it('publishes truthful attachment availability and read-only grants', async () => {
    await template('OPS','月度付款'); await approval('monthly','OPS',freight);
    let row = (await client.query('SELECT * FROM costing_read.financial_sources_v1')).rows[0];
    expect(row).toMatchObject({ attachment_count: '1', attachment_available_count: '0', attachment_pending_count: '1', attachment_failed_count: '0' });
    await client.query(`UPDATE costing_read.attachment_archive SET archive_status='archived',content_quality='original',archived_at=now()`);
    row = (await client.query('SELECT * FROM costing_read.financial_sources_v1')).rows[0];
    expect(row.attachment_available_count).toBe('1');
    const columns = (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='costing_read' AND table_name='approval_instances_v2' ORDER BY ordinal_position`)).rows;
    expect(columns.at(-1).column_name).toBe('deleted_at');
    await client.query('SET ROLE costing_reader');
    await client.query('SELECT * FROM costing_read.financial_sources_v1');
    await client.query('SELECT * FROM costing_read.financial_template_coverage_v1');
    await expect(client.query('SELECT * FROM costing_read.financial_backfill_window')).rejects.toThrow('permission denied');
    await client.query('RESET ROLE');
  });

  it('reads nested serialized financial fields and comment aliases without treating empty labels as values', async () => {
    await template('ODD','通用申请');
    await approval('nested','ODD',[{name:'明细',value:JSON.stringify([{name:'付款金额',value:'500'},{name:'柜号',value:'SYNTHETIC001'}])}]);
    await template('OPS','运营支出');
    await approval('comment-alias','OPS',[]);
    await client.query(`UPDATE ding_approval_instance SET raw_payload=jsonb_set(raw_payload,'{operationRecords,0,comment}','"追加海运费"') WHERE process_instance_id='comment-alias'`);
    await synchronizeInstanceAttachments('corp-1','comment-alias');
    expect((await client.query('SELECT process_instance_id FROM costing_read.eligible_attachment_instances ORDER BY 1')).rows.map(r=>r.process_instance_id))
      .toEqual(['comment-alias','nested']);
  });

  it('tracks unqueued document references and keeps completed finance in the late-comment rotation', async () => {
    await template('OPS','运营支出'); await approval('not-yet-transport','OPS',[]);
    const source=(await client.query('SELECT * FROM costing_read.financial_sources_v1')).rows[0];
    expect(source).toMatchObject({attachment_reference_count:'1',attachment_unqueued_count:'1',attachment_available_count:'0'});
    expect((await claimCompletedApprovalRefresh(10,0)).map(r=>r.process_instance_id)).toEqual(['not-yet-transport']);
    expect((await findBackfillTemplates('corp-1')).map(r=>r.process_code)).toEqual(['OPS']);
  });

  it('persists window pages, fences stale workers, and never skips an unfinished ID on resume', async () => {
    await template('OLD','Example-BU');
    const start=new Date('2026-01-01T00:00Z'),end=new Date('2026-01-09T00:00Z');
    expect(await financialQueries.enqueueFinancialWindows('corp-1',start,end)).toBe(2);
    expect(await financialQueries.enqueueFinancialWindows('corp-1',start,end)).toBe(0);
    const first=(await financialQueries.claimFinancialWindow('corp-1'))!;
    await financialQueries.saveFinancialPage(first,['saved','remaining'],20);
    await financialQueries.finishFinancialInstance(first);
    await client.query("UPDATE costing_read.financial_backfill_window SET lease_until=clock_timestamp()-interval '1 second' WHERE window_start=$1",[start]);
    // Claim the other, never-visited window first; later invocations return to the stale window.
    const other=(await financialQueries.claimFinancialWindow('corp-1'))!;
    await financialQueries.saveFinancialPage(other,[],null); await financialQueries.completeFinancialWindow(other);
    await closePool();
    const resumed=(await financialQueries.claimFinancialWindow('corp-1'))!;
    expect(resumed.pending_ids).toEqual(['remaining']); expect(resumed.next_token).toBe(20);
    await expect(financialQueries.finishFinancialInstance(first)).rejects.toThrow('lease lost');
    await financialQueries.finishFinancialInstance(resumed);
    await financialQueries.startNextFinancialPage(resumed); await financialQueries.saveFinancialPage(resumed,['final'],null);
    await financialQueries.finishFinancialInstance(resumed); await financialQueries.completeFinancialWindow(resumed);
    expect(await financialQueries.claimFinancialWindow('corp-1')).toBeNull();
    const rows=(await client.query('SELECT status,discovered_count,processed_count,pending_instance_count FROM costing_read.financial_template_coverage_v1 ORDER BY window_start')).rows;
    expect(rows).toEqual([{status:'completed',discovered_count:'3',processed_count:'3',pending_instance_count:0},
      {status:'completed',discovered_count:'0',processed_count:'0',pending_instance_count:0}]);
  });

  it('claims only the exact requested attachment without consuming unrelated queued files', async () => {
    await template('OPS','月结付款'); await approval('other','OPS',freight); await approval('target','OPS',freight);
    const claimed=await claimPendingAttachments(10,false,{corpId:'corp-1',processInstanceId:'target',fileId:'synthetic-file'});
    expect(claimed.map(item=>item.processInstanceId)).toEqual(['target']);
    expect((await client.query("SELECT archive_status FROM costing_read.attachment_archive WHERE process_instance_id='other'")).rows[0].archive_status).toBe('pending');
    expect(await claimPendingAttachments(10,false,{corpId:'corp-1',processInstanceId:'target',fileId:'missing-file'})).toEqual([]);
  });

  it('serves source pages, coverage and refresh selection without reparsing archived JSON', async () => {
    await template('OPS','月结付款'); await approval('monthly','OPS',freight);
    await financialQueries.enqueueFinancialWindows('corp-1',new Date('2026-01-01T00:00Z'),new Date('2026-02-01T00:00Z'));
    await client.query('BEGIN');
    try {
      for (const signature of ['financial_evidence_text(value jsonb) RETURNS text',
        'financial_attachment_ids(value jsonb) RETURNS text[]', 'financial_field_items(value jsonb) RETURNS SETOF jsonb']) {
        await client.query(`CREATE OR REPLACE FUNCTION costing_read.${signature}
          LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $$ BEGIN
          RAISE EXCEPTION 'Read path recursively parsed an archived snapshot'; END $$`);
      }
      expect((await client.query('SELECT count(*) FROM costing_read.financial_sources_v1')).rows[0].count).toBe('1');
      expect((await client.query('SELECT * FROM costing_read.financial_sources_v1')).rows[0])
        .toMatchObject({has_transport_evidence:true,eligible_for_adoption:true,attachment_reference_count:'1'});
      expect((await client.query('SELECT * FROM costing_read.financial_template_coverage_v1')).rows)
        .toHaveLength(5);
      expect((await client.query('SELECT process_instance_id FROM costing_read.completed_refresh_instances')).rows)
        .toEqual([{process_instance_id:'monthly'}]);
    } finally { await client.query('ROLLBACK'); }
  });

  it('keeps evidence watermarks stable when an identical snapshot is refreshed', async () => {
    await template('OPS','运营支出'); await approval('stable','OPS',freight);
    const before=(await client.query('SELECT evidence_updated_at FROM costing_read.financial_sources_v1')).rows[0];
    await approval('stable','OPS',freight);
    expect((await client.query('SELECT evidence_updated_at FROM costing_read.financial_sources_v1')).rows[0]).toEqual(before);
  });

  it('resolves related logistics when the initial source and target writes overlap', async () => {
    await template('ODD','通用申请');
    const other=new pg.Client({connectionString:databaseUrl}); await other.connect();
    await client.query('BEGIN');
    try {
      await client.query(`INSERT INTO ding_approval_instance(corp_id,process_instance_id,process_code,form_component_values)
        VALUES('corp-1','concurrent-source','ODD',$1)`,[JSON.stringify([{name:'金额',value:'500'},
          {name:'关联审批',componentType:'RelateField',value:JSON.stringify(['concurrent-target'])}])]);
      const insertTarget=other.query(`INSERT INTO ding_approval_instance(corp_id,process_instance_id,process_code)
        VALUES('corp-1','concurrent-target','LOG')`);
      // Keep the source uncommitted while the second connection enters its insert.
      await Promise.race([insertTarget,new Promise(resolve=>setTimeout(resolve,50))]);
      await client.query('COMMIT'); await insertTarget;
      expect((await client.query("SELECT has_transport_evidence FROM costing_read.financial_sources_v1 WHERE process_instance_id='concurrent-source'")).rows)
        .toEqual([{has_transport_evidence:true}]);
    } finally { await client.query('ROLLBACK'); await other.end(); }
  });

  it('refreshes references when corporation-specific logistics scope is registered later', async () => {
    await client.query(`INSERT INTO costing_read.allowed_process_template(process_code,purpose,archive_attachments,auto_registered_purchase)
      VALUES('SCOPEDLOG','international_logistics',true,true)`);
    await approval('scoped-target','SCOPEDLOG',[]);
    await template('ODD','通用申请');
    await approval('scoped-source','ODD',[{name:'金额',value:'500'},
      {name:'关联审批',componentType:'RelateField',value:JSON.stringify(['scoped-target'])}]);
    expect((await client.query('SELECT count(*) FROM costing_read.financial_sources_v1')).rows[0].count).toBe('0');
    await client.query(`INSERT INTO costing_read.purchase_template_scope(corp_id,process_code) VALUES('corp-1','SCOPEDLOG')`);
    expect((await client.query('SELECT has_transport_evidence FROM costing_read.financial_sources_v1')).rows)
      .toEqual([{has_transport_evidence:true}]);
  });

  it('updates evidence with snapshots and resolves exact related logistics that arrive later', async () => {
    await template('ODD','通用申请');
    await approval('linked-late','ODD',[{name:'金额',value:'500'},
      {name:'关联审批',componentType:'RelateField',value:JSON.stringify(['arrives-later'])}]);
    expect((await client.query('SELECT count(*) FROM costing_read.financial_sources_v1')).rows[0].count).toBe('0');
    await approval('arrives-later','LOG',[]);
    expect((await client.query('SELECT process_instance_id,transport_evidence FROM costing_read.financial_sources_v1')).rows)
      .toEqual([{process_instance_id:'linked-late',transport_evidence:['logistics_reference']}]);
    await approval('linked-late','ODD',[{name:'金额',value:'500'},{name:'说明',value:'办公室租金'}]);
    expect((await client.query('SELECT has_transport_evidence,eligible_for_adoption FROM costing_read.financial_sources_v1')).rows)
      .toEqual([{has_transport_evidence:false,eligible_for_adoption:false}]);
  });

  it('replays the migration idempotently without touching snapshots or stable exposure timestamps', async () => {
    await template('OPS','运营支出'); await approval('freight','OPS',freight);
    const before = (await client.query('SELECT updated_at,raw_payload FROM costing_read.approval_instances_v2')).rows[0];
    const require = createRequire(import.meta.url);
    const migration = require(`${migrationsDir}/${projectionMigration}.cjs`);
    await client.query('BEGIN');
    let sql = ''; migration.up({ sql: (value: string) => { sql += value; } });
    await client.query(sql); await client.query('COMMIT');
    expect((await client.query('SELECT updated_at,raw_payload FROM costing_read.approval_instances_v2')).rows[0]).toEqual(before);
  });
});
