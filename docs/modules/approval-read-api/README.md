# 审批与附件只读 HTTP API

[返回项目](../../../README.md) · [既有附件归档契约](../../logistics-settlement-archive.md)

实现入口：[读取路由](../../../src/approval-api/index.ts)、[配置声明](../../../src/config/schema.ts)、[分页游标](../../../src/approval-api/pagination.ts)、[稳定签名密钥](../../../src/approval-api/cursor-key.ts)、[来源及总量限流](../../../src/approval-api/rate-limit.ts)、[参数化查询](../../../src/db/queries/approval-read-api.ts)、[下载生命周期](../../../src/approval-api/attachment-download.ts)、[可取消的存储读取](../../../src/approval-api/object-store.ts)。本模块供其他业务系统通过 HTTP 获取本地归档快照。不会调用钉钉、触发补录或扩大附件收集范围。

## 调用方式与访问范围

三个接口均无需 Bearer Token 或调用方凭据，应用启动后即可调用。旧的 `APPROVAL_READ_API_CLIENTS_JSON` 配置被忽略，遗留 Authorization 请求头也不参与校验；不再返回 READ_API_DISABLED、UNAUTHORIZED 或 FORBIDDEN。

`corpId` 仍为必填查询条件，只用于选择企业数据，不构成身份认证或企业授权；`processCode` 是可选的精确流程筛选，不再有调用方企业/流程白名单。任何能够访问这些接口的请求，都可指定企业读取完整审批快照及符合状态条件的附件。访问范围取决于实际网络和反向代理入口，接口本身不识别调用系统。

默认无需新增配置：应用使用现有 DINGTALK_APP_SECRET，通过固定用途标识派生内部游标签名密钥。相同签名配置下，重启或跨进程/实例可以续用未过期游标。可选 APPROVAL_READ_API_CURSOR_SECRET（32–256 字符，空值按未设置处理）可提供独立的共享签名材料；它仅在服务内部使用，调用方无需知道或传递该值。多实例必须使用相同的显式值，或全部使用相同钉钉应用密钥的默认派生方式；更换有效签名材料后旧游标失效。

接口返回 `Cache-Control: no-store`，日志只记录资源、企业、条数及结果，不记录完整审批内容、查询字符串或遗留凭据。

限流分为两层，均按应用进程计数：

- `APPROVAL_READ_API_REQUESTS_PER_MINUTE` 默认 120：每个来源 IP 独立额度，三个接口共用该来源额度；参数错误、无效游标也只计入该来源，不阻断其他来源。相同 NAT/出口 IP 的系统共用额度。
- `APPROVAL_READ_API_TOTAL_REQUESTS_PER_MINUTE` 默认 1200：所有来源的总查询保护。仅在参数和游标校验通过、准备访问数据库时计数；实际访问后的 404/409 或后端失败也会计入。未通过校验及被来源限流拒绝的请求不消耗此额度。

任一限额触发均返回 429 RATE_LIMITED 和 Retry-After 秒数。来源计数缓存最多容纳 10000 个来源，每个 60 秒窗口到期清空；容量满时新来源返回 429，不重置现有来源的额度。多进程额度独立，不能视为部署整体统一配额。

来源采用 Fastify 的 request.ip。`HTTP_TRUSTED_PROXIES` 默认空（忽略转发头），只接受明确的 IPv4/IPv6 代理地址或 CIDR 列表，不接受 true、通配符或按跳数信任。通过已配置代理时从 X-Forwarded-For 链取最近的不受信任地址；直接访问或不可信代理发送的转发头不改变来源额度。

若宝塔 Nginx 与应用同机，且实际通过回环地址代理到 Node，可配置：

```dotenv
HTTP_TRUSTED_PROXIES=127.0.0.1,::1
```

代理应正确追加实际连接来源到 X-Forwarded-For 链。只配置实际代理地址；未配置时，同一代理转发的请求按代理 IP 共用额度。此配置由 [app.ts](../../../src/app.ts) 应用于 Fastify 的 IP、主机和协议解析，不代替身份认证。


## 路径与公共查询参数

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/v1/approvals` | 审批完整归档快照，支持分页和增量 |
| `GET /api/v1/attachments` | 附件清单、归档状态与下载路径，支持独立分页和增量 |
| `GET /api/v1/attachment-content` | 直接流式下载指定的已归档附件 |

两个列表接口共用以下参数；未知参数、重复形成数组的参数以及无效格式返回 400：

| 参数 | 规则 |
| --- | --- |
| `corpId` | 必填，要查询的企业；仅作为数据筛选条件 |
| `processCode` | 可选，精确流程码 |
| `processInstanceId` | 可选，精确审批实例 ID |
| `approvalNo` | 可选，钉钉审批编号 businessId，精确匹配；编号按字符串传输 |
| `updatedAfter` | 可选，带时区 ISO 8601，例如 `2026-10-28T00:00:00+08:00`；包含等于此时间的记录；不传表示从头读取 |
| `limit` | 默认 50，整数 1–200 |
| `cursor` | 可选，上一页返回的原样游标；后续页必须保持 corpId 和所有筛选条件一致，允许改变 limit |

`updatedAfter` 必须包含 `Z` 或显式时区偏移；偏移小时不超过 15、分钟不超过 59（与数据库可接受的时区位移范围一致），年份为 0001–9999，日期和时间必须有效。例如 `+99:99`、`+25:00`、`+08:75`、`+16:00` 或不带时区均在访问数据库前返回 `400 INVALID_REQUEST`。合法值保留原始字符串和微秒，不通过 JavaScript Date 重新格式化；`Z`、`+08:00`、`-05:30` 均可使用。

例如读取审批：

```bash
curl --get 'https://oa.example.com/api/v1/approvals' \
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

直接 GET 此路径即可下载，无需 Authorization。服务端根据 corpId、processInstanceId 和 fileId 查询对应附件，并复查归档、退役及来源删除状态，再使用数据库中保存的 bucket/object_key 从 MinIO 流式读取，不接受调用方指定任意对象路径。文件不加载为完整 Buffer，也不需要调用方持有 MinIO 凭据。

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
3. 使用 nextCursor 续读；游标版本为 v2，经稳定派生的内部密钥做 HMAC 签名，绑定资源、企业及其他筛选条件、微秒时间和稳定 ID，最长有效期 24 小时。签名配置一致时可跨重启和实例续读，无需粘性路由。篡改、跨企业/接口使用、筛选变化、过期或有效签名材料轮换均返回 400。旧鉴权版本的 v1 游标及此前随机实例密钥签发的 v2 游标不可续用，应从上次完成水位重开一轮。
4. 只有整轮成功后，才保存这一轮 syncUntil 作为完成水位。下一轮 updatedAfter 建议取该值减去至少 10 分钟的重叠区间（按最长事务时间调整），按主键幂等覆盖；不要只保存某一页的最大更新时间。
5. 审批包含 deletedAt，附件包含 retiredAt，均不会从增量列表中自动过滤；调用方需处理删除/退役。审批 sourceDeletedAt 与附件自身退役不是同一标记。两条流各用自身 updated_at，不能依赖审批变化发现附件下载完成。
6. 时间水位不是事务提交序号，分页也不是跨请求的一致性快照；长事务、分页过程中内容更新及超过重叠区间的提交仍需定期从头对账。仅改模板名称不会推进审批源水位，名称更新也依赖定期对账。接口不承诺上游归档完整性。

## 错误与部署验证

错误格式固定为 `{ "success": false, "code": "..." }`，调用方按稳定 code 国际化展示，不依赖自然语言错误文本。

| HTTP | code |
| --- | --- |
| 400 | INVALID_REQUEST、INVALID_CURSOR |
| 404 | ATTACHMENT_NOT_FOUND |
| 409 | ATTACHMENT_NOT_READY |
| 429 | RATE_LIMITED，包含 Retry-After 秒数 |
| 503 | READ_UNAVAILABLE、ATTACHMENT_UNAVAILABLE |
| 504 | ATTACHMENT_TIMEOUT（仅限文件响应头尚未发出时；已开始传输则断开连接） |

索引迁移为 [20261029000000_approval_read_api_indexes.cjs](../../../migrations/20261029000000_approval_read_api_indexes.cjs)，依赖现有审批表及附件归档表。创建包含删除/退役行的企业+更新时间+稳定 ID 索引，不改变原有 v1/v2 视图、状态或数据。部署前评估大表创建索引的锁和耗时；本次移除鉴权不新增数据库迁移，已应用此索引的环境无需重复执行；更新代码后编译并重启应用即可。旧客户端凭据配置可以移除。

本地验证入口：

```bash
npm run lint
npm run test:run -- src/approval-api/index.test.ts src/approval-api/config.test.ts src/approval-api/rate-limit.test.ts src/approval-api/object-store.test.ts src/db/queries/approval-read-api.test.ts src/app-read-api.test.ts
```

测试通过 Fastify inject、模拟 SQL/文件流及本机临时 HTTP 服务验证无凭据读取、遗留鉴权配置兼容、企业/流程筛选、跨重启/实例续页、签名轮换、来源隔离与总量限流、可信代理与转发头防伪、分页游标、微秒精度、删除/退役语义、流错误脱敏、三个下载超时和客户端取消。存储 transport 测试使用真实 MinIO SDK 访问 loopback 模拟服务，确认区域查询、对象响应等待和已打开流的 socket 在取消后关闭，且其他下载不受影响。测试不启动业务主进程、不连接生产数据库或线上 MinIO。真实数据库查询计划、反向代理入口、实例路由和 MinIO 对象读取仍须部署后联调。
