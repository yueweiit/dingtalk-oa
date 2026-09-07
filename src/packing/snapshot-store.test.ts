import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  canonicalSnapshotJson,
  storePackingSnapshot,
  type PackingSheetPayload,
} from './snapshot-store.js';

const payload: PackingSheetPayload = {
  schemaVersion: 1,
  workbookId: 'WB-1',
  sheetId: 'st-1',
  sheetName: '油漆-packing list2026.9.05',
  rangeAddress: 'A1:Y11',
  captureStartedAt: '2026-09-07T01:00:00.000Z',
  captureFinishedAt: '2026-09-07T01:00:01.000Z',
  mergeRangesAvailable: false,
  chunks: [{
    rangeAddress: 'A1:Y11',
    values: [[4197.4, 8.7403305]],
    displayValues: [['¥4197.40', '¥8.74']],
    formulas: [['=SUM(X2:X10)', '=SUM(Y2:Y10)']],
  }],
};

describe('packing snapshot store', () => {
  it('canonicalizes keys and stores an immutable hash-addressed JSON object', async () => {
    const putObject = vi.fn().mockResolvedValue({ etag: 'etag-1' });
    const result = await storePackingSnapshot('CORP-1', payload, {
      bucket: 'dingtalk-packing-snapshots',
      headObject: vi.fn().mockResolvedValue({ exists: false }),
      putObject,
    });

    const body = Buffer.from(canonicalSnapshotJson(payload), 'utf8');
    const sha256 = createHash('sha256').update(body).digest('hex');
    expect(result).toMatchObject({
      bucket: 'dingtalk-packing-snapshots',
      objectKey: `CORP-1/WB-1/st-1/${sha256}.json`,
      sha256,
      size: body.length,
      etag: 'etag-1',
    });
    expect(putObject).toHaveBeenCalledWith(
      `CORP-1/WB-1/st-1/${sha256}.json`,
      body,
      expect.objectContaining({
        'Content-Type': 'application/json',
        'x-amz-meta-sha256': sha256,
      }),
    );
  });

  it('uses HEAD recovery and never uploads an existing valid object', async () => {
    const body = Buffer.from(canonicalSnapshotJson(payload), 'utf8');
    const sha256 = createHash('sha256').update(body).digest('hex');
    const putObject = vi.fn();

    const result = await storePackingSnapshot('CORP-1', payload, {
      bucket: 'dingtalk-packing-snapshots',
      headObject: vi.fn().mockResolvedValue({
        exists: true, size: body.length, sha256, etag: 'existing-etag',
      }),
      putObject,
    });

    expect(putObject).not.toHaveBeenCalled();
    expect(result.etag).toBe('existing-etag');
  });

  it('rejects an existing object whose size or hash does not match', async () => {
    await expect(storePackingSnapshot('CORP-1', payload, {
      bucket: 'dingtalk-packing-snapshots',
      headObject: vi.fn().mockResolvedValue({ exists: true, size: 3, sha256: 'bad', etag: 'bad' }),
      putObject: vi.fn(),
    })).rejects.toThrow('packing snapshot object integrity mismatch');
  });
});
