import { recordApiUsage } from '../db/queries/attachment-archive.js';
import { acquireDingTalkApiSlot } from './api-client.js';
import { tokenManager } from './token-manager.js';

const BASE_URL = 'https://api.dingtalk.com';

export interface WorksheetInfo {
  id: string;
  name: string;
  visibility?: string;
  rowCount?: number;
  columnCount?: number;
  lastNonEmptyRow?: number;
  lastNonEmptyColumn?: number;
}

export interface WorksheetRange {
  values: unknown[][];
  displayValues: string[][];
  formulas: string[][];
}

class DocumentApiError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'DocumentApiError';
  }
}

function businessError(data: Record<string, unknown>): string | null {
  const code = data.code ?? data.errcode;
  if (data.success === false || (code !== undefined && code !== null && ![0, '0', 'ok', 'OK'].includes(code as never))) {
    return String(data.message ?? data.errmsg ?? code ?? '钉钉表格接口返回失败');
  }
  return null;
}

function isTwoDimensionalArray(value: unknown): value is unknown[][] {
  return Array.isArray(value) && value.every((row) => Array.isArray(row));
}

function stringMatrix(value: unknown): string[][] | null {
  if (!isTwoDimensionalArray(value)) return null;
  if (!value.every((row) => row.every((cell) => cell === null || cell === undefined || typeof cell === 'string'))) {
    return null;
  }
  return value.map((row) => row.map((cell) => cell == null ? '' : cell as string));
}

async function callDocumentApi<T>(params: {
  pathname: string;
  query: Record<string, string>;
  usageName: string;
  parse: (data: Record<string, unknown>) => T;
  retries?: number;
}): Promise<T> {
  const retries = params.retries ?? 1;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await acquireDingTalkApiSlot();
    const token = await tokenManager.getToken();
    const url = new URL(params.pathname, BASE_URL);
    for (const [key, value] of Object.entries(params.query)) url.searchParams.set(key, value);

    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'x-acs-dingtalk-access-token': token,
        },
      });
      const responseText = await response.text().catch(() => '');
      if (!response.ok) {
        throw new DocumentApiError(
          `钉钉表格 API 调用失败: ${params.usageName} HTTP ${response.status} ${responseText}`,
          response.status === 429 || response.status >= 500,
        );
      }

      let data: Record<string, unknown>;
      try {
        data = responseText ? JSON.parse(responseText) as Record<string, unknown> : {};
      } catch {
        throw new DocumentApiError('钉钉表格响应不是有效 JSON', false);
      }
      const error = businessError(data);
      if (error) throw new DocumentApiError(error, false);

      let parsed: T;
      try {
        parsed = params.parse(data);
      } catch (error) {
        throw new DocumentApiError(error instanceof Error ? error.message : String(error), false);
      }
      await recordApiUsage(params.usageName, true).catch(() => undefined);
      return parsed;
    } catch (error) {
      await recordApiUsage(params.usageName, false).catch(() => undefined);
      const retryable = error instanceof DocumentApiError && error.retryable;
      if (retryable && attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
  throw new Error('钉钉表格 API 超出重试次数');
}

function parseSheet(value: unknown): WorksheetInfo {
  if (!value || typeof value !== 'object') throw new Error('工作表响应格式无效');
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !row.id.trim() || typeof row.name !== 'string' || !row.name.trim()) {
    throw new Error('工作表响应格式无效');
  }
  const result: WorksheetInfo = { id: row.id, name: row.name };
  for (const key of ['rowCount', 'columnCount', 'lastNonEmptyRow', 'lastNonEmptyColumn'] as const) {
    const field = row[key];
    if (field !== undefined) {
      if (typeof field !== 'number' || !Number.isInteger(field)) throw new Error('工作表响应格式无效');
      result[key] = field;
    }
  }
  if (row.visibility !== undefined) {
    if (typeof row.visibility !== 'string') throw new Error('工作表响应格式无效');
    result.visibility = row.visibility;
  }
  return result;
}

export async function listWorkbookSheets(workbookId: string, operatorUnionId: string): Promise<WorksheetInfo[]> {
  return callDocumentApi({
    pathname: `/v1.0/doc/workbooks/${encodeURIComponent(workbookId)}/sheets`,
    query: { operatorId: operatorUnionId },
    usageName: '/v1.0/doc/workbooks/{workbookId}/sheets',
    parse: (data) => {
      if (!Array.isArray(data.value)) throw new Error('工作表列表响应格式无效');
      return data.value.map(parseSheet);
    },
  });
}

export async function getWorksheet(
  workbookId: string,
  sheetId: string,
  operatorUnionId: string,
): Promise<WorksheetInfo> {
  return callDocumentApi({
    pathname: `/v1.0/doc/workbooks/${encodeURIComponent(workbookId)}/sheets/${encodeURIComponent(sheetId)}`,
    query: { operatorId: operatorUnionId },
    usageName: '/v1.0/doc/workbooks/{workbookId}/sheets/{sheetId}',
    parse: parseSheet,
  });
}

export async function getWorksheetRange(
  workbookId: string,
  sheetId: string,
  rangeAddress: string,
  operatorUnionId: string,
): Promise<WorksheetRange> {
  return callDocumentApi({
    pathname: `/v1.0/doc/workbooks/${encodeURIComponent(workbookId)}/sheets/${encodeURIComponent(sheetId)}/ranges/${encodeURIComponent(rangeAddress)}`,
    query: { operatorId: operatorUnionId, select: 'values,displayValues,formulas' },
    usageName: '/v1.0/doc/workbooks/{workbookId}/sheets/{sheetId}/ranges/{rangeAddress}',
    parse: (data) => {
      const displayValues = stringMatrix(data.displayValues ?? []);
      const formulas = stringMatrix(data.formulas ?? []);
      if (!isTwoDimensionalArray(data.values) || displayValues === null || formulas === null) {
        throw new Error('工作表单元格响应格式无效');
      }
      return { values: data.values, displayValues, formulas };
    },
  });
}
