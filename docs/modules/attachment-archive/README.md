# 附件与物流归档

[返回知识库](../../knowledge/README.md) · [状态与恢复流程](workflow.md) · [既有物流契约](../../logistics-settlement-archive.md)

**验证状态：已验证（静态代码及迁移）。** 使用方为成本系统取证和运维；本服务保存附件，不执行成本核销。

## 归档范围与身份

国际物流使用 purpose=international_logistics 且 archive_attachments=true 的允许范围；财务来源使用有效性和运输证据判断。后续财务迁移已扩展早期“采购类别必须匹配”的规则，不能只读最初物流迁移。国际物流分支与财务分支条件不同，不能把财务状态排除规则无条件推广到前者。

附件可来自表单和评论，按企业+审批实例+file_id 唯一。源快照更新时同步活跃附件清单；源已删除、不再符合范围或描述不再包含该附件时退役，保留历史标记。评论后补附件通过已完成轮转发现。

依据：[eligible_attachment_instances 定义](../../../migrations/20260910010000_financial_source_scope.cjs)、[synchronizeInstanceAttachments](../../../src/db/queries/attachment-archive.ts)、[提取器](../../../src/archive/attachment-extractor.ts)。

下载策略可能使用主应用 token、专用 userId/unionId 和访问授权请求。未授权用户、权限不足、源文件不存在等不通过绕过权限解决。

## 归档步骤与一致性

1. 实例写入调用清单同步；附件内容仍未下载。
2. CLI 批量模式清理不合格清单，读取符合范围实例并同步其清单，然后领取一批附件；不是一次处理所有文件。
3. 默认批量最多 10，间隔至少 1000ms；失败按退避重试，达到 5 次或识别为永久权限/文件错误进入 manual_required。
4. 领取使用 SKIP LOCKED、15 分钟超时、claim_generation，object_key 随版本/领取代次变化；成功/失败写回匹配 id、object_key、generation、未退役且 archiving。
5. 下载策略区分原件与预览件。原件存在 declared_size 时比对字节数，计算 SHA-256，上传 MinIO 后保存清单；HEAD 可恢复已存在对象。没有跨 PostgreSQL/MinIO 原子事务。
6. archived 只代表归档流程完成，须同时读 content_quality；preview 不得作为原件凭证。没有可领取目标也不能算原件已归档。

## 精确目标与恢复工具

[parseArchiveTarget](../../../src/archive/archive-target.ts) 要求 --corp-id、--instance-id、--file-id 三个参数同时完整且各一次，未知/缺失/重复参数直接失败，避免误落入全局扫描。精确模式只同步对应实例并领取对应文件，跳过全局退役与扫描，仍受资格、租约、退避和次数限制。

[prepare-archive-recovery](../../../src/cli/prepare-archive-recovery.ts) 维护试探样本和成功样本剩余附件队列；ARCHIVE_RECOVERY_CANARY_ONLY 会限制领取。它们会改队列并可能引发后续外部请求，非只读检查。

## 下游契约和代码映射

| 功能 | 代码 |
| --- | --- |
| 表单/评论附件与对象路径 | [attachment-extractor](../../../src/archive/attachment-extractor.ts) |
| 清单差异、领取及写回 | [attachment-archive 查询](../../../src/db/queries/attachment-archive.ts) |
| 原件/预览策略与诊断 | [dingtalk-download](../../../src/archive/dingtalk-download.ts)、[download-strategies](../../../src/archive/download-strategies.ts) |
| 下载、大小检查、摘要与存储 | [archiveAttachment](../../../src/archive/archive-job.ts)、[MinIO](../../../src/archive/minio-archive.ts) |
| 批次运行、下载 Buffer、健康 | [archive-attachments CLI](../../../src/cli/archive-attachments.ts) |
| 版本及清单触发器 | [物流迁移](../../../migrations/20260909000000_logistics_settlement_archive.cjs) |
| 诊断列和质量 | [diagnostics 迁移](../../../migrations/1788505200000_add_archive_diagnostics.cjs) |

读契约为 attachment_archives_v1/v2；v2 保留 retired_at，审批/附件分别维护水位，重叠重放并按稳定业务键去重。下载地址与签名不应写入长期文档；下游读取桶和对象键。

已有 [归档测试](../../../src/archive/archive-job.test.ts)、[提取测试](../../../src/archive/attachment-extractor.test.ts)、[下载测试](../../../src/archive/dingtalk-download.test.ts)、[隔离库契约测试](../../../src/db/settlement-contract.integration.test.ts)，本次未运行。真实文件权限、对象完整性、原件比例、历史归档量和外部 CLI 定时调用待验证。
