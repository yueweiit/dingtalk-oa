import type pg from 'pg';
import { withClient, withTransaction } from '../pool.js';

export interface AllowedPackingWorkbook {
  corpId: string;
  workbookId: string;
  year?: number;
  label?: string;
}

export interface LivePackingSheet {
  sheetId: string;
  sheetName: string;
}

export interface PackingRefreshRequest {
  id: number;
  requestKind: 'workbook_index' | 'sheet_snapshot';
  corpId: string;
  workbookId: string;
  sheetId: string | null;
  attempts: number;
}

function refreshRequest(row: Record<string, unknown>): PackingRefreshRequest {
  return {
    id: Number(row.id),
    requestKind: row.request_kind as PackingRefreshRequest['requestKind'],
    corpId: String(row.corp_id),
    workbookId: String(row.workbook_id),
    sheetId: row.sheet_id == null ? null : String(row.sheet_id),
    attempts: Number(row.attempts),
  };
}

export async function syncAllowedPackingWorkbooks(
  corpId: string,
  workbooks: Array<{ workbookId: string; year: number; label: string }>,
): Promise<void> {
  await withTransaction(async (client) => {
    for (const workbook of workbooks) {
      await client.query(
        `INSERT INTO costing_read.allowed_packing_workbook(
           corp_id, workbook_id, year, label, enabled
         ) VALUES ($1,$2,$3,$4,true)
         ON CONFLICT (corp_id, workbook_id) DO UPDATE SET
           year=EXCLUDED.year, label=EXCLUDED.label, enabled=true, updated_at=now()`,
        [corpId, workbook.workbookId, workbook.year, workbook.label],
      );
    }
    const activeIds = workbooks.map((row) => row.workbookId);
    await client.query(
      `UPDATE costing_read.allowed_packing_workbook
          SET enabled=false, updated_at=now()
        WHERE corp_id=$1 AND enabled AND NOT (workbook_id = ANY($2::text[]))`,
      [corpId, activeIds],
    );
  });
}

export async function enqueueWorkbookIndexRefresh(params: {
  corpId: string;
  workbookId: string;
  requestKey: string;
  requestedBy: string;
}): Promise<number> {
  return withClient(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO costing_read.packing_refresh_request(
         request_key, request_kind, corp_id, workbook_id, requested_by
       ) VALUES ($1,'workbook_index',$2,$3,$4)
       ON CONFLICT (request_key) DO UPDATE SET request_key=EXCLUDED.request_key
       RETURNING id`,
      [params.requestKey, params.corpId, params.workbookId, params.requestedBy],
    );
    return Number(rows[0].id);
  });
}

export async function claimNextPackingRefreshRequest(): Promise<PackingRefreshRequest | null> {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `WITH picked AS (
         SELECT id
           FROM costing_read.packing_refresh_request
          WHERE (
            (status='pending' AND (
              attempts=0 OR updated_at <= now() - (LEAST(300, 5 * (1 << attempts)) * interval '1 second')
            ))
            OR (status='running' AND claimed_at < now() - interval '15 minutes')
          )
            AND attempts < 3
          ORDER BY requested_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE costing_read.packing_refresh_request request
          SET status='running', attempts=request.attempts + 1,
              claimed_at=now(), updated_at=now()
         FROM picked
        WHERE request.id=picked.id
       RETURNING request.*`,
    );
    return rows[0] ? refreshRequest(rows[0]) : null;
  });
}

export async function getAllowedPackingWorkbook(
  corpId: string,
  workbookId: string,
): Promise<AllowedPackingWorkbook | null> {
  return withClient(async (client) => {
    const { rows } = await client.query(
      `SELECT corp_id, workbook_id, year, label
         FROM costing_read.allowed_packing_workbook
        WHERE corp_id=$1 AND workbook_id=$2 AND enabled`,
      [corpId, workbookId],
    );
    if (!rows[0]) return null;
    return {
      corpId: String(rows[0].corp_id), workbookId: String(rows[0].workbook_id),
      year: Number(rows[0].year), label: String(rows[0].label),
    };
  });
}

export async function getLivePackingSheet(
  corpId: string,
  workbookId: string,
  sheetId: string,
): Promise<LivePackingSheet | null> {
  return withClient(async (client) => {
    const { rows } = await client.query(
      `SELECT sheet_id, sheet_name
         FROM costing_read.packing_sheet_index
        WHERE corp_id=$1 AND workbook_id=$2 AND sheet_id=$3 AND deleted_at IS NULL`,
      [corpId, workbookId, sheetId],
    );
    return rows[0] ? { sheetId: String(rows[0].sheet_id), sheetName: String(rows[0].sheet_name) } : null;
  });
}

export async function replacePackingSheetIndex(
  corpId: string,
  workbookId: string,
  sheets: Array<{ id: string; name: string; visibility?: string }>,
): Promise<void> {
  await withTransaction(async (client) => {
    for (const sheet of sheets) {
      await client.query(
        `INSERT INTO costing_read.packing_sheet_index(
           corp_id, workbook_id, sheet_id, sheet_name, visibility, indexed_at, deleted_at
         ) VALUES ($1,$2,$3,$4,$5,now(),NULL)
         ON CONFLICT (corp_id, workbook_id, sheet_id) DO UPDATE SET
           sheet_name=EXCLUDED.sheet_name, visibility=EXCLUDED.visibility,
           indexed_at=now(), deleted_at=NULL`,
        [corpId, workbookId, sheet.id, sheet.name, sheet.visibility || null],
      );
    }
    await client.query(
      `UPDATE costing_read.packing_sheet_index
          SET deleted_at=now(), indexed_at=now()
        WHERE corp_id=$1 AND workbook_id=$2 AND deleted_at IS NULL
          AND NOT (sheet_id = ANY($3::text[]))`,
      [corpId, workbookId, sheets.map((sheet) => sheet.id)],
    );
  });
}

export interface SnapshotInsert {
  corpId: string;
  workbookId: string;
  sheetId: string;
  sheetName: string;
  rangeAddress: string | null;
  captureStartedAt: string;
  captureFinishedAt: string;
  contentSha256: string;
  bucket: string;
  objectKey: string;
  actualSize: number;
  rowCount: number;
  columnCount: number;
  sourceLastNonEmptyRow: number;
  sourceLastNonEmptyColumn: number;
  captureConsistency: 'single_range' | 'multi_range';
}

export async function insertPackingSheetSnapshot(snapshot: SnapshotInsert): Promise<number> {
  return withClient(async (client) => {
    const values = [
      snapshot.corpId, snapshot.workbookId, snapshot.sheetId, snapshot.sheetName,
      snapshot.rangeAddress, snapshot.captureStartedAt, snapshot.captureFinishedAt,
      snapshot.contentSha256, snapshot.bucket, snapshot.objectKey, snapshot.actualSize,
      snapshot.rowCount, snapshot.columnCount, snapshot.sourceLastNonEmptyRow,
      snapshot.sourceLastNonEmptyColumn, snapshot.captureConsistency,
    ];
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO costing_read.packing_sheet_snapshot(
         corp_id, workbook_id, sheet_id, sheet_name, range_address,
         capture_started_at, capture_finished_at, content_sha256, bucket, object_key,
         actual_size, row_count, column_count, source_last_non_empty_row,
         source_last_non_empty_column, capture_consistency, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'ready')
       ON CONFLICT (corp_id, workbook_id, sheet_id, content_sha256)
       DO UPDATE SET content_sha256=EXCLUDED.content_sha256
       RETURNING id`,
      values,
    );
    return Number(rows[0].id);
  });
}

function errorDetails(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : 'packing_refresh_failed';
  return { code: code.slice(0, 256), message: message.slice(0, 4000) };
}

export async function markPackingRefreshSuccess(id: number, snapshotId: number | null): Promise<void> {
  await withClient((client) => client.query(
    `UPDATE costing_read.packing_refresh_request
        SET status='success', snapshot_id=$2, completed_at=now(),
            error_code=NULL, error_message=NULL, updated_at=now()
      WHERE id=$1`,
    [id, snapshotId],
  ).then(() => undefined));
}

export async function markPackingRefreshFailed(
  id: number,
  error: unknown,
  retryable: boolean,
): Promise<void> {
  const details = errorDetails(error);
  await withClient((client: pg.PoolClient) => client.query(
    `UPDATE costing_read.packing_refresh_request
        SET status=CASE WHEN $2 AND attempts < 3 THEN 'pending' ELSE 'failed' END,
            completed_at=CASE WHEN $2 AND attempts < 3 THEN NULL ELSE now() END,
            error_code=$3, error_message=$4, updated_at=now()
      WHERE id=$1`,
    [id, retryable, details.code, details.message],
  ).then(() => undefined));
}
