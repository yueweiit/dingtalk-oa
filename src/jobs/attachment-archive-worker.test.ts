import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingArchive } from '../archive/archive-job.js';
import { notifyAttachmentQueue } from '../archive/queue-signal.js';
import { createAttachmentArchiveWorker } from './attachment-archive-worker.js';

// Vitest's fake clock does not replace Node's internal timers/promises clock.
vi.mock('node:timers/promises', () => ({ setTimeout: (ms: number, value: unknown, options: { signal: AbortSignal }) =>
  new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
    const timer = setTimeout(() => { options.signal.removeEventListener('abort', abort); resolve(value); }, ms);
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
  }),
}));

const record: PendingArchive = { id: 1, corpId: 'corp', processInstanceId: 'instance', processCode: 'OPS',
  origin: 'comment', fileId: 'file', spaceId: 'space', fileName: 'receipt.pdf', declaredSize: 10,
  objectKey: 'corp/instance/file/revision-0/claim-1', attempts: 1, claimGeneration: '1' };
let worker: ReturnType<typeof createAttachmentArchiveWorker> | undefined;
function setup(batchSize = 10) {
  const dependencies = {
    retire: vi.fn<() => Promise<number>>().mockResolvedValue(0),
    claim: vi.fn<(priority: boolean) => Promise<PendingArchive | undefined>>().mockResolvedValue(undefined),
    archive: vi.fn<(record: PendingArchive) => Promise<void>>().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined), report: vi.fn().mockResolvedValue(undefined), onError: vi.fn(),
  };
  worker = createAttachmentArchiveWorker({ batchSize, pollMs: 5000, delayMs: 1000 }, dependencies);
  return dependencies;
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => { await worker?.stop(); worker = undefined; vi.useRealTimers(); });

describe('automatic attachment archive worker', () => {
  it('drains persisted work on startup, polls after an empty queue and wakes promptly after commit', async () => {
    const deps = setup();
    deps.claim.mockResolvedValueOnce(record);
    worker!.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.archive).toHaveBeenCalledWith(record);
    expect(deps.claim).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(deps.claim).toHaveBeenCalledTimes(3);
    deps.claim.mockResolvedValueOnce({ ...record, fileId: 'later-comment' });
    notifyAttachmentQueue(); notifyAttachmentQueue();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.archive).toHaveBeenCalledTimes(2);
  });

  it('preserves a history slot across small batches while preferring live files', async () => {
    const deps = setup(1);
    deps.claim.mockResolvedValue(record);
    worker!.start();
    await vi.advanceTimersByTimeAsync(24_000);
    expect(deps.claim.mock.calls.map(([priority]) => priority)).toEqual([true, true, true, true, false]);
  });

  it('does not overlap a slow archive even when repeatedly woken, and awaits it on stop', async () => {
    const deps = setup();
    let release!: () => void;
    deps.claim.mockResolvedValue(record);
    deps.archive.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    worker!.start();
    await vi.advanceTimersByTimeAsync(0);
    notifyAttachmentQueue();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.claim).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = worker!.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    notifyAttachmentQueue();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.claim).toHaveBeenCalledTimes(1);
    expect(deps.report).toHaveBeenCalledWith(expect.objectContaining({ processedCount: 1, failedCount: 0 }));
  });

  it('records a failed download and continues the next file without losing queue identity', async () => {
    const deps = setup();
    const error = new Error('permissionDenied');
    deps.claim.mockResolvedValueOnce(record).mockResolvedValueOnce({ ...record, id: 2 });
    deps.archive.mockRejectedValueOnce(error);
    worker!.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(deps.fail).toHaveBeenCalledWith(record, error);
    expect(deps.archive).toHaveBeenCalledTimes(2);
    expect(deps.report).toHaveBeenCalledWith(expect.objectContaining({ processedCount: 1, failedCount: 1 }));
  });

  it('backs off after a queue/database failure and never logs its raw secret-bearing message', async () => {
    const deps = setup();
    deps.claim.mockRejectedValueOnce(new Error('private signed download URI'));
    worker!.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.onError.mock.calls).toEqual([['ATTACHMENT_ARCHIVE_WORKER_FAILED']]);
    expect(deps.report).toHaveBeenCalledWith(expect.objectContaining({ success: false,
      processedCount: 0, failedCount: 0, errorCode: 'ATTACHMENT_ARCHIVE_CLAIM_FAILED' }));
    await vi.advanceTimersByTimeAsync(4999);
    expect(deps.claim).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.claim).toHaveBeenCalledTimes(2);
  });

  it('retires ineligible records on startup and periodically even when there is no queue work', async () => {
    const deps = setup();
    worker!.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.retire).toHaveBeenCalledTimes(1);
    expect(deps.retire.mock.invocationCallOrder[0]).toBeLessThan(deps.claim.mock.invocationCallOrder[0]);
    expect(deps.report).toHaveBeenCalledWith(expect.objectContaining({ success: true, processedCount: 0, failedCount: 0 }));
    for (let i = 0; i < 5; i++) {
      notifyAttachmentQueue();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(deps.retire).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.retire).toHaveBeenCalledTimes(2);
  });

  it('reports a claim failure after a successful file as a failed batch', async () => {
    const deps = setup();
    deps.claim.mockResolvedValueOnce(record).mockRejectedValueOnce(new Error('private query details'));
    worker!.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.report).toHaveBeenCalledWith(expect.objectContaining({ success: false,
      processedCount: 1, failedCount: 0, errorCode: 'ATTACHMENT_ARCHIVE_CLAIM_FAILED' }));
    expect(JSON.stringify(deps.report.mock.calls)).not.toContain('private query details');
  });

  it('reports retirement errors, then retries maintenance and resumes queue polling', async () => {
    const deps = setup();
    deps.retire.mockRejectedValueOnce(new Error('private maintenance details'));
    worker!.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.claim).not.toHaveBeenCalled();
    expect(deps.report).toHaveBeenLastCalledWith(expect.objectContaining({ success: false,
      errorCode: 'ATTACHMENT_ARCHIVE_RETIRE_FAILED' }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(deps.retire).toHaveBeenCalledTimes(2);
    expect(deps.claim).toHaveBeenCalledTimes(1);
    expect(deps.report).toHaveBeenLastCalledWith(expect.objectContaining({ success: true, errorCode: undefined }));
  });

  it('does not report success when writing a failed attachment state fails', async () => {
    const deps = setup();
    deps.claim.mockResolvedValueOnce(record);
    deps.archive.mockRejectedValueOnce(new Error('ATTACHMENT_STORAGE_TIMEOUT'));
    deps.fail.mockRejectedValueOnce(new Error('private database details'));
    worker!.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.report).toHaveBeenCalledWith(expect.objectContaining({ success: false, failedCount: 1,
      errorCode: 'ATTACHMENT_ARCHIVE_FAILURE_WRITE_FAILED' }));
  });
});
