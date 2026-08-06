import { describe, expect, it, vi } from 'vitest';

const kafkaMock = vi.hoisted(() => {
  const listeners = new Map<string, (event: any) => void>();
  const consumer = {
    events: {
      GROUP_JOIN: 'consumer.group_join',
      CRASH: 'consumer.crash',
    },
    on: vi.fn((eventName: string, listener: (event: any) => void) => {
      listeners.set(eventName, listener);
    }),
    connect: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    run: vi.fn().mockResolvedValue(undefined),
    commitOffsets: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };

  return {
    consumer,
    listeners,
    Kafka: vi.fn(function Kafka() {
      return { consumer: () => consumer };
    }),
  };
});

vi.mock('kafkajs', () => ({ Kafka: kafkaMock.Kafka }));
vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    KAFKA_BROKERS: 'localhost:9092',
    KAFKA_CLIENT_ID: 'test-client',
    KAFKA_GROUP_ID: 'test-group',
  }),
}));
vi.mock('./producer.js', () => ({ sendKafkaMessage: vi.fn() }));

import {
  closeKafkaConsumer,
  getKafkaConsumerHealth,
  getKafkaConsumerRecoveryDelay,
  initKafkaConsumer,
  isKafkaConsumerHealthy,
} from './consumer.js';

describe('Kafka consumer recovery', () => {
  it('uses exponential backoff and caps the delay at one minute', () => {
    expect(getKafkaConsumerRecoveryDelay(1)).toBe(1_000);
    expect(getKafkaConsumerRecoveryDelay(2)).toBe(2_000);
    expect(getKafkaConsumerRecoveryDelay(6)).toBe(32_000);
    expect(getKafkaConsumerRecoveryDelay(7)).toBe(60_000);
    expect(getKafkaConsumerRecoveryDelay(20)).toBe(60_000);
  });

  it('marks a crash unhealthy and rebuilds the consumer before recovering', async () => {
    await initKafkaConsumer(async () => undefined);
    kafkaMock.listeners.get('consumer.group_join')!({});
    expect(getKafkaConsumerHealth().status).toBe('running');
    expect(isKafkaConsumerHealthy()).toBe(true);

    kafkaMock.listeners.get('consumer.crash')!({
      payload: { error: new Error('broker disconnected') },
    });
    expect(getKafkaConsumerHealth()).toMatchObject({
      status: 'recovering',
      recoveryAttempts: 1,
      lastError: 'broker disconnected',
    });
    expect(isKafkaConsumerHealthy()).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(kafkaMock.consumer.connect).toHaveBeenCalledTimes(2);
    kafkaMock.listeners.get('consumer.group_join')!({});
    expect(getKafkaConsumerHealth().status).toBe('running');
    expect(isKafkaConsumerHealthy()).toBe(true);

    await closeKafkaConsumer();
  });
});
