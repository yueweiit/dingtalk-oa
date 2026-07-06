import { DWClient, type DWClientDownStream, EventAck } from 'dingtalk-stream';
import { getConfig } from '../config/index.js';
import { kafkaProducer } from '../kafka/producer.js';
import { bufferEvent } from '../kafka/event-buffer.js';
import { streamEventSchema } from './types.js';

let client: any = null;

export async function startStreamListener(): Promise<void> {
  const config = getConfig();

  client = new DWClient({
    clientId: config.DINGTALK_APP_KEY,
    clientSecret: config.DINGTALK_APP_SECRET,
    debug: true,
  });

  // 订阅审批实例变更事件
  client.registerCallbackListener('/bpms/instance_change', async (event: any) => {
    try {
      const data = JSON.parse(event.data);
      const parsed = streamEventSchema.parse(data);

      // 生成事件 ID（钉钉可能不提供 EventId，用 composite key 兜底）
      const eventId = parsed.EventId
        || `${parsed.CorpId}:${parsed.ProcessInstanceId}:${parsed.EventType}:${parsed.TimeStamp || ''}`;

      console.log('[StreamListener] 收到审批实例变更事件:', {
        corpId: parsed.CorpId,
        processInstanceId: parsed.ProcessInstanceId,
        type: parsed.Type,
      });

      await kafkaProducer.send({
        key: `${parsed.CorpId}:${parsed.ProcessInstanceId}`,
        value: {
          eventType: 'bpms_instance_change',
          corpId: parsed.CorpId,
          processInstanceId: parsed.ProcessInstanceId,
          processCode: parsed.ProcessCode,
          eventId,
          payload: parsed,
          source: 'stream',
          receivedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      console.error('[StreamListener] 处理审批实例变更事件失败:', error);
    }
  });

  // 订阅审批任务变更事件
  client.registerCallbackListener('/bpms/task_change', async (event: any) => {
    try {
      const data = JSON.parse(event.data);
      const parsed = streamEventSchema.parse(data);

      const eventId = parsed.EventId
        || `${parsed.CorpId}:${parsed.ProcessInstanceId}:${parsed.EventType}:${parsed.TimeStamp || ''}`;

      console.log('[StreamListener] 收到审批任务变更事件:', {
        corpId: parsed.CorpId,
        processInstanceId: parsed.ProcessInstanceId,
      });

      await kafkaProducer.send({
        key: `${parsed.CorpId}:${parsed.ProcessInstanceId}`,
        value: {
          eventType: 'bpms_task_change',
          corpId: parsed.CorpId,
          processInstanceId: parsed.ProcessInstanceId,
          processCode: parsed.ProcessCode,
          eventId,
          payload: parsed,
          source: 'stream',
          receivedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      console.error('[StreamListener] 处理审批任务变更事件失败:', error);
    }
  });

  // 兜底：捕获所有 EVENT 类型消息（审批事件走 EVENT 而非 CALLBACK）
  // 注意：dingtalk-stream 库不 await 回调返回值，因此无法在此异步等待 Kafka 发送
  // 依赖每日 backfill 作为安全网兜底丢失的事件
  client.registerAllEventListener((message: DWClientDownStream) => {
    const eventType = message.headers?.eventType;
    const eventCorpId = message.headers?.eventCorpId;
    const messageId = message.headers?.messageId;

    // 审批事件：从 headers 取 corpId，从 data 取 processInstanceId
    if (eventType && (eventType.includes('bpms') || eventType.includes('process'))) {
      try {
        const data = JSON.parse(message.data);
        const processInstanceId = data.processInstanceId || data.ProcessInstanceId;
        const processCode = data.processCode || data.ProcessCode;
        const actionType = data.type || data.Type;
        const eventId = data.EventId
          || messageId
          || `${eventCorpId}:${processInstanceId}:${eventType}:${data.TimeStamp || ''}`;

        if (processInstanceId && eventCorpId) {
          console.log('[StreamListener] 审批事件:', { eventCorpId, processInstanceId, eventType, actionType });

          const eventPayload = {
            eventType,
            corpId: eventCorpId,
            processInstanceId,
            processCode,
            eventId,
            payload: data,
            source: 'stream',
            receivedAt: new Date().toISOString(),
          };

          kafkaProducer.send({
            key: `${eventCorpId}:${processInstanceId}`,
            value: eventPayload,
          }).catch((err: any) => {
            console.warn('[StreamListener] Kafka 发送失败，事件已缓冲:', err.message);
            bufferEvent(`${eventCorpId}:${processInstanceId}`, eventPayload);
          });
        }
      } catch {
        // 非 JSON，忽略
      }
    }

    return { status: EventAck.SUCCESS };
  });

  // 连接断线重连
  client.on('disconnect', () => {
    console.warn('[StreamListener] 连接断开，尝试重连...');
  });

  client.on('reconnect', () => {
    console.log('[StreamListener] 重连成功');
  });

  await client.connect();
  console.log('[StreamListener] Stream 连接成功');
}

export async function stopStreamListener(): Promise<void> {
  if (client) {
    await client.disconnect();
    client = null;
    console.log('[StreamListener] Stream 连接已关闭');
  }
}
