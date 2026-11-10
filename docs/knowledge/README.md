# 项目知识库

核实日期：2026-10-23（Asia/Shanghai）；审批读取 API 更新：2026-10-30。项目：dingtalk-oa。

本项目接收钉钉审批事件，拉取审批详情归档到 PostgreSQL，并通过无需鉴权的 HTTP API 向业务系统提供审批与附件，以及向下游提供成本来源、附件和装箱工作簿快照。入口是 [项目规则](../../AGENTS.md) 和本索引。

## 阅读范围与证据

- **已验证**：本文库所述代码路径、SQL 定义及静态调用关系已按当前工作区核对。这里的“已验证”不代表已运行测试或完成生产验收。
- **待验证**：线上迁移版本、配置值、权限授予、外部 API 契约、数据完整性和实际调度状态。本次没有读取 .env、连接业务数据库、启动服务或调用外部系统。
- 覆盖 9 个业务领域及其主要代码入口；不逐一复制所有字段和测试用例，不覆盖 node_modules、dist、日志及备份。
- 原有 [项目 README](../../README.md)、[物流结算归档契约](../logistics-settlement-archive.md)、[财务来源专项说明](../financial-source-discovery.md) 保留。两份英文专项文档作为既有资料复用；本次新增文档使用简体中文，旧说明与代码差异集中记录在 [可靠性与待验证事项](reliability.md)。

## 基础文档

| 文档 | 使用场景 |
| --- | --- |
| [项目概况](project-overview.md) | 技术栈、目录、入口和系统边界 |
| [系统架构](architecture.md) | 事件、事务、后台任务与下游数据流 |
| [业务地图](business-map.md) | 模块、使用方及依赖关系 |
| [数据库设计](database.md) | 表分组、约束、迁移依赖和实体关系 |
| [核心数据字典](data-dictionary.md) | 关键标识、状态、时间及统计口径 |
| [API 总览](api-overview.md) | HTTP 路由、审批增量读取、数据库契约与兼容性 |
| [认证与权限](authentication.md) | 签名、应用凭据、数据库角色及企业边界 |
| [国际化](internationalization.md) | 当前缺口与渐进式扩展约定 |
| [系统集成](integrations.md) | 钉钉、预算、Kafka、MinIO、下游成本系统 |
| [运行与部署](deployment.md) | 命令副作用、配置分组、调度及环境限制 |
| [开发规范](conventions.md) | 复用入口、测试选择与文档更新规则 |
| [可靠性与待验证事项](reliability.md) | 已有保障、实现缺口、旧文档差异和验证边界 |

## 模块入口

| 模块 | 文档 |
| --- | --- |
| 审批事件与归档 | [业务与代码映射](../modules/approval-ingestion/README.md)、[处理流程](../modules/approval-ingestion/workflow.md) |
| 审批与附件 HTTP 读取 | [调用和增量契约](../modules/approval-read-api/README.md) |
| 元数据与组织 | [模板、字段、人员、部门](../modules/metadata-organization/README.md) |
| 审批人连接器 | [接口和人员解析](../modules/approval-connector/README.md) |
| 补录、状态核对与修复 | [恢复机制](../modules/approval-recovery/README.md) |
| 财务来源与历史覆盖 | [契约和代码](../modules/financial-sources/README.md)、[发现与恢复流程](../modules/financial-sources/workflow.md) |
| 附件与物流归档 | [归档规则](../modules/attachment-archive/README.md)、[状态流程](../modules/attachment-archive/workflow.md) |
| 装箱工作簿快照 | [读取、快照和队列](../modules/packing-workbooks/README.md) |
| 统一预警 | [超时、空节点、预算](../modules/alerts/README.md) |

## 维护方式

新任务先按范围选择上述文档，再核实对应代码。数据库、接口、权限、状态、调度或集成契约变化时更新其唯一负责文档，并检查本索引和模块链接；格式调整无需新增总结。新增业务模块时加入模块入口和业务地图。配置只记录名称与用途，不复制值或业务个人信息。

本次初始化采用只读源码核验与 Markdown 静态检查；具体执行结果见 [验证记录](reliability.md#本次初始化验证)。
