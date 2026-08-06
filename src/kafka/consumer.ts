import { Kafka, type Consumer } from 'kafkajs';
import { getConfig } from '../config/index.js';
import { TOPICS } from './topics.js';
import { sendKafkaMessage } from './producer.js';

const MAX_RETRIES = 3;
const RECOVERY_INITIAL_DELAY_MS = 1_000;
const RECOVERY_MAX_DELAY_MS = 60_000;

export type KafkaConsumerStatus = 'disabled' | 'starting' | 'running' | 'recovering' | 'stopped';

export interface KafkaConsumerHealth {
  configured: boolean;
  status: KafkaConsumerStatus;
  lastStartedAt: string | null;
  lastGroupJoinAt: string | null;
  lastCrashAt: string | null;
  recoveryAttempts: number;
  lastError: string | null;
}

let consumer: Consumer | null = null;
let messageHandler: ((message: any) => Promise<void>) | null = null;
let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
let isClosing = false;

const health: KafkaConsumerHealth = {
  configured: false,
  status: 'disabled',
  lastStartedAt: null,
  lastGroupJoinAt: null,
  lastCrashAt: null,
  recoveryAttempts: 0,
  lastError: null,
};

export function getKafkaConsumerHealth(): KafkaConsumerHealth {
  return { ...health };
}

export function isKafkaConsumerHealthy(): boolean {
  return !health.configured || health.status === 'running';
}

export function getKafkaConsumerRecoveryDelay(attempt: number): number {
  return Math.min(
    RECOVERY_INITIAL_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1)),
    RECOVERY_MAX_DELAY_MS
  );
}

export async function initKafkaConsumer(handler: (message: any) => Promise<void>): Promise<void> {
  messageHandler = handler;
  isClosing = false;

  const config = getConfig();
  health.configured = Boolean(config.KAFKA_BROKERS);

  if (!config.KAFKA_BROKERS) {
    health.status = 'disabled';
    health.lastError = null;
    console.warn('[KafkaConsumer] KAFKA_BROKERS 未配置，Kafka Consumer 已跳过');
    return;
  }

  if (consumer) {
    console.warn('[KafkaConsumer] Kafka Consumer 已在运行，跳过重复初始化');
    return;
  }

  try {
    await startKafkaConsumer();
  } catch (error) {
    console.error('[KafkaConsumer] 初始连接失败，将自动重试:', error);
    consumer = null;
    scheduleRecovery(error);
  }
}

async function startKafkaConsumer(): Promise<void> {
  const config = getConfig();
  if (!config.KAFKA_BROKERS || !messageHandler || isClosing) return;

  health.status = 'starting';
  const kafka = new Kafka({
    clientId: config.KAFKA_CLIENT_ID,
    brokers: config.KAFKA_BROKERS.split(','),
    retry: {
      initialRetryTime: 100,
      retries: 8,
    },
  });

  const currentConsumer = kafka.consumer({
    groupId: config.KAFKA_GROUP_ID,
    sessionTimeout: 30_000,
    heartbeatInterval: 3_000,
    // 统一由本模块恢复，避免 KafkaJS 内部重启与外部重建消费者并发。
    retry: {
      initialRetryTime: 1_000,
      retries: 8,
      restartOnFailure: async () => false,
    },
  });
  consumer = currentConsumer;

  currentConsumer.on(currentConsumer.events.GROUP_JOIN, () => {
    if (consumer !== currentConsumer || isClosing) return;
    health.status = 'running';
    health.lastGroupJoinAt = new Date().toISOString();
    health.recoveryAttempts = 0;
    health.lastError = null;
    console.log('[KafkaConsumer] 已加入消费组，消费已恢复');
  });

  currentConsumer.on(currentConsumer.events.CRASH, (event) => {
    if (consumer !== currentConsumer || isClosing) return;
    const error = event.payload.error;
    console.error('[KafkaConsumer] 消费者崩溃，将自动恢复:', error);
    consumer = null;
    scheduleRecovery(error);
  });

  try {
    await currentConsumer.connect();
    await currentConsumer.subscribe({
      topic: TOPICS.APPROVAL_EVENTS_RAW,
      fromBeginning: false,
    });

    await currentConsumer.run({
      autoCommit: false,
      eachMessage: async ({ topic, partition, message }) => {
      if (!message.value) {
        console.warn('[KafkaConsumer] 收到空消息（tombstone），跳过');
        await currentConsumer.commitOffsets([
          { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
        ]);
        return;
      }

      const value = JSON.parse(message.value.toString());
      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await messageHandler!(value);
          lastError = null;
          break;
        } catch (error: any) {
          lastError = error;
          console.warn(`[KafkaConsumer] 消息处理失败 (attempt ${attempt}/${MAX_RETRIES}):`, error.message);

          if (attempt < MAX_RETRIES) {
            await new Promise(resolve => setTimeout(resolve, 1_000 * Math.pow(2, attempt - 1)));
          }
        }
      }

      const nextOffset = (BigInt(message.offset) + 1n).toString();

      if (lastError) {
        console.error(`[KafkaConsumer] 消息处理失败，已重试 ${MAX_RETRIES} 次，发送到 DLQ:`, lastError.message);

        try {
          await sendKafkaMessage({
            key: message.key?.toString() || '',
            value: {
              ...value,
              _dlq: {
                originalTopic: topic,
                originalPartition: partition,
                originalOffset: message.offset,
                errorMessage: lastError.message,
                failedAt: new Date().toISOString(),
              },
            },
            topic: TOPICS.APPROVAL_EVENTS_DLQ,
          });
        } catch (dlqError) {
          console.error('[KafkaConsumer] 发送到 DLQ 失败:', dlqError);
        }
      }

      await currentConsumer.commitOffsets([{ topic, partition, offset: nextOffset }]);
      },
    });
  } catch (error) {
    // 启动阶段 Kafka 不可用时释放半连接状态，让主服务和 outbox 继续启动。
    try {
      await currentConsumer.disconnect();
    } catch {
      // Ignore cleanup errors while Kafka is unavailable.
    }
    if (consumer === currentConsumer) {
      consumer = null;
    }
    throw error;
  }

  if (consumer !== currentConsumer || isClosing) return;
  health.lastStartedAt = new Date().toISOString();
  console.log('[KafkaConsumer] Kafka Consumer 已启动，等待加入消费组');
}

function scheduleRecovery(error: unknown): void {
  if (isClosing || recoveryTimer) return;

  health.status = 'recovering';
  health.lastCrashAt = new Date().toISOString();
  health.lastError = error instanceof Error ? error.message : String(error);
  health.recoveryAttempts++;

  const delayMs = getKafkaConsumerRecoveryDelay(health.recoveryAttempts);
  console.warn(
    `[KafkaConsumer] 将在 ${delayMs}ms 后第 ${health.recoveryAttempts} 次重连`
  );

  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    void startKafkaConsumer().catch((restartError) => {
      console.error('[KafkaConsumer] 自动重连失败:', restartError);
      consumer = null;
      scheduleRecovery(restartError);
    });
  }, delayMs);
  recoveryTimer.unref();
}

export async function closeKafkaConsumer(): Promise<void> {
  isClosing = true;
  if (recoveryTimer) {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }

  const currentConsumer = consumer;
  consumer = null;
  health.status = health.configured ? 'stopped' : 'disabled';

  if (currentConsumer) {
    await currentConsumer.disconnect();
  }
  console.log('[KafkaConsumer] Kafka Consumer 已关闭');
}

export const kafkaConsumer = {
  init: initKafkaConsumer,
  close: closeKafkaConsumer,
  getHealth: getKafkaConsumerHealth,
};
