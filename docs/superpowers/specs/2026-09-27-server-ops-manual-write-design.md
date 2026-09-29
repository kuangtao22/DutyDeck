# 运维手工写库设计（取代脚本库方案）

> **状态：已定稿并进入实施。** 本文取代 `2026-09-27-server-ops-script-library-design.md`。

日期：2026-09-27

## 1. 为什么转向

脚本库方案（脚本资产 + 单次/通用甄别 + 参数化）源于用户「要用脚本来写库」的表述，但那是**手段**：
当时数据库完全没有写入能力，只能靠生成脚本来绕过。用户随后明确：「另一个方式，开放写数据库的语句，然后做历史记录可以运行写入」。

结论：把「写」做成 SQL 编辑器的一个显式模式，复用已有的查询历史作为复用入口；**不引入脚本资产层**。
直接收益是「单次还是通用」这个判定问题整体消失——没有脚本资产要分类。

## 2. 边界

| 主体 | 能力 |
| --- | --- |
| 用户在数据库工作台 | 显式开启写模式后可执行含写语句的脚本；执行前有确认卡；历史可回填并再次运行 |
| **Agent** | **仍然只读**。`ops_database_query`、`ops_database_change_context` 的合同与工具集不变，不因本方案增加任何写能力 |

写模式作用域取最保守的默认：**面板级临时开启，关闭面板即失效**，不做按连接的持久开关。
凭据沿用数据源已保存账号：只读账号执行写会失败并提示换成有写权限的账号；不新增凭据子系统。

## 3. 写的执行语义（与只读链的关系）

**分离的是执行语义，共用的是调度。**

- 写连接绝不携带任何只读会话设置，也不复用只读连接。
- 写执行仍走既有 `ServerOpsReadScheduler`（同源串行、全局最多 3、每源队列 8、排队 5 秒），
  否则同一数据源会同时跑只读查询与 DDL，正好撞在这个调度器本来要防的场景上。

三层拒绝规则全部收在共享层 `planServerOpsSqlWrite(sql, dialect)`，主进程与 utility 共用一份判定：

1. **语句切分**复用只读路径同一个词法器（`splitServerOpsSqlStatements`），按 token 偏移从原文切片，
   注释与格式原样保留，使确认卡显示的正文与实际执行一字不差。`$$`/`$tag$`/位置参数、
   `DELIMITER`、未闭合注释、语句数 > 200 一律整脚本拒绝。
2. **会话控制语句拒绝**（`USE`/`SET`/`DELIMITER`/`START`/`BEGIN`/`COMMIT`/`ROLLBACK`/`SAVEPOINT`/`RELEASE`/`LOCK`/`UNLOCK`）——
   事务由执行器统一控制。
3. **必须含写语句**。全是只读语句时拒绝并引导走只读通道：写通道没有敏感列遮罩与结果预算，
   不能被用来绕过它们。`WITH` 一律按写处理，避免 `WITH x AS (...) INSERT` 被误判成只读。

事务：MySQL 用 `START TRANSACTION` 包裹，全部成功才提交；**出现隐式提交语句（ALTER/CREATE/DROP/TRUNCATE/RENAME/GRANT/REVOKE/LOCK/UNLOCK）之后再失败时，连回滚语句都不发**，
如实报告「部分已生效」并附带公开警告，不谎称已回滚。结果只返回语句条数、累计受影响行数与逐条受影响行数，**不返回结果集正文**。

## 4. 审计

新增 operation `data-write` 与 resourceType `data-write`（本轮由早先的 `script-run` 改名而来）：
必须绑定 `sourceId` + `database`、必须带 `operationId` 与 `windowId`、**Agent 不得发起**（`actor` 只能是 `user`）。
开始记录写失败必须 fail closed，不发起写操作；结果记录写失败保留真实结果并附公开 warning。

## 5. 实施进度（2026-09-27）

已完成并验证：

- 共享写合同 `packages/shared/src/types/server-ops-data-write.ts`：通道、输入/结果 DTO、全部严格解析器。
- 写脚本计划 `planServerOpsSqlWrite` + 首关键字判定 `getServerOpsSqlStatementHead`
  （注释开头的语句不会被正则误判）+ 会话控制与只读白名单；新增诊断码
  `SERVER_OPS_SQL_STATEMENT_REJECTED` / `_WRITE_REQUIRED`。
- 审计 operation/resourceType 改名 `script-run` → `data-write`。
- MySQL 写执行器 `apps/electron/src/utility/server-ops/server-ops-write-runtime.ts`：
  独立于只读链的新文件，含事务边界、隐式提交如实标注、受影响行数归一化与取消检查；7 项假连接测试。
- **本地 SQLite 写执行器（真机验证）**：与只读入口共用同一个子进程脚本，但按 mode 决定打开方式——
  写模式 `readOnly: false` 且**不设置** `PRAGMA query_only`；`BEGIN IMMEDIATE` 包裹，全成功才 `COMMIT`，
  失败 `ROLLBACK`；主进程侧 `runServerOpsLocalSqliteWrite` 先复核 `localFileId`、库名固定 main、
  语句数与 payload 字节预算（子进程 stdin 上限 64 KiB，因此共享层的写脚本正文上限收紧到 **16 KiB**）。
  真机测试 4 项：改动确实落盘（用独立连接核对行值）、后续语句失败整脚本回滚、文件身份不符开子进程前拒绝、
  只读语句在编译计划阶段就被拒。**踩坑**：子进程的错误映射与 `SQLITE_PUBLIC_ERROR_MESSAGES` 白名单都偏向读侧，
  新写码不登记就会被降级成 `SERVER_OPS_SQLITE_READ_FAILED`，且 `no such table` 这类读侧映射会抢在写侧前面——
  必须把写分支放在映射链前面。
- **运行时协议写分支**：新增 `ServerOpsRuntimeDataWriteRequest`（复用读请求的连接字段，但携带**已切分并判定过的语句计划**
  而不是原始 SQL，utility 只执行、不二次解释）与 `data-write-result` / `data-write-cancelled` 两类消息；
  请求解析明确只接受 **MySQL 与本地 SQLite**，PostgreSQL / Redis / 远端 SQLite 一律拒绝，不做静默降级；
  结果消息直接复用共享合同的 `parseServerOpsDataWriteResult`，协议层不再维护第二份形状。
- **MySQL 连接构造抽取为唯一实现（用户明确选择「规范而非打补丁」）**：新增
  `apps/electron/src/utility/server-ops/server-ops-mysql-connection.ts`，把 TLS 校验、`tlsServerName` 处理、
  `preferred` 明文回退、加密流判定与失败资源清理收在一处；只读链的 `readMySql` 改为调用它，
  写链将复用同一实现，两者只在会话设置上分叉。**收益不只是去重**：这些安全不变量原先只能靠真机 MySQL 覆盖，
  现在有了 9 项假件测试（明文不请求 TLS / required 不报告 verified / verify 用 tlsServerName 且严格校验 /
  声称 TLS 却拿到明文流必须拒绝 / preferred 只回退一次且第二次不带 ssl / required 与 verify 绝不回退 /
  失败销毁通道与连接 / 取消后不创建驱动连接 / 省略默认库时驱动选项里没有 database）。
- **utility 分派已接线**：`server-ops.data-write` 与 `server-ops.data-write-cancel` 两个 case、
  独立的 `activeDataWrites` 登记表（与读取分开，取消仍要求完整跨进程身份）、关闭时一并 abort；
  MySQL 走刚抽出的连接构造 + `runServerOpsMySqlWriteScript`（用 `connection.promise()`，
  与只读链同一做法），本地 SQLite 走 `runServerOpsLocalSqliteWrite`。
  **经跳板的写显式拒绝**（`SERVER_OPS_DATA_WRITE_SSH_UNSUPPORTED`），因为 `forwardOut` 的所有权与终止语义需要单独设计；
  「还没连上就失败」与「执行失败」也用不同错误码区分，避免把连接失败报成「事务已回滚」。
  **验证缺口已还清**：utility 入口有顶层副作用、不可被测试导入，所以执行语义被抽到
  `server-ops-write-dispatch.ts`（依赖注入）并补了 6 项测试——引擎分支、
  「跳板写拒绝必须发生在任何引擎之前」、「连不上」与「写入失败」的区分、驱动错误码不得被当公开码透传、
  取消与提交失败的分类、以及「先登记通道再建连」的顺序；runtime 里的重复实现已删除，
  只剩消息循环侧的生命周期（登记 / 超时 / 取消 / 回传）。
- **抽取连接构造引发过一次真实故障（已修，务必记住）**：抽取时我把等待逻辑**按自己的理解重写**并监听
  `ready`，而 mysql2 在握手完成时发的是 `connect`——每次握手都挂到整体超时，用户看到的就是「数据库连不上」，
  **而且先坏的是只读链**。修复方式是改回 `connect` 并把重复实现删掉，全仓只留一份
  `waitForServerOpsMySqlConnection`。**测试当时全绿**，因为我的假连接按同一个错误假设发 `ready`：
  假件只验证内部自洽，不验证与真实驱动一致。现已补上「只发 ready 不发 connect 时不得认为握手完成」的回归。
  结论：抽取既有逻辑时**挪位置而不是重写**。
- **主进程 runtime client 已支持写**：`dataWrite()` 与 `dataRead()` 完全同构——独立 pending 表、
  主进程 deadline 比 utility 自身超时略长（先拿到 utility 的分类结果）、取消只发一次并保留到 utility ACK、
  取消消息无法送达时终止共享 utility（写事务不会留在一个失联进程里）、`data-write-result` /
  `data-write-cancelled` 两条消息路由、断线时按主机与连接身份统一收口。
  **取消后迟到的成功结果不发布**：写可能已经发生，但调用方已按取消收口，不能让它突然收到成功。
- **主进程服务层与 IPC/preload 已接线**：
  `ServerOpsDataService.writeSource()` 复用读侧的 `runReadTarget` 身份复核与 `ServerOpsReadScheduler`
  （**写与读共用同一个每源串行队列**，否则同一数据源会同时跑只读查询与 DDL），
  在执行前用共享层 `planServerOpsSqlWrite` 完成切分与拒绝；
  **带 `ownerSessionId` 的调用一律拒绝**（`SERVER_OPS_DATA_WRITE_AGENT_FORBIDDEN`）——写链没有 Agent 入口。
  新增 `runAuditedServerOpsDataWrite()`：开始记录写失败 fail closed，结果记录写失败降级成公开警告，
  **审计只写 sourceId + database，不带 queryHash/tables**。
  IPC 两条通道（EXECUTE/CANCEL）配一个**独立的写注册表**，`ServerOpsQueryRegistry` 的繁忙/取消码参数化后
  写链使用自己的码，避免用户看到「查询已取消」；preload 暴露 `writeServerOpsDatabase` /
  `cancelServerOpsDatabaseWrite`。

- **UI 已落地**：
  `server-ops-sql-write-controller.ts`（独立状态机，8 项测试：成功/失败/取消/切目标即取消在途/卸载即失效/
  结果身份核对/稳定码收敛成中文）配面板改造——写模式是**面板级临时开关**（切库或切连接即重置，不持久化），
  只读自动校验在写模式下停用，改用共享层 `planServerOpsSqlWrite` 作为执行前的门禁并在诊断行显示
  「将执行 N 条语句（首关键字）」；确认卡显示目标库、语句条数与首关键字、完整正文，并按方言给出
  **能否回滚**的准确说明（MySQL 隐式提交 / SQLite 事务回滚）；写入结果只呈现「有没有生效」
  （语句数、累计受影响行数、是否已提交、逐条影响行数、警告）；历史条目在写模式下多一个「运行」入口
  （回填并直接打开确认卡）；旧 preload 缺少写接口时写模式按钮显式禁用并给出原因。
- **Agent 只读边界回归测试已补**：`writeSource` 带 `ownerSessionId` 时在建连前抛
  `SERVER_OPS_DATA_WRITE_AGENT_FORBIDDEN`，且断言 runtime 一条请求都没收到。
- **写 UI 的组件测试已补**（6 项静态渲染）：默认只读模式不出现写入标记、写模式按钮可点但 `aria-pressed` 为假；
  旧 preload 缺写接口时按钮禁用并给出明确原因；写入结果视图区分「已提交/未提交」并逐条展示首关键字与影响行数；
  历史「运行」入口只在写模式下出现。**仓库没有 DOM 测试设施**（无 `@testing-library` 与 happy-dom，
  既有渲染层测试都是 `renderToStaticMarkup`），因此**交互粘合层没有自动化覆盖**：
  开关点击 → `prepareWrite` → 确认卡 → `writeController.execute` 这一段只有控制器测试（8 项）覆盖其逻辑，
  点击链路本身依赖人工验收或 Electron 界面 smoke。这一点必须如实记录，不能宣称「UI 已全面测试」。

未完成：

- **PostgreSQL 写执行器**（用户当前没有 PG 数据源，可最后做）。
- **经跳板（SSH transport）的写**：现在显式拒绝，需要单独设计 `forwardOut` 的所有权与终止语义。
- **真实引擎验收**：本地 SQLite 已真机验证；MySQL 目前只有假连接证据，需要在 dev 实例里对非生产库
  跑一次真实 DDL/DML 才能闭环（沙箱连不上内网与回环）。
- 主进程 `ServerOpsDataService.writeSource`（复用 `runReadTarget` 的身份复核与调度）+ 审计接线。
- IPC 两条通道 + preload 桥接。
- UI：SQL 编辑器的写模式开关、执行前确认卡（必须显示原文、目标库、是否可回滚）、历史条目的「运行」入口。
- Agent 只读边界回归测试（证明 `ops_database_query` 未获得写能力）。

## 6. 已写但本方案不使用的部分

脚本资产层（`server-ops-script-store.ts`、`server-ops-script-run-store.ts`、草稿合同、单次/通用信号）目前**没有任何代码引用**。
除三块可复用成果外（共享写合同、语句切分/计划、MySQL 写执行器），其余建议在功能落地后删除，避免仓库里留下无人使用的抽象。
