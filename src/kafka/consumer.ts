import { Kafka, Consumer } from 'kafkajs';
import { getConfig } from '../config/index.js';
import { TOPICS } from './topics.js';
import { sendKafkaMessage } from './producer.js';

const MAX_RETRIES = 3;

let consumer: Consumer | null = null;
let messageHandler: ((message: any) => Promise<void>) | null = null;

export async function initKafkaConsumer(handler: (message: any) => Promise<void>): Promise<void> {
  const config = getConfig();

  messageHandler = handler;

  if (!config.KAFKA_BROKERS) {
    console.warn('[KafkaConsumer] KAFKA_BROKERS 未配置，Kafka Consumer 已跳过');
    return;
  }

  const kafka = new Kafka({
    clientId: config.KAFKA_CLIENT_ID,
    brokers: config.KAFKA_BROKERS.split(','),
    retry: {
      initialRetryTime: 100,
      retries: 8,
    },
  });

  consumer = kafka.consumer({
    groupId: config.KAFKA_GROUP_ID,
    sessionTimeout: 30000,
    heartbeatInterval: 3000,
  });

  await consumer.connect();
  await consumer.subscribe({
    topic: TOPICS.APPROVAL_EVENTS_RAW,
    fromBeginning: false,
  });

  await consumer.run({
    autoCommit: false,
    eachMessage: async ({ topic, partition, message, heartbeat }) => {
      if (!message.value) {
        console.warn('[KafkaConsumer] 收到空消息（tombstone），跳过');
        await consumer!.commitOffsets([{ topic, partition, offset: (BigInt(message.offset) + 1n).toString() }]);
        return;
      }

      const value = JSON.parse(message.value.toString());
      let lastError: Error | null = null;

      // 重试最多 MAX_RETRIES 次
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await handler(value);
          lastError = null;
          break;
        } catch (error: any) {
          lastError = error;
          console.warn(`[KafkaConsumer] 消息处理失败 (attempt ${attempt}/${MAX_RETRIES}):`, error.message);

          if (attempt < MAX_RETRIES) {
            // 指数退避
            await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
          }
        }
      }

      const nextOffset = (BigInt(message.offset) + 1n).toString();

      if (lastError) {
        // 重试耗尽：写入 DLQ 并 commit offset 避免卡死
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

      // 无论成功还是失败（已发 DLQ），都 commit offset
      await consumer!.commitOffsets([{ topic, partition, offset: nextOffset }]);
    },
  });

  console.log('[KafkaConsumer] Kafka Consumer 启动成功');
}

export async function closeKafkaConsumer(): Promise<void> {
  if (consumer) {
    await consumer.disconnect();
    consumer = null;
    console.log('[KafkaConsumer] Kafka Consumer 已关闭');
  }
}

export const kafkaConsumer = {
  init: initKafkaConsumer,
  close: closeKafkaConsumer,
};
