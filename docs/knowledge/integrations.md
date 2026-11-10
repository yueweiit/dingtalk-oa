# 系统集成与数据责任

**验证状态：已验证（本仓库调用代码）；对端部署、授权、数据契约及实际响应待验证。**

| 对端 | 方向与责任 | 认证及代码依据 |
| --- | --- | --- |
| 钉钉审批 | Stream/Webhook 输入事件；本服务读取模板、审批详情、人员、部门和流程预测；审批本身由钉钉负责 | 应用 Token、Webhook 签名；[Stream](../../src/dingtalk/stream-listener.ts)、[API 客户端](../../src/dingtalk/api-client.ts) |
| 钉钉附件/存储 | 本服务获取下载地址，某些策略先申请附件访问授权，再下载字节 | 归档用户、unionId、应用 Token；[下载策略](../../src/archive/dingtalk-download.ts)、[归档 CLI](../../src/cli/archive-attachments.ts)；授权请求具有外部副作用 |
| 钉钉文档 | 本服务读取允许工作簿的工作表元数据和范围值，不修改单元格 | operatorId 使用 reader 的 unionId；[文档 API](../../src/dingtalk/document-client.ts) |
| 钉钉机器人 | 超时发任务审批人及可选配置群；空节点/预算仍发配置人员 | 独立机器人凭据，Token/发送均有 10 秒超时；[alert-robot](../../src/dingtalk/alert-robot.ts)、[预警契约](../modules/alerts/README.md) |
| Kafka | outbox → raw topic → consumer；失败尝试送 DLQ | 当前 KafkaJS 配置未见 SASL/TLS；[producer](../../src/kafka/producer.ts)、[consumer](../../src/kafka/consumer.ts)、[topics](../../src/kafka/topics.ts) |
| PostgreSQL | 源快照、投影、审计和任务持久化；成本系统读取视图并提交受限请求 | PG 连接配置、数据库角色；[数据库](database.md)、[认证](authentication.md) |
| MinIO | 写入附件和装箱 JSON，下游读取对象 | 专用访问凭据、两个桶配置；[MinIO](../../src/archive/minio-archive.ts)、[快照存储](../../src/packing/snapshot-store.ts) |
| 预算服务 | OA 将部门、月份、预算类型、申请金额发送到预算快照接口，预算服务返回预算/已用/预计和 alertLevel | GET query + x-budget-alert-key；[预算预警](../../src/jobs/budget-alert-monitor.ts) |
| 下游成本系统 | 读取审批、财务证据、附件和装箱快照；负责匹配、分类及金额采纳 | 数据库版本化契约；[物流契约](../logistics-settlement-archive.md)、[财务契约](../financial-source-discovery.md) |
| 其他业务系统 | HTTP 读取本地完整审批、附件清单及已归档文件；按更新时间分别同步 | 无需鉴权，企业必填及可选流程筛选；访问范围取决于网络入口；[审批读取 API](../modules/approval-read-api/README.md) |

没有发现本项目依赖另一个 OA 数据库同步审批；本项目就是从钉钉读取详情的上游归档服务。不要套用其他仓库的同步架构。

## 外部请求与故障策略

- 主 apiCall 默认额外重试 1 次，HTTP 401 清 Token 并允许重试，429/5xx 可重试；非重试业务错误直接失败。令牌桶初始容量 10、补充速率 30/s，限于本进程。
- listProcessTemplates、部分 legacy 和人员调用采用不同 fetch 路径，不能声称全部请求共享重试和限流。主 API、Token、文档、附件内容等多处未显式配置超时；预算查询单独为 10 秒。
- 文档 API 默认重试 1 次，只对其识别为可重试的 HTTP 错误重试；数据结构错误不重试。
- 财务历史 worker 遇 QpsLimitForApi 或 HTTP 429 记录失败并结束本轮，不继续领取其他窗口；其限速无法约束其他进程。
- 预算响应接口结构在本服务中有 TypeScript 类型及 success/data 检查，未见完整 Zod 数值验证。阈值等级由预算服务返回，本服务按 warning_90 / over_budget 决定发送。
- 机器人成功后再记录 sent，发送成功但记录失败时可能再次发送，不能称为端到端恰好一次投递。

## 跨系统一致性

PostgreSQL 与 Kafka、MinIO、钉钉通知之间没有分布式事务。采用 outbox、幂等键、附件代次检查和持久化恢复机制；不同模块保障不同，见 [可靠性](reliability.md)。数据库视图中的候选资格不代表支付已完成、成本已核销或文件一定是原件。
