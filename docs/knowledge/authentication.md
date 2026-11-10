# 身份认证与权限

**验证状态：已验证（代码和迁移）；公网暴露、数据库实际授权与钉钉权限待验证。**

## 应用和操作身份

- [TokenManager](../../src/dingtalk/token-manager.ts) 使用 DINGTALK_APP_KEY / DINGTALK_APP_SECRET 获取钉钉 access token，进程内缓存、提前 5 分钟刷新、并发刷新共用 Promise；刷新失败时只在旧 token 未过期时回退。
- Stream 使用相同应用凭据。模板列表依赖固定 DINGTALK_TEMPLATE_ADMIN_USER_ID；附件下载和装箱读取分别有专用用户/unionId 配置，不能互相假定权限等价。
- [预警机器人](../../src/dingtalk/alert-robot.ts) 使用独立 CLIENT_ID / CLIENT_SECRET / ROBOT_CODE；超时提醒按 DINGTALK_CORP_ID 过滤并发送给当前任务审批人及可选配置群，预算/空节点仍发固定配置人员。这些目标不是应用登录角色，部署者须保证机器人企业与 DINGTALK_CORP_ID 一致；群消息会向目标群成员展示审批提醒，群选择须匹配业务可见范围，详见 [预警](../modules/alerts/README.md)。
- 本项目没有发现用户登录、Session/JWT、角色菜单体系或完整 RBAC。用户快照和主体审批人表是源数据/业务路由，不是账户认证表。

## HTTP 边界

[app.ts](../../src/app.ts) 开启 origin:true、credentials:true 的 CORS；没有全局认证 hook。健康、指标和审批人连接器没有路由鉴权。CORS 和 corp_id 参数不能代替授权；反向代理或网络入口是否另有保护为待验证。

`/api/v1/approvals`、`/api/v1/attachments` 和 `/api/v1/attachment-content` 现按用户要求移除调用方鉴权，见 [读取路由](../../src/approval-api/index.ts)。无需 Bearer Token，旧 APPROVAL_READ_API_CLIENTS_JSON 配置不再校验或生效。企业和可选流程由查询参数选择，SQL 保留企业筛选，但这不构成租户授权；任何可访问接口的请求均能读取所选企业的归档数据和可下载附件。既有成本视图白名单不限制这些接口，也不扩大附件实际收集范围。

读取接口返回 no-store，每个应用进程按来源 IP 独立限流，并为校验通过的查询设置总量保护。来源由 Fastify request.ip 提供，HTTP_TRUSTED_PROXIES 默认空，仅显式代理地址可影响转发来源解析。游标签名默认从钉钉应用密钥按固定用途派生，也可使用独立共享的 APPROVAL_READ_API_CURSOR_SECRET；它不用于调用鉴权。签名配置一致时，最长 24 小时有效的游标可跨重启及实例续用；轮换有效签名材料时需重开同步。文件下载复查企业、实例、fileId、归档及退役/来源删除状态。应用日志继续对遗留 Authorization/Cookie 脱敏，不记录审批 payload 或存储错误明细。外部网络和反向代理访问范围仍须部署验证，参见 [模块契约](../modules/approval-read-api/README.md)。

下载只把固定错误码传给框架，包含流异步错误；首字节前使用脱敏 JSON，已开始传输时中断连接。独立的存储 transport 接收请求级 AbortSignal，超时或客户端断开会关闭实际存储连接，且不会取消其他调用方的下载。三个超时配置及边界见 [API 下载契约](../modules/approval-read-api/README.md#附件返回与文件下载)。

[Webhook](../../src/webhook/index.ts) 在配置缺失时拒绝；读取 x-dingtalk-timestamp、x-dingtalk-sign 并调用 [verifySignature](../../src/dingtalk/signature.ts)。现有实现使用 timestamp 与 token 组成签名材料、AES_KEY 作为 HMAC 密钥；body 参数未参与签名，未检查时间戳窗口。timingSafeEqual 对不同长度会抛错，路由捕获后返回 500。decryptMessage 虽存在，但当前路由未调用。不能将其描述为已验证完整实现钉钉官方加密回调协议。

## 数据库角色与企业隔离

- 成本读取通过 costing_read 视图，迁移向**已存在**的 costing_reader 授予 SELECT；若角色后建，不会自动补齐历史迁移授权。
- 审批修复与装箱刷新通过 SECURITY DEFINER 函数入队，显式 search_path、白名单校验并 REVOKE PUBLIC 执行，向已存在的 costing_job_submitter 授 EXECUTE。它们具有受控写入副作用，并非普通只读查询。
- 基础归档查询多带 corp_id；但运行时只配置一组钉钉应用凭据，遍历多个企业不等于已经实现多企业授权路由。
- 旧 allowed_process_template 仅以 process_code 为主键；自动采购/财务范围附加企业注册表。手工白名单保留旧范围，不能概括为所有行均有企业级数据库权限隔离。
- 装箱请求函数按 workbook_id（工作表刷新还带 sheet_id）从白名单选择企业，未接收可信登录租户身份；调用方角色和跨企业共享数据库边界必须单独核实。
- 未发现 RLS 策略。读角色可读视图的企业范围取决于视图过滤，不自动按会话用户收窄。

依据：[修复迁移](../../migrations/1788856369000_create_approval_repair_queue.cjs)、[采购范围](../../migrations/20260910000000_purchase_template_scope.cjs)、[装箱迁移](../../migrations/20260907000000_create_packing_sheet_cache.cjs)、[财务范围](../../migrations/20260910010000_financial_source_scope.cjs)。

## 后续变更约束

不在文档、日志或示例中保存凭据、真实个人 ID、下载签名 URL。修改鉴权、白名单、SECURITY DEFINER、企业过滤或操作用户时，同时检查 HTTP、后台任务和下游数据库契约。新增读取接口只改变自身 HTTP 访问边界，既有 Webhook、连接器和数据库角色规则保持原约定。
