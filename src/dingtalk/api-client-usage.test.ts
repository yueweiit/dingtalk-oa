import { beforeEach, describe, expect, it, vi } from 'vitest';

const { recordApiUsage } = vi.hoisted(() => ({ recordApiUsage: vi.fn() }));

vi.mock('../db/queries/attachment-archive.js', () => ({ recordApiUsage }));

import {
  getApprovalAttachmentDownloadUrl,
  getLegacyApprovalAttachmentSpaceId,
  authorizeLegacyApprovalAttachment,
  authorizeApprovalAttachmentDownload,
  getStorageThumbnailDownload,
  getLegacyApprovalAttachmentDownload,
  getStorageDentryDownloadInfo,
  getThumbnailMediaDownload,
} from './api-client.js';
import { tokenManager } from './token-manager.js';

describe('DingTalk API usage accounting', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    recordApiUsage.mockReset();
    recordApiUsage.mockResolvedValue(undefined);
    vi.spyOn(tokenManager, 'getToken').mockResolvedValue('token');
  });

  it('records every successful quota-consuming request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      result: { downloadUri: 'https://download.example/file' },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    await getApprovalAttachmentDownloadUrl('instance', 'file');

    expect(recordApiUsage).toHaveBeenCalledWith(
      '/workflow/processInstances/spaces/files/urls/download',
      true,
    );
  });

  it('parses legacy and storage download responses including signed headers', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        errcode: 0,
        result: { download_url: 'https://download.example/legacy' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: {
          downloadInfo: {
            resourceUrls: ['https://download.example/storage'],
            headers: { Authorization: 'signed' },
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getLegacyApprovalAttachmentDownload('PROC-1', 'FILE-1'))
      .resolves.toEqual({ uri: 'https://download.example/legacy', headers: {} });
    await expect(getStorageDentryDownloadInfo('SPACE-1', 'FILE-1', 'UNION-1'))
      .resolves.toEqual({
        uri: 'https://download.example/storage',
        headers: { Authorization: 'signed' },
      });
  });

  it('creates the media fallback URL without exposing it to diagnostics', async () => {
    await expect(getThumbnailMediaDownload('MEDIA/1')).resolves.toEqual({
      uri: 'https://oapi.dingtalk.com/media/downloadFile?access_token=token&media_id=MEDIA%2F1',
      headers: {},
    });
  });

  it('records HTTP 200 business errors as failures without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 'userNotExist', message: '用户不存在',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getApprovalAttachmentDownloadUrl('instance', 'file')).rejects.toThrow('userNotExist');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordApiUsage).toHaveBeenCalledWith('/workflow/processInstances/spaces/files/urls/download', false);
  });

  it('uses documented cspace, authorization and thumbnail request bodies', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, result: { space_id: '123' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, result: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { items: [{ downloadUrl: 'https://download.example/thumb' }] } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await getLegacyApprovalAttachmentSpaceId('PROC', 'FILE', 'USER');
    await authorizeLegacyApprovalAttachment('FILE', '123', 'USER');
    await authorizeApprovalAttachmentDownload('FILE', '123', 'USER');
    await getStorageThumbnailDownload('123', 'FILE', 'UNION');

    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)));
    expect(bodies[0]).toEqual({ user_id: 'USER' });
    expect(bodies[1]).toEqual({ request: { file_infos: [{ file_id: 'FILE', space_id: 123 }], userid: 'USER' } });
    expect(bodies[2]).toEqual({ userId: 'USER', fileInfos: [{ spaceId: 123, fileId: 'FILE' }] });
    expect(bodies[3]).toEqual({ dentryIds: ['FILE'] });
  });

  it('records item-level thumbnail business errors as failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      result: { resultItems: [{ success: false, errorCode: 'dentryNotExist', errorMessage: '文件不存在' }] },
    }), { status: 200 })));

    await expect(getStorageThumbnailDownload('123', 'FILE', 'UNION')).rejects.toThrow('dentryNotExist');
    expect(recordApiUsage).toHaveBeenCalledWith('/storage/spaces/{spaceId}/thumbnails/query', false);
    expect(recordApiUsage).not.toHaveBeenCalledWith('/storage/spaces/{spaceId}/thumbnails/query', true);
  });
});
