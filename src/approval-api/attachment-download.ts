import { PassThrough, type Readable } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DownloadAttachment } from '../db/queries/approval-read-api.js';

export type AttachmentDownloadCode = 'ATTACHMENT_UNAVAILABLE' | 'ATTACHMENT_TIMEOUT';

export class AttachmentDownloadError extends Error {
  constructor(readonly code: AttachmentDownloadCode) {
    super(code);
  }
}

export interface DownloadOptions {
  openTimeoutMs: number;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  openObject: (bucket: string, objectKey: string, signal: AbortSignal) => Promise<Readable>;
}

/** Bound even an incorrectly implemented opener; destroy a stream returned after cancellation. */
function openWithAbort(open: () => Promise<Readable>, signal: AbortSignal): Promise<Readable> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
      return;
    }
    Promise.resolve().then(open).then(stream => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) {
        stream.on('error', () => undefined);
        stream.destroy();
      } else {
        resolve(stream);
      }
    }, error => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

export async function sendAttachmentDownload(
  request: FastifyRequest,
  reply: FastifyReply,
  item: DownloadAttachment,
  options: DownloadOptions,
): Promise<void> {
  const controller = new AbortController();
  let source: Readable | undefined;
  let output: PassThrough | undefined;
  let openTimer: NodeJS.Timeout | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let totalTimer: NodeJS.Timeout | undefined;
  let stopped = false;

  const clearTimers = () => {
    clearTimeout(openTimer);
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
  };
  const stopStorage = (reason: Error) => {
    if (!controller.signal.aborted) controller.abort(reason);
    if (source && output) source.unpipe(output);
    source?.destroy();
  };
  const onDisconnect = () => {
    if (stopped) {
      cleanupListeners();
      return;
    }
    stopped = true;
    clearTimers();
    stopStorage(new Error('CLIENT_DISCONNECTED'));
    output?.destroy();
    cleanupListeners();
  };
  const onFinish = () => {
    stopped = true;
    clearTimers();
    cleanupListeners();
  };
  const cleanupListeners = () => {
    request.raw.removeListener('aborted', onDisconnect);
    reply.raw.removeListener('close', onDisconnect);
    reply.raw.removeListener('finish', onFinish);
  };
  const fail = (code: AttachmentDownloadCode) => {
    if (stopped) return;
    stopped = true;
    clearTimers();
    const error = new AttachmentDownloadError(code);
    request.log.warn({ code, resource: 'attachment-content' }, 'Attachment transfer failed');
    stopStorage(error);
    // Only this fixed error reaches Fastify: raw backend errors never enter its serializers/logs.
    output?.destroy(error);
  };
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fail('ATTACHMENT_TIMEOUT'), options.idleTimeoutMs);
    idleTimer.unref();
  };

  request.raw.once('aborted', onDisconnect);
  reply.raw.once('close', onDisconnect);
  reply.raw.once('finish', onFinish);
  openTimer = setTimeout(() => fail('ATTACHMENT_TIMEOUT'), options.openTimeoutMs);
  totalTimer = setTimeout(() => fail('ATTACHMENT_TIMEOUT'), options.totalTimeoutMs);
  openTimer.unref();
  totalTimer.unref();

  try {
    if (request.raw.aborted || reply.raw.destroyed) onDisconnect();
    source = await openWithAbort(() => options.openObject(item.bucket, item.objectKey, controller.signal), controller.signal);
    clearTimeout(openTimer);
    controller.signal.throwIfAborted();
    output = new PassThrough();
    // onSend hooks may defer stream handling, so keep a safe listener until Fastify takes ownership.
    output.on('error', () => undefined);
    source.on('error', () => fail('ATTACHMENT_UNAVAILABLE'));
    source.once('close', () => {
      if (!source?.readableEnded) fail('ATTACHMENT_UNAVAILABLE');
    });
    source.on('data', resetIdleTimer);
    resetIdleTimer();
    if (source.errored || (source.destroyed && !source.readableEnded)) {
      throw new AttachmentDownloadError('ATTACHMENT_UNAVAILABLE');
    }
    reply.type('application/octet-stream');
    const name = encodeURIComponent(item.fileName ?? item.fileId)
      .replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${name}`);
    reply.header('X-Content-Quality', item.contentQuality ?? 'unknown');
    reply.send(output);
    source.pipe(output);
  } catch (error) {
    const code = controller.signal.aborted && controller.signal.reason instanceof AttachmentDownloadError
      ? controller.signal.reason.code : 'ATTACHMENT_UNAVAILABLE';
    stopped = true;
    clearTimers();
    cleanupListeners();
    // Retain a listener while aborting an opened stream: abort can emit an asynchronous error.
    source?.on('error', () => undefined);
    stopStorage(error instanceof AttachmentDownloadError ? error : new AttachmentDownloadError(code));
    output?.destroy();
    if (!reply.raw.destroyed && !request.raw.aborted) throw new AttachmentDownloadError(code);
  }
}
