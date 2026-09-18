import {
  getWorksheet,
  getWorksheetRange,
  listWorkbookSheets,
  type WorksheetInfo,
  type WorksheetRange,
} from '../dingtalk/document-client.js';
import { getUserUnionId } from '../dingtalk/api-client.js';
import { getConfig } from '../config/index.js';
import {
  claimNextPackingRefreshRequest,
  getAllowedPackingWorkbook,
  getLivePackingSheet,
  insertPackingSheetSnapshot,
  markPackingRefreshFailed,
  markPackingRefreshSuccess,
  replacePackingSheetIndex,
  type AllowedPackingWorkbook,
  type LivePackingSheet,
  type PackingRefreshRequest,
  type SnapshotInsert,
} from '../db/queries/packing-workbook.js';
import {
  storePackingSnapshotInMinio,
  type PackingSheetPayload,
} from './snapshot-store.js';

export type { PackingRefreshRequest } from '../db/queries/packing-workbook.js';

export interface PackingRefreshOptions {
  operatorUnionId: string;
  bucket: string;
  maxCells: number;
  maxRows: number;
  maxColumns: number;
}

export interface PackingRefreshDependencies {
  listSheets: (workbookId: string, operatorUnionId: string) => Promise<WorksheetInfo[]>;
  getWorksheet: (workbookId: string, sheetId: string, operatorUnionId: string) => Promise<WorksheetInfo>;
  getRange: (
    workbookId: string, sheetId: string, rangeAddress: string, operatorUnionId: string,
  ) => Promise<WorksheetRange>;
  replaceSheetIndex: (
    corpId: string, workbookId: string, sheets: WorksheetInfo[],
  ) => Promise<void> | void;
  getAllowedWorkbook: (corpId: string, workbookId: string) => Promise<AllowedPackingWorkbook | null>;
  getLiveSheet: (
    corpId: string, workbookId: string, sheetId: string,
  ) => Promise<LivePackingSheet | null>;
  storeSnapshot: (
    corpId: string, payload: PackingSheetPayload,
  ) => Promise<{ bucket: string; objectKey: string; sha256: string; size: number; etag: string }>;
  insertSnapshot: (snapshot: SnapshotInsert) => Promise<number>;
  markSuccess: (id: number, snapshotId: number | null) => Promise<void> | void;
  markFailed: (id: number, error: unknown, retryable: boolean) => Promise<void> | void;
  now: () => Date;
}

function columnLetters(columnCount: number): string {
  let value = columnCount;
  let output = '';
  while (value > 0) {
    value -= 1;
    output = String.fromCharCode(65 + (value % 26)) + output;
    value = Math.floor(value / 26);
  }
  return output;
}

export function buildUsedRange(
  lastNonEmptyRow: number,
  lastNonEmptyColumn: number,
): { rangeAddress: string | null; rowCount: number; columnCount: number } {
  if (lastNonEmptyRow === -1 && lastNonEmptyColumn === -1) {
    return { rangeAddress: null, rowCount: 0, columnCount: 0 };
  }
  if (lastNonEmptyRow < 0 || lastNonEmptyColumn < 0) {
    throw Object.assign(new Error('工作表非空范围元数据不一致'), { code: 'invalid_sheet_bounds' });
  }
  const rowCount = lastNonEmptyRow + 1;
  const columnCount = lastNonEmptyColumn + 1;
  return { rangeAddress: `A1:${columnLetters(columnCount)}${rowCount}`, rowCount, columnCount };
}

export function chunkWorksheetRange(rowCount: number, columnCount: number, maxCells: number): string[] {
  if (!rowCount || !columnCount) return [];
  const rowsPerChunk = Math.max(1, Math.floor(maxCells / columnCount));
  const lastColumn = columnLetters(columnCount);
  const ranges: string[] = [];
  for (let start = 1; start <= rowCount; start += rowsPerChunk) {
    const end = Math.min(rowCount, start + rowsPerChunk - 1);
    ranges.push(`A${start}:${lastColumn}${end}`);
  }
  return ranges;
}

function isRetryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const combined = `${code} ${message}`.toLowerCase();
  if (combined.includes('permission') || combined.includes('forbidden') || combined.includes('accessdenied')) {
    return false;
  }
  return combined.includes('429') || combined.includes('timeout') || combined.includes('network') || combined.includes('http 5');
}

export async function processPackingRefreshRequest(
  request: PackingRefreshRequest,
  dependencies: PackingRefreshDependencies,
  options: PackingRefreshOptions,
): Promise<void> {
  try {
    const workbook = await dependencies.getAllowedWorkbook(request.corpId, request.workbookId);
    if (!workbook) throw Object.assign(new Error('packing workbook is not allowed'), { code: 'workbook_not_allowed' });

    if (request.requestKind === 'workbook_index') {
      const sheets = await dependencies.listSheets(request.workbookId, options.operatorUnionId);
      await dependencies.replaceSheetIndex(request.corpId, request.workbookId, sheets);
      await dependencies.markSuccess(request.id, null);
      return;
    }

    if (!request.sheetId) throw Object.assign(new Error('sheet id is required'), { code: 'sheet_id_missing' });
    const liveSheet = await dependencies.getLiveSheet(request.corpId, request.workbookId, request.sheetId);
    if (!liveSheet) throw Object.assign(new Error('packing sheet is not allowed'), { code: 'sheet_not_allowed' });

    const captureStartedAt = dependencies.now().toISOString();
    const sheet = await dependencies.getWorksheet(request.workbookId, request.sheetId, options.operatorUnionId);
    const lastRow = sheet.lastNonEmptyRow ?? -1;
    const lastColumn = sheet.lastNonEmptyColumn ?? -1;
    const used = buildUsedRange(lastRow, lastColumn);
    if (used.rowCount > options.maxRows || used.columnCount > options.maxColumns) {
      throw Object.assign(new Error('工作表使用范围超过安全读取上限'), { code: 'sheet_range_too_large' });
    }
    const ranges = chunkWorksheetRange(used.rowCount, used.columnCount, options.maxCells);
    const chunks = [];
    for (const rangeAddress of ranges) {
      const values = await dependencies.getRange(
        request.workbookId, request.sheetId, rangeAddress, options.operatorUnionId,
      );
      chunks.push({ rangeAddress, ...values });
    }
    const captureFinishedAt = dependencies.now().toISOString();
    const payload: PackingSheetPayload = {
      schemaVersion: 1,
      workbookId: request.workbookId,
      sheetId: request.sheetId,
      sheetName: sheet.name || liveSheet.sheetName,
      rangeAddress: used.rangeAddress,
      captureStartedAt,
      captureFinishedAt,
      mergeRangesAvailable: false,
      chunks,
    };
    const stored = await dependencies.storeSnapshot(request.corpId, payload);
    const snapshotId = await dependencies.insertSnapshot({
      corpId: request.corpId,
      workbookId: request.workbookId,
      sheetId: request.sheetId,
      sheetName: payload.sheetName,
      rangeAddress: used.rangeAddress,
      captureStartedAt,
      captureFinishedAt,
      contentSha256: stored.sha256,
      bucket: stored.bucket,
      objectKey: stored.objectKey,
      actualSize: stored.size,
      rowCount: used.rowCount,
      columnCount: used.columnCount,
      sourceLastNonEmptyRow: lastRow,
      sourceLastNonEmptyColumn: lastColumn,
      captureConsistency: ranges.length <= 1 ? 'single_range' : 'multi_range',
    });
    await dependencies.markSuccess(request.id, snapshotId);
  } catch (error) {
    await dependencies.markFailed(request.id, error, isRetryable(error));
    throw error;
  }
}

const runtimeDependencies: PackingRefreshDependencies = {
  listSheets: listWorkbookSheets,
  getWorksheet,
  getRange: getWorksheetRange,
  replaceSheetIndex: replacePackingSheetIndex,
  getAllowedWorkbook: getAllowedPackingWorkbook,
  getLiveSheet: getLivePackingSheet,
  storeSnapshot: storePackingSnapshotInMinio,
  insertSnapshot: insertPackingSheetSnapshot,
  markSuccess: markPackingRefreshSuccess,
  markFailed: markPackingRefreshFailed,
  now: () => new Date(),
};

let interval: NodeJS.Timeout | null = null;
let running = false;
let operatorUnionIdPromise: Promise<string> | null = null;

async function runOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const config = getConfig();
    const request = await claimNextPackingRefreshRequest();
    if (!request) return;
    if (!config.DINGTALK_PACKING_READER_USER_ID) {
      const error = Object.assign(new Error('DINGTALK_PACKING_READER_USER_ID is not configured'), {
        code: 'packing_reader_not_configured',
      });
      await markPackingRefreshFailed(request.id, error, false);
      return;
    }
    operatorUnionIdPromise ||= getUserUnionId(config.DINGTALK_PACKING_READER_USER_ID);
    const operatorUnionId = await operatorUnionIdPromise;
    await processPackingRefreshRequest(request, runtimeDependencies, {
      operatorUnionId,
      bucket: config.PACKING_SNAPSHOT_MINIO_BUCKET,
      maxCells: config.PACKING_RANGE_MAX_CELLS,
      maxRows: config.PACKING_SHEET_MAX_ROWS,
      maxColumns: config.PACKING_SHEET_MAX_COLUMNS,
    });
  } catch (error) {
    console.error('[PackingRefresh] 刷新任务失败:', error);
  } finally {
    running = false;
  }
}

export function startPackingRefreshWorker(): void {
  if (interval) return;
  const config = getConfig();
  void runOnce();
  interval = setInterval(() => void runOnce(), config.PACKING_REFRESH_POLL_MS);
  interval.unref();
}

export function stopPackingRefreshWorker(): void {
  if (interval) clearInterval(interval);
  interval = null;
}
