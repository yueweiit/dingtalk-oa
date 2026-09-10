import { z } from 'zod';

const packingWorkbookSchema = z.object({
  year: z.number().int().min(2000).max(2200),
  workbookId: z.string().trim().min(1).max(256),
  label: z.string().trim().min(1).max(500),
});

const packingWorkbooksSchema = z.string().default('[]').transform((value, context) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'must be valid JSON' });
    return z.NEVER;
  }
  const result = z.array(packingWorkbookSchema).safeParse(parsed);
  if (!result.success) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: result.error.message });
    return z.NEVER;
  }
  const years = new Set(result.data.map((row) => row.year));
  const ids = new Set(result.data.map((row) => row.workbookId));
  if (years.size !== result.data.length || ids.size !== result.data.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'contains duplicate year or workbookId' });
    return z.NEVER;
  }
  return result.data;
});

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
  DINGTALK_ARCHIVE_DOWNLOAD_USER_ID: z.string().trim().min(1).optional(),
  DINGTALK_ARCHIVE_DOWNLOAD_UNION_ID: z.string().trim().min(1).optional(),
  DINGTALK_PACKING_READER_USER_ID: z.string().trim().min(1).optional(),
  DINGTALK_PACKING_WORKBOOKS_JSON: packingWorkbooksSchema,

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
  APPROVAL_REPAIR_POLL_MS: z.coerce.number().int().min(1000).max(60_000).default(5000),

  // Durable financial history is explicitly seeded, then drained in bounded scheduled batches.
  FINANCIAL_BACKFILL_ENABLED: z.string().default('false').transform(value => ['1','true','yes','on'].includes(value.toLowerCase())),
  FINANCIAL_BACKFILL_CRON: z.string().default('*/10 * * * *'),
  FINANCIAL_BACKFILL_MAX_WINDOWS: z.coerce.number().int().min(1).max(20).default(1),

  // 已完成物流/物流采购的评论及附件轮转复查；迁移部署后显式启用。
  COMPLETED_APPROVAL_REFRESH_ENABLED: z.string().default('false').transform((value) => ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())),
  COMPLETED_APPROVAL_REFRESH_CRON: z.string().default('*/30 * * * *'),
  COMPLETED_APPROVAL_REFRESH_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  COMPLETED_APPROVAL_REFRESH_DELAY_MS: z.coerce.number().int().min(500).max(10_000).default(1000),
  COMPLETED_APPROVAL_REFRESH_MIN_INTERVAL_SECONDS: z.coerce.number().int().min(60).max(604800).default(21600),

  // 成本系统附件归档（MinIO 只使用专用非 root 账号）
  ARCHIVE_MINIO_ENDPOINT: z.string().default('172.19.49.226'),
  ARCHIVE_MINIO_PORT: z.coerce.number().int().min(1).max(65535).default(9000),
  ARCHIVE_MINIO_USE_SSL: z.string().default('false').transform((value) => ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())),
  ARCHIVE_MINIO_ACCESS_KEY: z.string().optional(),
  ARCHIVE_MINIO_SECRET_KEY: z.string().optional(),
  ARCHIVE_MINIO_BUCKET: z.string().default('dingtalk-approval-archive'),
  ARCHIVE_BATCH_SIZE: z.coerce.number().int().min(1).max(10).default(10),
  ARCHIVE_DELAY_MS: z.coerce.number().int().min(1000).max(60_000).default(1000),
  ARCHIVE_RECOVERY_CANARY_ONLY: z.string().default('false').transform((value) => ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())),
  PACKING_SNAPSHOT_MINIO_BUCKET: z.string().trim().min(3).max(63).default('dingtalk-packing-snapshots'),
  PACKING_REFRESH_POLL_MS: z.coerce.number().int().min(1000).max(60_000).default(5000),
  PACKING_RANGE_MAX_CELLS: z.coerce.number().int().min(100).max(20_000).default(5000),
  PACKING_SHEET_MAX_ROWS: z.coerce.number().int().min(1).max(10_000).default(5000),
  PACKING_SHEET_MAX_COLUMNS: z.coerce.number().int().min(1).max(200).default(100),

  // 日志
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // 服务端口
  PORT: z.coerce.number().default(3000),
});

export type Config = z.infer<typeof configSchema>;
