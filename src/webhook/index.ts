import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getConfig } from '../config/index.js';
import { verifySignature } from '../dingtalk/signature.js';
import { kafkaProducer } from '../kafka/producer.js';
import { streamEventSchema } from '../dingtalk/types.js';

export async function webhookRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/webhook/approval', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const config = getConfig();

      // 未配置签名密钥时拒绝请求（防止未授权访问）
      if (!config.WEBHOOK_TOKEN || !config.WEBHOOK_AES_KEY) {
        console.warn('[Webhook] WEBHOOK_TOKEN/WEBHOOK_AES_KEY 未配置，拒绝请求');
        return reply.status(503).send({ success: false, message: 'Webhook 未配置' });
      }

      const timestamp = request.headers['x-dingtalk-timestamp'] as string;
      const signature = request.headers['x-dingtalk-sign'] as string;

      if (!timestamp || !signature) {
        console.warn('[Webhook] 缺少签名头，拒绝请求');
        return reply.status(401).send({ success: false, message: '缺少签名头' });
      }

      const body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
      const isValid = verifySignature({ timestamp, signature, body });

      if (!isValid) {
        console.warn('[Webhook] 签名验证失败');
        return reply.status(401).send({ success: false, message: '签名验证失败' });
      }

      // 验证事件数据结构
      const parseResult = streamEventSchema.safeParse(request.body);
      if (!parseResult.success) {
        console.warn('[Webhook] 事件数据格式无效:', parseResult.error.issues);
        return reply.status(400).send({ success: false, message: '事件数据格式无效' });
      }
      const parsed = parseResult.data;

      console.log('[Webhook] 收到审批事件:', {
        corpId: parsed.CorpId,
        processInstanceId: parsed.ProcessInstanceId,
        type: parsed.Type,
      });

      const eventId = parsed.EventId
        || `${parsed.CorpId}:${parsed.ProcessInstanceId}:${parsed.EventType}:${parsed.TimeStamp || ''}`;

      await kafkaProducer.send({
        key: `${parsed.CorpId}:${parsed.ProcessInstanceId}`,
        value: {
          eventType: 'bpms_instance_change',
          corpId: parsed.CorpId,
          processInstanceId: parsed.ProcessInstanceId,
          processCode: parsed.ProcessCode,
          eventId,
          payload: parsed,
          source: 'webhook',
          receivedAt: new Date().toISOString(),
        },
      });

      return reply.send({ success: true });
    } catch (error) {
      console.error('[Webhook] 处理事件失败:', error);
      return reply.status(500).send({ success: false, message: '处理事件失败' });
    }
  });
}
