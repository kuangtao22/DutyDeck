# 运维脚本库（Server Ops Script Library）设计草案

> **⚠️ 已被取代（2026-09-27）**：用户改用「开放写 SQL + 历史复用」的方案，见
> `2026-09-27-server-ops-manual-write-design.md`。本文保留作为调研与边界记录：
> 其中「数据库三层只读」「写执行链与只读链的关系」「调度必须共用」三节仍然有效，
> 但脚本资产层（Store、草稿、单次/通用甄别）不再实施。

> **状态：用户已就三条分叉拍板，进入实施。** 本文只定义边界与产物契约；任务级步骤在实施计划里。

日期：2026-09-27

## 0. 用户决议（本设计的输入）

| 编号 | 决议 | 直接后果 |
| --- | --- | --- |
| U1 | **数据库变更脚本允许用户在运维里点击运行** | 新增直接写库入口，取代 2026-09-22「不新增直接写库、改表或自动执行变更入口」的旧约束；必须配二次确认、逐次审计、独立执行链 |
| U2 | **脚本跑完留运行记录：状态、时间、运行结果** | 新增运行记录存储，有界持久化，不保存完整结果集 |
| U3 | **通用脚本要参数化** | 参数定义 + 渲染成为合同的一部分；单次脚本禁止参数化 |

## 1. 要解决什么

现状（已实测）：数据库侧三层只读（SQL 解析只认单条 SELECT、引擎会话层只读、Agent 合同层 `executionAllowed:false`），服务器侧可以执行任意命令但不沉淀。真正的缺口是**没有「可复用脚本资产」这一层**——命令和 SQL 跑完只留在聊天记录里。

本模块交付三件事：**收入**（Agent 提议 / 用户新建 → 落盘到某个运维项目）、**管理**（列表、编辑、启停、删除）、**点击运行**（含参数填写、运行记录）。

## 2. 名词与数据模型

脚本是运维项目下的资产，绑定一个执行目标：

| kind | 绑定目标 | 执行通道 |
| --- | --- | --- |
| `ssh-command` | `hostId` | 既有 SSH exec（复用连接服务，不新开通道类型） |
| `sql` | `sourceId` + `database` | **新增写执行链**（不复用只读查询链） |

```ts
type ServerOpsScriptKind = 'ssh-command' | 'sql'
type ServerOpsScriptUsage = 'one-off' | 'reusable'
type ServerOpsScriptRisk = 'read-only' | 'mutating'

interface ServerOpsScriptParameter {
  name: string                     // ^[A-Za-z_][A-Za-z0-9_]{0,31}$
  label: string
  type: 'text' | 'number' | 'identifier' | 'date'
  required: boolean
  sensitive: boolean               // 运行记录里记 [REDACTED]，不回显取值
  default?: string
  description?: string
}

interface ServerOpsScript {
  id: string
  projectId: string
  name: string
  description?: string
  kind: ServerOpsScriptKind
  usage: ServerOpsScriptUsage
  risk: ServerOpsScriptRisk
  hostId?: string                  // kind=ssh-command 必填
  timeoutMs?: number               // kind=ssh-command
  sourceId?: string                // kind=sql 必填
  database?: string                // kind=sql 必填
  body: string                     // 脚本正文，可含 {{参数名}} 占位
  parameters: ServerOpsScriptParameter[]
  preconditions?: string           // 通用脚本必填
  expectedImpact?: string          // 通用脚本必填
  rollbackPlan?: string            // risk=mutating 且通用脚本必填
  origin: 'agent' | 'user'         // 由宿主盖章，模型不能自报
  suggestedUsage?: ServerOpsScriptUsage   // Agent 建议，仅供 UI 默认值
  suggestedUsageReason?: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}
```

落盘：`~/.proma/server-ops/scripts.json`（版本化快照 + 严格解析 + `server-ops-config-transaction` + `safe-file` 原子写），沿用 projects.json 的既有纪律。

## 3. 单次 / 通用怎么甄别

**判别依据是意图而不是文本，所以没有可靠的纯自动分类。** 采用「Agent 给建议 + 确定性信号 + 用户终审」：

- Agent 提议时必须同时给 `suggestedUsage` 与 `suggestedUsageReason`；UI 默认选中建议，用户可一键翻转。
- 确定性信号由纯函数 `inferServerOpsScriptUsageSignals` 产出，只提示不决定：硬编码主键/日期/绝对路径、无 `WHERE` 或无条件范围、写死单一 host/db/表、含单次标识（`LIMIT 1`、固定 `id=`）、影响行数不可预知、含凭据字面量。
- 形态由规则锁死：`usage='one-off'` 禁止 `parameters`；`usage='reusable'` 必须通过「换一组参数还能成立」检查（参数定义完整、`preconditions` 与 `expectedImpact` 非空），`risk='mutating'` 的通用脚本还必须给 `rollbackPlan`。

## 4. 参数渲染（安全核心）

渲染是纯函数，按 kind 与参数类型走白名单转义，未知占位符一律拒绝（fail closed）：

| 参数类型 | 校验 | shell 渲染 | SQL 渲染 |
| --- | --- | --- | --- |
| `text` | 长度上限 4 KiB，拒绝 NUL | 单引号包裹 + `'\''` 转义 | `'...'` + `''` 转义 |
| `number` | `^-?\d{1,18}(\.\d{1,6})?$` | 原样 | 原样 |
| `identifier` | `^[A-Za-z_][A-Za-z0-9_]{0,63}$` | 原样 | 原样（调用方负责必要的引号） |
| `date` | `^\d{4}-\d{2}-\d{2}$` | 单引号包裹 | `'...'` |

不允许在正文里做字符串拼接式「模板表达式」；只有占位符替换，没有函数、没有条件、没有循环。

**可空语义收紧（2026-09-27 优化）**：参数要么必填，要么可选且**必须声明 `default`**，解析保存时就强制。
早期版本允许「可选 + 无默认值」，缺省时只能渲染成空串——在 SQL 里恰好是「等于空串」而不是「省略条件」，
作者会在毫不知情的情况下执行 `WHERE a = ''`。要表达空值必须显式写 `default: ''`；默认值本身也要过类型校验。
解析完成后，运行时缺值只剩「调用方漏填必填参数」一种可能，直接拒绝。

## 5. 执行与安全边界

**Agent 不能运行脚本。** 工具集里只有提议（`ops_script_propose`）；发起运行只有渲染层 IPC 一条路，且必须带 `confirmed: true`。这条边界保证「模型不能自己跑变更脚本」，与接口工作台 B7b「只有人能出题」同源。

运行前主进程逐项复核：脚本存在且属于当前项目、目标仍存在、目标身份未变（`hostId` / `sourceId+localFileId+credentialRef`）、参数通过渲染校验。任一不满足拒绝，不发起远端动作。

**分离的是执行语义，共用的是调度。** 这两件事早期版本被混为一谈，结论如下：

- **执行语义必须分离**：写执行链不复用 `sql-query` 运行时模式，写连接绝不携带任何只读会话设置。
- **调度必须共用**：写执行仍走既有的 `ServerOpsReadScheduler`（`server-ops-read-scheduler.ts:39`，同源串行、全局最多 3、每源队列 8、排队 5 秒预算）。若另起一套并发预算，同一数据源会同时跑「只读查询」与「DDL」，恰好撞在这个调度器本来要防的场景上。

1. **语句切分复用既有词法器，不另写一套。** `packages/shared/src/types/server-ops-sql-parser.ts:325` 的 `tokenize(sql, dialect)` 已经是方言感知的，token 自带 `from/to` 偏移，并已 fail-closed 拒绝 `@` 变量、反斜杠转义、MySQL 双引号字符串——正是写执行链要拒的那一批。新增 `splitServerOpsSqlStatements(sql, dialect)` 放在该文件内复用它；另写切分器等于长期维护两套方言规则。切分时按 `from/to` 从原文切片，保留注释与格式，使确认卡显示的正文与执行的完全一致。遇 `DELIMITER`、`$$`/`$tag$` 引用体整脚本拒绝；语句数上限 200。
2. **给 tokenize 增加「允许跳过注释」模式。** 它现在遇到注释直接抛 `SERVER_OPS_SQL_COMMENTS_UNSUPPORTED`（同文件 `:344`），而真实迁移脚本几乎都带注释，不放宽则这类脚本一上来就跑不了。只放宽注释，字符串模式那几条不许放宽；读路径默认行为不变。
3. 拒绝会话控制语句（`USE`、`SET`、`DELIMITER`、`START TRANSACTION` 等）——事务由执行器控制。
4. 默认包事务（PostgreSQL / SQLite 支持；MySQL DDL 隐式提交不承诺回滚，运行记录如实标注）。
5. 引擎级时限（statement timeout 与整脚本总时限，默认 60s）与结果丢弃/截断策略；不返回结果集正文，只返回受影响行数与被拒绝原因。
6. 凭据沿用数据源已保存凭据（**不新增凭据子系统**）：只读账号会失败并给出稳定提示「该账号无写权限，请在数据源里换成具备写权限的账号」。只读查询链的只读保证来自会话设置，不依赖账号是否只读，因此复用同一凭据不会削弱读取侧的安全语义。

审计新增 `script-run`（`actor: 'user'`）：开始记录写失败必须 fail closed，不发起远端动作；结果记录写失败保留真实结果并附公开 warning。

## 6. 运行记录

`~/.proma/server-ops/script-runs.json`，有界：每脚本 100 条、全局 2000 条、文件 ≤2 MiB。

```ts
interface ServerOpsScriptRun {
  id: string
  scriptId: string
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'
  startedAt: number
  finishedAt?: number
  durationMs?: number
  parameters: { name: string; value: string }[]   // sensitive 参数记 [REDACTED]
  exitCode?: number            // ssh-command
  statementCount?: number      // sql
  affectedRows?: number        // sql
  errorCode?: string
  errorMessage?: string        // 已归一化，不含凭据
  outputPreview?: string       // 有界 4 KiB
}
```

`unknown` 表示「已提交但回执丢失」——不得当成失败重试，UI 需要显式区分。

## 7. Agent 提议链路

复用 `ops_connection_prepare` 已验证的范式：Agent 只写内存草稿（30 分钟 TTL、每会话 8 条、全局 64 条），用户在 UI 里选项目、改名、确认 `usage` 后才落盘。草稿只广播身份（`sessionId` + `id`），内容由所属会话按需读取。凭据、绝对路径、完整结果集都不进草稿。

## 8. 影响面

- 四层 IPC 契约（shared 通道常量与解析器、main handler、preload bridge、renderer 调用）全部要同步。
- 新增通道会改变 `server-ops-ipc.test.ts` 的 `remove-handler` 数量断言（当前 81），必须同步更新。
- 审计 operation union、Agent 工具白名单（`agent-run-tool-policy.ts`）与系统提示词（`agent-prompt-builder.ts`）需要同步。
- 不新增运行时依赖；不引入本地数据库；不新建凭据子系统。

## 9. 分阶段

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| A | 合同 + 参数渲染 + 两个 Store + IPC + Agent 提议 | 定向测试、7 工作区 typecheck |
| B | SQL 写执行链 + SSH 执行 + 运行记录 + 审计 | 定向回归 + 隔离引擎 fixture + `electron:build` |
| C | UI（项目视图脚本分组、保存/编辑对话框、运行确认、运行记录） | 组件测试 + 界面 smoke + 深浅主题与窄面板 |

阶段 B 的 SQL 写执行是本设计里唯一的高风险改动，必须在真实引擎 fixture（临时 MySQL/PostgreSQL/SQLite）上验证，不得只以 mock 通过结案。

## 10. 实施进度（2026-09-27）

已完成并验证：

- 共享合同 `packages/shared/src/types/server-ops-script.ts`：脚本与运行记录 DTO、全部严格解析器、参数渲染（POSIX/SQL 双套转义）、单次/通用信号与风险推断。19 项测试通过。
- 审计合同扩展：新增 operation `script-run` 与 resourceType `script`；record 校验强制「绑数据源或主机二选一」「必须带 operationId 与 windowId」「Agent 不得发起」。
- 持久化 `server-ops-script-store.ts` 与 `server-ops-script-run-store.ts`：`scripts.json` / `script-runs.json`，配置事务 + 原子写 + 有界容量（单脚本 100 条、全局 2000 条、≤2 MiB，运行中记录永不淘汰）。13 项测试通过。
- `server-ops-config-transaction.ts` 的固定文件白名单加入两个新文件（这是「窄锁协议」的硬约束，新文件必须显式登记，否则构造即抛 `SERVER_OPS_CONFIG_FILE_UNSUPPORTED`）。
- IPC 四层之三：8 条新通道（6 条脚本 + 2 条草稿）、handler、窄接口合同、preload 桥接与 `ElectronAPI` 接线。IPC 回归 67 项通过；`server-ops-ipc.test.ts` 的 `remove-handler` 断言 81 → 89。

未完成（下一阶段）：

- **执行链**：SQL 写执行 runtime（语句切分、会话控制语句拒绝、事务与限额）、SSH 脚本执行、`server-ops-script-service.ts` 编排（审计 start fail closed、运行记录终态、sensitive 参数脱敏）。当前用户点击运行会得到 `SERVER_OPS_SCRIPT_RUNNER_UNAVAILABLE`。
- **Agent 提议工具** `ops_script_propose` 与工具白名单、系统提示词同步。
- **UI**：项目视图脚本分组、保存/编辑对话框（含单次/通用甄别与参数定义）、运行确认卡、运行记录视图。
- **主进程组装**：在根装配处注入 `scripts` / `scriptRuns` / `scriptRunner` / `scriptDrafts`；未注入时界面必须显示「当前版本不支持运行脚本」而不是静默失败。

### 10.1 首轮自审后的优化（2026-09-27，已落地）

| 问题 | 性质 | 结论 |
| --- | --- | --- |
| 「没有参数占位符就建议单次」 | 我写错了规则 | `systemctl restart nginx` 这类天生无参数的脚本被集体判错。改为强弱信号分离：只有**写死的单次证据**（主键等值、字面日期、绝对路径、无 WHERE 的 UPDATE/DELETE）才驱动建议，`LIMIT 1`／具体 IP／无占位符降级为弱提示 |
| `\bwhere\b[^;]*\b\d{4,}\b` | 误报 | `WHERE amount > 10000` 会被说成「写死了记录标识」，整条规则删除 |
| 运行记录崩溃后永久卡在 `running` | 真实缺陷 | 淘汰逻辑明确不回收运行中记录，进程在写入开始与补写终态之间退出即永久卡死。新增 `reconcileInterruptedRuns()`：启动时把全部残留 `running` 改写为 `unknown` + `SERVER_OPS_SCRIPT_RUN_INTERRUPTED`，**且不补写 `finishedAt`**（真实结束时间不可知，编造会让记录里的时间失去可信度） |
| 「可选参数缺省渲染成空串」 | 语义陷阱 | 改为「可选 ⇒ 必须声明 default」，并校验默认值类型 |
| 「写执行链与只读链完全分离」 | 我表述错了 | 分离的只是执行语义（运行时模式）；**调度必须共用** `ServerOpsReadScheduler`，否则同源会同时跑只读查询与 DDL |
| 「自己写方言感知切分器」 | 重复实现 | 改为复用既有 `tokenize()` 并新增 `splitServerOpsSqlStatements()`；同时必须给它加注释模式，否则带注释的迁移脚本全部跑不了 |

上述六条已全部落地并验证（`splitServerOpsSqlStatements` 放在 `server-ops-sql-parser.ts` 内，
与读路径共用词法器；新增 9 项切分测试，读路径既有断言零回归）。
