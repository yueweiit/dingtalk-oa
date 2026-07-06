import { kafkaProducer } from './producer.js';

interface BufferedEvent {
  key: string;
  value: any;
  enqueuedAt: number;
}

const buffer: BufferedEvent[] = [];
const MAX_BUFFER_SIZE = 10000;
const FLUSH_INTERVAL_MS = 1000;
const MAX_FLUSH_BATCH = 50;

let flushTimer: ReturnType<typeof setInterval> | null = null;
let isFlushing = false;

export function startEventBuffer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
  console.log('[EventBuffer] 事件缓冲区已启动');
}

export function stopEventBuffer(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  console.log(`[EventBuffer] 事件缓冲区已停止，剩余 ${buffer.length} 条未发送`);
}

export function bufferEvent(key: string, value: any): void {
  if (buffer.length >= MAX_BUFFER_SIZE) {
    // 丢弃最旧的事件
    buffer.shift();
    console.warn('[EventBuffer] 缓冲区已满，丢弃最旧事件');
  }
  buffer.push({ key, value, enqueuedAt: Date.now() });
}

export function getBufferSize(): number {
  return buffer.length;
}

async function flush(): Promise<void> {
  if (isFlushing || buffer.length === 0) return;
  isFlushing = true;

  try {
    const batch = buffer.splice(0, MAX_FLUSH_BATCH);

    for (const event of batch) {
      try {
        await kafkaProducer.send({
          key: event.key,
          value: event.value,
        });
      } catch (error) {
        // 发送失败，放回缓冲区头部
        buffer.unshift(event);
        console.error('[EventBuffer] 发送失败，事件已放回缓冲区:', error);
        break; // 停止当前批次，下次重试
      }
    }
  } finally {
    isFlushing = false;
  }
}
