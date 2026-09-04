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
      }),
      getDownloadUri,
      fetchContent: vi.fn(),
      putObject: vi.fn(),
      markArchived,
      recordApiCall: vi.fn(),
    });

    expect(getDownloadUri).not.toHaveBeenCalled();
    expect(markArchived).toHaveBeenCalledWith(
      record.id,
      expect.objectContaining({ etag: 'etag-existing', sha256: 'existing-sha', actualSize: 4 }),
    );
  });

  it('downloads once, verifies size, hashes, uploads, then marks archived', async () => {
    const putObject = vi.fn();
    const markArchived = vi.fn();
    const recordApiCall = vi.fn();

    await archiveAttachment(record, {
      headObject: async () => ({ exists: false }),
      getDownloadUri: async () => 'https://download.example/file',
      fetchContent: async () => ({ body: Buffer.from('data'), contentType: 'application/octet-stream' }),
      putObject,
      markArchived,
      recordApiCall,
    });

    expect(recordApiCall).toHaveBeenCalledWith('approval_attachment_download_url', true);
    expect(putObject).toHaveBeenCalledWith(
      record.objectKey,
      Buffer.from('data'),
      expect.objectContaining({ 'x-amz-meta-original-filename': 'packing.xlsx' }),
    );
    expect(markArchived).toHaveBeenCalledWith(
      record.id,
      expect.objectContaining({
        actualSize: 4,
        sha256: '3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7',
      }),
    );
  });

  it('encodes non-ASCII filenames before placing them in HTTP object metadata', async () => {
    const putObject = vi.fn();

    await archiveAttachment({ ...record, fileName: '国际物流装箱单.xlsx' }, {
      headObject: async () => ({ exists: false }),
      getDownloadUri: async () => 'https://download.example/file',
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

  it('sends permanent DingTalk permission and historical-user errors straight to manual review', () => {
    expect(failureState(1, new Error('{"code":"userNotExist","message":"用户不存在"}')))
      .toBe('manual_required');
    expect(failureState(1, new Error('{"code":"noPermission","message":"无访问权限"}')))
      .toBe('manual_required');
  });
});
