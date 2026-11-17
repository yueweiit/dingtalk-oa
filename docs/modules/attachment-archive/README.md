# 附件与物流归档

[返回知识库](../../knowledge/README.md) · [状态与恢复流程](workflow.md) · [既有物流契约](../../logistics-settlement-archive.md)

**验证状态：已验证（静态代码及迁移）。** 使用方为成本系统取证和运维；本服务保存附件，不执行成本核销。

## 归档范围与身份

国际物流使用 purpose=international_logistics 且 archive_attachments=true 的允许范围；财务来源使用有效性和运输证据判断。后续财务迁移已扩展早期“采购类别必须匹配”的规则，不能只读最初物流迁移。国际物流分支与财务分支条件不同，不能把财务状态排除规则无条件推广到前者。

`costing_read.attachment_template_scope` 可以按 `corp_id + process_code` 单独启用附件收集。启用后，该模板下未删除的审批可收集表单和评论附件，包括普通运营支出和费用支出。收集器使用 `attachment_collection_instances`，涵盖这个开关和原有物流、财务资格。成本系统的 `attachment_archives_v1` 使用原有资格，v2 依照原有审批可读范围关联归档记录。金额采纳资格由财务来源规则判定。

附件可来自表单和评论，按企业+审批实例+file_id 唯一。源快照更新时同步活跃附件清单；源已删除、不再符合范围或描述不再包含该附件时退役，保留历史标记。评论后补附件通过已完成轮转发现。

依据：[模板归档范围迁移](../../../migrations/20261117000000_add_attachment_template_scope.cjs)、[原有财务资格](../../../migrations/20260910010000_financial_source_scope.cjs)、[清单同步](../../../src/db/queries/attachment-archive.ts)、[提取器](../../../src/archive/attachment-extractor.ts)。

下载策略可能使用主应用 token、专用 userId/unionId 和访问授权请求。未授权用户、权限不足、源文件不存在等不通过绕过权限解决。

工作流下载接口对评论来源的附件传 `withCommentAttatchment: true`，首次请求和授权后重试都使用该字段。字段拼写见 [钉钉 SDK](https://pkg.go.dev/github.com/alibabacloud-go/dingtalk@v1.7.46/workflow_1_0#GrantProcessInstanceForDownloadFileRequest)。

## 归档步骤与一致性

1. 实例写入调用清单同步；附件内容仍未下载。
2. CLI 批量模式清理不合格清单，扫描原有物流和财务范围，再从附件队列领取一批，包含新登记的模板附件。单独启用模板时用下述命令登记历史。文件下载由服务器定时执行归档 CLI。
3. 默认批量最多 10，间隔至少 1000ms；失败按退避重试，达到 5 次或识别为永久权限/文件错误进入 manual_required。
4. 领取使用 SKIP LOCKED、15 分钟超时、claim_generation，object_key 随版本/领取代次变化；成功/失败写回匹配 id、object_key、generation、未退役且 archiving。
5. 下载策略区分原件与预览件。原件存在 declared_size 时比对字节数，计算 SHA-256，上传 MinIO 后保存清单；HEAD 可恢复已存在对象。没有跨 PostgreSQL/MinIO 原子事务。
6. archived 只代表归档流程完成，须同时读 content_quality；preview 不得作为原件凭证。没有可领取目标也不能算原件已归档。

## 精确目标与恢复工具

[parseArchiveTarget](../../../src/archive/archive-target.ts) 支持 `--corp-id`、`--instance-id`、`--file-id` 三项组成的单附件模式。精确模式同步对应实例并领取指定文件，受资格、租约、退避和次数限制。模板模式使用 `--corp-id` 和 `--process-code`，可附带 `--enqueue-only`。未知、缺失、重复或混用的参数会使命令失败。

[prepare-archive-recovery](../../../src/cli/prepare-archive-recovery.ts) 维护试探样本和成功样本剩余附件队列；ARCHIVE_RECOVERY_CANARY_ONLY 会限制领取。它们会改队列并可能引发后续外部请求，非只读检查。

恢复脚本选择 `userNotExist` 记录。其他 `manual_required` 记录修复原因后，由运维按企业、审批实例和文件 ID 确认目标仍活跃且符合归档资格，将状态改为 `pending`，清零 `attempts`、清空 `claimed_at` 并更新 `updated_at`，然后运行修复版 CLI 的精确模式。用清单状态、`content_quality` 和实际下载结果验收。 [领取及恢复查询](../../../src/db/queries/attachment-archive.ts)

### 开启模板归档和回补历史

1. 发布时先应用模板归档范围迁移，再启动新版审批写入服务，并让定时任务使用新版归档 CLI。
2. 在 `public.ding_process_template` 按企业确认完整的流程码。用发布账号在 `costing_read.attachment_template_scope` 按企业和流程码配置 `enabled=true`。每个要启用的模板分别配置。

```sql
INSERT INTO costing_read.attachment_template_scope (corp_id, process_code, enabled)
VALUES ('CORP_ID', 'PROCESS_CODE', true)
ON CONFLICT (corp_id, process_code) DO UPDATE SET enabled = EXCLUDED.enabled;
```

3. 在服务目录运行一次历史登记，将已保存在本地的目标模板审批按实例主键分页扫描。命令报告扫描的审批数和识别到的附件引用数。重复运行会按企业、实例、文件 ID 对齐清单，可用于中断后重跑。钉钉已有附件而本地快照缺少引用的审批，应先刷新审批详情。

```bash
node dist/cli/archive-attachments.js \
  --corp-id='CORP_ID' --process-code='PROCESS_CODE' --enqueue-only
```

4. 让定时归档 CLI 消费队列，或者手工只处理这个模板的一批。每次最多 `ARCHIVE_BATCH_SIZE` 个文件。首次回补有大量记录时，先核对一张单返回的状态和原件质量，再由定时任务继续处理后续批次。

```bash
ARCHIVE_RECOVERY_CANARY_ONLY=false node dist/cli/archive-attachments.js \
  --corp-id='CORP_ID' --process-code='PROCESS_CODE'
```

5. 使用 `/api/v1/attachments` 按企业和模板核对附件 `fileId`、`archiveStatus` 和 `downloadPath`，再下载原件核对大小及 SHA-256。浏览清单时跟完游标分页。`retry` 依现有退避领取，`manual_required` 根据 `failure_code` 核对具体原因。

新审批保存或已完成轮转刷新后会同步清单。`enabled=false` 会停止显式收集，常规归档批次会退役失去收集资格的记录。

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

验证入口见 [归档测试](../../../src/archive/archive-job.test.ts)、[提取测试](../../../src/archive/attachment-extractor.test.ts)、[下载测试](../../../src/archive/dingtalk-download.test.ts)、[模板队列测试](../../../src/db/queries/attachment-archive.test.ts)及[隔离库契约测试](../../../src/db/financial-contract.integration.test.ts)。生产文件权限、对象完整性、原件比例、历史归档量和外部 CLI 定时调用须在部署后核对。
