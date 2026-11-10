# 财务来源发现与恢复流程

[模块概况](README.md)

**验证状态：已验证（静态代码）。**

```mermaid
flowchart TD
  N["当前列表及本地或显式历史名"] --> LOOK["发现或精确查询流程码"]
  LOOK -->|失败| ERR["保存名称 failed"]
  LOOK -->|成功| REG["企业内持久范围注册"]
  REG --> SEED["显式创建固定时间窗口"]
  SEED --> CLAIM["领取 pending 或可恢复窗口"]
  CLAIM --> PAGE{"已有持久页"}
  PAGE -->|否| SEARCH["查询一页并保存 pending_ids 和 next_token"]
  SEARCH --> ONE["处理队首实例"]
  PAGE -->|是| ONE
  ONE --> PERSIST["统一详情事务及清单投影"]
  PERSIST --> ACK["校验租约代次后移除队首"]
  ACK --> REMAIN{"本页还有 ID"}
  REMAIN -->|是| ONE
  REMAIN -->|否且有 next_token| NEXT["切换下一页"]
  NEXT --> SEARCH
  REMAIN -->|否且无 next_token| DONE["窗口 completed"]
  ONE -->|失败| FAIL["保留进度并标 failed"]
  SEARCH -->|失败或分页不推进| FAIL
  FAIL --> RATE{"限流错误"}
  RATE -->|是| STOP["结束本轮 drain"]
  RATE -->|否| OTHER["本轮预算内处理其他可领取窗口"]
```

依据：[发现](../../../src/jobs/financial-template-discovery.ts)、[脚本排期](../../../scripts/financial-backfill.ts)、[worker](../../../src/jobs/financial-backfill.ts)、[领取和写回](../../../src/db/queries/financial-backfill.ts)。

## 失败语义与边界

失败窗口至少等待约 1 分钟，且同一次 invocation 不立即重新领取刚失败窗口。更新进度必须匹配 generation、running 及有效租约；丢失租约时不继续推进。成功写详情后、确认进度前崩溃会重放同一实例，不会将失败 ID 当作完成。

completed 只表示该窗口搜索返回的全部页和 ID 都处理完成；不能证明未被发现的模板或上游未返回记录不存在。附件下载独立执行；窗口完成不等于附件已下载，也不等于财务入账完成。
