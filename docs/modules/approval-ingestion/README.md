# 审批事件与归档

[返回知识库](../../knowledge/README.md) · [处理流程](workflow.md)

**验证状态：已验证（静态代码）。** 使用方是钉钉事件源、运维和下游分析，不存在本模块独立前端或审批办理页面。

## 功能与规则

1. Stream 接收实例/任务事件，Webhook 是另一接收入口。两者将统一消息写入 ding_event_outbox；事件 ID 优先使用源 ID，缺失时按企业、实例、事件类型及时间生成，fallback 还使用 messageId。
2. Kafka 消息 key 为企业:实例；consumer 订阅 approval.events.raw。单条处理最多尝试 3 次，成功后提交下一 offset；失败尝试发送 DLQ 后也提交。DLQ 投递失败和无自动重放的限制见 [可靠性](../../knowledge/reliability.md)。
3. 编排器保存企业并插入事件日志。相同企业+event_id 且已 success 才跳过；其他状态可重试。没有 event_id 的日志不能使用同等去重规则。
4. 事件带 processCode 时，未知模板自动补建；已知 enabled=false 模板被标记 skipped，不继续获取详情。禁用检查依赖消息含模板码。
5. 从钉钉读取完整详情，再将实例、任务、字段和附件清单按既有事务链保存；不是根据单条事件直接推导最终状态。
6. 任务只对返回列表逐条 upsert；当前流程未删除详情中不再出现的旧任务。缺 taskId 时使用数组序号后备 ID，统计和状态迁移需留意。
7. 任务状态及结果保留上游值。实例原始 JSON 和表单 JSON 留存；本地 updated_at 与下游可见性水位受迁移触发器影响。
8. 字段保存失败使用 SAVEPOINT 隔离，可能出现主归档成功但字段元数据缺项。事务内先用本地资料补齐空值，事务后异步更新发起人和所有去重审批人的快照，再补齐本实例；外部用户 API 不占用审批事务。
9. 空节点和预算监控只在事件编排旁路执行；直接 refreshApprovalInstance 不触发这些通知。预警失败不回滚审批。

同一任务重新进入时，[upsertTask](../../../src/db/queries/approval-task.ts) 仅在新快照明确为 `RUNNING`、未提供结束时间，且新开始时间不早于历史结束时间并晚于已存开始时间时，清空旧轮次的 `end_time`。若之前已写入较新的开始时间但保留了更早的结束时间，同一开始时间的后续刷新也会修正该异常。开始时间缺失、仍为旧轮次、非 RUNNING 或显式提供结束时间时，保留原 COALESCE 兼容规则；不因单次缺字段清空正常历史。规则在原子 upsert 内执行，继续复用调用方事务 client，不新增迁移或批量修复。该行为同时作用于事件归档、状态刷新和普通补录。

## 人员、部门和节点空值补全

[实例解析](../../../src/normalize/instance-normalizer.ts) 同时支持嵌套 originator 和顶层 originatorUserId / originatorId、originatorUserName、originatorDeptId / originatorDeptName；[任务解析](../../../src/normalize/task-normalizer.ts) 在 nodeName 为空或空白时使用 taskGroupName。已知 ID 支持可精确表达的整数，空白不会阻断后备字段；不改变任务时间解析口径。

[统一补全查询](../../../src/db/queries/approval-enrichment.ts) 按企业及有界实例集合处理空值，保留已有非空字段和原始 payload。回填与正常入库采用相同的空白字符范围，制表符、换行和全角空格等纯空白值可以补齐。姓名依次使用审批原始信息、采集区间覆盖审批时点的成功快照、最后成功资料，跳过失败和 `unknown` 资料。任务使用自身 start_time，实例使用 create_time。最新任务载荷没有当前审批人时，跳过依据遗留人员 ID 补齐姓名或部门。

部门归属来自审批已有部门 ID 或同一人员的原始审批信息。用户快照的采集区间仅用于选择姓名版本，缺少部门归属证据时保留空值。缺失的部门名可取原始审批中的名称，或使用已知 ID 对应的同企业部门字典标签。字典标签可能与历史名称不同，合成的 ROOT 名称不参与补全。

审批人 ID 被新详情替换时，[任务 upsert](../../../src/db/queries/approval-task.ts) 不沿用旧审批人的姓名和部门。部门 ID 改变时也不沿用旧部门名，发起人采用相同规则。补全写入在同一事务中按实例 ID 顺序锁定未删除的父实例，节点补齐前后都受该锁保护。先完成删除的实例及节点会被跳过。写入还会比较原有人员、字段、时间和 payload，跳过并发变更的记录。只有字段实际变化时才更新 updated_at，实例元数据变化继续经过现有来源水位触发器。

事务内补全使用独立保存点，查询失败仅回滚补全步骤并记录 APPROVAL_METADATA_ENRICHMENT_FAILED；审批实例、任务、表单及附件仍走原事务保存。[异步补取](../../../src/normalize/approval-user-sync.ts) 覆盖发起人及所有当前详情任务参与人，先完成用户请求，再通过新事务补本实例。用户请求按企业+用户合并，同进程最多 2 个并发、成功响应缓存 1 小时，队列上限 10000；getUser 复用 API 限流槽并设置 10 秒超时。请求失败保留成功资料，仍可用于姓名补全；旁路任务不保证停机重放，历史重跑入口见 [人员模块](../metadata-organization/README.md#审批元数据历史回填)。

事件、修复、状态刷新和普通补录均复用 persistApprovalInstance；归档成功不表示每个展示字段都可还原。字段确无证据时保留 NULL，尤其是历史审批人的部门。

## 代码映射

| 层次 | 路径 / 方法 |
| --- | --- |
| 入口 | [stream-listener](../../../src/dingtalk/stream-listener.ts)、[webhookRoutes](../../../src/webhook/index.ts) |
| 入参 | [streamEventSchema](../../../src/dingtalk/types.ts)，未声明的回调字段会被剔除 |
| 投递 | [enqueueApprovalEvent / flushOutbox](../../../src/kafka/event-outbox.ts)、[SQL 队列](../../../src/db/queries/event-outbox.ts) |
| 消费 | [initKafkaConsumer](../../../src/kafka/consumer.ts)、[topic 常量](../../../src/kafka/topics.ts) |
| 编排 | [processApprovalMessage / refreshApprovalInstance / persistApprovalInstance](../../../src/normalize/orchestrator.ts) |
| 数据转换 | [normalizeInstance / parseDingTalkTime](../../../src/normalize/instance-normalizer.ts)、[normalizeTasks](../../../src/normalize/task-normalizer.ts) |
| 入库 | [upsertInstance](../../../src/db/queries/approval-instance.ts)、[upsertTask](../../../src/db/queries/approval-task.ts)、[saveFormFields](../../../src/normalize/form-field-extractor.ts) |
| 审计 | [insertEvent / updateEventStatus](../../../src/db/queries/event-log.ts) |
| 旁路 | [用户快照](../../../src/normalize/user-snapshot.ts)、[预警模块](../alerts/README.md) |

## 接口与数据

HTTP 仅 POST /webhook/approval，响应/error 见 [API](../../knowledge/api-overview.md)。Stream 不属于 Fastify 路由。核心表是 ding_corp_config、ding_process_template、ding_event_outbox、ding_event_log、ding_approval_instance、ding_approval_task、ding_form_field，并联动 costing_read 附件/财务对象。

核心唯一键及状态统一维护在 [数据库](../../knowledge/database.md) 和 [数据字典](../../knowledge/data-dictionary.md)，不在此复制全部字段。

## 验证与限制

现有测试包括 [实例规范化](../../../src/normalize/instance-normalizer.test.ts)、[任务规范化](../../../src/normalize/task-normalizer.test.ts)、[Kafka 恢复](../../../src/kafka/consumer.test.ts)。本次未运行。ACK、Kafka 积压、源状态值与并发快照完整性待运行环境验证。事件条数不等于审批数量。
