# 运行环境与部署说明

**验证状态：已验证（仓库配置与启动代码）。** 本次未执行下表命令，未连接任何业务环境。

## 已知运行结构

[package.json](../../package.json) 定义 npm 脚本；[docker-compose.yml](../../docker-compose.yml) 只部署单节点 apache/kafka:latest、KRaft、PLAINTEXT、端口 9092 和持久卷。没有应用、PostgreSQL、MinIO 容器或反向代理配置，不足以证明生产部署方式。生产 Node 版本、进程管理器、代理、TLS、备份、监控平台及 CI/CD 均待验证。

[app.ts](../../src/app.ts) 非 production 环境启用 pino-pretty；其他后台模块主要使用 console。`/metrics` 是 JSON 进程指标。主进程监听 0.0.0.0，默认端口 3000，SIGTERM/SIGINT 触发资源关闭、30 秒超时退出。

## 命令及副作用

| 命令 | 实际行为与使用限制 |
| --- | --- |
| npm run lint | tsc --noEmit 类型检查；不是 ESLint；本次未运行 |
| npm run build | tsc 生成 dist；本次禁止执行 |
| npm run test:run / npm test | vitest run / vitest 监听；部分集成测试执行数据库 DDL 和 TRUNCATE，不能当作只读检查 |
| npm run dev / npm start | 启动业务服务，可能建表、同步、入队和通知 |
| npm run migrate:up / migrate:down | 数据库结构/数据变更；财务迁移有拒绝 down 的实现 |
| npm run sync:templates / sync:users | 调钉钉并写元数据；用户同步还维护部门树与名称 |
| npm run backfill:metadata | 仅使用本地资料、按企业分批预览审批元数据空值；显式 --apply 才写入，无钉钉调用或通知；参数与证据口径见 [人员模块](../modules/metadata-organization/README.md#审批元数据历史回填) |
| npm run fetch / backfill | 拉取审批写数据库，消耗钉钉调用配额 |
| npm run finance:backfill | 发现、排期、恢复财务历史；参数语义见专项文档 |
| npm run archive:attachments | 同步清单并下载/上传附件；批量模式和精确目标模式不同 |
| npm run archive:recovery-canaries / archive:recovery-remainders | 更改历史附件队列，不是单纯诊断 |
| npm run packing:sync-workbooks | 同步允许工作簿并提交索引刷新 |
| check-db.ts / test-api.ts / scripts/create-db.js | 检查工具或维护脚本，不属于单元测试；执行前单独读源码确认数据库/网络副作用 |

## 环境变量分组

名称和默认校验以 [config/schema.ts](../../src/config/schema.ts) 为准，加载入口为 [config/index.ts](../../src/config/index.ts)。只记录名称，不读取或复制 .env 值。

| 配置组 | 名称及用途 |
| --- | --- |
| 数据库 | PGHOST、PGPORT、PGUSER、PGPASSWORD、PGDATABASE |
| 主应用 | DINGTALK_APP_KEY、DINGTALK_APP_SECRET、DINGTALK_CORP_ID |
| 模板操作人 | DINGTALK_TEMPLATE_ADMIN_USER_ID；未配置时模板同步跳过 |
| 回调 | WEBHOOK_TOKEN、WEBHOOK_AES_KEY；两者缺任一项时拒绝 Webhook |
| 审批只读 API | 无需 Token 或客户端配置；旧 APPROVAL_READ_API_CLIENTS_JSON 忽略。APPROVAL_READ_API_REQUESTS_PER_MINUTE 默认每进程每来源 IP 120，三个接口共用该来源额度；APPROVAL_READ_API_TOTAL_REQUESTS_PER_MINUTE 默认每进程总查询 1200，参数/游标无效不占用总额度。配置和索引迁移见 [API 模块](../modules/approval-read-api/README.md) |
| 游标签名 | 默认从现有 DINGTALK_APP_SECRET 按固定用途派生，可选 APPROVAL_READ_API_CURSOR_SECRET（32–256 字符）；各实例签名配置一致即可跨重启续页，轮换后旧游标失效。不是调用鉴权 |
| 可信 HTTP 代理 | HTTP_TRUSTED_PROXIES，默认空；只配置实际代理 IP/CIDR，逗号分隔。本机宝塔 Nginx 通过回环代理时可设 127.0.0.1,::1；未配置时转发头不影响来源，代理后请求按代理 IP 共用额度 |
| API 文件下载超时 | APPROVAL_READ_API_DOWNLOAD_OPEN_TIMEOUT_MS 默认 10000、APPROVAL_READ_API_DOWNLOAD_IDLE_TIMEOUT_MS 默认 30000、APPROVAL_READ_API_DOWNLOAD_TOTAL_TIMEOUT_MS 默认 300000；超时实际取消存储请求，仅影响 HTTP 下载 |
| Kafka | KAFKA_BROKERS、KAFKA_CLIENT_ID、KAFKA_GROUP_ID；未配置 brokers 时 consumer 禁用但 outbox 持续留存 |
| 普通补录与状态核对 | BACKFILL_LOOKBACK_DAYS、BACKFILL_WINDOW_DAYS；APPROVAL_STATUS_RECONCILE_CRON、APPROVAL_STATUS_RECONCILE_BATCH_SIZE、APPROVAL_STATUS_RECONCILE_DELAY_MS、APPROVAL_STATUS_RECONCILE_INVALID_ID_COOLDOWN_MINUTES，详见 [状态核对](../modules/approval-recovery/README.md#无效实例-id-冷却) |
| 审批修复 | APPROVAL_REPAIR_POLL_MS，默认 5000ms |
| 财务历史 | FINANCIAL_BACKFILL_ENABLED 默认 false；FINANCIAL_BACKFILL_CRON、FINANCIAL_BACKFILL_DELAY_MS、FINANCIAL_BACKFILL_MAX_WINDOWS；须先显式播种窗口 |
| 已完成轮转 | COMPLETED_APPROVAL_REFRESH_ENABLED 默认 false；COMPLETED_APPROVAL_REFRESH_CRON、COMPLETED_APPROVAL_REFRESH_BATCH_SIZE、COMPLETED_APPROVAL_REFRESH_DELAY_MS、COMPLETED_APPROVAL_REFRESH_MIN_INTERVAL_SECONDS |
| MinIO | ARCHIVE_MINIO_ENDPOINT、ARCHIVE_MINIO_PORT、ARCHIVE_MINIO_USE_SSL、ARCHIVE_MINIO_ACCESS_KEY、ARCHIVE_MINIO_SECRET_KEY、ARCHIVE_MINIO_BUCKET |
| 附件下载 | DINGTALK_ARCHIVE_DOWNLOAD_USER_ID、DINGTALK_ARCHIVE_DOWNLOAD_UNION_ID；ARCHIVE_BATCH_SIZE（1–10）、ARCHIVE_DELAY_MS、ARCHIVE_RECOVERY_CANARY_ONLY |
| 装箱 | DINGTALK_PACKING_READER_USER_ID、DINGTALK_PACKING_WORKBOOKS_JSON（year/workbookId/label，年和 ID 不得重复）、PACKING_SNAPSHOT_MINIO_BUCKET、PACKING_REFRESH_POLL_MS、PACKING_RANGE_MAX_CELLS、PACKING_SHEET_MAX_ROWS、PACKING_SHEET_MAX_COLUMNS |
| 机器人 | DINGTALK_ALERT_ROBOT_CODE、DINGTALK_ALERT_CLIENT_ID、DINGTALK_ALERT_CLIENT_SECRET；DINGTALK_ALERT_RECIPIENT_USER_IDS 仅用于预算/空节点，超时个人提醒取任务审批人 |
| 超时与空节点 | 超时须配置 DINGTALK_CORP_ID、APPROVAL_TIMEOUT_PROCESS_CODES；APPROVAL_TIMEOUT_MINUTES 默认 4320，旧环境显式阈值须同步更新；APPROVAL_TIMEOUT_MONITOR_CRON 默认每 30 分钟；可选 APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS 同步发企业群、APPROVAL_TIMEOUT_PAUSED_INSTANCES 按企业和实例暂停提醒；APPROVAL_EMPTY_NODE_PROCESS_CODES 控制空节点预警，详见 [预警](../modules/alerts/README.md) |
| 预算 | BUDGET_ALERT_PROCESS_CODES、BUDGET_ALERT_FIELD_MAP、BUDGET_ALERT_API_URL、BUDGET_ALERT_API_KEY |
| 日志/服务 | LOG_LEVEL、PORT；NODE_ENV 决定日志美化 |
| 独立测试库 | SETTLEMENT_TEST_DATABASE_URL、FINANCIAL_TEST_DATABASE_URL、APPROVAL_TIMEOUT_TEST_DATABASE_URL、USER_SNAPSHOT_TEST_DATABASE_URL，仅测试文件读取，均须明确获准的 loopback 一次性库；超时回归用会话临时表，用户快照回归限定 user_snapshot_test / user_snapshot_test_* 并仅操作自建随机 schema |

## 调度清单

由 [scheduler.ts](../../src/jobs/scheduler.ts) 注册，Cron 时区均为 Asia/Shanghai。

| 默认时间 | 工作 |
| --- | --- |
| 每天 02:00 | 普通回溯补录，默认最近 1 天 |
| 每天 03:00 | 删除 90 天前 success 事件日志，保留失败事件 |
| 每天 04:00 | 模板同步 |
| 每 15 分钟 | RUNNING 实例核对，默认最多 100 个、间隔 500ms |
| 每 30 分钟 | 超时预警，默认任务满 72 小时首次提醒，之后每个目标成功发送满 24 小时再次提醒 |
| 每小时 7/17/27/37/47/57 分钟 | 财务历史批次，仅开关开启时；默认每企业最多 1 个窗口、请求前等 2000ms |
| 每 30 分钟 | 已完成轮转，仅开关开启时；默认 10 条、最小复查间隔 21600 秒 |

outbox 默认每秒投递最多 100 条；修复和装箱 worker 默认每 5 秒轮询。附件字节归档 CLI 未注册进上述 scheduler，外部定时调用情况待验证。

## 部署和恢复边界

启动会调用 ensureCorpConfigTable，后台任务可修改数据库；就绪检查还可能调用钉钉 Token 接口。不得为了阅读知识库启动服务。

迁移先后依赖、不可逆范围及空库安装限制见 [数据库](database.md)。恢复方案需区分普通补录、财务窗口、修复、附件、装箱；不要默认用 migrate:down 回滚应用。仓库未提供完整生产备份恢复流程，已有专项文档中的历史测试描述不能作为当前环境通过证据。
