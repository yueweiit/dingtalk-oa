import { describe, expect, it, vi } from 'vitest';
import { archiveAttachment, failureState } from './archive-job.js';

const record = {
  id: 1,
  corpId: 'corp',
  processInstanceId: 'PROC-1',
  processCode: 'LOGISTICS',
  origin: 'form' as const,
  fileId: 'FILE-1',
  spaceId: 'SPACE-1',
  fileName: 'packing.xlsx',
  declaredSize: 4,
  objectKey: 'corp/PROC-1/FILE-1',
  claimGeneration: '1',
  attempts: 0,
};

describe('attachment archive job', () => {
  it('recovers from a previous DB failure using object HEAD without another DingTalk call', async () => {
    const markArchived = vi.fn();
    const getDownloadUri = vi.fn();

    await archiveAttachment(record, {
      headObject: async () => ({
        exists: true,
        size: 4,
        etag: 'etag-existing',
        contentType: 'application/vnd.ms-excel',
        sha256: 'existing-sha',
        archiveMethod: 'legacy_file_url',
        contentQuality: 'original',
      }),
      getDownload: getDownloadUri,
      fetchContent: vi.fn(),
      putObject: vi.fn(),
      markArchived,
      recordApiCall: vi.fn(),
    });

    expect(getDownloadUri).not.toHaveBeenCalled();
    expect(markArchived).toHaveBeenCalledWith(
      record.id,
      expect.objectContaining({
        etag: 'etag-existing',
        sha256: 'existing-sha',
        actualSize: 4,
        archiveMethod: 'legacy_file_url',
        contentQuality: 'original',
      }),
    );
  });

  it('downloads once, verifies size, hashes, uploads, then marks archived', async () => {
    const putObject = vi.fn();
    const markArchived = vi.fn();
    const recordApiCall = vi.fn();

    await archiveAttachment(record, {
      headObject: async () => ({ exists: false }),
      getDownload: async () => ({
        uri: 'https://download.example/file',
        headers: {},
        archiveMethod: 'workflow_download',
        contentQuality: 'original',
        diagnostics: [{ strategy: 'workflow_download', ok: true, attemptedAt: '2026-09-04T08:00:00.000Z' }],
      }),
      fetchContent: async () => ({ body: Buffer.from('data'), contentType: 'application/octet-stream' }),
      putObject,
      markArchived,
      recordApiCall,
    });

    expect(recordApiCall).toHaveBeenCalledWith('attachment_content:workflow_download', true);
    expect(putObject).toHaveBeenCalledWith(
      record.objectKey,
      Buffer.from('data'),
      expect.objectContaining({
        'x-amz-meta-original-filename': 'packing.xlsx',
        'x-amz-meta-archive-method': 'workflow_download',
        'x-amz-meta-content-quality': 'original',
      }),
    );
    expect(markArchived).toHaveBeenCalledWith(
      record.id,
      expect.objectContaining({
        actualSize: 4,
        archiveMethod: 'workflow_download',
        contentQuality: 'original',
        sha256: '3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7',
      }),
    );
  });

  it('encodes non-ASCII filenames before placing them in HTTP object metadata', async () => {
    const putObject = vi.fn();

    await archiveAttachment({ ...record, fileName: '国际物流装箱单.xlsx' }, {
      headObject: async () => ({ exists: false }),
      getDownload: async () => ({
        uri: 'https://download.example/file',
        headers: {},
        archiveMethod: 'workflow_download',
        contentQuality: 'original',
        diagnostics: [],
      }),
      fetchContent: async () => ({ body: Buffer.from('data'), contentType: 'application/octet-stream' }),
      putObject,
      markArchived: vi.fn(),
      recordApiCall: vi.fn(),
    });

    const metadata = putObject.mock.calls[0][2];
    expect(metadata['x-amz-meta-original-filename']).toBe(
      encodeURIComponent('国际物流装箱单.xlsx'),
    );
    expect(/^[\x00-\x7F]*$/.test(metadata['x-amz-meta-original-filename'])).toBe(true);
  });

  it('uses retry through attempt four and manual review on attempt five', () => {
    expect(failureState(4)).toBe('retry');
    expect(failureState(5)).toBe('manual_required');
  });

  it('does not treat userNotExist as proof that the file is permanently unavailable', () => {
    expect(failureState(1, new Error('{"code":"userNotExist","message":"用户不存在"}')))
      .toBe('retry');
    expect(failureState(1, new Error('{"code":"noPermission","message":"无访问权限"}')))
      .toBe('manual_required');
    const exhausted = new Error('未返回下载地址');
    Object.assign(exhausted, {
      diagnostics: [
        { strategy: 'workflow_download', ok: false, errorCode: 'invalidFileId' },
        { strategy: 'thumbnail_media', ok: false, message: '未返回下载地址' },
      ],
    });
    expect(failureState(1, exhausted)).toBe('manual_required');
  });

  it('forwards signed headers and accepts preview-quality thumbnail size differences', async () => {
    const fetchContent = vi.fn(async () => ({
      body: Buffer.from('preview'),
      contentType: 'image/png',
    }));
    const markArchived = vi.fn();

    await archiveAttachment(record, {
      headObject: async () => ({ exists: false }),
      getDownload: async () => ({
        uri: 'https://download.example/thumbnail',
        headers: { Authorization: 'signed' },
        archiveMethod: 'thumbnail_media',
        contentQuality: 'preview',
        diagnostics: [
          { strategy: 'workflow_download', ok: false, errorCode: 'userNotExist', attemptedAt: '2026-09-04T08:00:00.000Z' },
          { strategy: 'thumbnail_media', ok: true, attemptedAt: '2026-09-04T08:00:01.000Z' },
        ],
      }),
      fetchContent,
      putObject: vi.fn(async () => ({ etag: 'preview-etag' })),
      markArchived,
      recordApiCall: vi.fn(),
    });

    expect(fetchContent).toHaveBeenCalledWith(
      'https://download.example/thumbnail',
      { Authorization: 'signed' },
    );
    expect(markArchived).toHaveBeenCalledWith(record.id, expect.objectContaining({
      archiveMethod: 'thumbnail_media',
      contentQuality: 'preview',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ strategy: 'workflow_download', ok: false }),
      ]),
    }));
  });

  it('preserves strategy diagnostics when content download fails', async () => {
    const failure = new Error('download connection reset');
    await expect(archiveAttachment(record, {
      headObject: async () => ({ exists: false }),
      getDownload: async () => ({
        uri: 'https://download.example/file', headers: {},
        archiveMethod: 'legacy_file_url', contentQuality: 'original',
        diagnostics: [{ strategy: 'workflow_download', ok: false, errorCode: 'userNotExist', attemptedAt: '2026-09-04T08:00:00.000Z' }],
      }),
      fetchContent: async () => { throw failure; },
      putObject: vi.fn(), markArchived: vi.fn(), recordApiCall: vi.fn(),
    })).rejects.toBe(failure);
    expect(failure).toMatchObject({
      archiveMethod: 'legacy_file_url',
      diagnostics: [expect.objectContaining({ errorCode: 'userNotExist' })],
    });
  });
});
