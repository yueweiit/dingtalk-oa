# 项目总体概况

**验证状态：已验证（静态代码）。**

## 定位与边界

[package.json](../../package.json) 名称为 `dingtalk-oa`，描述为钉钉审批数据归档系统。归档服务保存源审批、任务和原始 JSON，不负责执行审批流转、支付、成本分摊或修改钉钉表格。成本系统通过数据库视图和 MinIO 消费资料，并通过受限数据库函数请求刷新/修复；本仓库没有下游成本计算应用。

其他系统也可通过 [审批与附件只读 HTTP API](../modules/approval-read-api/README.md) 获取本地归档数据及文件；无需 Token，通过企业/可选流程筛选、游标分页和分别维护的审批/附件增量水位读取。

未发现独立前端、页面路由、菜单权限、登录页面或 Redis。后台任务与 HTTP 服务在同一进程启动；附件字节归档另有 CLI。

## 技术栈与目录

| 位置 | 实际用途 |
| --- | --- |
| [package.json](../../package.json)、[tsconfig.json](../../tsconfig.json) | Node.js ESM；TypeScript 5.6 范围、ES2022、NodeNext、strict；Fastify 5、Zod 3、pg 8、KafkaJS 2、MinIO 8、node-cron 3；实际锁定版本见 package-lock.json |
| [src/index.ts](../../src/index.ts)、[src/app.ts](../../src/app.ts) | 生命周期、HTTP、健康检查与指标 |
| [src/config/schema.ts](../../src/config/schema.ts)、[src/config/index.ts](../../src/config/index.ts) | dotenv + Zod 环境校验与进程内缓存 |
| [src/dingtalk/](../../src/dingtalk/) | 审批、人员、文档 API、Token、签名、Stream、机器人 |
| [src/kafka/](../../src/kafka/) | outbox 投递、生产消费、失败队列 |
| [src/normalize/](../../src/normalize/) | 统一审批入库、时间和表单规范化 |
| [src/db/](../../src/db/)、[migrations/](../../migrations/) | pg 连接池、原生 SQL、类型、CJS 迁移；无 ORM |
| [src/jobs/](../../src/jobs/) | 补录、财务发现、状态核对、预警、修复 |
| [src/archive/](../../src/archive/)、[src/packing/](../../src/packing/) | 附件下载与工作簿快照 |
| [src/organization/](../../src/organization/)、[src/connector/](../../src/connector/) | 部门树和主体审批人 |
| [src/approval-api/](../../src/approval-api/) | 无需鉴权的读取路由、稳定签名游标、来源限流、审批与附件查询 |
| [src/cli/](../../src/cli/)、[scripts/](../../scripts/) | 手工归档、补录和元数据维护 |
| [src/](../../src/) 下 `*.test.ts` | Vitest 单元测试、迁移文本检查、受环境变量控制的 PostgreSQL 集成测试 |

## 启动行为

`npm run dev` 执行 tsx watch；`npm run build` 编译到 dist；`npm start` 运行 dist/index.js。包未声明 engines，不能仅根据 @types/node 推断已验证的运行时版本。

主进程加载配置、初始化数据库、调用 `ensureCorpConfigTable`（可执行 DDL）、尝试启动 Kafka 生产者、outbox、HTTP、Token 自检、模板名同步、Kafka 消费者、Stream、Cron、装箱刷新和审批修复。启动不是只读检查。失败分支允许部分功能继续启动，须结合就绪状态及积压判断运行情况。

配置与启动限制统一见 [运行与部署](deployment.md)。业务入口见 [业务地图](business-map.md)；国际化现状见 [国际化](internationalization.md)。
