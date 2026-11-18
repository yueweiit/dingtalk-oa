import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  corpEnabled: vi.fn(), templateEnabled: vi.fn(), enqueueCorp: vi.fn(), enqueueTemplate: vi.fn(),
  claim: vi.fn(), archive: vi.fn(), health: vi.fn(), legacy: vi.fn(), sync: vi.fn(), retire: vi.fn(), close: vi.fn(),
}));
vi.mock('../config/index.js', () => ({ getConfig: () => ({
  ARCHIVE_BATCH_SIZE: 3, ARCHIVE_RECOVERY_CANARY_ONLY: false, ARCHIVE_DELAY_MS: 0,
}) }));
vi.mock('../db/pool.js', () => ({ closePool: state.close }));
vi.mock('../archive/archive-runtime.js', () => ({ archiveQueuedAttachment: state.archive }));
vi.mock('../db/queries/attachment-archive.js', () => ({
  isAttachmentCorpEnabled: state.corpEnabled, isAttachmentTemplateEnabled: state.templateEnabled,
  enqueueCorpAttachments: state.enqueueCorp, enqueueTemplateAttachments: state.enqueueTemplate,
  claimPendingAttachments: state.claim, updateArchiveHealth: state.health, listWhitelistedInstances: state.legacy,
  synchronizeInstanceAttachments: state.sync, retireIneligibleAttachments: state.retire, markAttachmentFailed: vi.fn(),
}));

describe('corporation-wide archive CLI', () => {
  const argv = process.argv;
  const exitCode = process.exitCode;
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
    state.corpEnabled.mockResolvedValue(true);
    state.claim.mockResolvedValue([]);
    state.enqueueCorp.mockResolvedValue({ scannedCount: 4, candidateCount: 7 });
  });
  afterEach(() => {
    process.argv = argv;
    process.exitCode = exitCode;
    vi.restoreAllMocks();
  });
  async function run(...args: string[]) {
    process.argv = ['node', 'archive-attachments.js', ...args];
    await import('./archive-attachments.js');
    await vi.waitFor(() => expect(state.close).toHaveBeenCalledTimes(1));
  }

  it('registers historical references without downloading when enqueue-only is requested', async () => {
    await run('--corp-id=corp', '--all-templates', '--enqueue-only');
    expect(state.corpEnabled).toHaveBeenCalledWith('corp');
    expect(state.enqueueCorp).toHaveBeenCalledWith('corp');
    expect(state.claim).not.toHaveBeenCalled();
    expect(state.archive).not.toHaveBeenCalled();
    expect(state.legacy).not.toHaveBeenCalled();
    expect(state.health).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('limits a manual download batch to the selected corporation', async () => {
    await run('--corp-id=corp', '--all-templates');
    expect(state.claim).toHaveBeenCalledWith(3, false, { corpId: 'corp', allTemplates: true, enqueueOnly: false });
    expect(state.enqueueCorp).not.toHaveBeenCalled();
    expect(state.legacy).not.toHaveBeenCalled();
    expect(state.retire).not.toHaveBeenCalled();
    expect(state.health).toHaveBeenLastCalledWith(expect.objectContaining({ completed: true, success: true }));
    expect(process.exitCode).toBeUndefined();
  });

  it('fails before registration or download if the corporation has not opted in', async () => {
    state.corpEnabled.mockResolvedValue(false);
    await run('--corp-id=corp', '--all-templates', '--enqueue-only');
    expect(state.enqueueCorp).not.toHaveBeenCalled();
    expect(state.claim).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('[Archive] 归档任务失败:', expect.objectContaining({ message: 'ATTACHMENT_CORP_SCOPE_DISABLED' }));
    expect(process.exitCode).toBe(1);
  });

  it('never falls back to a global batch for an incomplete corporation selector', async () => {
    await run('--corp-id=corp');
    expect(state.corpEnabled).not.toHaveBeenCalled();
    expect(state.claim).not.toHaveBeenCalled();
    expect(state.legacy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
