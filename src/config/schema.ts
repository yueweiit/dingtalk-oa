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

  // 统一预警机器人。未配置流程码或接收人时，监控任务只记录跳过，不发送消息。
  DINGTALK_ALERT_ROBOT_CODE: z.string().trim().min(1).optional(),
  DINGTALK_ALERT_CLIENT_ID: z.string().trim().min(1).optional(),
  DINGTALK_ALERT_CLIENT_SECRET: z.string().trim().min(1).optional(),
  DINGTALK_ALERT_RECIPIENT_USER_IDS: z.string().default(''),
  APPROVAL_TIMEOUT_PROCESS_CODES: z.string().default(''),
  APPROVAL_TIMEOUT_MONITOR_CRON: z.string().default('*/30 * * * *'),
  APPROVAL_TIMEOUT_MINUTES: z.coerce.number().int().min(1).default(24 * 60),
  APPROVAL_TIMEOUT_WINDOW_BEFORE_MINUTES: z.coerce.number().int().min(1).default(40),
  APPROVAL_TIMEOUT_WINDOW_AFTER_MINUTES: z.coerce.number().int().min(1).default(40),
  APPROVAL_EMPTY_NODE_PROCESS_CODES: z.string().default(''),

  // 预算预警：仅对配置流程的审批中实例执行。字段映射使用流程组件 ID，避免依赖可变的显示名称。
  BUDGET_ALERT_PROCESS_CODES: z.string().default(''),
  BUDGET_ALERT_FIELD_MAP: z.string().default(''),
  BUDGET_ALERT_API_URL: z.string().url().default('http://127.0.0.1:3001/api/dingtalk/alert-budget-snapshot'),
  BUDGET_ALERT_API_KEY: z.string().trim().min(1).optional(),

  // 日志
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // 服务端口
  PORT: z.coerce.number().default(3000),
});

export type Config = z.infer<typeof configSchema>;
