import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getConfig } from '../config/index.js';
import { openReadApiObject } from './object-store.js';
import { resolveCursorSecret } from './cursor-key.js';
import { createReadRateLimiter } from './rate-limit.js';
import { AttachmentDownloadError, sendAttachmentDownload, type DownloadOptions } from './attachment-download.js';
import {
  findReadAttachment, listReadApprovals, listReadAttachments,
  type AttachmentReadItem,
} from '../db/queries/approval-read-api.js';
import {
  decodeCursor, encodeCursor, filtersSchema, pageQuerySchema,
} from './pagination.js';

export interface ReadApiDependencies {
  cursorSecret: Buffer;
  requestsPerMinute: number;
  totalRequestsPerMinute: number;
  approvals: typeof listReadApprovals;
  attachments: typeof listReadAttachments;
  attachment: typeof findReadAttachment;
  openObject: DownloadOptions['openObject'];
  downloadOpenTimeoutMs: number;
  downloadIdleTimeoutMs: number;
  downloadTotalTimeoutMs: number;
  now: () => number;
}

const downloadQuerySchema = z.object({
  corpId: z.string().trim().min(1).max(128),
  processInstanceId: z.string().trim().min(1).max(128),
  fileId: z.string().trim().min(1).max(256),
}).strict();

function failure(reply: FastifyReply, status: number, code: string) {
  return reply.type('application/json; charset=utf-8').code(status).send({ success: false, code });
}

export function createApprovalReadRoutes(dependencies: ReadApiDependencies) {
  return async function approvalReadRoutes(fastify: FastifyInstance) {
    const cursorSecret = Buffer.from(dependencies.cursorSecret);
    const limiter = createReadRateLimiter(dependencies);

    function admitQuery(reply: FastifyReply): boolean {
      const retryAfter = limiter.query();
      if (retryAfter === undefined) return true;
      reply.header('Retry-After', String(retryAfter));
      failure(reply, 429, 'RATE_LIMITED');
      return false;
    }

    // Keep query contents and any legacy credentials out of automatic access logs.
    fastify.setChildLoggerFactory((logger, bindings, options) => logger.child(bindings, {
      ...options,
      serializers: {
        ...options.serializers,
        req: request => ({ method: request.method, url: request.url?.split('?')[0] }),
      },
    }));

    fastify.setErrorHandler((error, request, reply) => {
      // Stream errors emitted before headers are sent also enter this handler.
      reply.removeHeader('Content-Disposition');
      reply.removeHeader('X-Content-Quality');
      // Fastify copies stream headers onto ServerResponse before the first byte is written.
      if (!reply.raw.headersSent) {
        reply.raw.removeHeader('Content-Disposition');
        reply.raw.removeHeader('X-Content-Quality');
      }
      if (error instanceof AttachmentDownloadError) {
        return failure(reply, error.code === 'ATTACHMENT_TIMEOUT' ? 504 : 503, error.code);
      }
      const status = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
      if (typeof status === 'number' && status >= 400 && status < 500) {
        return failure(reply, status, 'INVALID_REQUEST');
      }
      request.log.error({ resource: 'approval-read' }, 'Approval read API failed');
      return failure(reply, 503, 'READ_UNAVAILABLE');
    });

    fastify.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.header('X-Content-Type-Options', 'nosniff');
      const retryAfter = limiter.source(request.ip);
      if (retryAfter !== undefined) {
        reply.header('Retry-After', String(retryAfter));
        return failure(reply, 429, 'RATE_LIMITED');
      }
    });

    for (const resource of ['approvals', 'attachments'] as const) {
      fastify.get(`/api/v1/${resource}`, async (request, reply) => {
        const query = pageQuerySchema.safeParse(request.query);
        if (!query.success) return failure(reply, 400, 'INVALID_REQUEST');
        const { limit, cursor: token, ...queryFilters } = query.data;
        // Parse again to give the signature a stable property order.
        const filters = filtersSchema.parse(queryFilters);
        const now = dependencies.now();
        let cursor;
        if (token) {
          try {
            cursor = decodeCursor(token, cursorSecret, resource, filters, now);
          } catch {
            return failure(reply, 400, 'INVALID_CURSOR');
          }
        }
        if (!admitQuery(reply)) return reply;
        try {
          const input = { filters, limit, position: cursor?.position, syncUntil: cursor?.syncUntil };
          const page = resource === 'approvals'
            ? await dependencies.approvals(input) : await dependencies.attachments(input);
          const hasMore = page.items.length > limit;
          const items = page.items.slice(0, limit);
          const last = items.at(-1);
          const nextCursor = hasMore && last ? encodeCursor(cursorSecret, resource, filters, page.syncUntil, {
            updatedAt: last.updatedAt, processInstanceId: last.processInstanceId,
            ...(resource === 'attachments' ? { fileId: (last as AttachmentReadItem).fileId } : {}),
          }, cursor?.expiresAt ?? now + 24 * 60 * 60_000) : null;
          const data = resource === 'attachments'
            ? (items as AttachmentReadItem[]).map(item => ({ ...item, downloadPath: downloadPath(item) })) : items;
          request.log.info({ resource, corpId: filters.corpId, count: data.length }, 'Approval read API');
          return reply.send({ success: true, data, pagination: { limit, hasMore, nextCursor, syncUntil: page.syncUntil } });
        } catch {
          // Do not log raw SQL, source payloads, connection strings or storage errors.
          request.log.error({ resource }, 'Approval read API query failed');
          return failure(reply, 503, 'READ_UNAVAILABLE');
        }
      });
    }

    fastify.get('/api/v1/attachment-content', async (request, reply) => {
      const query = downloadQuerySchema.safeParse(request.query);
      if (!query.success) return failure(reply, 400, 'INVALID_REQUEST');
      if (!admitQuery(reply)) return reply;
      try {
        const item = await dependencies.attachment({
          corpId: query.data.corpId, processInstanceId: query.data.processInstanceId,
        }, query.data.fileId);
        if (!item || item.retiredAt || item.sourceDeletedAt) return failure(reply, 404, 'ATTACHMENT_NOT_FOUND');
        if (item.archiveStatus !== 'archived') return failure(reply, 409, 'ATTACHMENT_NOT_READY');
        await sendAttachmentDownload(request, reply, item, {
          openObject: dependencies.openObject,
          openTimeoutMs: dependencies.downloadOpenTimeoutMs,
          idleTimeoutMs: dependencies.downloadIdleTimeoutMs,
          totalTimeoutMs: dependencies.downloadTotalTimeoutMs,
        });
        request.log.info({ resource: 'attachment-content', corpId: item.corpId }, 'Approval read API');
        return reply;
      } catch (error) {
        request.log.error({ resource: 'attachment-content' }, 'Approval attachment read failed');
        if (error instanceof AttachmentDownloadError) throw error;
        return failure(reply, 503, 'ATTACHMENT_UNAVAILABLE');
      }
    });
  };
}

function downloadPath(item: AttachmentReadItem): string | null {
  if (item.archiveStatus !== 'archived' || item.retiredAt || item.sourceDeletedAt) return null;
  const query = new URLSearchParams({ corpId: item.corpId, processInstanceId: item.processInstanceId, fileId: item.fileId });
  return `/api/v1/attachment-content?${query}`;
}

export async function approvalReadRoutes(fastify: FastifyInstance): Promise<void> {
  const config = getConfig();
  return createApprovalReadRoutes({
    cursorSecret: resolveCursorSecret(config),
    requestsPerMinute: config.APPROVAL_READ_API_REQUESTS_PER_MINUTE,
    totalRequestsPerMinute: config.APPROVAL_READ_API_TOTAL_REQUESTS_PER_MINUTE,
    approvals: listReadApprovals,
    attachments: listReadAttachments,
    attachment: findReadAttachment,
    openObject: openReadApiObject,
    downloadOpenTimeoutMs: config.APPROVAL_READ_API_DOWNLOAD_OPEN_TIMEOUT_MS,
    downloadIdleTimeoutMs: config.APPROVAL_READ_API_DOWNLOAD_IDLE_TIMEOUT_MS,
    downloadTotalTimeoutMs: config.APPROVAL_READ_API_DOWNLOAD_TOTAL_TIMEOUT_MS,
    now: Date.now,
  })(fastify);
}
