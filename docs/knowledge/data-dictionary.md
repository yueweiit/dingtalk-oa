# 核心数据字典

**验证状态：已验证（字段类型与代码使用）；生产值域和业务统计完整性待验证。**

## 核心字段与口径

| 模型 / 字段 | 类型 | 含义及约束 |
| --- | --- | --- |
| 基础表 corp_id | VARCHAR(64) | 企业维度，不是已实现的登录租户权限 |
| 模板 process_code / 实例 process_instance_id / 任务 task_id | VARCHAR(128) | 稳定源标识；任务缺少 ID 时规范化器按实例和数组下标生成后备值，不能保证上游重排后仍指同一任务 |
| 实例 raw_payload / form_component_values | JSONB | 完整详情及原始表单；业务编号 businessId 从 JSON 提取到只读视图，并非基础独立列 |
| 实例 status / result | VARCHAR(32) | 保留上游字符串，基础表无封闭枚举；不要擅自统一大小写或翻译落库值 |
| 实例 create_time / finish_time | TIMESTAMPTZ | 发起及结束时间 |
| 实例 last_event_time | TIMESTAMPTZ | 规范化时的本地刷新时间，并非严格的上游事件时间 |
| 实例 updated_at | TIMESTAMPTZ | 查询层写 now；物流迁移触发器让源内容不变时保留旧值，不能脱离迁移解释 |
| 视图 approval_instances_v2.updated_at | TIMESTAMPTZ | 可包含范围注册与首次暴露时间；用于逻辑可见性增量 |
| 任务 approver_user_id / end_time | VARCHAR(128) / TIMESTAMPTZ | 任务处理人及任务结束时间；人员列可能因 COALESCE 保留历史值，提醒优先按当前原始任务快照取人；同一任务有新轮次时间证据时可清空旧结束时间，见 [归档规则](../modules/approval-ingestion/README.md#功能与规则) |
| 用户 snapshot_hash / valid_from / valid_to / is_current | VARCHAR(64) / TIMESTAMPTZ / BOOLEAN | 姓名、部门、职位、头像的 SHA-256 成功资料版本摘要及有效期间；current 表示最后成功资料，不是用户在职状态；企业+用户仅一条 current，失败不替换资料；union_id 可独立补齐 |
| 实例/任务人员姓名、部门与节点名称 | VARCHAR（原有列） | 保留已有非空值。姓名可用成功资料补全，部门归属来自审批记录，部门名可为已知 ID 的字典标签。无证据仍可为 NULL，见 [补全规则](../modules/approval-ingestion/README.md#人员部门和节点空值补全) |
| 用户失败 fetch_status / fetch_error / failure_count / first_failed_at / last_failed_at | VARCHAR / TEXT / BIGINT / TIMESTAMPTZ | ding_user_fetch_failure 独立保存错误历史；最近相同错误合并次数、不同错误新增行，不表示错误当前仍存在；旧失败行通过 source_snapshot_id 追溯，详见 [人员规则](../modules/metadata-organization/README.md#用户快照与失败记录) |
| 用户失败 source_snapshot_id / source_snapshot_payload | BIGINT / JSONB（可空） | 旧失败快照的历史来源 ID 及清理前完整原行；清理后 ID 不再对应快照表实体，JSON 保留原始资料及版本时间供人工追溯。新发生的失败不生成源快照，两个字段为空；见 [清理契约](../modules/metadata-organization/README.md#旧失败快照的独立清理) |
| 离职 source_process_instance_id / departed_on / user_id / identity_method | VARCHAR(128) / DATE / VARCHAR(128) / TEXT | 企业内关联来源审批；离职日期取自同一份已通过的原始详情，按当地日历日生效；员工 ID 与确认方式同时为空或有值，确认方式为 `originator` 或 `manual`；见 [离职记录](../modules/metadata-organization/README.md#审批离职记录) |
| 离职 candidate_user_id / identity_review_required | VARCHAR(128) / BOOLEAN | 墨西哥姓名匹配结果仅作候选，员工 ID 保持空；人工确认出现人员冲突时保留原确认和历史姓名，并标记待复核，期间暂停离职生效 |
| 字段 field_id / field_name / field_type | VARCHAR(128/256/64) | 稳定组件 ID 与展示名、组件类型；源表单名称可能多语言但不是翻译资源 |
| 附件 file_id / attachment_origin / sha256 | VARCHAR(256) / VARCHAR(16) / CHAR(64) | 同一企业和实例内按 file_id 去重；attachment_origin 为 form 或 comment |
| 附件 declared_size / actual_size | BIGINT | 源声明与下载字节数；原件下载时有大小比对 |
| 附件 revision_generation / claim_generation | BIGINT | 归档版本及领取代次；结合 object_key 阻止旧任务覆盖当前结果 |
| 附件 retired_at / 实例 deleted_at | TIMESTAMPTZ | 两种删除/退役标记，v2 下游需独立处理 |
| 财务 transport_evidence | TEXT[] | logistics_category、main_freight、transport_surcharge、logistics_reference |
| 财务 source_valid / eligible_for_adoption | BOOLEAN | 有效来源与采纳候选资格；后者还要求完成状态、运输证据及排除项判断 |
| 财务 evidence_updated_at | TIMESTAMPTZ | 汇合来源、附件、投影变化；与审批水位不同 |
| 财务 pending_ids / next_token / page_loaded | JSONB / JSONB / BOOLEAN | 持久分页进度；成功写入一个详情后才移除队首 ID |
| 装箱 content_sha256 / capture_consistency | CHAR(64) / VARCHAR | 完整快照 JSON 摘要；single_range 或 multi_range，不保证跨块同一时点 |
| 预警 alert_type / alert_phase / recipient_user_id | VARCHAR | 按实例、类型、阶段、接收人去重；超时为 daily:hash(taskId, startedAt)，个人用任务审批人 ID，群用 group:sha256(openConversationId)，同一投递记录成功满 24 小时可重投；预算阶段包含等级、部门和月份，详见 [预警](../modules/alerts/README.md) |
| 超时预警 payload.batchId | JSONB 中的字符串 | 最近一次汇总投递尝试的标识。同一条消息包含的各任务记录共享该值，任务仍独立记状态及最近成功时间 |

依据：[基础模型](../../src/db/types.ts)、[规范化](../../src/normalize/instance-normalizer.ts)、[任务规范化](../../src/normalize/task-normalizer.ts)、[用户摘要](../../src/normalize/user-snapshot.ts)、[物流迁移](../../migrations/20260909000000_logistics_settlement_archive.cjs)、[财务范围](../../migrations/20260910010000_financial_source_scope.cjs)、[财务投影](../../migrations/20260910020000_financial_source_projection.cjs)、[装箱迁移](../../migrations/20260907000000_create_packing_sheet_cache.cjs)、[预警迁移](../../migrations/20260915000000_create_ding_alert_notification.cjs)。

## 状态编码

| 对象 | 当前代码使用的状态 | 依据 |
| --- | --- | --- |
| 事件日志 | pending、processing、success、failed、skipped | [编排器](../../src/normalize/orchestrator.ts) |
| outbox | pending → publishing → published；失败回 pending | [查询](../../src/db/queries/event-outbox.ts) |
| 普通补录 | running、completed、failed | [补录](../../src/jobs/backfill.ts) |
| 财务窗口 | pending、running、completed、failed；视图额外展示 not_scheduled | [窗口](../../src/db/queries/financial-backfill.ts)、[财务迁移](../../migrations/20260910010000_financial_source_scope.cjs) |
| 财务名称发现 | pending、resolved、failed | [发现查询](../../src/db/queries/financial-template-discovery.ts) |
| 审批修复 | pending、running、retry、success、manual_required | [修复查询](../../src/db/queries/approval-repair.ts) |
| 附件 | pending、archiving、archived、retry、manual_required；退役另看 retired_at | [附件查询](../../src/db/queries/attachment-archive.ts) |
| 附件质量 | original、preview；不可仅凭 archived 判定原件 | [下载类型](../../src/archive/download-strategies.ts) |
| 装箱请求 / 快照 | pending、running、success、failed / ready、failed | [装箱迁移](../../migrations/20260907000000_create_packing_sheet_cache.cjs) |
| 预警投递 | sending、sent、failed | [投递查询](../../src/db/queries/alert-notification.ts) |

审批来源状态不受上述内部队列枚举约束。核对/预警常用 UPPER(status)='RUNNING'；已完成轮转选择 COMPLETED；财务采纳候选接受 COMPLETED、FINISHED、APPROVED。三个判断不是同义条件。财务有效性排除撤销、取消、驳回、删除等状态或拒绝结果，详见实际 SQL 函数。

## 时间、数量与语言

`parseDingTalkTime` 对以 Z 结尾的源字符串替换成 +08:00，数值按毫秒时间戳解释，无显式时区的字符串仍交给 Date 解析。这个兼容规则不是通用 ISO 时间规范；样本和部署时区待验证，变更需检查历史修正迁移及相关测试。

个人审批量可区分任务行数和 DISTINCT process_instance_id；企业、用户、任务 end_time 以及实际状态值都需核实。COMPLETED 与 AGREE/REFUSE 可作为候选筛选，不足以证明本人手动审批，还须核对代理、自动结束和同步缺口。Kafka 消息数、事件日志数不能作为审批数量。

财务 coverage 视图的流程总量会在每个窗口重复展示，不能跨窗口求和。金额、标签和多语言扩展见 [国际化](internationalization.md)，数据所有权见 [系统集成](integrations.md)。
