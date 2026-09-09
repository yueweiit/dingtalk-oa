import { createHash } from 'node:crypto';
import { archiveAttachment, type ArchiveDependencies, type PendingArchive } from '../archive/archive-job.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listWhitelistedInstances, claimPendingAttachments, markAttachmentArchived, markAttachmentFailed, retireIneligibleAttachments } from './queries/attachment-archive.js';
import { closePool } from './pool.js';
import * as approvalQueries from './queries/approval-instance.js';
import { upsertInstance, markAsDeleted } from './queries/approval-instance.js';

// Only run against an explicitly supplied disposable local database.
const databaseUrl = process.env.SETTLEMENT_TEST_DATABASE_URL;
const migrationName = '20260909000000_logistics_settlement_archive';
const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));
const hasMigration = existsSync(`${migrationsDir}/${migrationName}.cjs`);
const category = (value: unknown, name = '采购类别') => [{ name, value: typeof value === 'string' ? value : JSON.stringify(value) }];
let client: pg.Client;

async function insertInstance(id: string, code: string, components: unknown = [], deleted = false) {
  await client.query(`INSERT INTO ding_approval_instance(corp_id, process_instance_id, process_code, status,
    form_component_values, raw_payload, deleted_at) VALUES ('corp-1',$1,$2,'COMPLETED',$3,$4,
    CASE WHEN $5 THEN now() END)`, [id, code, JSON.stringify(components), JSON.stringify({
    status: 'COMPLETED', formComponentValues: components,
  }), deleted]);
}

describe.runIf(Boolean(databaseUrl))('settlement read contract (disposable PostgreSQL)', () => {
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.startsWith('/settlement_test')) {
      throw new Error('Use a disposable loopback database named settlement_test*');
    }
    Object.assign(process.env, {
      PGHOST: url.hostname, PGPORT: url.port, PGUSER: url.username, PGPASSWORD: url.password,
      PGDATABASE: url.pathname.slice(1), DINGTALK_APP_KEY: 'local-test', DINGTALK_APP_SECRET: 'local-test',
    });
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`DO $role$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='costing_reader') THEN CREATE ROLE costing_reader; END IF;
    END $role$`);
    if (hasMigration && (await client.query("SELECT to_regclass('settlement_test_migrations') AS relation")).rows[0].relation) {
      await runner({ dbClient: client, dir: migrationsDir, file: migrationName, checkOrder: false,
        migrationsTable: 'settlement_test_migrations', direction: 'down', log: () => undefined });
    }
    for (const file of [
      '20260703000001_create_ding_approval_instance',
      '1788492000000_create_costing_archive',
      '1788492060000_limit_archive_to_logistics',
      '1788505200000_add_archive_diagnostics',
      ...(hasMigration ? [migrationName] : []),
    ]) {
      await runner({ dbClient: client, dir: migrationsDir, file, checkOrder: false,
        migrationsTable: 'settlement_test_migrations', direction: 'up', log: () => undefined });
    }
  });
  beforeEach(async () => {
    await client.query('TRUNCATE ding_approval_instance, costing_read.allowed_process_template, costing_read.attachment_archive RESTART IDENTITY CASCADE');
    if (hasMigration) await client.query('TRUNCATE costing_read.completed_approval_refresh');
    await client.query(`INSERT INTO costing_read.allowed_process_template(process_code,purpose,archive_attachments)
      VALUES ('LOG','international_logistics',true),('BUY','purchase_expense',false),('OTHER','other',false)`);
  });
  afterAll(async () => { await closePool(); await client?.end(); });

  it('allows the read-only costing role to read upstream sync health', async () => {
    await client.query('SET ROLE costing_reader');
    try {
      await expect(client.query('SELECT * FROM costing_read.sync_health_v1 LIMIT 1')).resolves.toBeDefined();
    } finally {
      await client.query('RESET ROLE');
    }
  });

  it('exposes every allowlisted source including deleted tombstones in v2', async () => {
    await insertInstance('log', 'LOG');
    await insertInstance('buy-deleted', 'BUY', [], true);
    await insertInstance('other', 'OTHER');
    await insertInstance('private', 'PRIVATE');
    const view = hasMigration ? 'approval_instances_v2' : 'approval_instances_v1';
    const { rows } = await client.query(`SELECT * FROM costing_read.${view} ORDER BY process_instance_id`);
    expect(rows.map(row => row.process_instance_id)).toEqual(['buy-deleted', 'log', 'other']);
    expect(rows[0].deleted_at).toBeInstanceOf(Date);
    expect(rows[0]).toHaveProperty('raw_payload');
    expect(rows[0]).toHaveProperty('updated_at');
    expect((await client.query('SELECT process_instance_id FROM costing_read.approval_instances_v1')).rows).toHaveLength(2);
  });

  it('archives only logistics and bilingual service→logistics purchase categories', async () => {
    await insertInstance('log', 'LOG');
    await insertInstance('buy-cn', 'BUY', category(['服务类采购', '物流及运输服务']));
    await insertInstance('buy-es', 'BUY', category(['Compra De Servicios', 'Servicios de logística y transporte'], 'Tipo de compra'));
    await insertInstance('buy-split', 'BUY', [
      { name: '采购支出Gastos de Compra', value: '服务类采购Compra De Servicios' },
      { name: '服务类采购 Adquisiciones de servicios', value: '物流及运输服务Servicios de logística y transporte' },
    ]);
    await insertInstance('commodity-split', 'BUY', [
      { name: '采购支出Gastos de Compra', value: '商品类采购Compra de mercancías' },
      { name: '服务类采购 Adquisiciones de servicios', value: '物流及运输服务Servicios de logística y transporte' },
    ]);
    await insertInstance('commodity', 'BUY', category(['商品类采购', '物流及运输服务']));
    await insertInstance('unrelated', 'BUY', category(['服务类采购', '咨询服务']));
    await insertInstance('comment-mention', 'BUY', category('服务类采购→物流及运输服务', '备注'));
    await insertInstance('unknown', 'BUY', category('待确认'));
    expect((await listWhitelistedInstances()).map(row => row.process_instance_id).sort())
      .toEqual(['buy-cn', 'buy-es', 'buy-split', 'log']);
  });

  it.each([
    ['commodity plus a misleading explanation field', [
      { name: '采购支出Gastos de Compra', value: '商品类采购Compra de mercancías' },
      { name: '采购支出说明', value: '上次使用服务类采购→物流及运输服务，本次为普通物料' },
    ]],
    ['an explanation field without any category', [
      { name: '采购支出说明', value: '服务类采购→物流及运输服务' },
    ]],
    ['free text in a recognized parent field', [
      { name: '采购支出Gastos de Compra', value: '上次使用服务类采购→物流及运输服务，本次为普通物料' },
    ]],
    ['free text in the service child field', [
      { name: '采购支出Gastos de Compra', value: '服务类采购Compra De Servicios' },
      { name: '服务类采购 Adquisiciones de servicios', value: '上次使用物流及运输服务，本次为咨询' },
    ]],
    ['conflicting explicit commodity and service parents', [
      { name: '采购支出Gastos de Compra', value: '商品类采购Compra de mercancías' },
      { name: '采购类别', value: '["服务类采购","物流及运输服务"]' },
    ]],
  ])('does not archive %s', async (_description, components) => {
    await insertInstance('not-logistics', 'BUY', components);
    expect(await listWhitelistedInstances()).toEqual([]);
  });

  it.each([
    ['legacy combined path', category('服务类采购→物流及运输服务')],
    ['bilingual combined path', category('服务类采购Compra De Servicios / 物流及运输服务Servicios de logística y transporte')],
    ['native structured array', [{ name: '采购类别', value: ['服务类采购', '物流及运输服务'] }]],
    ['Spanish split fields', [
      { name: 'Gastos de Compra', value: 'Compra De Servicios' },
      { name: 'Adquisiciones de servicios', value: 'Servicios de logística y transporte' },
    ]],
  ])('retains %s classification', async (_description, components) => {
    await insertInstance('logistics', 'BUY', components);
    expect((await listWhitelistedInstances()).map(row => row.process_instance_id)).toEqual(['logistics']);
  });

  it('publishes comment attachments, updates metadata, and retains removed/deleted tombstones', async () => {
    const base = { corp_id: 'corp-1', process_instance_id: 'log', process_code: 'LOG', status: 'COMPLETED' };
    const payload = { status: 'COMPLETED', operationRecords: [{ remark: 'invoice', files: [{ fileId: 'f1', fileName: 'invoice.pdf', fileSize: 10 }] }] };
    await upsertInstance({ ...base, raw_payload: payload });
    let rows = (await client.query('SELECT * FROM costing_read.attachment_archive')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].attachment_origin).toBe('comment');
    const originalUpdatedAt = rows[0].updated_at;
    await upsertInstance({ ...base, raw_payload: { ...payload, operationRecords: [{ remark: '', files: [{ fileId: 'f1', fileName: 'revised.pdf', fileSize: 11 }] }] } });
    rows = (await client.query('SELECT * FROM costing_read.attachment_archives_v2')).rows;
    expect(rows[0].file_name).toBe('revised.pdf');
    expect(rows[0].declared_size).toBe('11');
    expect(rows[0].comment_remark).toBeNull();
    expect(rows[0].updated_at.getTime()).toBeGreaterThan(originalUpdatedAt.getTime());
    await upsertInstance({ ...base, raw_payload: { status: 'COMPLETED', operationRecords: [] } });
    rows = (await client.query('SELECT * FROM costing_read.attachment_archives_v2')).rows;
    expect(rows[0].retired_at).toBeInstanceOf(Date);
    expect((await client.query('SELECT * FROM costing_read.attachment_archives_v1')).rows).toHaveLength(0);
    await upsertInstance({ ...base, raw_payload: payload });
    expect((await client.query('SELECT * FROM costing_read.attachment_archives_v2')).rows[0].retired_at).toBeNull();
    await markAsDeleted('corp-1', 'log');
    expect((await client.query('SELECT * FROM costing_read.attachment_archives_v2')).rows[0].retired_at).toBeInstanceOf(Date);
  });

  it('does not advance source updated_at for an identical poll but does for changed completed comments', async () => {
    const base = { corp_id: 'corp-1', process_instance_id: 'log', process_code: 'LOG', status: 'COMPLETED', raw_payload: { status: 'COMPLETED', operationRecords: [] } };
    const first = await upsertInstance({ ...base, last_event_time: new Date() });
    const second = await upsertInstance({ ...base, last_event_time: new Date(Date.now() + 1000) });
    expect(second.updated_at).toEqual(first.updated_at);
    const third = await upsertInstance({ ...base, raw_payload: { ...base.raw_payload, operationRecords: [{ remark: 'new payment confirmation' }] } });
    expect(third.updated_at.getTime()).toBeGreaterThan(second.updated_at.getTime());
    expect(third.status).toBe('COMPLETED');
  });


  it('claims completed relevant approvals fairly even after failure and across connections', async () => {
    expect(approvalQueries).toHaveProperty('claimCompletedApprovalRefresh');
    for (const id of ['a', 'b', 'c']) await insertInstance(id, 'LOG');
    await insertInstance('d', 'BUY', category(['服务类采购', '物流及运输服务']));
    await insertInstance('ignored-commodity', 'BUY', category(['商品类采购', '物流及运输服务']));
    await insertInstance('ignored-deleted', 'LOG', [], true);
    await insertInstance('ignored-running', 'LOG');
    await client.query("UPDATE ding_approval_instance SET status='RUNNING' WHERE process_instance_id='ignored-running'");
    const before = (await client.query("SELECT updated_at FROM ding_approval_instance WHERE process_instance_id='a'")).rows[0].updated_at;
    const first = await approvalQueries.claimCompletedApprovalRefresh(2, 0);
    expect(first.map(row => row.process_instance_id)).toEqual(['a', 'b']);
    await approvalQueries.finishCompletedApprovalRefresh(first[0], new Error('temporary API failure'));
    await approvalQueries.finishCompletedApprovalRefresh(first[1]);
    await closePool(); // Fairness is persisted in PostgreSQL rather than process memory.
    const second = await approvalQueries.claimCompletedApprovalRefresh(2, 0);
    expect(second.map(row => row.process_instance_id)).toEqual(['c', 'd']);
    const third = await approvalQueries.claimCompletedApprovalRefresh(2, 0);
    expect(third.map(row => row.process_instance_id)).toEqual(['a', 'b']);
    const ledger = (await client.query("SELECT * FROM costing_read.completed_approval_refresh WHERE process_instance_id='a'")).rows[0];
    expect(ledger.last_error).toContain('temporary API failure');
    expect(ledger.last_checked_at).toBeInstanceOf(Date);
    expect((await client.query("SELECT updated_at FROM ding_approval_instance WHERE process_instance_id='a'")).rows[0].updated_at).toEqual(before);
    expect(await approvalQueries.claimCompletedApprovalRefresh(2, 0)).toHaveLength(0); // Every row leased.
  });


  it('rearchives a changed file descriptor and refuses a stale worker result', async () => {
    const base = { corp_id: 'corp-1', process_instance_id: 'log', process_code: 'LOG', status: 'COMPLETED' };
    const payload = (size: number) => ({ status: 'COMPLETED', operationRecords: [{ files: [{ fileId: 'same-file', fileName: 'invoice.pdf', fileSize: size }] }] });
    await upsertInstance({ ...base, raw_payload: payload(10) });
    const [original] = await claimPendingAttachments(1);
    const archived = { actualSize: 10, etag: 'etag', contentType: 'application/pdf', sha256: 'a'.repeat(64) };
    await markAttachmentArchived(original.id, archived, original.objectKey, original.claimGeneration);
    await upsertInstance({ ...base, raw_payload: payload(11) });
    let row = (await client.query('SELECT * FROM costing_read.attachment_archives_v2')).rows[0];
    expect(row.archive_status).toBe('pending');
    expect(row.object_key).not.toBe(original.objectKey);
    expect(row.sha256).toBeNull();
    await markAttachmentArchived(original.id, archived, original.objectKey, original.claimGeneration);
    await markAttachmentFailed(original.id, 5, new Error('stale'), original.objectKey, original.claimGeneration);
    row = (await client.query('SELECT * FROM costing_read.attachment_archives_v2')).rows[0];
    expect(row.archive_status).toBe('pending');
    const [current] = await claimPendingAttachments(1);
    expect(current.declaredSize).toBe(11);
    await markAttachmentArchived(current.id, { ...archived, actualSize: 11 }, current.objectKey, current.claimGeneration);
    expect((await client.query('SELECT * FROM costing_read.attachment_archives_v2')).rows[0].archive_status).toBe('archived');
  });


  it('keeps existing running-approval rotation working after no-op source timestamps become stable', async () => {
    const params = (id: string) => ({ corp_id: 'corp-1', process_instance_id: id, process_code: 'LOG', status: 'RUNNING', raw_payload: { status: 'RUNNING' } });
    await upsertInstance(params('running-a'));
    await upsertInstance(params('running-b'));
    expect((await approvalQueries.findRunningApprovalInstances(1))[0].process_instance_id).toBe('running-a');
    await upsertInstance({ ...params('running-a'), last_event_time: new Date(Date.now() + 1000) });
    expect((await approvalQueries.findRunningApprovalInstances(1))[0].process_instance_id).toBe('running-b');
  });


  it('grants only SELECT on the public contract and retains compatible v1 columns', async () => {
    const { rows } = await client.query(`SELECT
      has_table_privilege('costing_reader','costing_read.approval_instances_v2','SELECT') AS approval_read,
      has_table_privilege('costing_reader','costing_read.attachment_archives_v2','SELECT') AS attachment_read,
      has_table_privilege('costing_reader','costing_read.completed_approval_refresh_v1','SELECT') AS health_read,
      has_table_privilege('costing_reader','costing_read.attachment_archives_v2','UPDATE') AS attachment_write,
      has_table_privilege('costing_reader','public.ding_approval_instance','SELECT') AS raw_read`);
    expect(rows[0]).toEqual({ approval_read: true, attachment_read: true, health_read: true, attachment_write: false, raw_read: false });
    const columns = async (view: string) => (await client.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='costing_read' AND table_name=$1 ORDER BY ordinal_position`, [view])).rows.map(row => row.column_name);
    expect(await columns('approval_instances_v2')).toEqual([...(await columns('approval_instances_v1')), 'deleted_at']);
    expect(await columns('attachment_archives_v2')).toEqual([...(await columns('attachment_archives_v1')), 'retired_at']);
  });


  it('honors the minimum interval and prevents a stale completion from releasing a newer lease', async () => {
    await insertInstance('a', 'LOG');
    const [first] = await approvalQueries.claimCompletedApprovalRefresh(1, 21600);
    await approvalQueries.finishCompletedApprovalRefresh(first);
    expect(await approvalQueries.claimCompletedApprovalRefresh(1, 21600)).toHaveLength(0);
    await client.query("UPDATE costing_read.completed_approval_refresh SET last_checked_at=now()-interval '7 hours'");
    const [second] = await approvalQueries.claimCompletedApprovalRefresh(1, 21600);
    expect(second.refresh_generation).not.toEqual(first.refresh_generation);
    await approvalQueries.finishCompletedApprovalRefresh(first, new Error('late old result'));
    const state = (await client.query('SELECT * FROM costing_read.completed_approval_refresh')).rows[0];
    expect(state.lease_until).toBeInstanceOf(Date);
    expect(state.last_error).toBeNull();
    await client.query("UPDATE costing_read.completed_approval_refresh SET lease_until=now()-interval '1 minute'");
    expect(await approvalQueries.claimCompletedApprovalRefresh(1, 0)).toHaveLength(1);
  });


  it('retires archived purchases when category eligibility is removed and reconciles direct source deletions', async () => {
    const base = { corp_id: 'corp-1', process_instance_id: 'buy', process_code: 'BUY', status: 'COMPLETED' };
    const components = category(['服务类采购', '物流及运输服务']);
    const payload = { status: 'COMPLETED', formComponentValues: components, operationRecords: [{ files: [{ fileId: 'invoice' }] }] };
    await upsertInstance({ ...base, form_component_values: components, raw_payload: payload });
    expect((await client.query('SELECT * FROM costing_read.attachment_archives_v1')).rows).toHaveLength(1);
    await upsertInstance({ ...base, form_component_values: category(['商品类采购']), raw_payload: { ...payload, formComponentValues: category(['商品类采购']) } });
    expect((await client.query('SELECT * FROM costing_read.attachment_archives_v2')).rows[0].retired_at).toBeInstanceOf(Date);
    expect((await client.query('SELECT * FROM costing_read.attachment_archives_v1')).rows).toHaveLength(0);
    expect(await claimPendingAttachments(10)).toHaveLength(0);
    await upsertInstance({ ...base, form_component_values: components, raw_payload: payload });
    await client.query("UPDATE ding_approval_instance SET deleted_at=clock_timestamp() WHERE process_instance_id='buy'");
    await retireIneligibleAttachments();
    expect((await client.query('SELECT * FROM costing_read.attachment_archives_v2')).rows[0].retired_at).toBeInstanceOf(Date);
  });


  it.each(['failure', 'success'])('fences stale %s writes after an attachment lease is reclaimed', async (staleOutcome) => {
    await upsertInstance({ corp_id: 'corp-1', process_instance_id: 'log', process_code: 'LOG', status: 'COMPLETED',
      raw_payload: { operationRecords: [{ files: [{ fileId: 'fenced', fileSize: 11 }] }] } });
    const [stale] = await claimPendingAttachments(1);
    await client.query("UPDATE costing_read.attachment_archive SET claimed_at=now()-interval '16 minutes'");
    const [current] = await claimPendingAttachments(1);
    const archived = { actualSize: 11, etag: 'stale-etag', contentType: 'application/pdf', sha256: 'a'.repeat(64) };
    if (staleOutcome === 'failure') {
      await markAttachmentFailed(stale.id, 5, new Error('late failure'), stale.objectKey, stale.claimGeneration);
    } else {
      await markAttachmentArchived(stale.id, archived, stale.objectKey, stale.claimGeneration);
    }
    let row = (await client.query('SELECT * FROM costing_read.attachment_archive')).rows[0];
    expect(row.archive_status).toBe('archiving');
    expect(row.etag).toBeNull();
    expect(current.claimGeneration).not.toEqual(stale.claimGeneration);
    await markAttachmentArchived(current.id, { ...archived, etag: 'current-etag' }, current.objectKey, current.claimGeneration);
    row = (await client.query('SELECT * FROM costing_read.attachment_archive')).rows[0];
    expect(row.archive_status).toBe('archived');
    expect(row.etag).toBe('current-etag');
  });

  it.each(['failure', 'success'])('fences stale %s writes when a file descriptor changes back to an earlier value', async (staleOutcome) => {
    const base = { corp_id: 'corp-1', process_instance_id: 'log', process_code: 'LOG', status: 'COMPLETED' };
    const payload = (size: number) => ({ operationRecords: [{ files: [{ fileId: 'revision', fileSize: size }] }] });
    await upsertInstance({ ...base, raw_payload: payload(10) });
    await upsertInstance({ ...base, raw_payload: payload(11) });
    const [stale] = await claimPendingAttachments(1);
    await upsertInstance({ ...base, raw_payload: payload(12) });
    await upsertInstance({ ...base, raw_payload: payload(11) });
    const [current] = await claimPendingAttachments(1);
    const archived = { actualSize: 11, etag: 'stale-etag', contentType: 'application/pdf', sha256: 'a'.repeat(64) };
    if (staleOutcome === 'failure') {
      await markAttachmentFailed(stale.id, 5, new Error('late failure'), stale.objectKey, stale.claimGeneration);
    } else {
      await markAttachmentArchived(stale.id, archived, stale.objectKey, stale.claimGeneration);
    }
    expect((await client.query('SELECT archive_status FROM costing_read.attachment_archive')).rows[0].archive_status).toBe('archiving');
    expect(current.objectKey).not.toBe(stale.objectKey);
    await markAttachmentArchived(current.id, { ...archived, etag: 'current-etag' }, current.objectKey, current.claimGeneration);
    expect((await client.query('SELECT etag FROM costing_read.attachment_archive')).rows[0].etag).toBe('current-etag');
  });

  it('downloads fresh bytes instead of recovering old HEAD content when a descriptor recurs', async () => {
    const base = { corp_id: 'corp-1', process_instance_id: 'log', process_code: 'LOG', status: 'COMPLETED' };
    const payload = (size: number) => ({ operationRecords: [{ files: [{ fileId: 'revision', fileSize: size }] }] });
    const objects = new Map<string, Buffer>();
    let downloads = 0;
    const archive = (record: PendingArchive) => archiveAttachment(record, {
      headObject: async (key) => {
        const body = objects.get(key);
        return body ? { exists: true, size: body.length, etag: 'head-etag', contentType: 'application/pdf',
          sha256: createHash('sha256').update(body).digest('hex') } : { exists: false };
      },
      getDownload: async () => ({ uri: 'https://local.invalid/file', headers: {},
        archiveMethod: 'workflow_download', contentQuality: 'original', diagnostics: [] }),
      fetchContent: async () => ({ body: Buffer.alloc(11, ++downloads === 1 ? 'a' : 'b'), contentType: 'application/pdf' }),
      putObject: async (key, body) => { objects.set(key, body); return { etag: 'download-etag' }; },
      markArchived: (id, result) => markAttachmentArchived(id, result, record.objectKey, record.claimGeneration),
      recordApiCall: async () => undefined,
    });
    await upsertInstance({ ...base, raw_payload: payload(10) });
    await upsertInstance({ ...base, raw_payload: payload(11) });
    const [firstEleven] = await claimPendingAttachments(1);
    await archive(firstEleven);
    await upsertInstance({ ...base, raw_payload: payload(12) });
    await upsertInstance({ ...base, raw_payload: payload(11) });
    const [secondEleven] = await claimPendingAttachments(1);
    await archive(secondEleven);
    expect(downloads).toBe(2);
    expect(secondEleven.objectKey).not.toBe(firstEleven.objectKey);
    expect(objects.get(firstEleven.objectKey)).toEqual(Buffer.alloc(11, 'a'));
    expect(objects.get(secondEleven.objectKey)).toEqual(Buffer.alloc(11, 'b'));
    const row = (await client.query('SELECT * FROM costing_read.attachment_archive')).rows[0];
    expect(row.sha256).toBe(createHash('sha256').update(Buffer.alloc(11, 'b')).digest('hex'));
    const unchangedKey = row.object_key;
    await upsertInstance({ ...base, raw_payload: payload(11) });
    expect((await client.query('SELECT object_key FROM costing_read.attachment_archive')).rows[0].object_key).toBe(unchangedKey);
  });


  it('preserves the complete file identity when a file ID itself begins with revision-', async () => {
    const base = { corp_id: 'corp-1', process_instance_id: 'log', process_code: 'LOG', status: 'COMPLETED' };
    const payload = (size: number) => ({ operationRecords: [{ files: ['revision-a', 'revision-b'].map(fileId => ({ fileId, fileName: 'invoice.pdf', fileSize: size })) }] });
    await upsertInstance({ ...base, raw_payload: payload(10) });
    await upsertInstance({ ...base, raw_payload: payload(11) });
    const rows = (await client.query('SELECT file_id, object_key FROM costing_read.attachment_archive ORDER BY file_id')).rows;
    expect(rows).toEqual([
      { file_id: 'revision-a', object_key: 'corp-1/log/revision-a/revision-1' },
      { file_id: 'revision-b', object_key: 'corp-1/log/revision-b/revision-1' },
    ]);
  });


  it('keeps a reclaimed original object intact when the stale preview worker PUT finishes later', async () => {
    await upsertInstance({ corp_id: 'corp-1', process_instance_id: 'log', process_code: 'LOG', status: 'COMPLETED',
      raw_payload: { operationRecords: [{ files: [{ fileId: 'race', fileSize: 11 }] }] } });
    const objects = new Map<string, Buffer>();
    const original = Buffer.alloc(11, 'b');
    const preview = Buffer.alloc(5, 'a');
    let signalPreviewStarted!: () => void;
    const previewStarted = new Promise<void>(resolve => { signalPreviewStarted = resolve; });
    let releasePreview!: () => void;
    const previewReleased = new Promise<void>(resolve => { releasePreview = resolve; });
    const dependencies = (
      record: PendingArchive, quality: 'preview' | 'original', fetchBody: () => Promise<Buffer>,
    ): ArchiveDependencies => ({
      headObject: async (key) => {
        const body = objects.get(key);
        return body ? { exists: true, size: body.length, etag: 'head-etag', contentType: 'application/pdf',
          sha256: createHash('sha256').update(body).digest('hex') } : { exists: false };
      },
      getDownload: async () => ({ uri: 'https://local.invalid/file', headers: {},
        archiveMethod: 'workflow_download', contentQuality: quality, diagnostics: [] }),
      fetchContent: async () => ({ body: await fetchBody(), contentType: 'application/pdf' }),
      putObject: async (key, body) => { objects.set(key, body); return { etag: quality }; },
      markArchived: (id, result) => markAttachmentArchived(id, result, record.objectKey, record.claimGeneration),
      recordApiCall: async () => undefined,
    });
    const [stale] = await claimPendingAttachments(1);
    const staleWork = archiveAttachment(stale, dependencies(stale, 'preview', async () => {
      signalPreviewStarted();
      await previewReleased;
      return preview;
    }));
    await previewStarted;
    await client.query("UPDATE costing_read.attachment_archive SET claimed_at=now()-interval '16 minutes'");
    const [current] = await claimPendingAttachments(1);
    await archiveAttachment(current, dependencies(current, 'original', async () => original));
    const published = (await client.query('SELECT * FROM costing_read.attachment_archives_v2')).rows[0];
    expect(published.archive_status).toBe('archived');
    expect(objects.get(published.object_key)).toEqual(original);
    releasePreview();
    await staleWork;
    const afterLatePut = (await client.query('SELECT * FROM costing_read.attachment_archives_v2')).rows[0];
    expect(objects.get(afterLatePut.object_key)).toEqual(original);
    expect(afterLatePut.actual_size).toBe('11');
    expect(afterLatePut.content_quality).toBe('original');
    expect(afterLatePut.sha256).toBe(createHash('sha256').update(objects.get(afterLatePut.object_key)!).digest('hex'));
    expect(afterLatePut.object_key).toBe(current.objectKey);
    expect(current.objectKey).not.toBe(stale.objectKey);
    expect(objects.get(stale.objectKey)).toEqual(preview);
  });

});
