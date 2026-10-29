import { createHash, timingSafeEqual } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getConfig } from '../config/index.js';
import { getArchiveMinioClient } from '../archive/minio-archive.js';
import {
  findReadAttachment, listReadApprovals, listReadAttachments,
  type AttachmentReadItem,
} from '../db/queries/approval-read-api.js';
import type { ReadApiClient } from './config.js';
import {
  decodeCursor, encodeCursor, filtersSchema, pageQuerySchema,
  type ReadFilters,
} from './pagination.js';

export interface ReadApiDependencies {
  clients: ReadApiClient[];
  requestsPerMinute: number;
  approvals: typeof listReadApprovals;
  attachments: typeof listReadAttachments;
  attachment: typeof findReadAttachment;
  openObject: (bucket: string, objectKey: string) => Promise<Readable>;
  now: () => number;
}

const downloadQuerySchema = z.object({
  corpId: z.string().trim().min(1).max(128),
  processInstanceId: z.string().trim().min(1).max(128),
  fileId: z.string().trim().min(1).max(256),
}).strict();

function failure(reply: FastifyReply, status: number, code: string) {
  return reply.code(status).send({ success: false, code });
}

export function createApprovalReadRoutes(dependencies: ReadApiDependencies) {
  return async function approvalReadRoutes(fastify: FastifyInstance) {
    const requestClients = new WeakMap<object, ReadApiClient>();
    const rateWindows = new Map<string, { resetAt: number; count: number }>();

    // Even a rejected token-in-query request must not put that URL into access logs.
    fastify.setChildLoggerFactory((logger, bindings, options) => logger.child(bindings, {
      ...options,
      serializers: {
        ...options.serializers,
        req: request => ({ method: request.method, url: request.url?.split('?')[0] }),
      },
    }));

    fastify.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.header('X-Content-Type-Options', 'nosniff');
      if (!dependencies.clients.length) return failure(reply, 503, 'READ_API_DISABLED');
      const authorization = request.headers.authorization;
      const match = typeof authorization === 'string' && /^Bearer ([A-Za-z0-9_-]{43,256})$/i.exec(authorization);
      let client: ReadApiClient | undefined;
      if (match) {
        const digest = createHash('sha256').update(match[1]).digest();
        for (const candidate of dependencies.clients) {
          if (timingSafeEqual(digest, Buffer.from(candidate.tokenSha256, 'hex'))) client = candidate;
        }
      }
      if (!client) {
        reply.header('WWW-Authenticate', 'Bearer realm="approval-read"');
        return failure(reply, 401, 'UNAUTHORIZED');
      }
      const now = dependencies.now();
      let window = rateWindows.get(client.clientId);
      if (!window || window.resetAt <= now) {
        window = { resetAt: now + 60_000, count: 0 };
        rateWindows.set(client.clientId, window);
      }
      if (++window.count > dependencies.requestsPerMinute) {
        reply.header('Retry-After', String(Math.max(1, Math.ceil((window.resetAt - now) / 1000))));
        return failure(reply, 429, 'RATE_LIMITED');
      }
      requestClients.set(request, client);
    });

    function allowed(client: ReadApiClient, filters: ReadFilters): boolean {
      return client.corpIds.includes(filters.corpId)
        && (!filters.processCode || !client.processCodes || client.processCodes.includes(filters.processCode));
    }

    for (const resource of ['approvals', 'attachments'] as const) {
      fastify.get(`/api/v1/${resource}`, async (request, reply) => {
        const client = requestClients.get(request)!;
        const query = pageQuerySchema.safeParse(request.query);
        if (!query.success) return failure(reply, 400, 'INVALID_REQUEST');
        const { limit, cursor: token, ...queryFilters } = query.data;
        // Parse again to give the signature a stable property order.
        const filters = filtersSchema.parse(queryFilters);
        if (!allowed(client, filters)) return failure(reply, 403, 'FORBIDDEN');
        const now = dependencies.now();
        let cursor;
        if (token) {
          try {
            cursor = decodeCursor(token, client, resource, filters, now);
          } catch {
            return failure(reply, 400, 'INVALID_CURSOR');
          }
        }
        try {
          const input = { client, filters, limit, position: cursor?.position, syncUntil: cursor?.syncUntil };
          const page = resource === 'approvals'
            ? await dependencies.approvals(input) : await dependencies.attachments(input);
          const hasMore = page.items.length > limit;
          const items = page.items.slice(0, limit);
          const last = items.at(-1);
          const nextCursor = hasMore && last ? encodeCursor(client, resource, filters, page.syncUntil, {
            updatedAt: last.updatedAt, processInstanceId: last.processInstanceId,
            ...(resource === 'attachments' ? { fileId: (last as AttachmentReadItem).fileId } : {}),
          }, cursor?.expiresAt ?? now + 24 * 60 * 60_000) : null;
          const data = resource === 'attachments'
            ? (items as AttachmentReadItem[]).map(item => ({ ...item, downloadPath: downloadPath(item) })) : items;
          request.log.info({ clientId: client.clientId, resource, corpId: filters.corpId, count: data.length }, 'Approval read API');
          return reply.send({ success: true, data, pagination: { limit, hasMore, nextCursor, syncUntil: page.syncUntil } });
        } catch {
          // Do not log raw SQL, source payloads, connection strings or storage errors.
          request.log.error({ clientId: client.clientId, resource }, 'Approval read API query failed');
          return failure(reply, 503, 'READ_UNAVAILABLE');
        }
      });
    }

    fastify.get('/api/v1/attachment-content', async (request, reply) => {
      const client = requestClients.get(request)!;
      const query = downloadQuerySchema.safeParse(request.query);
      if (!query.success) return failure(reply, 400, 'INVALID_REQUEST');
      if (!allowed(client, query.data)) return failure(reply, 403, 'FORBIDDEN');
      try {
        const item = await dependencies.attachment(client, {
          corpId: query.data.corpId, processInstanceId: query.data.processInstanceId,
        }, query.data.fileId);
        if (!item || item.retiredAt || item.sourceDeletedAt) return failure(reply, 404, 'ATTACHMENT_NOT_FOUND');
        if (item.archiveStatus !== 'archived') return failure(reply, 409, 'ATTACHMENT_NOT_READY');
        const stream = await dependencies.openObject(item.bucket, item.objectKey);
        // Always download as a file; arbitrary archived HTML/SVG must not execute on the API origin.
        reply.type('application/octet-stream');
        reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(item.fileName ?? item.fileId).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`);
        reply.header('X-Content-Quality', item.contentQuality ?? 'unknown');
        request.log.info({ clientId: client.clientId, resource: 'attachment-content', corpId: item.corpId }, 'Approval read API');
        return reply.send(stream);
      } catch {
        request.log.error({ clientId: client.clientId, resource: 'attachment-content' }, 'Approval attachment read failed');
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
    clients: config.APPROVAL_READ_API_CLIENTS_JSON,
    requestsPerMinute: config.APPROVAL_READ_API_REQUESTS_PER_MINUTE,
    approvals: listReadApprovals,
    attachments: listReadAttachments,
    attachment: findReadAttachment,
    openObject: (bucket, key) => getArchiveMinioClient().getObject(bucket, key),
    now: Date.now,
  })(fastify);
}
