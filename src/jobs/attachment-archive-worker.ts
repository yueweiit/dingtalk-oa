import { setTimeout as wait } from 'node:timers/promises';
import { getConfig } from '../config/index.js';
import type { PendingArchive } from '../archive/archive-job.js';
import { archiveQueuedAttachment } from '../archive/archive-runtime.js';
import { subscribeAttachmentQueue } from '../archive/queue-signal.js';
import { claimPendingAttachments, markAttachmentFailed, retireIneligibleAttachments, updateArchiveHealth } from '../db/queries/attachment-archive.js';

interface WorkerOptions { pollMs: number; batchSize: number; delayMs: number }
interface WorkerResult {
  startedAt: Date;
  processedCount: number;
  failedCount: number;
  success: boolean;
  errorCode?: string;
}
interface WorkerDependencies {
  retire: () => Promise<number>;
  claim: (prioritize: boolean) => Promise<PendingArchive | undefined>;
  archive: (record: PendingArchive) => Promise<void>;
  fail: (record: PendingArchive, error: unknown) => Promise<void>;
  report: (result: WorkerResult) => Promise<void>;
  onError: (code: string) => void;
}

export function createAttachmentArchiveWorker(options: WorkerOptions, dependencies: WorkerDependencies) {
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let unsubscribe: (() => void) | undefined;
  let wakeRequested = false;
  let claims = 0;
  let nextRetirementAt = 0;

  function schedule(ms: number) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, ms);
    timer.unref();
  }

  async function drain(signal: AbortSignal) {
    const result = { startedAt: new Date(), processedCount: 0, failedCount: 0 };
    let stage = 'ATTACHMENT_ARCHIVE_RETIRE_FAILED';
    let errorCode: string | undefined;
    try {
      if (Date.now() >= nextRetirementAt) {
        await dependencies.retire();
        nextRetirementAt = Date.now() + 60_000;
      }
      for (let index = 0; index < options.batchSize && !signal.aborted; index++) {
        // Reserve every fifth claim for the oldest ready item, even with batchSize=1.
        // Claim one file at a time: a slow file cannot consume another file's lease.
        stage = 'ATTACHMENT_ARCHIVE_CLAIM_FAILED';
        const record = await dependencies.claim(claims % 5 !== 4);
        if (!record) break;
        claims++;
        try {
          await dependencies.archive(record);
          result.processedCount++;
        } catch (error) {
          result.failedCount++;
          stage = 'ATTACHMENT_ARCHIVE_FAILURE_WRITE_FAILED';
          await dependencies.fail(record, error);
        }
        stage = 'ATTACHMENT_ARCHIVE_WORKER_FAILED';
        if (!signal.aborted) await wait(options.delayMs, undefined, { signal });
      }
    } catch (error) {
      if (!signal.aborted || (error as Error)?.name !== 'AbortError') {
        errorCode = stage;
        throw error;
      }
    } finally {
      await dependencies.report({ ...result, success: !errorCode && result.failedCount === 0,
        errorCode: errorCode ?? (result.failedCount ? 'ATTACHMENT_ARCHIVE_BATCH_FAILED' : undefined),
      });
    }
  }

  function tick() {
    timer = undefined;
    if (!controller || controller.signal.aborted || active) return;
    wakeRequested = false;
    active = drain(controller.signal)
      .catch(() => dependencies.onError('ATTACHMENT_ARCHIVE_WORKER_FAILED'))
      .finally(() => {
        active = undefined;
        if (controller && !controller.signal.aborted) schedule(wakeRequested ? 0 : options.pollMs);
      });
  }

  function wake() {
    if (!controller || controller.signal.aborted) return;
    if (active) wakeRequested = true;
    else schedule(0);
  }

  return {
    start() {
      if (active || (controller && !controller.signal.aborted)) return;
      controller = new AbortController();
      nextRetirementAt = 0;
      unsubscribe = subscribeAttachmentQueue(wake);
      wake();
    },
    wake,
    async stop() {
      controller?.abort();
      if (timer) clearTimeout(timer);
      timer = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
      // Finish the owned file before the application's pool is closed.
      await active;
    },
  };
}

let worker: ReturnType<typeof createAttachmentArchiveWorker> | undefined;

export function startAttachmentArchiveWorker(): void {
  const config = getConfig();
  if (!config.ARCHIVE_WORKER_ENABLED || worker) return;
  if (!config.ARCHIVE_MINIO_ACCESS_KEY || !config.ARCHIVE_MINIO_SECRET_KEY) {
    throw new Error('ARCHIVE_STORAGE_NOT_CONFIGURED');
  }
  worker = createAttachmentArchiveWorker({
    pollMs: config.ARCHIVE_WORKER_POLL_MS, batchSize: config.ARCHIVE_BATCH_SIZE, delayMs: config.ARCHIVE_DELAY_MS,
  }, {
    retire: () => retireIneligibleAttachments(100),
    claim: async prioritize => (await claimPendingAttachments(1, config.ARCHIVE_RECOVERY_CANARY_ONLY, undefined, prioritize))[0],
    archive: record => archiveQueuedAttachment(record, true),
    fail: (record, error) => markAttachmentFailed(record.id, record.recoveryCanary ? 5 : record.attempts,
      error, record.objectKey, record.claimGeneration),
    report: async result => {
      await updateArchiveHealth({ ...result, completed: true, scannedCount: 0,
        ...(result.errorCode ? { error: new Error(result.errorCode) } : {}),
      });
      if (result.processedCount || result.failedCount || result.errorCode) {
        console.log('[Archive] ATTACHMENT_ARCHIVE_BATCH_FINISHED', result);
      }
    },
    onError: code => console.error('[Archive]', code),
  });
  worker.start();
  console.log('[Archive] ATTACHMENT_ARCHIVE_WORKER_STARTED');
}

export async function stopAttachmentArchiveWorker(): Promise<void> {
  await worker?.stop();
  worker = undefined;
}
