# 项目开发与知识库维护约定

**验证状态：已验证（已有代码约定）；以下新增约束用于后续开发。**

## 代码组织与复用

- TypeScript strict、ESM、NodeNext；本地 import 使用 .js 后缀。模块既有命名多为 kebab-case；JSON/HTTP 多 camelCase，数据库多 snake_case，源钉钉字段保留实际命名。
- HTTP 放 app/webhook/connector，SQL 放 db/queries，归档组合流程放 normalize，调度与后台任务放 jobs；不虚构 Controller/Service 层。
- 数据库优先 withClient/withTransaction，事务内部将 client 下传。不要在同一业务事务中无意新开独立连接。
- 审批刷新优先复用 refreshApprovalInstance / persistApprovalInstance / upsertInstance；后者联动附件和 SQL 触发器，不能只改一条 INSERT 而忽略投影、任务与下游水位。
- 部门树构造、附件提取/下载策略、装箱范围切块、预警投递去重已有实现，先复用。不同队列的租约实现并不相同，不直接复制后宣称保障等价。
- 保留原始 JSON、稳定业务 ID、source 状态、v1/v2 视图兼容性。涉及用户可见文本按 [国际化规范](internationalization.md) 设计，当前尚无统一翻译器。
- 生产/外部数据访问、通知、回填、迁移、依赖和服务调整须在任务授权范围内进行；文档分析只读。不得在日志新增凭据、Token 或带签名下载地址。

依据：[tsconfig](../../tsconfig.json)、[事务](../../src/db/pool.ts)、[编排器](../../src/normalize/orchestrator.ts)、[架构复用表](architecture.md)。

## 验证方式

命令来源为 [package.json](../../package.json)。本次初始化**没有运行**构建或测试。

| 变更 | 后续获准开发时建议验证 |
| --- | --- |
| 普通 TypeScript | npm run lint；按变更范围选择 Vitest 文件 |
| 时间和任务 | instance-normalizer.test.ts、task-normalizer.test.ts、approval-timeout-monitor.test.ts；实际任务 upsert 与提醒候选查询使用 approval-timeout.integration.test.ts，需要明确获准的隔离测试库 |
| 附件 | attachment-extractor、download-strategies、archive-job、archive-target 相关测试；更改契约时加隔离库验证 |
| 装箱 | document-client、refresh-worker、snapshot-store、packing-workbook 相关测试 |
| 财务 | financial-template-discovery、financial-backfill、scheduler 及隔离库契约测试 |
| 文档 | 路径/相对链接、Markdown 表格/代码块、Mermaid 结构、Git 差异及文件哈希；不启动业务代码 |

测试文件大多与源码同目录，实际测试名/路径从 [src](../../src/) 定位。测试采用 Vitest、vi.mock 和显式依赖注入，不能仅凭测试文件存在声称已通过。

[物流集成测试](../../src/db/settlement-contract.integration.test.ts) 仅在 SETTLEMENT_TEST_DATABASE_URL 存在时启用，限制 loopback 且数据库名 settlement_test*；[财务集成测试](../../src/db/financial-contract.integration.test.ts) 要求 FINANCIAL_TEST_DATABASE_URL 和 settlement_test_financial*。它们会建角色、迁移及 TRUNCATE，只能使用获准的一次性隔离数据库，不能共用业务库。构建产物不等于已部署。

[超时提醒集成测试](../../src/db/approval-timeout.integration.test.ts) 仅在显式提供获准的 APPROVAL_TIMEOUT_TEST_DATABASE_URL 时启用；限定 loopback 及 approval_timeout_test / approval_timeout_test_* 库名，拒绝连接参数覆盖目标地址。只创建会话临时表，重置操作显式限定 pg_temp，不运行迁移或修改 public 表。本次 8 项因没有获准隔离库而跳过，不可把单元测试通过写成真实 PostgreSQL 已验证。

[用户快照集成测试](../../src/db/user-snapshot.integration.test.ts) 需要显式获准的 USER_SNAPSHOT_TEST_DATABASE_URL，限定 loopback 和 user_snapshot_test / user_snapshot_test_*，拒绝连接参数覆盖。在测试自建随机 schema 中执行两阶段迁移、区间整理、并发读取/写入和回滚用例；另验证旧失败清理的完整 JSON 归档、成功历史保留、错配回滚、外键/触发器/规则拦截及后续正常写入。结束时仅删除该 schema，禁止使用业务库。第二阶段校验必须在第一阶段提交后执行，不能用外层事务把两阶段重新包在一起；独立清理也须保留单阶段事务。未提供获准库时应跳过；[离线迁移检查](../../src/db/user-snapshot-migration.test.ts) 生成 SQL 并用模拟数据库检验实际迁移器的事务边界和清理安全契约，不连接真实数据库。

[审批元数据集成测试](../../src/db/approval-enrichment.integration.test.ts) 同样仅使用获准的 USER_SNAPSHOT_TEST_DATABASE_URL、loopback 和 user_snapshot_test / user_snapshot_test_* 数据库，并建立独立 approval_metadata_it_* schema。覆盖调岗后延迟采集导致的历史部门误判、多种空白字符、双连接并发软删除、转交、幂等、只读预览及保存点回滚。没有获准测试库时必须跳过，真实 SQL 行为以集成测试结果为准。

## 文档维护映射

| 发生变化 | 优先更新 |
| --- | --- |
| 入口、依赖、服务边界 | project-overview、architecture、deployment |
| HTTP/错误码、视图/请求函数 | api-overview、对应模块；数据库变化同步 database/data-dictionary |
| 状态、金额、时间口径 | data-dictionary、对应模块流程 |
| 权限、企业过滤、操作用户 | authentication、integrations、对应模块 |
| 定时任务、失败恢复、并发 | deployment、对应模块；可靠性问题解决后更新 reliability |
| 多语言和通知文本 | internationalization、alerts |
| 新增业务模块 | business-map、README 索引、模块文档 |
| 项目约束改变 | 只更新 AGENTS 中相关条目，不复制整本知识库 |

遵循“代码先核实、文档单一来源、相对链接引用”。每次按任务范围读文档，不重新扫描全仓库；重要变更同步现有文档，不为每次修改新建总结文件。待验证信息补足证据后再改状态，保留与生产验收的区别。
