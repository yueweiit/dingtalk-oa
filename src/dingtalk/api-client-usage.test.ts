import { beforeEach, describe, expect, it, vi } from 'vitest';

const { recordApiUsage } = vi.hoisted(() => ({ recordApiUsage: vi.fn() }));

vi.mock('../db/queries/attachment-archive.js', () => ({ recordApiUsage }));

import { getApprovalAttachmentDownloadUrl } from './api-client.js';
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
});
