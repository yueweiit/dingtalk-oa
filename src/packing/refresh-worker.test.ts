import { describe, expect, it, vi } from 'vitest';

import {
  buildUsedRange,
  chunkWorksheetRange,
  processPackingRefreshRequest,
  type PackingRefreshDependencies,
  type PackingRefreshRequest,
} from './refresh-worker.js';

function dependencies(overrides: Partial<PackingRefreshDependencies> = {}): PackingRefreshDependencies {
  return {
    listSheets: vi.fn().mockResolvedValue([]),
    getWorksheet: vi.fn(),
    getRange: vi.fn(),
    replaceSheetIndex: vi.fn(),
    getAllowedWorkbook: vi.fn().mockResolvedValue({ corpId: 'CORP-1', workbookId: 'WB-1' }),
    getLiveSheet: vi.fn().mockResolvedValue({ sheetId: 'st-1', sheetName: 'Sheet 1' }),
    storeSnapshot: vi.fn().mockResolvedValue({
      bucket: 'snapshots', objectKey: 'key', sha256: 'a'.repeat(64), size: 2, etag: 'etag',
    }),
    insertSnapshot: vi.fn().mockResolvedValue(9),
    markSuccess: vi.fn(),
    markFailed: vi.fn(),
    now: vi.fn()
      .mockReturnValueOnce(new Date('2026-09-07T01:00:00.000Z'))
      .mockReturnValueOnce(new Date('2026-09-07T01:00:01.000Z')),
    ...overrides,
  };
}

const sheetRequest: PackingRefreshRequest = {
  id: 7,
  requestKind: 'sheet_snapshot',
  corpId: 'CORP-1',
  workbookId: 'WB-1',
  sheetId: 'st-1',
  attempts: 1,
};

describe('packing refresh worker', () => {
  it('converts zero-based last non-empty indexes to an inclusive A1 range', () => {
    expect(buildUsedRange(10, 24)).toEqual({
      rangeAddress: 'A1:Y11', rowCount: 11, columnCount: 25,
    });
    expect(buildUsedRange(-1, -1)).toEqual({ rangeAddress: null, rowCount: 0, columnCount: 0 });
  });

  it('chunks a worksheet without exceeding the configured cell limit', () => {
    expect(chunkWorksheetRange(501, 25, 5000)).toEqual([
      'A1:Y200', 'A201:Y400', 'A401:Y501',
    ]);
  });

  it('refreshes an empty sheet without calling the range endpoint', async () => {
    const getRange = vi.fn();
    const deps = dependencies({
      getWorksheet: vi.fn().mockResolvedValue({
        id: 'st-1', name: 'Sheet 1', lastNonEmptyRow: -1, lastNonEmptyColumn: -1,
      }),
      getRange,
    });

    await processPackingRefreshRequest(sheetRequest, deps, {
      operatorUnionId: 'UNION-1', bucket: 'snapshots', maxCells: 5000,
      maxRows: 5000, maxColumns: 100,
    });

    expect(getRange).not.toHaveBeenCalled();
    expect(deps.storeSnapshot).toHaveBeenCalledWith('CORP-1', expect.objectContaining({
      rangeAddress: null, chunks: [], mergeRangesAvailable: false,
    }));
    expect(deps.markSuccess).toHaveBeenCalledWith(7, 9);
  });

  it('captures every chunk with raw, display and formula values', async () => {
    const getRange = vi.fn()
      .mockResolvedValueOnce({ values: [[4197.4]], displayValues: [['¥4197.40']], formulas: [['=SUM(X2:X10)']] })
      .mockResolvedValueOnce({ values: [[8.7403305]], displayValues: [['¥8.74']], formulas: [['=SUM(Y2:Y10)']] });
    const deps = dependencies({
      getWorksheet: vi.fn().mockResolvedValue({
        id: 'st-1', name: 'Sheet 1', lastNonEmptyRow: 399, lastNonEmptyColumn: 24,
      }),
      getRange,
    });

    await processPackingRefreshRequest(sheetRequest, deps, {
      operatorUnionId: 'UNION-1', bucket: 'snapshots', maxCells: 5000,
      maxRows: 5000, maxColumns: 100,
    });

    expect(getRange).toHaveBeenNthCalledWith(1, 'WB-1', 'st-1', 'A1:Y200', 'UNION-1');
    expect(getRange).toHaveBeenNthCalledWith(2, 'WB-1', 'st-1', 'A201:Y400', 'UNION-1');
    expect(deps.storeSnapshot).toHaveBeenCalledWith('CORP-1', expect.objectContaining({
      captureStartedAt: '2026-09-07T01:00:00.000Z',
      captureFinishedAt: '2026-09-07T01:00:01.000Z',
      chunks: [
        expect.objectContaining({ values: [[4197.4]], displayValues: [['¥4197.40']] }),
        expect.objectContaining({ values: [[8.7403305]], displayValues: [['¥8.74']] }),
      ],
    }));
  });

  it('refreshes a workbook index and soft-removes sheets missing from the latest response', async () => {
    const deps = dependencies({
      listSheets: vi.fn().mockResolvedValue([{ id: 'st-1', name: 'Only live sheet' }]),
    });
    const request: PackingRefreshRequest = {
      ...sheetRequest, requestKind: 'workbook_index', sheetId: null,
    };

    await processPackingRefreshRequest(request, deps, {
      operatorUnionId: 'UNION-1', bucket: 'snapshots', maxCells: 5000,
      maxRows: 5000, maxColumns: 100,
    });

    expect(deps.replaceSheetIndex).toHaveBeenCalledWith('CORP-1', 'WB-1', [
      { id: 'st-1', name: 'Only live sheet' },
    ]);
    expect(deps.markSuccess).toHaveBeenCalledWith(7, null);
  });

  it('marks permission failures once instead of requeueing forever', async () => {
    const error = Object.assign(new Error('Document.Workbook.Read required'), { code: 'permission_denied' });
    const deps = dependencies({ getWorksheet: vi.fn().mockRejectedValue(error) });

    await expect(processPackingRefreshRequest(sheetRequest, deps, {
      operatorUnionId: 'UNION-1', bucket: 'snapshots', maxCells: 5000,
      maxRows: 5000, maxColumns: 100,
    })).rejects.toThrow('Document.Workbook.Read');

    expect(deps.markFailed).toHaveBeenCalledWith(7, error, false);
  });
});
