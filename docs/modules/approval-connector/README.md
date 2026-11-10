# 业务主体审批人连接器

[返回知识库](../../knowledge/README.md) · [权限边界](../../knowledge/authentication.md)

**验证状态：已验证（静态路由与查询）。** 调用方是钉钉审批连接器；本模块只解析人员，不发起或审批单据。

## 接口契约

POST /connector/approval/approvers。JSON body 同名项覆盖 query。

| 字段 | 规则 |
| --- | --- |
| businessEntities | 1–20 个非空字符串；支持直接数组、序列化 JSON 数组、中英文逗号分隔；选项对象取 value、label、key |
| processInstanceId | 可选非空字符串，仅日志上下文，未用于校验审批所有权 |
| originatorUserId | 可选非空字符串，用于从候选结果排除发起人 |

成功返回 success=true、result（人员 userId 数组）、error 空字符串、users（userId/name）、matchedBusinessEntities（businessCode/name）。没有额外前端页面。

| 状态码 | code | 含义 |
| --- | --- | --- |
| 400 | INVALID_REQUEST | 入参未通过 Zod |
| 503 | CORP_ID_NOT_CONFIGURED | 未配置 DINGTALK_CORP_ID |
| 422 | BUSINESS_ENTITY_NOT_FOUND | 至少一项主体无法匹配，并返回 unmatchedBusinessEntities |
| 422 | APPROVER_NOT_FOUND | 合并并排除发起人后没有候选人 |

## 解析规则与数据

企业固定取配置 DINGTALK_CORP_ID，调用方不能通过请求改变企业。按 business_code **或精确 name** 匹配 active 主体；随后查询 active 人员映射，以 userId 去重，取较小 priority，最终按 priority 和 userId 排序。用户姓名从当前成功快照 LEFT JOIN 获取，可为空。多个主体是人员并集，不是要求每个人同时属于全部主体。

代码：[connectorRoutes](../../../src/connector/index.ts)、[resolveBusinessEntities / findBusinessEntityApprovers](../../../src/db/queries/business-entity-approver.ts)。

模型：ding_business_entity、ding_business_entity_approver，人员名依赖 ding_user_snapshot。结构见 [主体迁移](../../../migrations/20260805000000_create_business_entity_approver.cjs) 和 [多主体共享审批人调整](../../../migrations/20260806000000_add_multi_entity_shared_approvers.cjs)。迁移包含项目专属初始化映射，文档不复制真实人员标识。

## 兼容性与待验证

没有接口签名或用户认证；当前约束是输入检查、固定企业和 active 筛选，不能称为登录授权。网络访问控制及连接器实际配置待验证。主体名可匹配是兼容行为，新接入应优先使用稳定 businessCode；不要通过翻译显示名改变内部业务匹配。

仓库未发现该路由独立的接口测试文件。本次仅静态核对，不调用接口；后续改动应验证多主体去重、未知主体、排除发起人、姓名为空和错误码兼容。
