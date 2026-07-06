import { Kafka, Partitioners } from 'kafkajs';
import { getConfig } from '../config/index.js';
import { TOPICS } from './topics.js';

let producer: any = null;

export async function initKafkaProducer(): Promise<void> {
  const config = getConfig();

  if (!config.KAFKA_BROKERS) {
    console.warn('[KafkaProducer] KAFKA_BROKERS 未配置，Kafka 功能已禁用。事件将无法发送到 Kafka');
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

  producer = kafka.producer({
    createPartitioner: Partitioners.DefaultPartitioner,
    idempotent: true,
    maxInFlightRequests: 5,
    transactionalId: undefined,
  });

  await producer.connect();
  console.log('[KafkaProducer] Kafka Producer 连接成功');
}

export async function sendKafkaMessage(params: {
  key: string;
  value: any;
  topic?: string;
}): Promise<void> {
  const topic = params.topic || TOPICS.APPROVAL_EVENTS_RAW;

  if (!producer) {
    throw new Error('[KafkaProducer] Kafka 未初始化，无法发送消息。请配置 KAFKA_BROKERS 环境变量');
  }

  await producer.send({
    topic,
    messages: [
      {
        key: params.key,
        value: JSON.stringify(params.value),
        timestamp: Date.now().toString(),
      },
    ],
  });
}

export async function closeKafkaProducer(): Promise<void> {
  if (producer) {
    await producer.disconnect();
    producer = null;
    console.log('[KafkaProducer] Kafka Producer 已关闭');
  }
}

// 导出供其他模块使用的接口
export const kafkaProducer = {
  send: sendKafkaMessage,
  close: closeKafkaProducer,
};
