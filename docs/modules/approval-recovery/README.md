# 补录、状态核对与审批修复

[返回知识库](../../knowledge/README.md)

**验证状态：已验证（静态代码）。** 使用方为定时调度、运维和下游缺口修复请求。

## 四种恢复入口

| 机制 | 范围与流程 | 可靠性边界 |
| --- | --- | --- |
| 普通补录 | 企业→模板→默认 7 天窗口→每页 20 个 ID→详情事务；每日 02:00 默认回溯 1 天 | 仅记录处理计数，单实例失败后继续；窗口 completed 不保证无失败 |
| RUNNING 核对 | 按最后同步时间选择本地未删且处于 RUNNING 的实例，跳过冷却中的企业与实例组合后取批次，默认 100 条 | 同进程核对串行执行，冷却随进程重启清空。跨进程分别核对 |
| 已完成轮转 | 默认关闭；从 completed_refresh_instances 或兼容旧范围读取 COMPLETED，用持久账本公平轮转 | 可发现晚到评论/附件；15 分钟租约、账本代次校验；不等于持续扫描全部历史 |
| 审批修复队列 | 下游受限 SQL 函数入队→worker 读取钉钉→校验实例/业务编号/模板→统一入库 | 最多 3 次领取；权限/标识不符不重试，网络/429/5xx 等可重试；超时结果写回无代次保护 |

### 无效实例 ID 冷却

钉钉审批详情明确返回 HTTP 400 和 `processInstanceIdError` 时，该企业和实例在定时核对中进入冷却。`APPROVAL_STATUS_RECONCILE_INVALID_ID_COOLDOWN_MINUTES` 默认 `1440`。日志记录下次可核对的时间，冷却到期后按现有顺序重新选入批次。网络错误、限流和其他返回码保持现有重试行为。冷却只影响定时核对，审批状态、正常事件归档和超时提醒各自沿用原有规则。[核对实现](../../../src/jobs/approval-status-reconcile.ts) · [候选查询](../../../src/db/queries/approval-instance.ts)

钉钉应用 Token 刷新和审批详情每次 HTTP 请求最多等待 10 秒，包含响应正文读取。详情超时沿用原有重试次数，Token 刷新超时可回退到仍有效的旧 Token。单条最终超时按临时失败记录，该实例仍可参加后续核对，同批次其余实例继续执行。[Token 刷新](../../../src/dingtalk/token-manager.ts) · [详情请求](../../../src/dingtalk/api-client.ts)

## 普通补录细节

[runBackfill](../../../src/jobs/backfill.ts) 默认按企业配置表取企业，指定 process_code 时直接处理该流程；未指定则使用 [findBackfillTemplates](../../../src/db/queries/process-template.ts)，包括注册的财务历史范围。实例间默认 500ms，翻页 1000ms，窗口间 2000ms。

[backfill_cursor](../../../src/db/queries/backfill-cursor.ts) 按企业+模板+窗口 upsert；运行中游标检查与创建分离，不是原子跨进程互斥。超过 24 小时的 running 标为 failed。分页 nextToken 在内存；重启没有逐 ID 断点，也没有本地已存在就跳过详情的逻辑。

模板 last_sync_at 仍可能在部分窗口失败后更新，不能独立作为完整性证据。需要可验证财务历史覆盖时使用 [财务窗口](../financial-sources/README.md)。

## 审批修复契约

[request_approval_repair](../../../migrations/1788856369000_create_approval_repair_queue.cjs) 是 SECURITY DEFINER SQL 函数而非 HTTP API；[采购范围迁移](../../../migrations/20260910000000_purchase_template_scope.cjs) 进一步约束自动注册范围。唯一 request_key、复用已有非 manual_required 请求（包括 success）、白名单 purpose 等以迁移定义为准；允许目的为 international_logistics / purchase_expense。提交者与只读角色分离。

[processApprovalRepairRequest](../../../src/jobs/approval-repair-worker.ts) 对返回的显式实例 ID 冲突拒绝；businessId 必须与 expectedBusinessId 一致；返回 processCode 存在时必须匹配。缺少回显实例/流程码可使用请求定位与已校验模板兜底。请求详情时关闭 API 客户端重试，由队列最多 3 次负责重试。

成功使用 persistApprovalInstance，同步附件清单；国际物流额外调用附件候选提取。不会执行付款或成本修改。最终失败 manual_required；最后一次运行中领取超时会标人工处理。字段和状态见 [数据字典](../../knowledge/data-dictionary.md)。

## 代码与测试映射

| 功能 | 实现 | 已有测试 |
| --- | --- | --- |
| 调度 | [scheduler](../../../src/jobs/scheduler.ts) | [scheduler.test](../../../src/jobs/scheduler.test.ts) |
| 状态核对 | [approval-status-reconcile](../../../src/jobs/approval-status-reconcile.ts) | [核对测试](../../../src/jobs/approval-status-reconcile.test.ts) |
| 完成复查 | [completed-approval-refresh](../../../src/jobs/completed-approval-refresh.ts)、[查询](../../../src/db/queries/approval-instance.ts) | [复查测试](../../../src/jobs/completed-approval-refresh.test.ts) |
| 缺口修复 | [worker](../../../src/jobs/approval-repair-worker.ts)、[队列](../../../src/db/queries/approval-repair.ts) | [worker 测试](../../../src/jobs/approval-repair-worker.test.ts)、[迁移检查](../../../src/db/queries/approval-repair.test.ts) |
| 手工补录 | [CLI 脚本](../../../scripts/backfill.ts)、[单实例工具](../../../src/cli/fetch-approval.ts) | 本次未执行 |

所有恢复路径都会写数据库并可能调用钉钉。本次没有执行；调度开关、实际缺口与源状态待验证。
