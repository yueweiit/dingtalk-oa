import { describe, expect, it, vi } from 'vitest';
import { resolveDingTalkArchiveDownload, type DingTalkArchiveApi } from './dingtalk-download.js';

const record = {
  id: 1,
  corpId: 'corp',
  processInstanceId: 'PROC-1',
  processCode: 'LOGISTICS',
  origin: 'form' as const,
  fileId: 'FILE-1',
  spaceId: 'SPACE-1',
  fileName: '装箱计划.png',
  declaredSize: 12,
  objectKey: 'corp/PROC-1/FILE-1',
  attempts: 1,
  thumbnailMediaId: 'MEDIA-1',
};

function api(overrides: Partial<DingTalkArchiveApi> = {}): DingTalkArchiveApi {
  const unavailable = async () => { throw new Error('unavailable'); };
  return {
    workflowDownload: unavailable,
    legacyFileUrl: unavailable,
    legacySpaceId: unavailable,
    legacyAuthorize: unavailable,
    authorizeDownload: unavailable,
    userUnionId: unavailable,
    storageDentryDownload: unavailable,
    driveDownload: unavailable,
    storageThumbnail: unavailable,
    thumbnailMedia: unavailable,
    ...overrides,
  };
}

describe('DingTalk archive resolver', () => {
  it('tries current, legacy, authorization, storage, and drive in a controlled order', async () => {
    const calls: string[] = [];
    const result = await resolveDingTalkArchiveDownload(record, {
      downloadUserId: 'ACTIVE-USER',
      configuredUnionId: 'UNION-1',
      api: api({
        workflowDownload: async () => { calls.push('workflow'); throw new Error('userNotExist'); },
        legacyFileUrl: async () => { calls.push('legacy'); throw new Error('userNotExist'); },
        legacyAuthorize: async (_fileId, _spaceId, userId) => {
          calls.push(`legacy-auth:${userId}`);
        },
        authorizeDownload: async (_fileId, _spaceId, userId) => {
          calls.push(`new-auth:${userId}`);
        },
        storageDentryDownload: async () => {
          calls.push('storage');
          return { uri: 'https://download.example/storage', headers: { 'x-signature': 'ok' } };
        },
      }),
    });

    expect(result.archiveMethod).toBe('storage_dentry');
    expect(result.headers).toEqual({ 'x-signature': 'ok' });
    expect(calls).toEqual([
      'workflow',
      'legacy',
      'legacy-auth:ACTIVE-USER',
      'legacy',
      'new-auth:ACTIVE-USER',
      'workflow',
      'storage',
    ]);
  });

  it('uses a successful legacy authorization without requiring modern authorization', async () => {
    let legacyCalls = 0;
    const result = await resolveDingTalkArchiveDownload(record, {
      downloadUserId: 'ACTIVE-USER',
      api: api({
        legacyFileUrl: async () => {
          legacyCalls += 1;
          if (legacyCalls === 1) throw new Error('noPermission');
          return { uri: 'https://download.example/legacy-authorized' };
        },
        legacyAuthorize: async () => undefined,
      }),
    });

    expect(result.archiveMethod).toBe('legacy_dentry_auth');
  });

  it('uses a thumbnail only for images and labels it preview quality', async () => {
    const thumbnailMedia = vi.fn(async () => ({ uri: 'https://download.example/thumb' }));
    const result = await resolveDingTalkArchiveDownload(record, {
      downloadUserId: 'ACTIVE-USER',
      api: api({ thumbnailMedia }),
    });
    expect(result).toMatchObject({ archiveMethod: 'thumbnail_media', contentQuality: 'preview' });

    await expect(resolveDingTalkArchiveDownload(
      { ...record, fileName: '装箱单.xlsx' },
      { downloadUserId: 'ACTIVE-USER', api: api({ thumbnailMedia }) },
    )).rejects.toMatchObject({ code: 'attachment_download_strategies_exhausted' });
    expect(thumbnailMedia).toHaveBeenCalledTimes(1);
  });
});
