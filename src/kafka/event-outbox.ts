import { enqueueOutboxEvent, claimPendingOutboxEvents, markOutboxFailed, markOutboxPublished } from '../db/queries/event-outbox.js';
import type { JsonValue } from '../db/json-types.js';
import { sendKafkaMessage } from './producer.js';
import { TOPICS } from './topics.js';

const FLUSH_INTERVAL_MS = 1000;
const FLUSH_BATCH_SIZE = 100;

let flushTimer: ReturnType<typeof setInterval> | null = null;
let isFlushing = false;

export interface ApprovalEventMessage {
  eventType: string;
  corpId: string;
  processInstanceId: string;
  processCode?: string;
  eventId: string;
  payload: Record<string, unknown>;
  source: string;
  receivedAt: string;
}

export async function enqueueApprovalEvent(message: ApprovalEventMessage): Promise<void> {
  await enqueueOutboxEvent({
    corp_id: message.corpId,
    event_id: message.eventId,
    event_key: `${message.corpId}:${message.processInstanceId}`,
    topic: TOPICS.APPROVAL_EVENTS_RAW,
    event_type: message.eventType,
    source: message.source,
    process_instance_id: message.processInstanceId,
    process_code: message.processCode ?? null,
    payload: message as unknown as JsonValue,
  });

  // 先持久化成功，再尝试即时投递；失败会由定时 flush 重试。
  void flushOutbox();
}

export function startEventOutbox(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    void flushOutbox();
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
  console.log('[EventOutbox] 持久化事件发送队列已启动');
  void flushOutbox();
}

export function stopEventOutbox(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  console.log('[EventOutbox] 持久化事件发送队列已停止');
}

async function flushOutbox(): Promise<void> {
  if (isFlushing) return;
  isFlushing = true;

  try {
    const events = await claimPendingOutboxEvents(FLUSH_BATCH_SIZE);
    for (const event of events) {
      try {
        await sendKafkaMessage({
          key: event.event_key,
          value: event.payload,
          topic: event.topic,
        });
        await markOutboxPublished(event.id);
      } catch (error: any) {
        await markOutboxFailed(event.id, String(error?.message || error));
        console.warn(`[EventOutbox] Kafka 投递失败，${event.id} 已安排重试:`, error?.message || error);
      }
    }
  } catch (error) {
    // 数据库错误也不能阻塞 Stream/Webhook 主线程；下一个周期继续尝试。
    console.error('[EventOutbox] 读取待发送事件失败:', error);
  } finally {
    isFlushing = false;
  }
}
