# 财务来源与历史覆盖

[返回知识库](../../knowledge/README.md) · [发现与恢复流程](workflow.md) · [复用的财务专项契约](../../financial-source-discovery.md)

**验证状态：已验证（TypeScript 与累积 SQL 定义）。** 使用方为运维及下游成本系统；本模块不是完整财务账务系统。

## 来源范围与资格

- 当前列表按中/英/西财务关键词及 BU 历史后缀发现；本地历史名和人工指定精确名通过专门查询流程码。名称查找失败持久化为 failed，不默认为模板不存在。
- 财务模板按企业+流程码注册，停用、删除或改名不自动撤销历史范围。当前列表新发现默认启用，历史专门发现新模板默认 disabled；保留已有模板启用状态。
- 非财务名模板的单据也可能因“有金额字段 + 运输证据”获得持久的实例级暴露；这不自动授予整个模板的修复权限。
- 运输证据包括明确物流类别、主运输费、运输附加费或物流引用。来源可含嵌套/JSON 字符串字段、评论；关联物流实例须同企业且精确匹配，附件不透明 ID 本身不是运输证据。
- source_valid 排除单据撤销、取消、拒绝、删除等；不因模板删除直接失效。无效财务来源仍可读以保留审计。
- 财务新附件收集要求来源有效并有运输证据；eligible_for_adoption 还要求 COMPLETED/FINISHED/APPROVED，且不是仅排除费用。海关税费或尾程词不能单独作为主运输证据。
- eligible_for_adoption 是候选提示，不能授权整单金额自动采纳；逐行分类、匹配置信度、金额归属由下游负责。

依据：[发现逻辑](../../../src/jobs/financial-template-discovery.ts)、[注册查询](../../../src/db/queries/financial-template-discovery.ts)、[范围与分类 SQL](../../../migrations/20260910010000_financial_source_scope.cjs)、[投影 SQL](../../../migrations/20260910020000_financial_source_projection.cjs)。

## 数据库读契约

| 对象 | 用途及易错点 |
| --- | --- |
| financial_sources_v1 | 扩展审批 v2，给出证据、有效性、候选资格、附件计数与证据水位 |
| financial_template_coverage_v1 | 持久窗口进度；无窗口为 not_scheduled；流程总量在每个窗口重复，不能跨窗口累加 |
| financial_template_discovery_v1 | 精确请求名、解析流程码、状态、次数和最后错误 |
| financial_source_projection | 内部投影，不是对外基础表授权；保存证据、关联 ID、附件引用数 |
| financial_template_scope / financial_source_exposure | 模板级与实例级持久可读范围 |
| financial_backfill_window | 企业+流程+起止时间主键；next_token、pending_ids、page_loaded、lease_generation |

所有对象均在 costing_read。完整列由迁移定义，不在模块内复制。附件引用、活跃清单、可用、待处理、失败、退役和未排队计数不同；available 也可能是预览件，必须检查 content_quality。

## 历史恢复及性能

显式 CLI 发现并创建固定窗口（最大 7 天一段），再由 worker 恢复。CLI 日期按 Asia/Shanghai 左闭右开；默认 2026 历史范围及截止规则见 [脚本](../../../scripts/financial-backfill.ts)，不是自动承诺全部年度已覆盖。定时只消费已种下的队列，默认关闭。

数据库通过行锁、15 分钟租约、generation 和有效期保护每次进度推进；先持久化分页 ID，再逐一归档成功后出队。失败保留当前 ID，可安全 upsert 重放。QpsLimitForApi / HTTP 429 结束当次 drain，不能立即重启制造重试风暴。

后续投影迁移把本地 JSON 解析移动至写入时；关联物流后到或新注册范围推进依赖证据水位。使用事务 advisory lock 协调关联写入。性能优化实现存在不代表实际数据规模已验证。

## 代码映射与验证

| 入口 | 实现 |
| --- | --- |
| 手工发现、排期、恢复、状态 | [scripts/financial-backfill.ts](../../../scripts/financial-backfill.ts) |
| 名称识别与发现 | [financial-template-discovery](../../../src/jobs/financial-template-discovery.ts) |
| 窗口处理 | [runFinancialBackfill](../../../src/jobs/financial-backfill.ts)、[持久窗口 SQL](../../../src/db/queries/financial-backfill.ts) |
| 定时消费 | [scheduler](../../../src/jobs/scheduler.ts)，FINANCIAL_BACKFILL_ENABLED |
| 统一详情保存 | [refreshApprovalInstance](../../../src/normalize/orchestrator.ts) |
| 契约回归 | [financial-contract.integration.test](../../../src/db/financial-contract.integration.test.ts)、[发现测试](../../../src/jobs/financial-template-discovery.test.ts)、[补录测试](../../../src/jobs/financial-backfill.test.ts) |

本次未运行这些测试。生产历史模板全集、远程搜索是否覆盖全部实例、年度窗口完成和下游实际采纳口径待验证。财务迁移 down 禁止删除审计证据，详见 [数据库约定](../../knowledge/database.md)。
