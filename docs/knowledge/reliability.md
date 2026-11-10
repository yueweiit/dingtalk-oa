# 可靠性、差异与待验证事项

核实日期：2026-10-23。以下“已验证”均指静态代码事实，不代表缺陷已在线上发生。本次不修复业务代码。

## 已有可靠性机制

| 范围 | 已验证机制 | 不能推定的保证 |
| --- | --- | --- |
| 事件接入 | outbox 企业+事件 ID 去重、持久化后异步投递、失败退避、SKIP LOCKED 领取；[outbox 查询](../../src/db/queries/event-outbox.ts) | PostgreSQL 与 Kafka 无分布式事务，重复投递仍可能发生 |
| 审批归档 | 已成功事件跳过；实例/任务唯一键 upsert，清单同事务；[编排器](../../src/normalize/orchestrator.ts) | 事件状态不与实例同事务；字段保存点允许元数据局部失败；用户快照异步 |
| 财务历史 | 固定窗口、先保存页再逐 ID 确认、15 分钟租约、代次及租约有效期校验；[窗口查询](../../src/db/queries/financial-backfill.ts) | 不能证明未被发现的历史模板已覆盖 |
| 财务投影 | 本地 JSON 投影、关联证据回补、按排序 ID 加 advisory transaction lock；[投影迁移](../../migrations/20260910020000_financial_source_projection.cjs) | 没有在线查询计划或大数据量性能验证 |
| 附件 | 状态/次数、退避、15 分钟超时领取、代次+对象键写回条件、版本化对象、退役标记；[附件查询](../../src/db/queries/attachment-archive.ts) | archived 可能为 preview；DB 与对象存储不原子 |
| 已完成轮转 | 领取前推进持久时间、代次校验账本结果；[实例查询](../../src/db/queries/approval-instance.ts) | 账本代次校验不等于所有源快照写入都受代次约束 |
| 修复/装箱 | 请求键去重、SKIP LOCKED、重试上限与超时重领；[修复](../../src/db/queries/approval-repair.ts)、[装箱](../../src/db/queries/packing-workbook.ts) | 结果按 id 更新，未见财务窗口同级的代次校验 |
| 预警 | 唯一投递键、失败或 15 分钟 sending 可再领；超时按目标成功发送满 24 小时可重投，预算/空节点 sent 不再领取；[投递](../../src/db/queries/alert-notification.ts)、[预警](../modules/alerts/README.md) | 外部发送成功与本地 sent 不原子，不保证恰好一次；完成后停止依赖本地状态同步 |

## 已验证问题与影响

| 编号 | 事实与依据 | 影响及后续处理方向 |
| --- | --- | --- |
| R1 | [消费者](../../src/kafka/consumer.ts) 发送 DLQ 失败后仍提交 offset；无自动 DLQ 重放 worker | 失败事件可能不再从当前 offset 重试；需独立设计投递确认与重放，当前不能保证零丢失 |
| R2 | [Stream](../../src/dingtalk/stream-listener.ts) fallback 使用 void enqueue 并立即返回 SUCCESS；专用回调捕获持久化异常未向外传播 | ACK 与 outbox 成功并非所有分支绑定；SDK 重投行为待联调 |
| R3 | [生产者](../../src/kafka/producer.ts) 首次连接失败后置 null，无应用级重建循环；无 brokers 时仍无法投递；[就绪](../../src/app.ts) 把未配置 consumer 视为健康 | 进程启动或 ready 不代表事件流通；需要核对 outbox 积压和生产者状态 |
| R4 | [签名](../../src/dingtalk/signature.ts) 未使用 body、无时效检查，长度不等时抛错；[路由](../../src/webhook/index.ts) 未解密消息 | 请求完整性、防重放及上游协议兼容待独立验证/修复 |
| R5 | [连接器](../../src/connector/index.ts) 和 [审批读取 API](../../src/approval-api/index.ts) 无应用鉴权；[app](../../src/app.ts) 无全局鉴权且 CORS 宽松 | 数据暴露取决于外部网络保护，部署访问控制待验证 |
| R6 | [普通补录](../../src/jobs/backfill.ts) 单实例失败仅日志后继续，最终窗口可 completed；分页 token 不持久化，未按本地已存在跳过 getInstance | 普通 completed 不是完整覆盖证据；恢复应重跑窗口或采用专用财务队列 |
| R7 | [事件 Schema](../../src/dingtalk/types.ts) 未 passthrough，也未声明 UserId/TaskId/StaffId | 专用回调及 Webhook 会丢弃额外字段；完整任务统计依靠详情，不依靠事件原始记录 |
| R8 | [normalizeInstance](../../src/normalize/instance-normalizer.ts) 本地时间作为 last_event_time；[upsert](../../src/db/queries/approval-instance.ts) 无按源版本拒绝旧详情的条件 | 并发刷新可能存在快照先后覆盖问题；生产发生情况待验证，不应称严格有序 |
| R9 | [修复](../../src/db/queries/approval-repair.ts) 与 [装箱](../../src/db/queries/packing-workbook.ts) 结果按 id 写回；装箱最后一次领取后崩溃没有修复队列那样的终态清理 | 超时重领有旧 worker 写回风险；装箱 attempts=3 的 running 可能滞留，需要单独恢复设计 |
| R10 | [装箱缓存](../../src/packing/refresh-worker.ts) unionId Promise 失败后未重置；[快照](../../src/packing/snapshot-store.ts) hash 包含采集时间 | 身份查询失败可能持续影响进程；相同单元格的不同采集不一定去重，容量需按实际采集频率评估 |
| R11 | 多处 fetch 未设置超时；全局扫描 [listWhitelistedInstances](../../src/db/queries/attachment-archive.ts) 无分页，归档 CLI 全量同步清单后仅领取小批；[下载](../../src/cli/archive-attachments.ts) 整体载入 Buffer | 大量记录/大附件可能增加延迟和内存；需业务规模和性能证据后再优化 |
| R12 | 手工白名单只有流程码、单组钉钉凭据、装箱请求按工作簿选择企业；[认证](authentication.md) 有详细依据 | 多企业数据维度不等于完整租户授权，不能直接扩展成通用多租户服务 |
| R13 | [parseDingTalkTime](../../src/normalize/instance-normalizer.ts) 改写 Z 后缀；无时区字符串按 Date 默认解释 | 时间口径依赖上游样本与运行时；历史修正、超时、报表需联合回归 |
| R14 | [财务 SQL](../../migrations/20260910010000_financial_source_scope.cjs) 依赖名称/关键词；[预算](../../src/jobs/budget-alert-monitor.ts) 使用 number 和对端等级；无统一币种或翻译资源 | 分类与数值边界需样本；不能把识别关键词视为完整多语言或金额准确性保障 |
| R15 | [迁移](../../migrations/) 数字前缀格式混用且存在依赖；集成测试按指定顺序运行；财务 down 拒绝执行 | 空库自动安装、生产升级和回滚方案尚未验证；勿直接按 README 执行迁移 |
| R16 | 2026-11-10 已补 [事务及同用户锁](../../src/db/queries/user-snapshot.ts)、独立失败历史、手工同步复用和 [唯一约束迁移](../../migrations/20261110000000_separate_user_fetch_failures.cjs) | 代码与离线检查通过；迁移未执行、真实 PostgreSQL 集成用例未运行，不能推定线上重复 current 已修复；见 [人员迁移边界](../modules/metadata-organization/README.md#用户快照与失败记录) |

## 旧文档与当前实现差异

保留已有文档原文，通过此表统一澄清，避免未经核实重写历史记录。

| 旧说明 | 当前代码事实 |
| --- | --- |
| README 主链路描述本地缓冲和直接处理 | 当前入口使用持久 outbox；event-buffer 未接入；未配置 Kafka 无直写降级 |
| README “所有唯一键带 corp_id” | 旧白名单、请求键和部分技术主键不符合此概括，见数据库文档 |
| README 普通回填重启跳过已有数据 | 实现逐条获取详情；依赖 upsert，而非按实例存在跳过 |
| README 模板同步依赖任意已知用户 | 定时模板同步使用显式 DINGTALK_TEMPLATE_ADMIN_USER_ID；手工脚本另有逻辑，应分别阅读 |
| 物流专项最初采购分类范围 | 后续财务范围和投影迁移扩展了来源/附件资格，不能只应用最初规则 |
| 既有专项文档记录曾测试或未上线 | 属于历史记录；本次没有重跑测试，也未核实当前部署状态 |

## 待验证范围

生产数据库迁移/角色、Kafka 可达性与积压、Stream ACK 重投、Webhook 实际协议、MinIO 权限及原件比例、钉钉用户权限、预算对端阈值/币种、历史模板名单及历史覆盖、任务状态真实值、外部附件调度、下游增量和企业授权均未现场验证。

8 个模块均完成主要代码与流程覆盖；没有逐一审计所有 SQL 分支、下载 API 响应、历史迁移在生产的结果或下游仓库实现。以上是本次覆盖边界，不作为已完成业务验收的依据。

## 本次初始化验证

- 基线：master 分支，初始工作区干净，记录 147 个原有受 Git 跟踪文件的 SHA-256。
- 执行：静态读取源代码、迁移、配置声明及现有文档；创建知识库与项目规则。
- 最终检查项目：新增文档本地链接/代码路径、Markdown 表格与代码围栏、Mermaid 基础结构、HTTP 路由与配置名称、原有文件哈希和 Git 修改范围。
- 未执行：业务测试、构建、类型检查、Mermaid 完整渲染、数据库迁移、数据库查询、服务启动、外部调用、部署、Git 提交或推送。
- 静态检查结果：25 个新增 Markdown 文件，399 个本地链接（包含代码路径和章节锚点）、31 个表格结构已检查；6 个 Mermaid 图仅检查基础结构和关系语句，未完整解析或渲染。5 条 HTTP 路由与 61 个配置名称按源码核对，静态检查无未解决错误。
- 原有 147 个受跟踪文件 SHA-256 全部一致；初始已有文档保留。最终 Git 修改范围仅为根 AGENTS.md、docs/knowledge 和 docs/modules 的新增文件。静态检查不得解释为运行或集成测试通过。
