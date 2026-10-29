# 审批与附件只读 HTTP API

[返回项目](../../../README.md) · [既有附件归档契约](../../logistics-settlement-archive.md)

实现入口：[路由及鉴权](../../../src/approval-api/index.ts)、[配置校验](../../../src/approval-api/config.ts)、[分页游标](../../../src/approval-api/pagination.ts)、[参数化查询](../../../src/db/queries/approval-read-api.ts)、[下载生命周期](../../../src/approval-api/attachment-download.ts)、[可取消的存储读取](../../../src/approval-api/object-store.ts)。本模块供其他业务系统通过 HTTP 获取本地归档快照。不会调用钉钉、触发补录或扩大附件收集范围。

## 配置与访问范围

`APPROVAL_READ_API_CLIENTS_JSON` 默认为 `[]`，此时三个接口均返回 `503 READ_API_DISABLED`。每个调用系统配置独立条目：

```json
[
  {
    "clientId": "erp",
    "tokenSha256": "<随机Token的64位SHA256十六进制摘要>",
    "corpIds": ["ding-example"],
    "processCodes": ["PROC-EXAMPLE"]
  }
]
```

- `clientId`：1–64 位字母、数字、下划线或连字符，用于访问日志和限流。
- `tokenSha256`：必须是 64 位十六进制摘要，服务端不保存明文 Token；clientId 和摘要不得重复。
- `corpIds`：必填且非空的企业白名单。每次请求必须指定一个 `corpId`，服务端同时校验权限并加入 SQL 条件。
- `processCodes`：可选；配置后强制限制所有列表和文件下载。省略表示明确授予这些企业内全部已归档流程的读取权限，不受原有成本视图白名单限制。空数组不合法。

在受控环境使用 Node.js 为每个系统生成至少 32 字节随机 Token，并计算摘要；将明文交给调用系统，摘要和范围加入服务端环境配置：

```bash
node --input-type=module -e 'import {randomBytes,createHash} from "node:crypto"; const token=randomBytes(32).toString("base64url"); console.log(JSON.stringify({token,tokenSha256:createHash("sha256").update(token).digest("hex")}));'
```

生成结果属于凭据，不放入仓库、文档或聊天。Token 使用 43–256 位 base64url 字符，通过 `Authorization: Bearer <TOKEN>` 传入，不支持 query 参数传凭据。配置变更在应用重新启动后生效；删除条目可撤销访问，替换摘要可轮换 Token。

通过 HTTPS 调用。反向代理需转发 Authorization 且不缓存这些接口；接口返回 `Cache-Control: no-store`。恒定时间比较摘要，按调用系统限制每个应用进程每分钟请求数（`APPROVAL_READ_API_REQUESTS_PER_MINUTE`，默认 120，列表和下载共用）；多进程的统一配额应由入口代理提供。日志只记录 clientId、资源、企业、条数及结果，不记录 Token、完整审批内容和存储凭据。

## 路径与公共查询参数

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/v1/approvals` | 审批完整归档快照，支持分页和增量 |
| `GET /api/v1/attachments` | 附件清单、归档状态与下载路径，支持独立分页和增量 |
| `GET /api/v1/attachment-content` | 鉴权后流式下载指定的已归档附件 |

两个列表接口共用以下参数；未知参数、重复形成数组的参数以及无效格式返回 400：

| 参数 | 规则 |
| --- | --- |
| `corpId` | 必填，调用系统有权访问的企业 |
| `processCode` | 可选，精确流程码；必须属于调用系统权限范围 |
| `processInstanceId` | 可选，精确审批实例 ID |
| `approvalNo` | 可选，钉钉审批编号 businessId，精确匹配；编号按字符串传输 |
| `updatedAfter` | 可选，带时区 ISO 8601，例如 `2026-10-28T00:00:00+08:00`；包含等于此时间的记录；不传表示从头读取 |
| `limit` | 默认 50，整数 1–200 |
| `cursor` | 可选，上一页返回的原样游标；后续页必须保持 corpId 和所有筛选条件一致，允许改变 limit |

`updatedAfter` 必须包含 `Z` 或显式时区偏移；偏移小时不超过 15、分钟不超过 59（与数据库可接受的时区位移范围一致），年份为 0001–9999，日期和时间必须有效。例如 `+99:99`、`+25:00`、`+08:75`、`+16:00` 或不带时区均在访问数据库前返回 `400 INVALID_REQUEST`。合法值保留原始字符串和微秒，不通过 JavaScript Date 重新格式化；`Z`、`+08:00`、`-05:30` 均可使用。

例如读取审批：

```bash
curl --get 'https://oa.example.com/api/v1/approvals' \
  -H "Authorization: Bearer ${OA_READ_TOKEN}" \
  --data-urlencode 'corpId=ding-example' \
  --data-urlencode 'limit=50' \
  --data-urlencode 'updatedAfter=2026-10-28T00:00:00+08:00'
```

后续页保持这些参数，并追加 `--data-urlencode "cursor=${NEXT_CURSOR}"`。读取附件时把路径替换成 `/api/v1/attachments`。URL 中的 `+08:00` 必须正确编码，避免 `+` 被当成空格。

## 审批返回内容

```json
{
  "success": true,
  "data": [
    {
      "corpId": "ding-example",
      "processInstanceId": "instance-example",
      "approvalNo": "202610290001",
      "processCode": "PROC-EXAMPLE",
      "templateName": "运营支出",
      "title": "示例审批",
      "status": "COMPLETED",
      "result": "agree",
      "originatorUserId": "user-example",
      "originatorUserName": "示例人员",
      "originatorDeptId": "dept-example",
      "originatorDeptName": "示例部门",
      "createTime": "2026-10-28T01:00:00.000000Z",
      "finishTime": "2026-10-29T01:00:00.000000Z",
      "formComponentValues": [],
      "rawPayload": { "businessId": "202610290001", "formComponentValues": [], "tasks": [], "operationRecords": [] },
      "lastEventTime": "2026-10-29T01:01:00.000000Z",
      "updatedAt": "2026-10-29T01:01:00.123456Z",
      "deletedAt": null
    }
  ],
  "pagination": {
    "limit": 50,
    "hasMore": false,
    "nextCursor": null,
    "syncUntil": "2026-10-29T02:00:00.654321Z"
  }
}
```

`approvalNo` 从 raw_payload 的 businessId/business_id 读取，不是 processInstanceId。`templateName` 先取同企业+流程的模板名称，缺失时取财务历史范围中保留的名称；都缺失则为 null，不伪造名称。已停用或删除的模板不导致历史审批消失。

`rawPayload` 完整返回本地保存的原始 JSON，包含已归档的表单、任务、操作记录、评论、附件引用及上游扩展字段；不截断、不重写内部 JSON 字符串。它是当前本地快照，既不是钉钉实时查询，也不是所有历史版本列表。不存在的上游内容不会补造。`formComponentValues` 为规范化表单；业务状态、原始名称和 rawPayload 内的时间原样保留。外层数据库时间按 UTC 输出并保留微秒，避免翻页丢失精度。

## 附件返回与文件下载

附件行同样包含 corpId、processInstanceId、approvalNo、processCode、templateName，并返回：

```text
fileId, fileName, attachmentOrigin, declaredSize, actualSize, contentType,
sha256, archiveStatus, archiveMethod, contentQuality, failureCode,
commentUserId, commentUserName, commentTime, commentRemark,
archivedAt, updatedAt, retiredAt, sourceDeletedAt, downloadPath
```

大小以十进制字符串或 null 返回，避免 bigint 精度丢失。清单覆盖现有归档器实际维护的表单/评论附件；审批原始 JSON 中存在引用不代表已经收集或下载。不会暴露内部错误、诊断 JSON、MinIO 密钥或签名链接。

仅在 `archiveStatus=archived`、`retiredAt=null` 且来源未删除时提供相对 `downloadPath`：

```text
/api/v1/attachment-content?corpId=ding-example&processInstanceId=instance-example&fileId=file-example
```

带同一个 Bearer Token GET 此路径即可下载。服务端再次根据企业、流程、实例和 fileId 查询权限，然后使用数据库中保存的 bucket/object_key 从 MinIO 流式读取，不接受调用方指定任意对象路径。文件不加载为完整 Buffer，也不需要调用方持有 MinIO 凭据。

响应为 `application/octet-stream` 和 `Content-Disposition: attachment`，文件名使用 UTF-8；`X-Content-Quality` 为 original/preview/unknown。`archived` 可能是预览件，调用方应检查 contentQuality，不能自动认作原件。退役或来源已删除返回 404，尚未归档返回 409。对象不可用或 MinIO 未配置返回 503，不触发重新下载。

下载有三项独立时间限制，只作用于本模块，不改变后台归档和其他 MinIO 使用方：

| 环境变量 | 默认毫秒 | 允许范围 | 作用 |
| --- | --- | --- | --- |
| APPROVAL_READ_API_DOWNLOAD_OPEN_TIMEOUT_MS | 10000 | 100–120000 | 等待对象响应流，含 MinIO 区域查询 |
| APPROVAL_READ_API_DOWNLOAD_IDLE_TIMEOUT_MS | 30000 | 100–300000 | 等待首字节或后续数据；每个数据块重置计时 |
| APPROVAL_READ_API_DOWNLOAD_TOTAL_TIMEOUT_MS | 300000 | 1000–3600000 | 从打开对象开始到 HTTP 响应完成的最长时长，持续收到数据也不会延长 |

超时和客户端断开时，通过 AbortSignal 取消当前下载的真实 HTTP 请求并销毁流；不会只结束等待而遗留存储连接，也不会取消其他下载。每个下载使用独立客户端和 transport，沿用现有存储配置，不使用共享归档客户端。关闭 SDK 自动重试，由调用方按情况重试。

错误与断流约定：

- **尚未发送文件响应头**：打开或读取失败返回 `503 {"success":false,"code":"ATTACHMENT_UNAVAILABLE"}`；任一超时返回 `504 {"success":false,"code":"ATTACHMENT_TIMEOUT"}`。返回 JSON 时移除文件下载和内容质量头，不把底层错误、堆栈或存储路径放进响应/日志。
- **已经开始传输文件**：无法再改 HTTP 状态或插入 JSON；发生错误或超时即中断连接。调用方必须识别传输中断，丢弃未完成文件并按需重新下载，不能仅凭最初的 200 判定成功；可结合清单中的 actualSize、sha256 校验。
- **客户端主动取消**：取消底层存储请求并释放流，不再尝试发送错误 JSON。正常完成、失败和取消都会清理计时器，完成后的连接不会被残留计时器中断。

原始后端错误仅在模块内部捕获；传给 Fastify 的流错误使用固定错误码，避免框架自动错误响应或日志重新暴露原文。

## 增量同步协议

1. 审批与附件分别建立水位。审批主键为 `(corpId, processInstanceId)`，附件主键为 `(corpId, processInstanceId, fileId)`。
2. 首次不传 updatedAfter，从头分页。第一请求以数据库时间确定 syncUntil，后续页保持同一上界。审批按 `(updated_at, process_instance_id)` 排序，附件按 `(updated_at, process_instance_id, file_id)` 排序；企业已固定。使用多取一行判断 hasMore，不执行无界总数统计。
3. 使用 nextCursor 续读；游标经 HMAC 签名，绑定调用系统、当前权限、资源、筛选条件、微秒时间和稳定 ID，有效期 24 小时。篡改、权限变化、跨接口使用或过期返回 400，应从上次完成的同步水位重开一轮。
4. 只有整轮成功后，才保存这一轮 syncUntil 作为完成水位。下一轮 updatedAfter 建议取该值减去至少 10 分钟的重叠区间（按最长事务时间调整），按主键幂等覆盖；不要只保存某一页的最大更新时间。
5. 审批包含 deletedAt，附件包含 retiredAt，均不会从增量列表中自动过滤；调用方需处理删除/退役。审批 sourceDeletedAt 与附件自身退役不是同一标记。两条流各用自身 updated_at，不能依赖审批变化发现附件下载完成。
6. 时间水位不是事务提交序号，分页也不是跨请求的一致性快照；长事务、分页过程中内容更新及超过重叠区间的提交仍需定期从头对账。仅改模板名称不会推进审批源水位，名称更新也依赖定期对账。接口不承诺上游归档完整性。

## 错误与部署验证

错误格式固定为 `{ "success": false, "code": "..." }`，调用方按稳定 code 国际化展示，不依赖自然语言错误文本。

| HTTP | code |
| --- | --- |
| 400 | INVALID_REQUEST、INVALID_CURSOR |
| 401 | UNAUTHORIZED，包含 WWW-Authenticate: Bearer |
| 403 | FORBIDDEN |
| 404 | ATTACHMENT_NOT_FOUND |
| 409 | ATTACHMENT_NOT_READY |
| 429 | RATE_LIMITED，包含 Retry-After 秒数 |
| 503 | READ_API_DISABLED、READ_UNAVAILABLE、ATTACHMENT_UNAVAILABLE |
| 504 | ATTACHMENT_TIMEOUT（仅限文件响应头尚未发出时；已开始传输则断开连接） |

索引迁移为 [20261029000000_approval_read_api_indexes.cjs](../../../migrations/20261029000000_approval_read_api_indexes.cjs)，依赖现有审批表及附件归档表。创建包含删除/退役行的企业+更新时间+稳定 ID 索引，不改变原有 v1/v2 视图、状态或数据。部署前评估大表创建索引的锁和耗时；迁移、配置和重启需在实际环境按授权发布。本次开发没有执行生产迁移或部署。

本地验证入口：

```bash
npm run lint
npm run test:run -- src/approval-api/index.test.ts src/approval-api/config.test.ts src/approval-api/object-store.test.ts src/db/queries/approval-read-api.test.ts src/app-read-api.test.ts
```

测试通过 Fastify inject、模拟 SQL/文件流及本机临时 HTTP 服务验证鉴权、企业/流程过滤、分页游标、微秒精度、删除/退役语义、流错误脱敏、三个下载超时和客户端取消。存储 transport 测试使用真实 MinIO SDK 访问 loopback 模拟服务，确认区域查询、对象响应等待和已打开流的 socket 在取消后关闭，且其他下载不受影响。测试不启动业务主进程、不连接生产数据库或线上 MinIO。真实数据库查询计划、实际授权配置、反向代理和 MinIO 对象读取仍须部署后联调。
