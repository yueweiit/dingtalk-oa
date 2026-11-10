# 统一预警

[返回知识库](../../knowledge/README.md) · [国际化](../../knowledge/internationalization.md)

**验证状态：已核实代码并通过相关单元测试（2026-11-10）。** 超时提醒发给当前任务审批人及可选群；预算和空节点仍使用固定接收人。未连接业务数据库或发送真实消息。

## 三类触发规则

| 预警 | 触发和计算 | 去重阶段 |
| --- | --- | --- |
| 审批超时 | Cron 默认每 30 分钟；配置企业/流程且实例/任务均 RUNNING、任务未结束；默认满 72 小时首次提醒，成功后每满 24 小时再次提醒 | daily:hash(taskId, startedAt)，按接收人/群独立领取 |
| 空审批节点 | 事件归档后的 RUNNING 实例；配置流程、必要人员/部门及接收人齐全；按本次表单值预测流程 | activityId |
| 预算 | 事件归档后的 RUNNING 实例；配置流程及稳定组件映射；从预算服务查询各部门快照 | alertLevel:departmentId:month |

共同唯一键：corp_id、process_instance_id、alert_type、alert_phase、recipient_user_id。内部类型为 approval_timeout、empty_approver_node、budget_threshold。依据：[超时](../../../src/jobs/approval-timeout-monitor.ts)、[空节点](../../../src/jobs/approval-empty-node-monitor.ts)、[预算](../../../src/jobs/budget-alert-monitor.ts)。

## 超时

开始时间依次取任务 `start_time`、任务原始 `startTime`、任务原始 `createTime`，使用现有 `parseDingTalkTime`。不再回退整单发起时间或其他人的操作时间；缺失/无效时记录 `APPROVAL_TIMEOUT_TASK_START_MISSING` 并跳过，避免把整单等待误判为当前节点等待。

默认 `APPROVAL_TIMEOUT_MINUTES=4320`。未满 72 小时不提醒，达到阈值后不再设结束窗口；每个投递目标上次成功发送满 24 小时后重新领取。故障恢复只发送当前一次，不补发多天历史；每天按成功发送时间滚动计时，实际发送在下一次 Cron 扫描（默认延迟不超过约 30 分钟，另受执行耗时和故障影响）。旧前后窗口配置保留解析兼容但不再使用；已有环境若显式设置旧阈值，须更新为 4320。

个人接收人优先取实例最新 `tasks` 中对应任务的 `userId`；实例详情没有 `tasks` 数组时，使用任务自身的非空原始快照。上述快照存在但人员缺失、为空或仅含空白时，不回退 COALESCE 保留的历史人员列、旧任务快照、固定接收人或发起人；个人不发送，群提醒不 @ 且显示未知审批人。只有实例和任务均无可用原始任务快照的历史行才兼容读取 `ding_approval_task.approver_user_id`。姓名同样优先取当前快照，缺失时显示当前 userId，避免展示历史人员姓名。并行任务分别发送给各自审批人；最新快照已转交时使用其当前人员。缺少审批人时记录 `APPROVAL_TIMEOUT_APPROVER_MISSING`。

可选 `APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS` 为机器人所在企业群的 `openConversationId` 列表（逗号、分号或空白分隔并去重），留空仅发个人。群与个人使用同一独立机器人应用；群发送使用 `/v1.0/robot/groupMessages/send`，Markdown 显示流程、节点、待审批人、等待时长及审批链接，并 @ 当前任务对应的审批人。群发送函数接收审批人 userId 列表，去空去重后同时设置顶层 `atUserIds`、`isAtAll=false`，并在正文添加 `@userId` 标记；缺少审批人时仍发普通群提醒，不回退 @ 全员或其他固定接收人。@ 参数依据 [发送方 SDK](https://github.com/DingTalk-Real-AI/dingtalk-channel-sdk-python/blob/main/src/dingtalk_channel_sdk/send.py) 和 [CLI 群 @ 规范](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/main/skills/mono/references/products/chat.md#机器人-指定人发群消息)，实际群内通知效果待联调。每个任务单独发消息，未做同批汇总。接口字段依据 [钉钉官方 SDK @alicloud/dingtalk](https://www.npmjs.com/package/@alicloud/dingtalk) 的 `robot_1_0.orgGroupSendWithOptions`；[选择群会话](https://open.dingtalk.com/tools/explorer/jsapi?id=10303) 返回 `openConversationId`。机器人入群、发送权限及真实送达需部署后联调。

超时监控要求配置 `DINGTALK_CORP_ID`，SQL 和发送前均约束该企业；部署者须确保机器人凭据属于该企业。查询仅接受未删除、实例/任务 `RUNNING` 且任务 `end_time` 为空的记录；最新实例原始 `tasks` 数组若已移除或结束旧任务，也会跳过。任务重进的结束时间修正规则见 [审批归档](../approval-ingestion/README.md#功能与规则)，不执行历史批量修复；既有异常记录需后续详情刷新满足条件后修正。重进以任务 ID 和开始时间形成新的去重阶段，哈希长度适配现有 `VARCHAR(64)`；群以 `group:sha256(openConversationId)` 存入现有接收人键，避免扩表。停止提醒依赖审批事件/状态核对写入本地的及时性，不代表实时查询钉钉状态。

## 空节点

forecastProcess 提交当前 formComponentValues，优先按 workflowForecastNodes 的 activityId 集合过滤路径；若集合为空，代码检查规则列表，而不是凭空确认实际路径。仅 approval 类型或 approver actor 节点参与；isTargetSelect 自选节点排除，存在非空 userId 即不为空。

预测不成功返回 forecast_failed；输入缺失或未配置时 skipped。该通知是事件归档旁路，失败不阻断入库，没有阻止用户提交或自动修改审批人。

## 预算

- 使用 BUDGET_ALERT_FIELD_MAP 中 applicationDateFieldId、budgetTypeFieldId、serviceEntityFieldId、amountFieldId；拆分还配置 tableFieldId、departmentFieldId、amountFieldId。
- 普通表单从主体 extValue 取部门 code，从字段取金额；发现未配置拆分的非空表格时拒绝猜测。
- 部门拆分按配置表格逐行提取并合并相同部门金额，再逐部门查询。
- GET 预算快照携带 departmentId、month、type、applicationAmount，x-budget-alert-key 认证，10 秒超时。预算服务负责预计金额及等级，本服务接受其 normal/warning_90/over_budget/missing_budget。
- 预算为 0、负值或 missing_budget 不发送；warning_90、over_budget 发送，接收人仍为固定配置，未实现部门负责人动态路由。
- 金额使用 number，显示固定 zh-CN 两位小数，无币种参数；对端规则与精度需联调确认。

## 投递、审计与失败

[claimAlertDelivery](../../../src/db/queries/alert-notification.ts) 原子 INSERT/冲突更新领取；默认 sent 不再领取，failed 或超过 15 分钟 sending 可再次领取。仅超时提醒传入 1440 分钟重投间隔，允许上次 `sent_at` 满 24 小时后重新领取，保留最近发送时间并累加尝试次数；预算和空节点仍为一次性规则。个人和各群独立记录，单渠道失败不阻断其他目标或重发已成功渠道。[机器人](../../../src/dingtalk/alert-robot.ts) 使用独立应用 Token，个人通过 oToMessages/batchSend 发送 Markdown，并检查 invalidStaffIdList / flowControlledStaffIdList；群要求响应包含 processQueryKey。Token 获取和发送请求均设置 10 秒超时。

先外部发送后标 sent，不是 exactly-once；发送已成功而落库失败可能重发。空节点/预算没有独立周期补偿队列，之后能否再尝试依赖事件或调用再次触发；日志成功不能证明旁路通知均已送达。

数据库结构：[ding_alert_notification 迁移](../../../migrations/20260915000000_create_ding_alert_notification.cjs)，本次无需结构迁移。消息集中在 [超时通知模板](../../../src/jobs/approval-timeout-message.ts)，目前正式支持简体中文并预留 locale 扩展；源名称原样展示。

验证：`npm run lint` 及超时、机器人、空节点、预算、调度、实例/任务规范化 7 个文件的 61 项单元测试通过（2026-11-10）。测试模拟数据库与网络，覆盖首次阈值、长期超时、渠道重试、并行审批人、群 @ 参数与正文标记、最新快照缺失人员且历史列仍有人员、转交/结束快照、缺失时间、企业过滤和旧预警兼容。

新增 [PostgreSQL 集成回归](../../../src/db/approval-timeout.integration.test.ts) 8 项用例，经过真实 normalizeTasks → upsertTask → 候选查询 → 模拟通知，验证新轮次清理旧结束时间、开始时间恰等于旧结束时间、已保存新开始时间的异常行恢复、普通缺字段/旧开始时间保留结束历史、显式结束时间保留，以及历史人员列不会触发误发。仅显式提供获准的 `APPROVAL_TIMEOUT_TEST_DATABASE_URL` 才启用，要求 loopback 和 `approval_timeout_test` 或 `approval_timeout_test_*` 库名，使用会话临时表，不运行迁移或访问 public 表。本次未获准隔离库，8 项均跳过；真实 PostgreSQL 重投/并发、钉钉权限与送达、生产状态同步仍待联调。
