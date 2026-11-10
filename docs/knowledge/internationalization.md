# 国际化与多语言扩展

**验证状态：已验证（依赖、代码文本及格式化调用）。**

## 当前能力

| 项目 | 当前实现 |
| --- | --- |
| 前端、语言选择、用户偏好 | 无独立前端和语言切换入口 |
| i18n 依赖、资源目录、翻译键 | 未发现统一机制；不能宣称已经支持一套完整中/英/西界面 |
| 通知、错误与日志 | 中文通知和中英错误混用；[预警机器人](../../src/dingtalk/alert-robot.ts)、[Webhook](../../src/webhook/index.ts)、[连接器](../../src/connector/index.ts) |
| 钉钉人员查询 | 部分调用固定 language='zh_CN'，见 [api-client](../../src/dingtalk/api-client.ts) |
| 金额区域化 | 预算消息固定 toLocaleString('zh-CN') 两位小数，未传币种，见 [预算预警](../../src/jobs/budget-alert-monitor.ts) |
| 时间 | Cron 使用 Asia/Shanghai；数据库 TIMESTAMPTZ；源时间有专用兼容处理，见 [数据字典](data-dictionary.md) |
| 业务数据多语言 | 原始模板、字段、主体名按源字符串保存，无独立按 locale 维护的名称模型 |
| 财务识别 | 中/英/西关键词及中文西语类别兼容属于数据识别规则，不是界面翻译；见 [财务发现](../../src/jobs/financial-template-discovery.ts)、[物流 SQL](../../migrations/20260909000000_logistics_settlement_archive.cjs) |
| 输出 | 机器人 Markdown 为中文；装箱保留源 displayValues；未发现独立 Excel/PDF/打印/邮件生成模块 |

新增 [审批读取 HTTP API](../modules/approval-read-api/README.md) 的错误只返回稳定 code，由调用方翻译，不新增自然语言错误依赖；模板名、表单名和 rawPayload 按源语言保存。外层数据库时间统一 UTC ISO 8601 并保留微秒，原始 JSON 内的时间不改写。

审批超时通知（2026-11-10）已在 [approval-timeout-message.ts](../../src/jobs/approval-timeout-message.ts) 集中模板并预留 locale 参数，正式支持简体中文；时长数字使用 Intl.NumberFormat，流程/节点/人员源名称不翻译。群接口新增错误使用稳定 ALERT_ROBOT_* 编码。这是局部实现，未引入翻译依赖，也不代表其他通知或整项目已有统一语言切换。

## 后续新增功能约定（建议，尚未实现）

1. 先按功能边界提取消息模板与稳定错误码，复用现有 code、alertType、alertPhase、状态编码，不把中文提示当内部判断条件。不在本次初始化引入依赖。
2. 在获准的功能开发中确定通知/接口所需语言及 locale 传入位置；可先用轻量映射集中管理新增文本，再评估引入 i18n 库。建议按业务命名如 approval.timeout.title、archive.error.permission_denied；这些仅为建议键，不是现有资源。
3. 资源至少覆盖该次正式确认支持的语言，缺译需明确标注并约定回退。当前没有统一默认语言或回退实现，不擅自声称英文/西文已完成。
4. 展示文案、日期、金额、货币格式按 locale 和业务时区处理；源时间解释不得因展示语言变化而改变。
5. 界面/通知翻译与业务数据翻译分离。业务主体用 business_code、表单优先用组件 ID；源名称原样留存，翻译不能回写替代原始事实。
6. 预算字段已按稳定 ID 映射，应复用；财务分类仍有关键词和名称规则，新增语言必须补同义词样本及负例，不能只翻译文案。
7. 新增导出、打印、邮件等能力时显式设计语言参数、格式和币种；数据库新增多语言结构、公共 API locale 参数需单独评估兼容性。

## 本次检查结论

已核实没有统一翻译框架、资源及语言切换；记录了通知、错误、金额、源数据语言的限制。没有新增用户可见业务文本、安装国际化包或改动业务字段。后续实际建设时更新本文件，区分“已实现”与“建议”。
