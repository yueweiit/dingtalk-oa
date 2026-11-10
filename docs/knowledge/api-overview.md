# API 总体设计

**验证状态：已验证（路由注册及处理代码）。** 审批只读 API 已有 Fastify inject 单元验证；实际数据库、MinIO 与外部系统联调待验证。

## HTTP 路由

全部由 [createApp](../../src/app.ts) 注册。新增审批读取接口使用 /api/v1；其他既有路径保持原样。未发现 Swagger/OpenAPI 生成器；读取接口用 success/data/pagination，其他接口沿用既有响应。

| 方法与路径 | 入参及返回 | 认证 / 错误 |
| --- | --- | --- |
| GET /health/live | `{status:"ok"}` | 无应用鉴权，仅表示进程存活 |
| GET /health/ready | status、checks.database/token/kafkaConsumer、kafkaConsumer 详情 | DB SELECT 1、获取或刷新 Token、检查消费者；就绪 200，否则 503；不是纯离线检查 |
| GET /metrics | uptime、memory、timestamp、kafkaConsumer | 无应用鉴权；JSON，不是 Prometheus 文本格式 |
| POST /webhook/approval | 大写事件字段，成功 `{success:true}`；持久化到 outbox 后返回 | 需要两项 Webhook 配置及签名头；503 未配置，401 缺签名/校验失败，400 事件无效，500 处理异常 |
| POST /connector/approval/approvers | businessEntities、可选 processInstanceId/originatorUserId；返回 result 人员 ID 数组及 users/matchedBusinessEntities | 未发现路由鉴权；400 参数错误，503 企业未配置，422 主体或审批人未找到 |
| GET /api/v1/approvals | 企业、流程、编号、更新时间、游标；完整审批 JSON、审批编号和表名称 | 无需鉴权；corpId 必填，流程可选；包含删除标记 |
| GET /api/v1/attachments | 企业、流程、编号、更新时间、游标；附件清单及下载路径 | 同上；独立附件水位及退役标记 |
| GET /api/v1/attachment-content | corpId、processInstanceId、fileId；流式下载已归档文件 | 无需鉴权并复查来源/文件状态；404 不存在或退役，409 未就绪；首字节前失败 503、超时 504，传输开始后异常则断流 |

完整调用、配置、分页、返回和错误码见 [审批读取 API](../modules/approval-read-api/README.md)。该接口按请求指定的企业和可选流程查询源归档；企业筛选不构成访问授权，不套用 costing_read 视图白名单，也不扩大已有附件收集范围。

读取接口按来源 IP 独立限流，并对校验通过的查询设总量保护；仅信任 HTTP_TRUSTED_PROXIES 中的代理地址。内部签名密钥在相同配置下跨进程及重启稳定，调用方不需要凭据。增量时间先校验有效日期和时区范围，非法值在查询数据库前返回 400；合法微秒时间保留原文。下载分别限制对象打开、数据空闲和总时长，超时/客户端取消会中止底层存储连接；流错误按固定错误码处理，避免框架默认响应/日志输出后端错误原文。

Webhook 代码：[路由](../../src/webhook/index.ts)、[事件 Schema](../../src/dingtalk/types.ts)、[签名](../../src/dingtalk/signature.ts)。支持的事件字段为 CorpId、EventType，以及可选 ProcessInstanceId、ProcessCode、Type、Result、TimeStamp、EventId；业务处理仍要求实例 ID。Zod 对象未 passthrough，未声明字段会被去掉。Webhook 输出事件类型固定为 bpms_instance_change，不能推定它完整支持所有任务事件语义。

连接器 JSON body 覆盖 query 同名字段，支持数组、JSON 数组字符串、中英文逗号分隔及选项对象；详见 [连接器模块](../modules/approval-connector/README.md)。

## 数据库接口同样属于公共契约

| 接口组 | 用途 | 定义入口 |
| --- | --- | --- |
| costing_read.approval_instances_v1/v2、attachment_archives_v1/v2 | 审批与附件版本化读取、删除标记、独立增量水位 | [物流迁移](../../migrations/20260909000000_logistics_settlement_archive.cjs)，后续由采购及财务迁移重定义 |
| approval_actor_names_v1、sync_health_v1 | 人员名辅助、归档批次健康 | [人员名迁移](../../migrations/1788508800000_create_costing_actor_names_view.cjs)、[归档迁移](../../migrations/1788492000000_create_costing_archive.cjs) |
| financial_sources_v1、financial_template_coverage_v1、financial_template_discovery_v1 | 财务证据、窗口覆盖、历史名称发现 | [财务来源](../modules/financial-sources/README.md) |
| request_approval_repair、approval_repair_status_v1 | 受限修复提交函数及状态视图 | [修复迁移](../../migrations/1788856369000_create_approval_repair_queue.cjs)、[采购范围更新](../../migrations/20260910000000_purchase_template_scope.cjs) |
| packing_workbooks_v1、packing_sheet_index_v1、packing_sheet_snapshots_v1、packing_refresh_status_v1 | 工作簿、工作表、快照及队列状态 | [装箱迁移](../../migrations/20260907000000_create_packing_sheet_cache.cjs) |
| request_packing_workbook_index_refresh、request_packing_sheet_refresh | 数据库提交工作簿索引/工作表刷新请求 | [装箱模块](../modules/packing-workbooks/README.md) |
| completed_approval_refresh_v1 | 已完成审批轮转账本 | [物流迁移](../../migrations/20260909000000_logistics_settlement_archive.cjs) |

这些对象不是 HTTP 路由。读角色和提交角色不同，见 [权限](authentication.md)。完整列定义直接读取迁移，避免复制两套字段表。

## 兼容性和错误处理

新 HTTP 字段应保持已有 success/result/users 结构；连接器错误码是稳定编码，Webhook 当前以中文 message 为主。数据库视图新增版本时保留旧列和类型；审批与附件水位分别续读并重叠重放，不能只看审批变化发现附件变化。

未发现通用业务错误处理器；路由显式错误与 Fastify 默认异常返回并存。财务/附件 SQL 契约、HTTP 返回和 CLI 退出码分别维护。外部钉钉、预算请求由 [集成文档](integrations.md) 统一说明。
