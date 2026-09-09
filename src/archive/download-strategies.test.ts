import { describe, expect, it, vi } from 'vitest';
import { resolveDownloadWithStrategies } from './download-strategies.js';

const record = {
  id: 11,
  corpId: 'corp',
  processInstanceId: 'PROC-1',
  processCode: 'LOGISTICS',
  origin: 'form' as const,
  fileId: 'FILE-1',
  spaceId: 'SPACE-1',
  fileName: '装箱单.png',
  declaredSize: 100,
  objectKey: 'corp/PROC-1/FILE-1',
  claimGeneration: '1',
  attempts: 1,
  thumbnailMediaId: 'MEDIA-1',
};

describe('attachment download strategy chain', () => {
  it('uses the first successful strategy and records prior failures without leaking URLs', async () => {
    const current = vi.fn(async () => { throw new Error('{"code":"userNotExist"}'); });
    const legacy = vi.fn(async () => ({
      uri: 'https://secret.example/file?token=abc',
      headers: { Authorization: 'signed' },
    }));
    const drive = vi.fn();

    const result = await resolveDownloadWithStrategies(record, [
      { name: 'workflow_download', contentQuality: 'original', run: current },
      { name: 'legacy_file_url', contentQuality: 'original', run: legacy },
      { name: 'drive_download', contentQuality: 'original', run: drive },
    ]);

    expect(result.archiveMethod).toBe('legacy_file_url');
    expect(result.uri).toContain('secret.example');
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ strategy: 'workflow_download', ok: false, errorCode: 'userNotExist', message: '{"code":"userNotExist"}', attemptedAt: expect.any(String) }),
      expect.objectContaining({ strategy: 'legacy_file_url', ok: true, attemptedAt: expect.any(String) }),
    ]);
    expect(JSON.stringify(result.diagnostics)).not.toContain('token=abc');
    expect(drive).not.toHaveBeenCalled();
  });

  it('throws one diagnostic error after every strategy fails', async () => {
    await expect(resolveDownloadWithStrategies(record, [
      { name: 'workflow_download', contentQuality: 'original', run: async () => { throw new Error('userNotExist'); } },
      { name: 'thumbnail_media', contentQuality: 'preview', run: async () => null },
    ])).rejects.toMatchObject({
      code: 'attachment_download_strategies_exhausted',
      diagnostics: [
        expect.objectContaining({ strategy: 'workflow_download', ok: false }),
        expect.objectContaining({ strategy: 'thumbnail_media', ok: false }),
      ],
    });
  });
});
