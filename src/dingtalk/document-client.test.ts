import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { recordApiUsage } = vi.hoisted(() => ({ recordApiUsage: vi.fn() }));

vi.mock('../db/queries/attachment-archive.js', () => ({ recordApiUsage }));

import {
  getWorksheet,
  getWorksheetRange,
  listWorkbookSheets,
} from './document-client.js';
import { tokenManager } from './token-manager.js';

describe('DingTalk document workbook client', () => {
  beforeEach(() => {
    recordApiUsage.mockReset();
    recordApiUsage.mockResolvedValue(undefined);
    vi.spyOn(tokenManager, 'getToken').mockResolvedValue('app-token');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses the three verified read-only workbook endpoints and preserves raw values', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        value: [{ id: 'st-1', name: '装箱单' }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'st-1', name: '装箱单', rowCount: 100, columnCount: 40,
        lastNonEmptyRow: 10, lastNonEmptyColumn: 24, visibility: 'visible',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        values: [[4197.4, 8.7403305]],
        displayValues: [['¥4197.40', '¥8.74']],
        formulas: [['=SUM(X2:X10)', '=SUM(Y2:Y10)']],
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listWorkbookSheets('WB/1', 'UNION 1')).resolves.toEqual([
      { id: 'st-1', name: '装箱单' },
    ]);
    await expect(getWorksheet('WB/1', 'st-1', 'UNION 1')).resolves.toMatchObject({
      id: 'st-1', lastNonEmptyRow: 10, lastNonEmptyColumn: 24,
    });
    await expect(getWorksheetRange('WB/1', 'st-1', 'A1:Y11', 'UNION 1')).resolves.toEqual({
      values: [[4197.4, 8.7403305]],
      displayValues: [['¥4197.40', '¥8.74']],
      formulas: [['=SUM(X2:X10)', '=SUM(Y2:Y10)']],
    });

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.dingtalk.com/v1.0/doc/workbooks/WB%2F1/sheets?operatorId=UNION+1',
      'https://api.dingtalk.com/v1.0/doc/workbooks/WB%2F1/sheets/st-1?operatorId=UNION+1',
      'https://api.dingtalk.com/v1.0/doc/workbooks/WB%2F1/sheets/st-1/ranges/A1%3AY11?operatorId=UNION+1&select=values%2CdisplayValues%2Cformulas',
    ]);
    expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit).method === 'GET')).toBe(true);
    expect(recordApiUsage).toHaveBeenCalledTimes(3);
  });

  it('does not retry HTTP 403 or a permission business error', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('denied', { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 'Forbidden.AccessDenied.AccessTokenPermissionDenied',
        message: 'Document.Workbook.Read required',
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listWorkbookSheets('wb', 'union')).rejects.toThrow('HTTP 403');
    await expect(listWorkbookSheets('wb', 'union')).rejects.toThrow('Document.Workbook.Read');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recordApiUsage).toHaveBeenNthCalledWith(1, '/v1.0/doc/workbooks/{workbookId}/sheets', false);
    expect(recordApiUsage).toHaveBeenNthCalledWith(2, '/v1.0/doc/workbooks/{workbookId}/sheets', false);
  });

  it('retries HTTP 429 once and records both physical calls', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('limited', { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = listWorkbookSheets('wb', 'union');
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recordApiUsage).toHaveBeenNthCalledWith(1, '/v1.0/doc/workbooks/{workbookId}/sheets', false);
    expect(recordApiUsage).toHaveBeenNthCalledWith(2, '/v1.0/doc/workbooks/{workbookId}/sheets', true);
  });

  it('rejects malformed worksheet responses before returning them', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: '', name: 3,
    }), { status: 200 })));

    await expect(getWorksheet('wb', 'sheet', 'union')).rejects.toThrow('工作表响应格式无效');
    expect(recordApiUsage).toHaveBeenCalledWith('/v1.0/doc/workbooks/{workbookId}/sheets/{sheetId}', false);
  });
});
