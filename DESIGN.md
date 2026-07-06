# 钉钉审批数据归档系统 - 实现计划

## Context

将钉钉审批/表单/事件实时同步到 PostgreSQL 数据仓库，支持结构化查询、报表分析和历史追溯。空目录起步，纯后端服务。

**技术决策（已确认）：**
- Node.js + TypeScript + Fastify 5
- PostgreSQL（JSONB 存储原始表单数据）
- Kafka 做异步队列
- 钉钉 Stream 模式接收事件（为主），Webhook 为备
- 使用钉钉 v1.0 API
- node-pg-migrate 管理数据库迁移

---

## Phase 1: 项目基础搭建

### 1.1 脚手架文件
- `package.json` — 依赖和脚本
- `tsconfig.json` — ES2022 + NodeNext + strict
- `.env.example` — 所有环境变量模板
- `.gitignore`

### 1.2 核心依赖
```
生产: fastify, @fastify/cors, pg, kafkajs, dingtalk-stream, zod, node-cron, pino, pino-pretty, dotenv
开发: typescript, tsx, vitest, @types/pg, @types/node, @types/node-cron, node-pg-migrate
```

### 1.3 配置模块
- `src/config/schema.ts` — zod schema 验证所有环境变量
- `src/config/index.ts` — 启动时 fail-fast 校验，导出类型安全的 config 对象

### 1.4 数据库连接池
- `src/db/pool.ts` — pg.Pool 单例 + `withClient(fn)` 辅助函数

---

## Phase 2: 数据库迁移（7 张表）

使用 node-pg-migrate，迁移文件在 `migrations/` 目录。全新建库，无历史数据迁移。**所有时间字段统一使用 TIMESTAMPTZ**；钉钉毫秒时间戳按 UTC instant 入库，展示时再转 Asia/Shanghai。

### 表 1: `ding_process_template`（审批模板管理）
Backfill 必须按 processCode 查询，需要知道同步哪些审批模板。
```sql
CREATE TABLE ding_process_template (
  id            BIGSERIAL PRIMARY KEY,
  corp_id       VARCHAR(64) NOT NULL,
  process_code  VARCHAR(128) NOT NULL,
  name          VARCHAR(255),
  enabled       BOOLEAN DEFAULT true,    -- 管理员控制是否同步
  is_deleted    BOOLEAN DEFAULT false,   -- 钉钉侧是否已删除
  remark        TEXT,                     -- 管理员备注（如：财务要求、测试模板、已废弃）
  last_sync_at  TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ DEFAULT now(),
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(corp_id, process_code)
);
```
- `enabled` — 管理员手动控制是否参与同步（可随时禁用某个模板）
- `is_deleted` — API 中已消失的模板标记为 true，与 enabled 互不干扰

### 表 2: `ding_approval_instance`（审批实例主表）
- `corp_id VARCHAR(64) NOT NULL` — 支持多企业
- `UNIQUE(corp_id, process_instance_id)` — 幂等 upsert（带 corp_id）
- `form_component_values JSONB` — 原始表单数据
- `raw_payload JSONB` — 完整 API 响应（支持后续重处理）
- **发起人快照字段**（保存审批发生当时的数据，不依赖用户表关联）：
  - `originator_user_id`, `originator_user_name`, `originator_dept_id`, `originator_dept_name`
- `last_event_time TIMESTAMPTZ` — 最后一次事件时间。ON CONFLICT UPDATE 时仅当 incoming.last_event_time > db.last_event_time 时才执行 UPDATE，否则忽略该事件，防止三条来源（Webhook + Stream + Backfill）乱序覆盖
- `deleted_at TIMESTAMPTZ` — 收到删除事件时标记，不物理删除，历史仍可查
- GIN 索引 on form_component_values
- 索引: process_code, originator_user_id, create_time, status

### 表 3: `ding_approval_task`（审批流程节点）
- `UNIQUE(corp_id, process_instance_id, task_id)` — 复合唯一键（避免跨企业 ID 冲突）
- `task_order INTEGER` — 节点顺序，来源于钉钉返回的审批节点顺序；若 API 未提供，则按 Normalizer 遍历顺序生成，仅用于展示，不参与业务判断
- **审批人快照字段**（保存审批发生当时的数据，与 instance 的 originator 快照保持一致）：
  - `approver_user_id`, `approver_user_name`, `approver_dept_id`, `approver_dept_name`
- 关联 process_instance_id

### 表 4: `ding_user_snapshot`（用户快照 — 变化才写入）
**优化设计：只在用户信息变化时插入新快照，避免数据膨胀。**
```sql
CREATE TABLE ding_user_snapshot (
  id              BIGSERIAL PRIMARY KEY,
  corp_id         VARCHAR(64) NOT NULL,
  user_id         VARCHAR(128) NOT NULL,
  name            VARCHAR(256),
  dept_id_list    JSONB,
  title           VARCHAR(256),
  avatar          TEXT,
  snapshot_hash   VARCHAR(64) NOT NULL,  -- 对核心字段做 hash，用于判断是否变化
  valid_from      TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to        TIMESTAMPTZ,           -- NULL 表示当前有效
  is_current      BOOLEAN NOT NULL DEFAULT true,
  fetch_status    VARCHAR(32) DEFAULT 'success',  -- success / failed / not_found / no_permission
  fetch_error     TEXT,                            -- 失败原因
  raw_payload     JSONB,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),  -- 快照实际写入时间
  UNIQUE(corp_id, user_id, snapshot_hash, valid_from)
);
CREATE INDEX idx_user_snapshot_current ON ding_user_snapshot(corp_id, user_id, is_current);
```
逻辑：计算用户核心字段 hash → 查 is_current=true 的记录 → hash 相同则跳过 → hash 不同则关闭旧快照（set valid_to=now(), is_current=false）并插入新行。
人员兜底：getUser 失败时记录 fetch_status=failed + fetch_error 原因，不阻断审批归档。

### 表 5: `ding_form_field`（表单字段元数据）
- `UNIQUE(corp_id, process_code, field_id)` — 带 corp_id
- `is_deleted BOOLEAN DEFAULT false` — API 中已消失的字段标记为 true（不物理删除，历史数据仍能解析）
- `updated_at TIMESTAMPTZ` — 记录字段变更时间，排查模板变化
- `raw_payload JSONB` — 原始字段配置，便于未来重新解析（required/placeholder/options 等）
- 支持动态表单解析和 BI 字段映射

### 表 6: `backfill_cursor`（补数据进度追踪）
- 游标 + 时间窗口 + 状态（running/completed/failed）
- `started_at TIMESTAMPTZ` / `finished_at TIMESTAMPTZ` — 记录执行耗时
- `processed_count INTEGER` — 已处理记录数
- `UNIQUE(corp_id, process_code, window_start, window_end)` — 断点续传防重叠

### 表 7: `ding_event_log`（事件去重与追踪）
```sql
CREATE TABLE ding_event_log (
  id                    BIGSERIAL PRIMARY KEY,
  corp_id               VARCHAR(64) NOT NULL,
  event_id              VARCHAR(128),               -- 部分来源可能无 eventId
  event_type            VARCHAR(64) NOT NULL,
  source                VARCHAR(32) NOT NULL,       -- stream / webhook / backfill / manual
  process_instance_id   VARCHAR(128),
  process_code          VARCHAR(128),
  received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at          TIMESTAMPTZ,
  duration_ms           INTEGER,                    -- 处理耗时（毫秒），用于统计性能
  status                VARCHAR(32) NOT NULL DEFAULT 'pending',  -- pending / processing / success / failed / skipped
  retry_count           INTEGER NOT NULL DEFAULT 0,
  error_message         TEXT,
  raw_event             JSONB,
  UNIQUE(corp_id, event_id) WHERE event_id IS NOT NULL
);
```
event_id 不存在时（如 Backfill 来源），消费逻辑使用 processInstanceId + eventType + receivedAt 生成内部 event_key 作为兜底去重。
作用：防重复处理、运行追踪、失败可重放。Kafka 消费失败重试 3 次后写入 status=failed，必要时进入 DLQ topic `approval.events.dlq`。
数据保留策略：默认保留 90 天（可配置），历史数据定期归档或删除；失败事件长期保存用于排查。
DLQ 恢复：管理员可手动将 DLQ 消息重新投递到 `approval.events.raw`，重新进入消费流程。

---

## Phase 3: 钉钉集成

### 3.1 Token Manager (`src/dingtalk/token-manager.ts`)
- 内存缓存 token，5 分钟过期缓冲自动刷新；刷新失败记录日志并重试
- token 即将过期（剩余 5 分钟）提前刷新；刷新失败时继续使用未过期 token 直到真正过期
- 多个请求同时 401 时，只允许一个线程刷新 token，其余等待刷新结果（Promise 锁），避免重复刷新
- `POST https://api.dingtalk.com/v1.0/oauth2/accessToken`

### 3.2 API Client (`src/dingtalk/api-client.ts`)
- `searchInstances(params)` — 分页搜索审批实例（每页最多 20 条，最多 10000 条）
- `getInstance(id)` — 获取单个实例详情（含表单数据）
- `getUser(userId)` — 获取用户信息
- `listProcessTemplates()` — 获取企业所有审批模板列表（用于定时同步 ding_process_template）
- 自动注入 token，401 自动刷新重试

### 3.3 类型定义 (`src/dingtalk/types.ts`)
- zod schema 验证钉钉 API 响应（API 响应不可靠，必须运行时校验）

### 3.4 Stream Listener (`src/dingtalk/stream-listener.ts`)
- 使用 `dingtalk-stream` 包
- **订阅事件（以钉钉官方实际事件名为准）：**
  - `bpms_instance_change` — 审批实例开始、结束、终止、删除事件，支持 Stream 和 HTTP 推送
  - `bpms_task_change` — 审批任务节点变更
- 事件体包含: CorpId, processInstanceId, processCode, type, result 等
- 收到事件后发送到 Kafka
- Stream 断线自动重连（指数退避），避免网络抖动导致同步中断
- 事件去重：event_id 唯一键为主，消费逻辑中增加二次保护判断（corp_id + process_instance_id + event_type + received_at），防止不同来源事件 ID 不一致

---

## Phase 4: Kafka 层

### 4.1 Producer (`src/kafka/producer.ts`)
- idempotent Producer，acks=all，max.in.flight.requests.per.connection <= 5（官方推荐配置，避免 Producer retry 重复发送）
- key = `${corpId}:${processInstanceId}`（保证同实例事件有序）

### 4.2 Consumer (`src/kafka/consumer.ts`)
- 消费 `approval.events.raw` topic
- 成功写库后才 commit offset（at-least-once）
- 失败重试 3 次；仍失败写入 ding_event_log status=failed，发送到 DLQ topic `approval.events.dlq`，commit offset 避免卡死

### 4.3 消息格式
```json
{
  "eventType": "bpms_instance_change",
  "corpId": "ding123456",
  "processInstanceId": "xxx",
  "processCode": "xxx",
  "payload": { ... },
  "source": "stream" | "webhook" | "backfill",
  "receivedAt": "2026-07-03T10:00:00Z"
}
```

---

## Phase 5: Webhook 备用入口 (`src/webhook/`)

- `POST /webhook/approval` — Fastify 路由
- 按钉钉事件订阅官方加解密/签名规则校验，配置项包括 token、aes_key 等，具体参数以应用类型为准
- 收到事件后发送到 Kafka（同 Stream 路径）

---

## Phase 6: Normalize 管道（核心业务逻辑）

### 6.1 Instance Normalizer (`src/normalize/instance-normalizer.ts`)
- 纯函数：钉钉 API 响应 → DB 行对象
- 解析时间字符串（UTC+8）为 Date
- `INSERT ... ON CONFLICT (corp_id, process_instance_id) DO UPDATE` 幂等写入

### 6.2 Task Normalizer (`src/normalize/task-normalizer.ts`)
- 处理审批节点数组
- `ON CONFLICT (corp_id, process_instance_id, task_id) DO UPDATE` 幂等

### 6.3 User Snapshot (`src/normalize/user-snapshot.ts`)
- 计算用户核心字段 hash（name, dept_id_list, title, avatar）
- 查询当前 is_current=true 的快照 → hash 相同则跳过
- hash 不同：关闭旧快照（valid_to=now, is_current=false）→ 插入新行
- 内存 LRU 缓存（1 小时 TTL）避免频繁调用 getUser API
- **人员兜底**：当 getUser 因离职/无权限/用户不存在失败时，不阻断审批归档；保留审批实例 raw_payload 中的用户信息，并在用户快照中记录 user_id + name=unknown 状态

### 6.4 Form Field Extractor (`src/normalize/form-field-extractor.ts`)
- 从 formComponentValues 提取字段元数据
- `ON CONFLICT (corp_id, process_code, field_id) DO UPDATE`

### 6.5 编排器
- 统一入口：消息 → 拉取完整实例 → instance/task/user/form-field normalizer → 单事务写入
- 事务保证原子性
- **事件兜底发现审批模板**：当收到事件中的 processCode 在 ding_process_template 中不存在时，自动插入模板记录（enabled=true, is_deleted=false, name=null），并继续处理当前实例。避免当天新增模板在定时同步前产生的数据丢失。
- 处理逻辑：
  1. 从事件拿 processCode → 查 ding_process_template
  2. 不存在 → 自动插入 → 继续处理
  3. 存在且 enabled=true → 正常处理
  4. 存在但 enabled=false → 只记录 ding_event_log（status=skipped），不拉取详情、不写审批实例

---

## Phase 7: 补历史任务（Backfill）

### 7.1 时间窗口策略
- **普通版**: 最多补最近 365 天，单窗口最大 120 天，每页最多 20 条，循环最多 10000 条
- **OA 高级版**: 最多补 5 年
- **单窗口推荐 30 天**保守执行
- **兜底**: 非 OA 高级版企业，一年以前的数据 API 无法直接补齐，需通过钉钉后台导出后导入本系统
- 从 `ding_process_template` 读取所有 enabled=true 且 is_deleted=false 的 processCode 逐个补数据

### 7.2 Backfill Job (`src/jobs/backfill.ts`)
- 按 enabled=true 且 is_deleted=false 的 processCode 遍历
- 时间窗口分段（默认 30 天/窗口，不超过 120 天）
- 每个窗口内游标分页调用 searchInstances（每页 20 条，最多 10000 条循环）
- 每条记录调用 getInstance 拿完整表单数据
- 直接走 normalize 写库（不经 Kafka）
- 防限流：200ms 延迟 + 429 指数退避
- 更新 `ding_process_template.last_sync_at`
- **最终一致性**：不依赖 last_sync_at 判断数据是否完整。默认策略简单高效：
  - 每天凌晨：扫描最近 N 天（由 `BACKFILL_LOOKBACK_DAYS` 配置，默认 1 天），兜底 Stream 漏数据
  - 手动补历史：管理员指定 processCode + 时间范围执行
  - 特殊情况：系统升级、发现缺数据、切换环境时，可手动执行 7 天或 30 天补扫
  - 所有重复数据依靠 ON CONFLICT 去重
  - 不默认每周/每月自动重扫，避免 API 调用浪费

### 7.3 Scheduler (`src/jobs/scheduler.ts`)
- 每天凌晨 2 点：扫描最近 N 天（`BACKFILL_LOOKBACK_DAYS` 配置，默认 1 天）
- 每天凌晨 3 点：清理 90 天前的 ding_event_log（保留失败事件）
- 防重叠：检查 backfill_cursor 表是否有 running 状态
- 支持手动触发：指定 processCode + 时间范围

### 7.4 审批模板同步 (`src/jobs/process-template-sync.ts`)
定时同步只负责补全模板名称、更新模板状态、标记已删除模板；不作为唯一模板发现来源（发现由事件兜底完成）。
- 调用钉钉 API 获取当前企业所有审批模板列表
- 与 `ding_process_template` 表对比：
  - 已存在但 name=null 的模板 → 补全名称
  - 已存在的模板 → 更新名称等信息
  - API 中已消失的模板 → 标记 is_deleted=true（不影响 enabled 状态）
- 调度频率：每天 1 次（与 backfill 同一 cron 或独立 cron）
- 手动管理：管理员也可手动在数据库中调整 enabled 状态

### 7.5 进度追踪 (`src/jobs/backfill-state.ts`)
- 读写 backfill_cursor 表
- 支持断点续传

---

## Phase 8: 启动入口和生命周期

### 8.1 Fastify App (`src/app.ts`)
- 注册 CORS、Webhook 路由
- `GET /health/live` — 存活检查（仅判断服务进程是否活着）
- `GET /health/ready` — 就绪检查（检查 DB、Kafka、Stream、Token 是否可用）
- `GET /metrics` — 运行指标（JSON 格式）：
  ```json
  {
    "streamConnected": true,
    "kafkaConnected": true,
    "consumerLag": 0,
    "pendingEvents": 3,
    "failedEvents": 1,
    "tokenRefreshCount": 1,
    "apiCallsToday": 324,
    "api429Count": 0
  }
  ```
  以上指标为运行态统计，服务重启后重新计数。长期统计使用 Prometheus 或其他监控系统。

### 8.2 Entry Point (`src/index.ts`)
启动顺序（Fastify 优先，确保健康检查尽早可用）：
1. 加载配置（zod 校验）
2. 初始化 DB 连接池
3. 初始化 Kafka Producer
4. 启动 Fastify 服务（健康检查立即可用）
5. **API 权限自检**：验证 accessToken 获取成功、审批实例读权限具备、模板列表接口可用。自检失败记录告警日志但不阻断启动。
6. 启动 Kafka Consumer
7. 启动 Stream Listener
8. 启动 Cron 调度器（含 backfill + 审批模板同步）
9. 注册 SIGTERM/SIGINT 优雅关闭

---

## 关键设计决策

| 决策 | 理由 |
|------|------|
| 所有唯一键带 `corp_id` | 不同企业 ID 不一定全局唯一，避免跨企业冲突 |
| `ON CONFLICT` 幂等写入 | Webhook 重放、Kafka 重投递、Backfill 重叠都安全 |
| `raw_payload` JSONB 存完整响应 | 永远只追加更新，不进行字段裁剪；API 格式变化时可重新处理历史数据 |
| 用户快照 hash 去重 | 变化才写入，避免每次见到用户都膨胀数据 |
| `ding_process_template` 表 | Backfill 需要知道同步哪些审批模板 |
| Backfill 绕过 Kafka | 批量受控操作，Kafka 只增加复杂度无收益 |
| Stream 为主 + Webhook 为备 | Stream 不需要公网 IP，部署更简单 |
| Webhook 按钉钉官方规则校验 | 配置项包括 token、aes_key 等，具体参数以应用类型为准 |
| 模板同步三层机制 | 事件处理=实时发现，定时同步=定期校准，Backfill=历史补齐 |
| ding_event_log 事件去重 | 基于 corp_id+event_id 唯一键防重复，失败可追踪重放 |
| Kafka 消费失败 3 次→DLQ | 避免卡死同一条消息，写入 event_log 后 commit |
| 启动 API 权限自检 | 验证 token/读权限/模板接口，失败告警不阻断 |

---

## 项目结构

```
dingtalk-oa/
├── package.json / tsconfig.json / .env.example / .gitignore
├── migrations/
│   ├── 20260703000000_create_ding_process_template.ts
│   ├── 20260703000001_create_ding_approval_instance.ts
│   ├── 20260703000002_create_ding_approval_task.ts
│   ├── 20260703000003_create_ding_user_snapshot.ts
│   ├── 20260703000004_create_ding_form_field.ts
│   ├── 20260703000005_create_backfill_cursor.ts
│   └── 20260703000006_create_ding_event_log.ts
├── src/
│   ├── index.ts                    # 入口
│   ├── app.ts                      # Fastify 工厂
│   ├── config/                     # zod 配置校验
│   ├── db/
│   │   ├── pool.ts                 # pg.Pool 单例
│   │   ├── queries/                # 参数化 SQL
│   │   │   ├── process-template.ts
│   │   │   ├── approval-instance.ts
│   │   │   ├── approval-task.ts
│   │   │   ├── user-snapshot.ts
│   │   │   ├── form-field.ts
│   │   │   └── event-log.ts
│   │   └── types.ts
│   ├── dingtalk/
│   │   ├── token-manager.ts        # Token 生命周期（缓存+自动刷新+Promise锁）
│   │   ├── api-client.ts           # v1.0 API 封装
│   │   ├── types.ts                # zod schema
│   │   ├── stream-listener.ts      # Stream 事件监听
│   │   └── signature.ts            # Webhook 签名验证（钉钉官方加解密机制）
│   ├── webhook/                    # Webhook 路由（备用）
│   ├── kafka/
│   │   ├── producer.ts
│   │   ├── consumer.ts
│   │   └── topics.ts
│   ├── normalize/                  # 核心转换逻辑
│   │   ├── instance-normalizer.ts
│   │   ├── task-normalizer.ts
│   │   ├── user-snapshot.ts        # hash 去重快照
│   │   └── form-field-extractor.ts
│   ├── jobs/                       # 定时任务
│   │   ├── backfill.ts
│   │   ├── process-template-sync.ts  # 审批模板定时同步
│   │   ├── scheduler.ts
│   │   └── backfill-state.ts
│   └── types/                      # 类型声明
└── tests/                          # vitest 测试
```

---

## 验证方式

1. **数据库迁移**: `npm run migrate` 成功创建所有 7 张表和索引
2. **配置校验**: 缺少必填环境变量时启动失败并给出明确错误
3. **Stream 连接**: 启动后日志显示 Stream 连接成功
4. **Webhook 签名**: 单元测试验证钉钉官方事件订阅签名校验逻辑
5. **端到端**: 手动在钉钉发起一个审批，观察数据是否正确写入 PostgreSQL
6. **幂等性**: 同一条事件处理两次，数据库只有一条记录（corp_id + process_instance_id 唯一）
7. **用户快照去重**: 同一用户信息不变时不会产生重复快照行
8. **Backfill**: 手动触发补历史，检查历史数据是否正确归档
9. **事件去重**: 同一 eventId 处理两次，第二次跳过（UNIQUE 约束）
10. **失败重试**: Kafka 消费失败 3 次后写入 ding_event_log status=failed
11. **API 自检**: 启动日志显示权限校验结果
12. **Health check**: `GET /health/live` 返回存活状态，`GET /health/ready` 返回 DB/Kafka/Stream/Token 就绪状态
13. **Metrics**: `GET /metrics` 返回 JSON 格式运行指标
