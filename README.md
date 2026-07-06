# 钉钉审批数据归档系统

将钉钉 OA 审批数据实时同步到 PostgreSQL，用于数据分析和归档。

## 架构概览

```
钉钉 Stream 回调 ──┐                   ┌→ 直接处理
                   ├──→ Kafka ──→ Consumer ──┤
钉钉 Webhook ─────┘        ↑               └→ DLQ（失败重试）
                           │
                    事件缓冲区（Kafka 不可用时本地缓存重试）
                           │
                     编排器 ──→ PostgreSQL
                        ↓
                   getInstance() API
                   getUser() API
```

**核心流程：** 钉钉推送审批事件 → Kafka 缓冲（失败时本地缓存） → Consumer 消费 → 调用钉钉 API 获取完整数据 → 事务写入数据库

## 技术栈

- **运行时**: Node.js + TypeScript
- **Web 框架**: Fastify 5
- **数据库**: PostgreSQL (JSONB)
- **消息队列**: Kafka（可选，支持本地事件缓冲区降级）
- **事件接收**: 钉钉 Stream 模式（为主）+ Webhook（备用）
- **校验**: Zod（API 响应、配置、入参校验）
- **限流**: 内置令牌桶限流器（30 req/s）

## 数据库表

| 表名 | 说明 | 数据来源 |
|------|------|----------|
| `ding_corp_config` | 企业配置 | 事件自动写入 |
| `ding_event_log` | 事件日志（去重/审计） | 事件自动写入 |
| `ding_process_template` | 审批流程模板 | 事件自动发现 + 定时同步 |
| `ding_approval_instance` | 审批实例（主表） | getInstance() API |
| `ding_approval_task` | 审批任务节点 | getInstance() API |
| `ding_form_field` | 表单字段定义 | getInstance() API |
| `ding_user_snapshot` | 用户信息快照 | getUser() API（基于 hash 去重） |
| `backfill_cursor` | 回填进度 | 回填任务自动写入 |

## 快速开始

### 1. 环境要求

- Node.js >= 18
- PostgreSQL >= 14
- Kafka（可选，用于生产环境缓冲事件）

### 2. 安装依赖

```bash
npm install
```

### 3. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env` 填入实际配置：

```env
# PostgreSQL
PGHOST=localhost
PGPORT=5432
PGUSER=postgres
PGPASSWORD=your_password
PGDATABASE=dingtalk_oa

# 钉钉应用（在钉钉开发者后台获取）
DINGTALK_APP_KEY=your_app_key
DINGTALK_APP_SECRET=your_app_secret
DINGTALK_CORP_ID=your_corp_id

# Kafka（可选，不配置时事件直接处理）
KAFKA_BROKERS=localhost:9092
```

### 4. 创建数据库

```bash
node scripts/create-db.js
```

### 5. 执行数据库迁移

```bash
npm run migrate:up
```

### 6. 启动 Kafka（可选）

```bash
docker-compose up -d
```

### 7. 启动服务

```bash
# 开发模式（热重载）
npm run dev

# 生产模式
npm run build
npm start
```

## 钉钉应用配置

在 [钉钉开发者后台](https://open-dev.dingtalk.com) 需要开通以下权限：

| 权限 | 标识 | 说明 |
|------|------|------|
| 审批流程实例读权限 | `workflow:instance:read` | 读取审批实例详情 |
| 成员信息读权限 | `qyapi_get_member` | 获取用户详情 |
| 工作流模板读权限 | - | 获取审批模板列表 |

**事件订阅：**
- 订阅 `/bpms/instance_change` — 审批实例变更
- 订阅 `/bpms/task_change` — 审批任务变更
- 请求地址填写：`http://your-server:3000/webhook/approval`

> 注意：Webhook 路由要求 `WEBHOOK_TOKEN` 和 `WEBHOOK_AES_KEY` 已配置，否则会拒绝请求（返回 503）。

## 手动同步脚本

首次部署或数据不完整时，可手动运行同步脚本：

```bash
# 全部同步（模板 + 用户）
npx tsx scripts/sync-metadata.ts

# 只同步模板
npx tsx scripts/sync-metadata.ts --templates
npm run sync:templates

# 只同步用户
npx tsx scripts/sync-metadata.ts --users
npm run sync:users
```

该脚本执行：
- **同步模板名称** — 从钉钉 API 获取所有审批模板名称，补填本地数据库，同时插入新发现的模板
- **同步用户信息** — 递归获取所有部门的用户，写入用户快照表，回填审批实例和任务表的姓名字段

> 注意：模板同步需要至少有一个已知用户（从审批实例或用户快照中获取）。用户同步需要 `qyapi_get_member` 权限已开通。部分外部用户或已离职用户可能查询失败，属正常情况。

## 历史数据回填

首次部署或需要补录历史审批数据时，使用 backfill 脚本。大时间范围会自动切分为 7 天子窗口逐个处理，避免触发钉钉 API 限制。

```bash
# 补最近一年（默认，7 天一切窗口，500ms 间隔）
npx tsx scripts/backfill.ts --days=365

# 补最近 30 天
npx tsx scripts/backfill.ts --days=30

# 补 7 天，加速模式（200ms 间隔）
npx tsx scripts/backfill.ts --days=7 --delay-ms=200

# 只补指定模板
npx tsx scripts/backfill.ts --days=365 --process-code=PROC-XXX

# 指定企业
npx tsx scripts/backfill.ts --corp-id=ding144583309b2fb01c35c2f4657eb6378f

# 查看帮助
npx tsx scripts/backfill.ts --help
```

**参数说明：**

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--days=N` | 365 | 回溯天数 |
| `--chunk-days=N` | 7 | 每个子窗口天数（越小越安全） |
| `--delay-ms=N` | 500 | 每条实例处理间隔毫秒 |
| `--process-code=XXX` | 全部 | 只补指定模板 |
| `--corp-id=XXX` | 全部 | 只补指定企业 |

**钉钉 API 限制：**
- 搜索接口 40 QPS，脚本默认 2 QPS，留有充足余量
- 每次搜索最多返回 20 条，自动翻页
- 建议先用 `--days=7` 小范围测试，确认无误后再全量回填

> 注意：回填会逐条调用钉钉 API 获取实例详情，一年数据量较大时运行时间较长。回填过程中可随时 Ctrl+C 中断，下次运行会跳过已有数据。

## 定时任务

服务启动后自动运行以下定时任务（Asia/Shanghai 时区）：

| 时间 | 任务 | 说明 |
|------|------|------|
| 每天 02:00 | 补数据 | 扫描最近 N 天的审批数据，兜底 Stream 漏掉的事件 |
| 每天 03:00 | 日志清理 | 清理 90 天前的成功事件日志 |
| 每天 04:00 | 模板同步 | 从钉钉同步审批模板列表 |

## API 接口

| 路径 | 方法 | 说明 |
|------|------|------|
| `/health/live` | GET | 存活检查 |
| `/health/ready` | GET | 就绪检查（DB、Token） |
| `/metrics` | GET | 运行指标 |
| `/webhook/approval` | POST | 钉钉 Webhook 回调（备用入口） |

## 数据流详解

```
1. 钉钉审批事件推送
   ↓
2. Stream Listener / Webhook 接收
   ↓
3. 发送到 Kafka（approval.events.raw）
   ↓
4. Consumer 消费消息
   ↓
5. 编排器 processApprovalMessage():
   ├── saveCorpId()              → ding_corp_config
   ├── insertEvent()             → ding_event_log
   ├── upsertProcessTemplate()   → ding_process_template
   ├── getInstance() API 调用
   ├── normalize + upsert        → ding_approval_instance
   ├── normalize + upsert        → ding_approval_task
   ├── extractFormFields()       → ding_form_field
   ├── processUserSnapshot()     → ding_user_snapshot（异步）
   └── updateEventStatus()       → ding_event_log（更新状态）
```

## 常用命令

```bash
# 开发与构建
npm run dev          # 开发模式启动（热重载）
npm run build        # TypeScript 编译
npm start            # 生产模式启动
npm run lint         # 类型检查

# 数据库迁移
npm run migrate:up   # 执行迁移
npm run migrate:down # 回滚迁移

# 数据同步与检查
npm run sync:templates   # 只同步模板
npm run sync:users       # 只同步用户
npx tsx scripts/sync-metadata.ts  # 全部同步
npx tsx check-db.ts     # 查看数据库状态

# 历史数据回填
npm run backfill -- --days=365          # 补最近一年
npm run backfill -- --days=7            # 补最近 7 天
npm run backfill -- --days=30 --delay-ms=200  # 补 30 天加速模式
npx tsx scripts/backfill.ts --help      # 查看全部参数

# 测试
npm run test:run     # 运行测试
```

## 项目结构

```
dingtalk-oa/
├── migrations/              # 数据库迁移文件
├── scripts/
│   ├── create-db.js         # 创建数据库
│   ├── sync-metadata.ts     # 手动同步脚本（模板+用户）
│   └── backfill.ts          # 历史数据回填 CLI
├── src/
│   ├── index.ts             # 入口文件
│   ├── app.ts               # Fastify 应用
│   ├── config/
│   │   ├── index.ts         # 配置加载
│   │   └── schema.ts        # 配置 Zod 校验
│   ├── db/
│   │   ├── pool.ts          # PostgreSQL 连接池
│   │   ├── json-types.ts    # JSON 类型定义（JsonValue）
│   │   ├── types.ts         # 数据库表类型定义
│   │   └── queries/         # 各表的 CRUD 操作
│   ├── dingtalk/
│   │   ├── api-client.ts    # 钉钉 API 封装（含限流器）
│   │   ├── token-manager.ts # Access Token 管理
│   │   ├── signature.ts     # Webhook 签名验证与解密
│   │   ├── stream-listener.ts # Stream 事件监听
│   │   └── types.ts         # 钉钉 API 类型定义（Zod Schema）
│   ├── kafka/
│   │   ├── producer.ts      # Kafka 生产者
│   │   ├── consumer.ts      # Kafka 消费者
│   │   ├── event-buffer.ts  # 本地事件缓冲区（Kafka 降级）
│   │   └── topics.ts        # Topic 定义
│   ├── normalize/
│   │   ├── orchestrator.ts  # 核心编排器（事件处理主流程）
│   │   ├── instance-normalizer.ts  # 审批实例数据标准化
│   │   ├── task-normalizer.ts      # 审批任务数据标准化
│   │   ├── user-snapshot.ts        # 用户快照处理
│   │   └── form-field-extractor.ts # 表单字段提取
│   ├── jobs/
│   │   ├── scheduler.ts     # 定时任务调度
│   │   ├── backfill.ts      # 历史数据回填
│   │   ├── backfill-state.ts # 回填进度管理
│   │   ├── process-template-sync.ts # 模板同步
│   │   └── sync-template-names.ts   # 模板名称补填
│   ├── webhook/
│   │   └── index.ts         # Webhook 路由
│   └── cli/                 # 命令行工具
├── check-db.ts              # 数据库状态检查工具
├── test-api.ts              # API 测试工具
├── docker-compose.yml       # Kafka 容器配置
├── package.json
└── tsconfig.json
```

## 环境变量说明

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| PGHOST | 否 | localhost | PostgreSQL 主机 |
| PGPORT | 否 | 5432 | PostgreSQL 端口 |
| PGUSER | 是 | - | PostgreSQL 用户名 |
| PGPASSWORD | 是 | - | PostgreSQL 密码 |
| PGDATABASE | 是 | - | 数据库名 |
| DINGTALK_APP_KEY | 是 | - | 钉钉应用 AppKey |
| DINGTALK_APP_SECRET | 是 | - | 钉钉应用 AppSecret |
| DINGTALK_CORP_ID | 否 | - | 企业 ID（首次收到事件时自动获取） |
| KAFKA_BROKERS | 否 | - | Kafka 地址（逗号分隔） |
| KAFKA_CLIENT_ID | 否 | dingtalk-oa | Kafka 客户端 ID |
| KAFKA_GROUP_ID | 否 | dingtalk-oa-group | Kafka 消费组 ID |
| BACKFILL_LOOKBACK_DAYS | 否 | 1 | 每日补数据回溯天数 |
| BACKFILL_WINDOW_DAYS | 否 | 30 | 单次补数据窗口天数 |
| LOG_LEVEL | 否 | info | 日志级别 |
| PORT | 否 | 3000 | 服务端口 |

## 故障排查

**事件处理失败：** 查看 `ding_event_log` 表中 `status = 'failed'` 的记录，`error_message` 列包含具体错误。

**用户快照为空：** 确认钉钉应用已开通 `qyapi_get_member` 权限，然后运行：
```bash
npx tsx scripts/sync-metadata.ts
```

**模板名称为空：** 运行同步脚本补填：
```bash
npx tsx scripts/sync-metadata.ts
```

**检查服务状态：**
```bash
npx tsx check-db.ts
```

## 设计决策

| 决策 | 理由 |
|------|------|
| 所有唯一键带 corp_id | 支持多企业，避免 ID 冲突 |
| ON CONFLICT 幂等写入 | 事件重放安全 |
| raw_payload JSONB 存储 | 支持后续重处理 |
| 用户快照 hash 去重 | 避免数据膨胀 |
| Stream 为主 + Webhook 为备 | Stream 无需公网 IP |
| Webhook 未配置密钥时拒绝请求 | 防止未授权访问 |
| 本地事件缓冲区 | Kafka 不可用时事件不丢失 |
| API 令牌桶限流 | 主动防触发钉钉限流 |
| 优雅关闭 + 30s 超时 | 确保资源释放，防止僵尸进程 |
| 生产环境禁用 pino-pretty | 减少日志开销 |

## License

MIT
