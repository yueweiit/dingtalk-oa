# 元数据与组织

[返回知识库](../../knowledge/README.md)

**验证状态：已验证（静态代码）。** 服务归档、主体审批人解析和下游人员显示，主要由后台及运维脚本调用，无独立前端/API。

## 模板、字段和人员规则

| 能力 | 业务规则 | 依据 |
| --- | --- | --- |
| 定时模板同步 | 使用固定模板管理员；未配置跳过，远程空列表不标删；新增模板启用，已有模板更新名称，重新出现的已删模板会启用 | [syncProcessTemplates](../../../src/jobs/process-template-sync.ts)、[管理员选择](../../../src/dingtalk/template-admin-user.ts) |
| 事件模板发现 | 事件带新流程码时补建，模板列表用于尝试补名 | [编排器](../../../src/normalize/orchestrator.ts) |
| 启动补名 | 服务启动时异步补缺名称 | [syncTemplateNames](../../../src/jobs/sync-template-names.ts)、[主入口](../../../src/index.ts) |
| 普通补录模板范围 | 除启用未删除模板外，还纳入已注册的财务历史范围 | [findBackfillTemplates](../../../src/db/queries/process-template.ts) |
| 表单字段 | 从顶层 formComponentValues 提取有 id 的组件，按企业+流程+字段 ID 更新 | [extractFormFields](../../../src/normalize/form-field-extractor.ts)、[查询](../../../src/db/queries/form-field.ts) |
| 用户快照 | 保留最后一次成功资料；1 小时 TTL、10000 项内存缓存；资料 hash 不变不新增版本，unionId 可补齐；失败写独立历史表，事务和唯一索引保证当前版本唯一 | [processUserSnapshot](../../../src/normalize/user-snapshot.ts)、[快照与失败写入](../../../src/db/queries/user-snapshot.ts) |
| 手工全量元数据 | 模板和用户同步、部门遍历、回填实例发起人/任务审批人姓名；与定时模板同步是不同入口 | [sync-metadata](../../../scripts/sync-metadata.ts) |

模板启用、软删除、财务注册是不同维度。模板列表缺失不证明某个历史流程不存在，财务历史名称还需显式发现。普通元数据同步也可能改变模板状态，不应作为只读诊断运行。

## 用户快照与失败记录

`ding_user_snapshot` 的当前版本表示**最后一次成功获取的用户资料**，不是本次拉取状态，也不等于用户仍在职或拥有业务权限。资料变化时关闭旧成功版本并新增成功版本；内容不变时复用，unionId 单独补齐。源名称不翻译，历史列和既有下游视图不删改。接口失败后不关闭成功资料、不写 `unknown` 当前版本。

`ding_user_fetch_failure` 独立记录失败：企业、用户、fetch_status、fetch_error、首次/最近失败时间和 failure_count。最近一条错误的状态和文本相同时增加计数并更新最近时间，错误变化则新增历史行；成功不会删除失败历史。失败日志不是“当前仍失败”的状态表，最近一次错误可能已恢复。迁移复制的历史行以 source_snapshot_id 关联原快照，其计数只能反映可回溯行数，不能还原旧版本已合并的实际请求次数。

[upsertSnapshot / recordFetchFailure](../../../src/db/queries/user-snapshot.ts) 默认使用 withTransaction 和同企业、同用户的事务级 advisory lock；传入 client 时调用方必须已开启事务。版本切换在取得锁后获取一个数据库时刻，作为旧 valid_to 与新 valid_from，避免锁等待导致时间倒退。数据库以部分唯一索引约束每个 `(corp_id,user_id)` 最多一条 current，并以 CHECK 禁止失败或已有 valid_to 的行成为 current。

事件/补录与 [手工同步](../../../scripts/sync-metadata.ts) 复用同一写入入口，手工同步不再直接关闭/插入快照。内存缓存只在成功落库后建立，命中后不重放旧资料覆盖其他进程的新资料；保存失败不缓存，后续事件仍能重试。人员不存在的 `could not be found` 错误识别为 not_found，其他错误仍为 failed，不改变审批归档的旁路容错。

升级分为两阶段：[数据整理与约束添加](../../../migrations/20261110000000_separate_user_fetch_failures.cjs)、[独立校验](../../../migrations/20261110000001_validate_user_snapshot_current.cjs)。第一阶段在一个事务内锁定快照写入、复制历史失败，按企业+用户和 valid_from、id 的顺序计算下一成功版本生效时间；较旧成功版本缺失或过晚的 valid_to 收口到下一成功版本，保留更早的已知结束时间。生效时间相同则按 id 决定顺序，旧版本可为零长度区间。再关闭旧失败 current、恢复每位用户最后一次成功资料，建立唯一索引，并以 NOT VALID 添加 CHECK。原历史行及 ID 保留，不删除数据；从未成功获取的用户不生成当前占位资料。截图所示人员不存在错误不会因结构优化自动变成有效人员。

第二阶段通过迁移器 noTransaction 打断 singleTransaction 合并事务，先提交第一阶段，再在独立事务中 VALIDATE CHECK，避免在持有添加约束的排他锁时扫描历史全表。NOT VALID 只延后旧数据校验，不允许新写入绕过 CHECK。两阶段均将 lock_timeout 设为 5 秒、statement_timeout 设为 5 分钟，并使用 SET LOCAL 防止设置泄漏到后续会话操作。时间上限须在实际数据量和获准维护方案中评估。

部署顺序：在获准实施时先备份并安排读写维护窗口，停止旧服务及元数据脚本等写入进程，依次应用两阶段迁移，再部署新代码恢复写入；不能让旧失败写入逻辑与新约束混跑。第一阶段末尾 ADD CHECK NOT VALID 仍需短暂 ACCESS EXCLUSIVE，会阻塞普通读取，不能承诺迁移全程可读；锁等待超时会回滚本阶段。第一阶段提交后，第二阶段的历史扫描使用较低锁级别，可与普通读取并行。第二阶段失败不会撤销第一阶段已提交的整理和唯一索引，应排查后重试幂等校验，不可假定整个升级已回滚。两阶段 down 均拒绝自动回退，须制定人工恢复方案。本次只准备代码和迁移，未运行迁移、同步、服务或生产数据修复。

2026-11-10 验证：项目类型检查、手工同步脚本独立类型检查已通过；用户写入/规范化、迁移离线生成、迁移器两种 singleTransaction 执行路径、组织、人员名视图及超时提醒共 73 项单元测试通过（迁移回归 9 项，其他相关回归 64 项）。[11 项 PostgreSQL 集成用例](../../../src/db/user-snapshot.integration.test.ts) 需要显式获准的 USER_SNAPSHOT_TEST_DATABASE_URL，限定 loopback 与 user_snapshot_test / user_snapshot_test_* 数据库，在独立随机 schema 验证真实迁移、重复成功版本区间、早结束时间保留、时间并列、企业隔离、开放读事务下的约束校验及重试、并发、回滚和约束；本次未提供获准隔离库，全部跳过。实际数据库迁移和多进程运行仍待验证。

## 部门树

[buildDepartmentTreeRows](../../../src/organization/department-tree.ts) 从部门 1 的 ROOT 开始，根据父子边构造 pathIds/pathNames；无法找到父部门时抛错。[syncDepartmentTree](../../../src/organization/department-tree-sync.ts) upsert 本轮部门，其他原 current 行改为 false；手工同步脚本在事务中调用它。

数据库 ding_department_tree 保存企业内部门 ID、父 ID、名称、JSONB 路径和当前标志。[迁移](../../../migrations/20260722000000_create_ding_department_tree.cjs) 是结构依据，路径是派生值而非权限树。

## 数据关系与扩展

- ding_process_template 关联审批/字段/财务注册；修改名称可能触发自动财务或采购范围注册。
- ding_user_snapshot 通过企业+用户 ID 关联人员显示；union_id 用于文档/附件身份，不等于 user_id。
- 修改快照字段和 hash 规则需检查连接器、人员名视图、下载操作身份。名称原样保存，不是多语言资源。
- 组织、模板脚本和定时路径的实现不同，不能直接将某个路径的事务或权限假定推广到其他路径。

测试入口：[部门构造](../../../src/organization/department-tree.test.ts)、[部门同步](../../../src/organization/department-tree-sync.test.ts)、[用户快照](../../../src/normalize/user-snapshot.test.ts)、[快照 SQL](../../../src/db/queries/user-snapshot.test.ts)、[迁移离线检查](../../../src/db/user-snapshot-migration.test.ts)。执行结果见上文；真实组织完整性、离职人员权限、手工同步范围及历史版本数据待验证。
