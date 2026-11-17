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

### 固定归档下载用户

在运行归档 CLI 的环境中设置专用下载用户，推荐只填写员工 UserID，让程序自动查询该用户的 unionId：

```dotenv
DINGTALK_ARCHIVE_DOWNLOAD_USER_ID=replace_with_authorized_user_id
# 推荐省略此项；新版配置校验也允许空白值，含义为自动查询。
# DINGTALK_ARCHIVE_DOWNLOAD_UNION_ID=
```

员工 UserID 可在钉钉管理后台“通讯录 > 成员管理”的成员信息中获取。选择属于当前应用企业、长期有效且在应用可使用范围内的账号，并验证它能下载目标审批的附件。管理员身份本身不能代替具体文件授权；应用接口权限和用户对文件的权限都需要满足。人员获取与授权条件可参考[官方接入说明](https://help.aliyun.com/zh/polardb/polardb-for-mysql/sync-dingtalk-documents-to-the-knowledge-base)。

- `DINGTALK_ARCHIVE_DOWNLOAD_USER_ID` 用于审批附件授权；Storage、Drive 和存储缩略图策略使用该用户对应的 unionId。未显式配置 unionId 时，通过用户详情接口解析，应用需具备查询该成员的权限。
- 两项配置缺省或空白均视为未配置。有值时去除首尾空白并保留字符串格式。已有固定 unionId 配置继续优先使用，程序不会自动核对它与 UserID 是否对应；更换用户时应同时移除旧的固定 unionId，或改为新用户的值。
- 标准审批下载接口仍只传审批实例、文件 ID 和评论标志，不接收该下载用户参数。专用账号可稳定备用下载身份，但不能保证解决源用户失效、文件删除或文件权限不足等所有历史失败。
- `.env` 从命令当前目录加载，已有进程环境变量优先，配置在进程内缓存。编辑服务器 `.env` 的已有配置行，确保定时任务、进程管理器没有覆盖旧值；下一次从项目目录启动 CLI 会读取新配置，常驻归档进程需重新启动。旧版本若尚未支持空白值，请注释或删除 UnionId 配置行。
- 账号调整后先对一条已确认目标重试，按 `archive_status=archived`、`content_quality=original` 和实际下载结果验收。配置不会自动重置 `manual_required`，历史失败仍按下述精确目标恢复流程处理。

依据：[配置示例](../../../.env.example)、[配置校验](../../../src/config/schema.ts)、[加载入口](../../../src/config/index.ts)、[共用下载实现](../../../src/archive/archive-runtime.ts)、[下载身份解析](../../../src/archive/dingtalk-download.ts)、[用户详情查询](../../../src/dingtalk/api-client.ts)。

## 提交和评论附件自动归档

主服务可运行[附件后台任务](../../../src/jobs/attachment-archive-worker.ts)，复用现有持久队列、下载策略、MinIO 和校验规则。文件原件保存在 MinIO，数据库保存关联、对象位置、大小、摘要及状态；ERP 下载已归档文件时不再请求钉钉。

部署新版前先执行 [队列优先级迁移](../../../migrations/20261117010000_add_attachment_queue_priority.cjs)，它依赖此前附件归档迁移。新增 `queue_priority` 和部分索引，历史记录默认为 0，不重置归档状态，也不修改 v1/v2 或 HTTP 字段。随后配置已有 MinIO 账号、下载用户和 `corpId + processCode` 收集范围，并设置：

```dotenv
ARCHIVE_WORKER_ENABLED=true
ARCHIVE_WORKER_POLL_MS=5000
ARCHIVE_DOWNLOAD_TIMEOUT_MS=60000
ARCHIVE_STORAGE_TIMEOUT_MS=60000
COMPLETED_APPROVAL_REFRESH_CRON=*/5 * * * *
COMPLETED_APPROVAL_REFRESH_BATCH_SIZE=20
COMPLETED_APPROVAL_REFRESH_DELAY_MS=1000
COMPLETED_APPROVAL_REFRESH_MIN_INTERVAL_SECONDS=1800
```

重启主服务后生效。后台开关默认 false，便于先迁移再启用；开启时即使 `COMPLETED_APPROVAL_REFRESH_ENABLED=false`，也会启用已完成审批复查。已有环境变量优先于新默认值，旧服务器需同步检查复查周期和批量。

- 审批事件、审批中核对及已完成复查均通过统一详情保存入口更新清单。实时发现或变化的附件设优先级 1，事务提交后只发送进程内唤醒信号，网络下载在事务外异步执行；事务回滚不唤醒。跨进程写入、重启或丢失唤醒依靠持久队列轮询恢复。
- 普通补录、财务补录和模板历史登记的附件按优先级 0 入队。完全相同的清单重放不改变优先级或重置失败状态。后台每第 5 次领取按就绪队列最早时间处理，其余优先实时附件，避免持续新增导致历史记录一直等待。
- 后台逐个领取、串行下载，沿用 `ARCHIVE_BATCH_SIZE`、`ARCHIVE_DELAY_MS`、`ARCHIVE_RECOVERY_CANARY_ONLY`、锁和租约。领取时重新检查收集资格。停止时不再领取新文件，等待当前文件处理完成；进程被强制终止时由租约超时恢复。
- 后台启动时检查失去收集资格的活跃清单，之后每隔至少 60 秒在下一轮批次前继续检查，每轮最多处理 100 张审批。清理复用源实例行锁并重新确认资格，更新 `retired_at` 和 `updated_at`，保留已归档证据；无需额外运行 CLI。仍符合其他收集分支的附件保留。积压或当前文件耗时会延长全部清理时间。
- 评论附件只有在最新详情中可见后才能登记；收到相关审批事件即刷新，同时保留 RUNNING 核对和 COMPLETED 轮转兜底。已完成范围包含显式开启的模板，默认每 5 分钟最多 20 张、同一单至少间隔 30 分钟。范围较大时完整轮转更久，这些参数不是每张单的发现时限，不能承诺所有评论上传即刻可见。
- 自动任务仅接受原件，不以缩略图替代成功；既有 CLI 仍可按原规则保存明确标注的 preview。已有 preview 和 manual_required 不会自动改成原件或重置，需按恢复流程单独处理。
- 文件下载包含正文读取的总超时默认 60 秒；审批/Storage/Drive 下载地址和授权请求有单次 10 秒超时。MinIO 单次 HEAD 或上传另受 `ARCHIVE_STORAGE_TIMEOUT_MS` 控制，默认 60 秒、可配置 1–300 秒，覆盖桶区域查询、响应正文和该操作内的分片请求；超时实际取消底层请求，错误码为 `attachment_storage_timeout`。此限制用于附件后台与 CLI，不改变装箱快照的共享客户端。
- 单文件失败保留状态和策略诊断，按既有规则重试或转人工，继续下一条。每次轮询（含空队列）更新既有健康记录；清理、领取和失败状态写回异常都使批次失败，不因前面已有成功文件而更新成功时间。健康错误仅保存稳定错误码，空轮询不输出批次日志。多进程与 CLI 可借助行锁避免重复领取，但各进程独立限速，常态建议仅保留一个自动下载进程。

这项能力减少延迟下载带来的历史权限问题；首次下载仍需要钉钉接口及文件权限。生产验收需用新审批表单附件、审批结束后补传的评论附件各验证一次，核对原件状态、实际大小与 SHA-256。部署后如需历史回补，仍按下节先登记历史引用；后台不会每轮全表扫描历史审批。

## 归档步骤与一致性

1. 实例写入调用清单同步；附件内容由事务外的后台任务或 CLI 下载。
2. 后台直接消费已持久化的清单，并周期性分批退役失去资格的记录。CLI 批量模式仍清理不合格清单、扫描原有物流和财务范围，再领取一批；单独启用模板时用下述命令登记历史。
3. 默认批量最多 10，间隔至少 1000ms；失败按退避重试，达到 5 次或识别为永久权限/文件错误进入 manual_required。
4. 领取使用 SKIP LOCKED、15 分钟超时、claim_generation，object_key 随版本/领取代次变化；成功/失败写回匹配 id、object_key、generation、未退役且 archiving。
5. 下载策略区分原件与预览件。原件存在 declared_size 时比对字节数，计算 SHA-256，上传 MinIO 后保存清单；HEAD 可恢复已存在对象。没有跨 PostgreSQL/MinIO 原子事务。
6. archived 只代表归档流程完成，须同时读 content_quality；preview 不得作为原件凭证。没有可领取目标也不能算原件已归档。

## 精确目标与恢复工具

[parseArchiveTarget](../../../src/archive/archive-target.ts) 支持 `--corp-id`、`--instance-id`、`--file-id` 三项组成的单附件模式。精确模式同步对应实例并领取指定文件，受资格、租约、退避和次数限制。模板模式使用 `--corp-id` 和 `--process-code`，可附带 `--enqueue-only`。未知、缺失、重复或混用的参数会使命令失败。

[prepare-archive-recovery](../../../src/cli/prepare-archive-recovery.ts) 维护试探样本和成功样本剩余附件队列；ARCHIVE_RECOVERY_CANARY_ONLY 会限制领取。它们会改队列并可能引发后续外部请求，非只读检查。

恢复脚本选择 `userNotExist` 记录。其他 `manual_required` 记录修复原因后，由运维按企业、审批实例和文件 ID 确认目标仍活跃且符合归档资格，将状态改为 `pending`，清零 `attempts`、清空 `claimed_at` 并更新 `updated_at`，然后运行修复版 CLI 的精确模式。用清单状态、`content_quality` 和实际下载结果验收。 [领取及恢复查询](../../../src/db/queries/attachment-archive.ts)

### 开启模板归档和回补历史

1. 发布时先应用模板归档范围和队列优先级迁移，再启动新版审批写入服务。自动下载配置见上节；已有外部定时任务须使用新版 CLI。
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

4. 开启后台任务消费队列，或者手工只处理这个模板的一批。每次最多 `ARCHIVE_BATCH_SIZE` 个文件。首次回补有大量记录时，先核对一张单返回的状态和原件质量，再继续处理后续批次。

```bash
ARCHIVE_RECOVERY_CANARY_ONLY=false node dist/cli/archive-attachments.js \
  --corp-id='CORP_ID' --process-code='PROCESS_CODE'
```

5. 使用 `/api/v1/attachments` 按企业和模板核对附件 `fileId`、`archiveStatus` 和 `downloadPath`，再下载原件核对大小及 SHA-256。浏览清单时跟完游标分页。`retry` 依现有退避领取，`manual_required` 根据 `failure_code` 核对具体原因。

新审批保存或已完成轮转刷新后会同步清单。`enabled=false` 会停止显式收集；后台周期清理或常规 CLI 归档批次会退役失去全部收集资格的记录。退役会推进附件增量水位，HTTP 清单返回 `retiredAt`，内容接口按原规则拒绝下载。

## 下游契约和代码映射

| 功能 | 代码 |
| --- | --- |
| 表单/评论附件与对象路径 | [attachment-extractor](../../../src/archive/attachment-extractor.ts) |
| 清单差异、领取及写回 | [attachment-archive 查询](../../../src/db/queries/attachment-archive.ts) |
| 原件/预览策略与诊断 | [dingtalk-download](../../../src/archive/dingtalk-download.ts)、[download-strategies](../../../src/archive/download-strategies.ts) |
| 下载、大小检查、摘要与存储 | [archiveAttachment](../../../src/archive/archive-job.ts)、[MinIO](../../../src/archive/minio-archive.ts) |
| 批次运行、下载 Buffer、健康 | [archive-attachments CLI](../../../src/cli/archive-attachments.ts) |
| 自动领取、唤醒和公平调度 | [后台任务](../../../src/jobs/attachment-archive-worker.ts)、[提交后唤醒](../../../src/archive/queue-signal.ts)、[共用下载](../../../src/archive/archive-runtime.ts) |
| 版本及清单触发器 | [物流迁移](../../../migrations/20260909000000_logistics_settlement_archive.cjs) |
| 诊断列和质量 | [diagnostics 迁移](../../../migrations/1788505200000_add_archive_diagnostics.cjs) |

读契约为 attachment_archives_v1/v2；v2 保留 retired_at，审批/附件分别维护水位，重叠重放并按稳定业务键去重。下载地址与签名不应写入长期文档；下游读取桶和对象键。

验证入口见 [后台任务测试](../../../src/jobs/attachment-archive-worker.test.ts)、[MinIO 超时与连接取消测试](../../../src/archive/minio-archive.test.ts)、[正文超时测试](../../../src/archive/archive-runtime.test.ts)、[事务唤醒测试](../../../src/normalize/orchestrator.test.ts)、[归档测试](../../../src/archive/archive-job.test.ts)、[下载测试](../../../src/archive/dingtalk-download.test.ts)、[模板队列测试](../../../src/db/queries/attachment-archive.test.ts)及[隔离库契约测试](../../../src/db/financial-contract.integration.test.ts)。隔离库测试需要单独获准的测试库；生产文件权限、对象完整性、原件比例、历史归档量及实际后台配置须部署后核对。

2026-11-17 本地验证：186 项相关单元/HTTP 测试通过；在明确获准、仅绑定 127.0.0.1 的一次性 PostgreSQL 16 容器中，财务契约 26 项及物流归档契约 58 项全部通过。覆盖 MinIO 卡住后的连接取消和队列继续处理、批次异常健康结果、自动退役及下游增量可见、分批清理和企业隔离，以及实时优先、并发防重复领取、带既有证据的优先级迁移 down/up。归档证据、状态和 v1/v2 视图列保持一致。类型检查与构建通过；测试容器及临时库已清理，此结果不代表生产部署或钉钉真实文件权限已验证。
