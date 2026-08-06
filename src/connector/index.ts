import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getConfig } from '../config/index.js';
import {
  findBusinessEntityApprovers,
  resolveBusinessEntities,
} from '../db/queries/business-entity-approver.js';

const businessEntitiesSchema = z.preprocess((value) => {
  const splitValues = (items: unknown[]) => items.flatMap((item) => {
    if (item && typeof item === 'object') {
      const option = item as { value?: unknown; label?: unknown; key?: unknown };
      item = option.value ?? option.label ?? option.key;
    }
    if (typeof item !== 'string') return [item];
    return item.split(/[,，]/).map((part) => part.trim()).filter(Boolean);
  });

  if (Array.isArray(value)) return splitValues(value);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return splitValues(parsed);
    } catch {
      // Some connector versions serialize a multi-select as a comma-separated string.
    }
    return splitValues([value]);
  }
  return value;
}, z.array(z.string().trim().min(1)).min(1).max(20));

const approverRequestSchema = z.object({
  businessEntities: businessEntitiesSchema,
  processInstanceId: z.string().trim().min(1).optional(),
  originatorUserId: z.string().trim().min(1).optional(),
});

export async function connectorRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/connector/approval/approvers', async (request: FastifyRequest, reply: FastifyReply) => {
    const config = getConfig();

    // 兼容连接器将参数放入 URL 查询串的配置方式；JSON body 优先级更高。
    const body = request.body && typeof request.body === 'object'
      ? request.body as Record<string, unknown>
      : {};
    const query = request.query && typeof request.query === 'object'
      ? request.query as Record<string, unknown>
      : {};
    const parsed = approverRequestSchema.safeParse({ ...query, ...body });
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        code: 'INVALID_REQUEST',
        message: 'businessEntities must be a non-empty string array',
      });
    }
    if (!config.DINGTALK_CORP_ID) {
      return reply.status(503).send({ success: false, code: 'CORP_ID_NOT_CONFIGURED' });
    }

    const input = parsed.data;
    const entities = await resolveBusinessEntities(config.DINGTALK_CORP_ID, input.businessEntities);
    const matchedValues = new Set(entities.flatMap((entity) => [entity.businessCode, entity.name]));
    const unmatchedBusinessEntities = input.businessEntities.filter((value) => !matchedValues.has(value));
    if (unmatchedBusinessEntities.length > 0) {
      return reply.status(422).send({
        success: false,
        code: 'BUSINESS_ENTITY_NOT_FOUND',
        unmatchedBusinessEntities,
      });
    }

    const approvers = await findBusinessEntityApprovers(
      config.DINGTALK_CORP_ID,
      entities.map((entity) => entity.businessCode)
    );
    const users = approvers
      .filter((approver) => approver.userId !== input.originatorUserId)
      .map(({ userId, name }) => ({ userId, name }));
    if (users.length === 0) {
      return reply.status(422).send({ success: false, code: 'APPROVER_NOT_FOUND' });
    }

    fastify.log.info({
      processInstanceId: input.processInstanceId,
      businessCodes: entities.map((entity) => entity.businessCode),
      userIds: users.map((user) => user.userId),
    }, 'Resolved approval connector approvers');

    return reply.send({
      success: true,
      // 钉钉审批“从连接器获取”要求人员 userId 位于 result 数组。
      result: users.map((user) => user.userId),
      error: '',
      users,
      matchedBusinessEntities: entities,
    });
  });
}
