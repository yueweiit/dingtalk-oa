import { z } from 'zod';

export const configSchema = z.object({
  // PostgreSQL
  PGHOST: z.string().default('localhost'),
  PGPORT: z.coerce.number().default(5432),
  PGUSER: z.string(),
  PGPASSWORD: z.string(),
  PGDATABASE: z.string(),

  // 钉钉应用
  DINGTALK_APP_KEY: z.string(),
  DINGTALK_APP_SECRET: z.string(),
  DINGTALK_CORP_ID: z.string().optional(),

  // Kafka（可选）
  KAFKA_BROKERS: z.string().optional(),
  KAFKA_CLIENT_ID: z.string().default('dingtalk-oa'),
  KAFKA_GROUP_ID: z.string().default('dingtalk-oa-group'),

  // Webhook（备用）
  WEBHOOK_TOKEN: z.string().optional(),
  WEBHOOK_AES_KEY: z.string().optional(),

  // Backfill
  BACKFILL_LOOKBACK_DAYS: z.coerce.number().default(1),
  BACKFILL_WINDOW_DAYS: z.coerce.number().default(30),

  // 日志
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // 服务端口
  PORT: z.coerce.number().default(3000),
});

export type Config = z.infer<typeof configSchema>;
