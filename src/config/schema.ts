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
  DINGTALK_TEMPLATE_ADMIN_USER_ID: z.string().trim().min(1).optional(),

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
  APPROVAL_STATUS_RECONCILE_CRON: z.string().default('*/15 * * * *'),
  APPROVAL_STATUS_RECONCILE_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  APPROVAL_STATUS_RECONCILE_DELAY_MS: z.coerce.number().int().min(0).max(10_000).default(500),

  // 成本系统附件归档（MinIO 只使用专用非 root 账号）
  ARCHIVE_MINIO_ENDPOINT: z.string().default('172.19.49.226'),
  ARCHIVE_MINIO_PORT: z.coerce.number().int().min(1).max(65535).default(9000),
  ARCHIVE_MINIO_USE_SSL: z.string().default('false').transform((value) => ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())),
  ARCHIVE_MINIO_ACCESS_KEY: z.string().optional(),
  ARCHIVE_MINIO_SECRET_KEY: z.string().optional(),
  ARCHIVE_MINIO_BUCKET: z.string().default('dingtalk-approval-archive'),
  ARCHIVE_BATCH_SIZE: z.coerce.number().int().min(1).max(10).default(10),
  ARCHIVE_DELAY_MS: z.coerce.number().int().min(1000).max(60_000).default(1000),

  // 日志
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // 服务端口
  PORT: z.coerce.number().default(3000),
});

export type Config = z.infer<typeof configSchema>;
