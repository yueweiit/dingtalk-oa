import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { ReadApiClient } from './config.js';

export const timestampSchema = z.string().max(40).datetime({ offset: true });
const identifier = z.string().trim().min(1).max(128);

export const filtersSchema = z.object({
  corpId: identifier,
  processCode: identifier.optional(),
  processInstanceId: identifier.optional(),
  approvalNo: identifier.optional(),
  updatedAfter: timestampSchema.optional(),
}).strict();

export const pageQuerySchema = filtersSchema.extend({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(8192).optional(),
}).strict();

export type ReadFilters = z.infer<typeof filtersSchema>;
export type ReadResource = 'approvals' | 'attachments';

const positionSchema = z.object({
  updatedAt: timestampSchema,
  processInstanceId: identifier,
  fileId: z.string().min(1).max(256).optional(),
}).strict();
export type ReadPosition = z.infer<typeof positionSchema>;

const cursorSchema = z.object({
  version: z.literal(1),
  clientId: z.string(),
  policy: z.string(),
  resource: z.enum(['approvals', 'attachments']),
  filters: filtersSchema,
  syncUntil: timestampSchema,
  position: positionSchema,
  expiresAt: z.number().int(),
}).strict();

export type ReadCursor = z.infer<typeof cursorSchema>;

function policyDigest(client: ReadApiClient): string {
  return createHash('sha256').update(JSON.stringify({
    corpIds: [...client.corpIds].sort(),
    processCodes: client.processCodes ? [...client.processCodes].sort() : null,
  })).digest('hex');
}

function signature(payload: string, client: ReadApiClient): Buffer {
  return createHmac('sha256', Buffer.from(client.tokenSha256, 'hex')).update(payload).digest();
}

export function encodeCursor(
  client: ReadApiClient,
  resource: ReadResource,
  filters: ReadFilters,
  syncUntil: string,
  position: ReadPosition,
  expiresAt: number,
): string {
  const payload = Buffer.from(JSON.stringify({
    version: 1, clientId: client.clientId, policy: policyDigest(client),
    resource, filters, syncUntil, position, expiresAt,
  } satisfies ReadCursor)).toString('base64url');
  return `${payload}.${signature(payload, client).toString('hex')}`;
}

export function decodeCursor(
  value: string,
  client: ReadApiClient,
  resource: ReadResource,
  filters: ReadFilters,
  now: number,
): ReadCursor {
  const parts = value.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[a-f0-9]{64}$/.test(parts[1])) {
    throw new Error('INVALID_CURSOR');
  }
  if (!timingSafeEqual(signature(parts[0], client), Buffer.from(parts[1], 'hex'))) {
    throw new Error('INVALID_CURSOR');
  }
  const cursor = cursorSchema.parse(JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')));
  if (cursor.clientId !== client.clientId || cursor.policy !== policyDigest(client)
    || cursor.resource !== resource || cursor.expiresAt <= now
    || JSON.stringify(cursor.filters) !== JSON.stringify(filters)
    || (resource === 'attachments') !== Boolean(cursor.position.fileId)) {
    throw new Error('INVALID_CURSOR');
  }
  return cursor;
}
