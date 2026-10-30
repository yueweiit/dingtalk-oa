import type pg from 'pg';
import { withClient } from '../pool.js';
import type { JsonValue } from '../json-types.js';
import { filtersSchema, type ReadFilters, type ReadPosition, type ReadResource } from '../../approval-api/pagination.js';

export interface ApprovalReadItem {
  corpId: string;
  processInstanceId: string;
  approvalNo: string | null;
  processCode: string;
  templateName: string | null;
  title: string | null;
  status: string | null;
  result: string | null;
  originatorUserId: string | null;
  originatorUserName: string | null;
  originatorDeptId: string | null;
  originatorDeptName: string | null;
  createTime: string | null;
  finishTime: string | null;
  formComponentValues: JsonValue | null;
  rawPayload: JsonValue | null;
  lastEventTime: string | null;
  updatedAt: string;
  deletedAt: string | null;
}

export interface AttachmentReadItem {
  corpId: string;
  processInstanceId: string;
  approvalNo: string | null;
  processCode: string;
  templateName: string | null;
  fileId: string;
  fileName: string | null;
  attachmentOrigin: string;
  declaredSize: string | null;
  actualSize: string | null;
  contentType: string | null;
  sha256: string | null;
  archiveStatus: string;
  archiveMethod: string | null;
  contentQuality: string | null;
  failureCode: string | null;
  commentUserId: string | null;
  commentUserName: string | null;
  commentTime: string | null;
  commentRemark: string | null;
  archivedAt: string | null;
  updatedAt: string;
  retiredAt: string | null;
  sourceDeletedAt: string | null;
}

export interface DownloadAttachment extends AttachmentReadItem {
  bucket: string;
  objectKey: string;
}

export interface ReadPageRequest {
  filters: ReadFilters;
  limit: number;
  position?: ReadPosition;
  syncUntil?: string;
}

export interface ReadPage<T> {
  items: T[];
  syncUntil: string;
}

// Return database microseconds verbatim; pg's default Date parser drops the last three digits.
const timestamp = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const approvalNumber = `COALESCE(NULLIF(i.raw_payload->>'businessId',''), i.raw_payload->>'business_id')`;
const templateName = 'COALESCE(t.name, scope.template_name)';
const templateJoins = `LEFT JOIN public.ding_process_template t ON t.corp_id=i.corp_id AND t.process_code=i.process_code
  LEFT JOIN costing_read.financial_template_scope scope ON scope.corp_id=i.corp_id AND scope.process_code=i.process_code`;

function filterWhere(input: ReadFilters) {
  // Corporate selection remains mandatory even for direct repository callers.
  const filters = filtersSchema.parse(input);
  const values: unknown[] = [];
  const param = (value: unknown) => { values.push(value); return `$${values.length}`; };
  const conditions = [`i.corp_id=${param(filters.corpId)}`];
  if (filters.processCode) conditions.push(`i.process_code=${param(filters.processCode)}`);
  if (filters.processInstanceId) conditions.push(`i.process_instance_id=${param(filters.processInstanceId)}`);
  if (filters.approvalNo) conditions.push(`${approvalNumber}=${param(filters.approvalNo)}`);
  return { values, param, conditions };
}

const approvalColumns = `i.corp_id AS "corpId", i.process_instance_id AS "processInstanceId",
  ${approvalNumber} AS "approvalNo", i.process_code AS "processCode", ${templateName} AS "templateName",
  i.title, i.status, i.result, i.originator_user_id AS "originatorUserId",
  i.originator_user_name AS "originatorUserName", i.originator_dept_id AS "originatorDeptId",
  i.originator_dept_name AS "originatorDeptName", ${timestamp('i.create_time')} AS "createTime",
  ${timestamp('i.finish_time')} AS "finishTime", i.form_component_values AS "formComponentValues",
  i.raw_payload AS "rawPayload", ${timestamp('i.last_event_time')} AS "lastEventTime",
  ${timestamp('i.updated_at')} AS "updatedAt", ${timestamp('i.deleted_at')} AS "deletedAt"`;

const attachmentColumns = `a.corp_id AS "corpId", a.process_instance_id AS "processInstanceId",
  ${approvalNumber} AS "approvalNo", a.process_code AS "processCode", ${templateName} AS "templateName",
  a.file_id AS "fileId", a.file_name AS "fileName", a.attachment_origin AS "attachmentOrigin",
  a.declared_size::text AS "declaredSize", a.actual_size::text AS "actualSize",
  a.content_type AS "contentType", a.sha256, a.archive_status AS "archiveStatus",
  a.archive_method AS "archiveMethod", a.content_quality AS "contentQuality", a.failure_code AS "failureCode",
  a.comment_user_id AS "commentUserId", a.comment_user_name AS "commentUserName",
  ${timestamp('a.comment_time')} AS "commentTime", a.comment_remark AS "commentRemark",
  ${timestamp('a.archived_at')} AS "archivedAt", ${timestamp('a.updated_at')} AS "updatedAt",
  ${timestamp('a.retired_at')} AS "retiredAt", ${timestamp('i.deleted_at')} AS "sourceDeletedAt"`;

async function readOnly<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return withClient(async client => {
    await client.query('BEGIN READ ONLY');
    try {
      await client.query("SET LOCAL statement_timeout = '15s'");
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

async function readPage<T extends pg.QueryResultRow>(resource: ReadResource, input: ReadPageRequest): Promise<ReadPage<T>> {
  const { values, param, conditions } = filterWhere(input.filters);
  return readOnly(async client => {
    const syncUntil = input.syncUntil ?? (await client.query<{ syncUntil: string }>(
      `SELECT ${timestamp('clock_timestamp()')} AS "syncUntil"`,
    )).rows[0].syncUntil;
    const alias = resource === 'approvals' ? 'i' : 'a';
    if (input.filters.updatedAfter) conditions.push(`${alias}.updated_at>=${param(input.filters.updatedAfter)}::timestamptz`);
    conditions.push(`${alias}.updated_at<=${param(syncUntil)}::timestamptz`);
    const order = resource === 'approvals' ? 'i.updated_at, i.process_instance_id' : 'a.updated_at, a.process_instance_id, a.file_id';
    if (input.position) {
      const keys = [
        `${param(input.position.updatedAt)}::timestamptz`, param(input.position.processInstanceId),
      ];
      if (resource === 'attachments') keys.push(param(input.position.fileId));
      conditions.push(`(${order})>(${keys.join(',')})`);
    }
    const columns = resource === 'approvals' ? approvalColumns : attachmentColumns;
    const from = resource === 'approvals' ? 'public.ding_approval_instance i'
      : `costing_read.attachment_archive a JOIN public.ding_approval_instance i
        ON i.corp_id=a.corp_id AND i.process_instance_id=a.process_instance_id`;
    const limit = param(input.limit + 1);
    const { rows } = await client.query<T>(`SELECT ${columns} FROM ${from} ${templateJoins}
      WHERE ${conditions.join(' AND ')} ORDER BY ${order} LIMIT ${limit}`, values);
    return { items: rows, syncUntil };
  });
}

export const listReadApprovals = (input: ReadPageRequest) => readPage<ApprovalReadItem>('approvals', input);
export const listReadAttachments = (input: ReadPageRequest) => readPage<AttachmentReadItem>('attachments', input);

export async function findReadAttachment(
  filters: ReadFilters, fileId: string,
): Promise<DownloadAttachment | undefined> {
  const { values, param, conditions } = filterWhere(filters);
  conditions.push(`a.file_id=${param(fileId)}`);
  return readOnly(async connection => (await connection.query<DownloadAttachment>(
    `SELECT ${attachmentColumns}, a.bucket, a.object_key AS "objectKey"
     FROM costing_read.attachment_archive a JOIN public.ding_approval_instance i
       ON i.corp_id=a.corp_id AND i.process_instance_id=a.process_instance_id
     ${templateJoins} WHERE ${conditions.join(' AND ')} LIMIT 1`, values,
  )).rows[0]);
}
