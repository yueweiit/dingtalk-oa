# dingtalk-oa 项目规则

## 项目与入口

Node.js / TypeScript ESM 后端：Fastify 5、pg/PostgreSQL、KafkaJS、钉钉 Stream、MinIO、node-cron；没有独立前端。主入口 [src/index.ts](src/index.ts)，HTTP [src/app.ts](src/app.ts)，配置声明 [src/config/schema.ts](src/config/schema.ts)。

新任务先根据范围读 [知识库索引](docs/knowledge/README.md)，再选择对应 [业务模块](docs/knowledge/business-map.md)；无需每次全仓库扫描。文档基于静态代码，生产状态另行验证。

## 项目专属约束

- 审批标准保存入口在 [normalize/orchestrator.ts](src/normalize/orchestrator.ts)。修改实例入库同时检查任务、表单字段、附件清单、财务触发器及下游水位。
- 数据库使用原生参数化 SQL；事务内复用传入 client。Schema 以累积迁移为准，参考 [数据库](docs/knowledge/database.md) 和 [数据字典](docs/knowledge/data-dictionary.md)。
- 保留企业过滤、稳定业务 ID、原始 payload、v1/v2 视图列/类型和删除标记。corp_id 维度不等于完整多租户授权；权限改动先读 [认证](docs/knowledge/authentication.md)。
- 当前主接入是持久 outbox → Kafka；旧 event-buffer 未接入。不要依据旧 README 假定无 Kafka 时自动直接归档。
- 财务可读范围、附件收集资格和采纳候选是不同条件；候选资格不授权整单成本入账。改动时读 [财务模块](docs/modules/financial-sources/README.md) 和 [附件模块](docs/modules/attachment-archive/README.md)。
- `parseDingTalkTime` 有项目特定 Z 后缀兼容规则；修改需联查历史修正、任务时间和超时预警，勿擅自按通用 ISO 规则替换。
- 国际化尚未统一建设。新增消息按 [国际化](docs/knowledge/internationalization.md) 规划稳定错误码、集中模板和语言扩展；源业务名称原样保存，不擅自引入依赖或修改存量模型。
- 对外系统关系见 [集成](docs/knowledge/integrations.md)，已有实现缺口见 [可靠性](docs/knowledge/reliability.md)。

## 验证与安全

- import 保持项目现有 .js 后缀、TypeScript strict 和 NodeNext；命令以 package.json 为准。
- `npm run lint` 是 tsc --noEmit；`npm run test:run` 是 Vitest；测试多位于 src 内。按改动选择测试，详见 [开发规范](docs/knowledge/conventions.md)。
- 两套 PostgreSQL 集成测试会迁移、建角色及清空测试数据，必须使用明确获准的一次性 loopback 测试库；不能当作只读检查。
- 主进程启动可执行 DDL、外部同步及通知；回填、附件/装箱 CLI 和 SQL 请求函数均可能写入。文档分析任务不得自动运行启动、构建、测试、迁移、同步、部署或通知命令。
- 不读取或复制无关凭据，不将 .env、Token、签名下载 URL 或真实人员标识写入知识库。修改前检查 Git 状态，保留已有工作；未经明确要求不提交或推送。

## 文档更新

重要业务、数据库、API、权限、国际化或集成变化时更新对应现有模块及基础文档，新增模块同步索引。原有专项契约通过链接复用，不批量迁移或覆盖。文档与代码冲突时核实代码，记录待验证边界；简单改动无需新增总结。全局规则负责通用规范，本文件只维护项目差异。
