# 编排工厂 Agent 完整代操作实现计划

> 使用 subagent-driven-development 执行独立工作线，主代理统一集成、审查与验证。用户已批准设计和实现，不再重复请求执行许可。

**Goal:** 当前会话 Agent 能调用工厂完整操作并完成可停止、有证据和轮数限制的批量优化。

**Architecture:** 复用现有 service/runner/evaluator，扩展精确工具白名单及不可变操作快照；将对比计算共享、批次状态持久化。界面和 Agent 共用批次入口，业务持久化仍为 JSON/JSONL。

**Tech Stack:** Bun、TypeScript、Electron、React、Pi Agent、现有 Radix primitives。

## 1. 定义与运行基础（独立工作线）

文件：主进程 `capability-factory-service.ts`、`capability-factory-run.ts`、`capability-factory-evaluate.ts` 及对应测试；必要时增加同目录纯校验 helper。

- [x] 先增加 BDD 测试，证明未知步骤字段在保存前拒绝、编辑中空草案兼容、取消停止后续步骤与评审、批次不混版本。
- [x] 运行失败测试后实现结构预检、外部取消信号和归属守卫；复用 runner parser，不删除未知字段。
- [x] 重跑相关测试，保留旧版本、任务保存和自动评审行为。

## 2. Agent 操作面（独立工作线）

文件：`capability-factory-agent-facade.ts`、`capability-factory-agent-tools.ts` 及对应测试。

- [x] 先增加创建/修改/采纳/回滚/删除/导出/数据集/批次工具测试，以及失效快照、身份冲突与越权拒绝测试。
- [x] 扩展只读与批次工具；修改操作采用准备、审批、应用两段式。批准内容从宿主快照获取，拒绝未知动作。
- [x] 固定来源与当前归属，准备时冻结完整实体状态，应用前复核；新增工具分类帮助宿主明确区分只读、执行和写操作。
- [x] 重跑工具和 Facade 测试。

## 3. 共享与持久批次（独立工作线）

文件：新增 shared 批次合同、共享优化比较模块；新增主进程批次服务/存储及测试。

- [x] 先增加真实临时目录测试：同条件配对、逐条落盘、重读恢复、取消、版本/输入变化、整批采纳门槛、10 用例/3 轮限制。
- [x] 将 renderer 比较函数迁到共享纯模块，保留旧导出兼容；批次保存只存必要索引及快照，完整输出按 runId 读取。
- [x] 实现串行评测/对比、冻结输入和定义、进度及取消、精确读取和列表；不依赖 renderer 或 Electron。
- [x] 批次执行与 UI/Agent 的宿主回调通过明确类型组合，避免第二套模型运行器。

## 4. 宿主与界面集成（主代理）

文件：shared IPC、工厂 IPC/preload、主 `ipc.ts`、`agent-orchestrator.ts`、运行/优化/评测组件、审批卡及其测试。

- [x] 先补 IPC 解析、权限与身份隔离测试，再接共享批次服务与 requestId 进度事件。
- [x] Agent 注册按前台/受限来源边界处理；所有写入/运行在 plan 模式拒绝，危险操作显示真实快照。
- [x] UI 对比使用持久批次，读取 Agent 创建的结果并可采纳；批测区增加进度、停止和刷新恢复。
- [x] 完成工具执行与界面共用结果的集成测试，防止迟到请求污染新场景。

## 5. 引导与交付验证（主代理）

文件：`agent-prompt-builder.ts`、默认工厂 Skill（patch +1）及相关测试；设计与 MEMORY。

- [x] 更新旧人工专属操作文案，明确完整代操作、有限优化与证据读取。
- [x] 跑各线定向 `bun test`，然后 `bun run typecheck`；必要时完成 Electron 构建与隔离 UI 冒烟。
- [x] 检查 diff 并独立复核需求覆盖及实现质量，不覆盖已有未提交改动。
- [x] 将实际完成项、验证证据及限制写入计划和 MEMORY；不自动提交、推送或发布。

## 验收结果（2026-10-09）

- 功能相关测试：`473 pass / 0 fail`，覆盖 45 个文件；最终批次/Facade/session runtime 修改另重跑 `50 pass / 0 fail`。测试日志：`/private/tmp/dutydeck-factory-final-tests.log`、`/private/tmp/dutydeck-factory-final-integration.log`。
- 整仓 `bun run typecheck`：所有 workspace 退出码 0，包含 Electron。日志：`/private/tmp/dutydeck-factory-final-typecheck.log`。
- 真实隐藏 Electron UI 冒烟：`bun run scripts/capability-factory-batch-ui-smoke.ts` 退出码 0。验证已存在 Agent 批次恢复不重跑、历史选择保持、迟到会话隔离、重复提交锁、停止，以及 12 条数据集默认选择 10 条、换选第 11 条并精确传递 caseIds。使用临时 userData 和内存 IPC，不访问真实配置。日志：`/private/tmp/dutydeck-factory-ui-smoke.log`。
- 主进程、preload、renderer 隔离构建通过，产物位于 `/private/tmp/dutydeck-factory-build`；未覆盖运行实例的 dist。主进程仍有既有 import.meta/CJS 警告，renderer 仍有较大 chunk 警告，没有阻断构建。未执行安装包发布验证。
- `git diff --check` 通过。仓库没有独立 lint 脚本，以 TypeScript 检查、diff 检查和定向可执行测试验证。
- 独立复核修复：ownership 失效后迟到写入、跨 Agent 回合读取被预算 scope 错误过滤、最近批次按文件名截断、采纳证据未绑定全部快照字段、异步采纳后未再次检查身份、混用单次/批次绕过预算、大数据集无法分批测试、Agent 产生新任务后列表不刷新。
- 默认 Skill 升级至 `1.0.7`，系统提示及工具说明同步。无新增依赖，未提交、推送、发布、重启真实应用或调用真实模型；真实模型输出质量仍取决于场景与渠道，离线测试验证的是执行与评审协议、证据及权限边界。

## 追加需求：自主优化与采纳审核（2026-10-09）

- [x] 执行模式允许连续准备候选、评审标准和数据集、运行批测与读取建议；plan 继续拒绝执行和写入。
- [x] 采纳和破坏性操作始终走不可永久授权的单次审批，完全自动模式不跳过；普通写草案无需逐轮确认。
- [x] 采纳摘要从宿主持久证据生成，显示改善收益、当前版问题、剩余风险和验证范围；缺少匹配证据不宣称已验证。摘要与草案同时冻结，证据变化后旧批准失效。
- [x] 使用独立 AlertDialog；暂不采纳保留草案与测试结果，失败支持重试，同帧重复点击只响应一次，通用 Enter 不批准采纳。
- [x] 系统提示、工具描述和默认 Skill 同步，Skill 升级至 `1.0.8`，不再要求 Agent 先做文字确认才能弹窗。
- [x] 真实权限服务、临时持久层和 facade 集成覆盖挂起、拒绝、单次批准、伪造永久批准、中止、计划模式切换和草案并发替换；隔离 Electron UI 冒烟验证弹窗实际行为。

验证日志：`/private/tmp/factory-adoption-final-tests.log`、`/private/tmp/factory-adoption-typecheck.log`、`/private/tmp/factory-adoption-final-ui-smoke.log`。主进程与 renderer 隔离构建位于 `/private/tmp/dutydeck-factory-adoption-build`，未覆盖运行实例或访问真实业务数据。

- 最终定向回归 `565 pass / 0 fail`，51 个文件、2091 次断言；包含本次权限策略、摘要、持久层与交互相关路径。
- 独立审查发现逐个 getRun 会重复解析完整历史；已改为按一组运行 ID 每阶段批量读取一次。摘要、采纳证据核验及批次汇总均复用当阶段结果，不跨阶段缓存，保留确认后证据失效检查。新增读取次数回归覆盖满批十组、缺失 ID、重复 ID、空请求。
- Electron 冒烟仍使用真实组件与隔离临时数据，覆盖普通批次恢复/取消、大数据集子集，以及采纳弹窗的确认/拒绝、Enter 防误批、错误重试、双击防重和跨会话队列隔离。
- 性能修复后整仓 `bun run typecheck` 全部 workspace 通过；主进程重建通过，`git diff --check` 通过。独立复核结论 APPROVE，复核的五个测试文件 90 项全部通过。仍未调用真实模型，未打包发布。

## 实测反馈修正：有用的采纳说明与原有审批卡（2026-10-09）

- [x] 根据用户反馈撤回独立 AlertDialog，复用 Agent 原有 `PermissionBanner` 的队列、按钮、拒绝、失败重试与会话隔离；采纳仍逐次批准且不能永久授权。
- [x] 宿主从当前定义与冻结草案生成真实前后差异，覆盖长提示词的实际变化位置、流程输入绑定/模型字段、步骤顺序及评审标准；草案作者的理由和 Agent 预期不冒充测试结果。
- [x] 新 Agent 采纳工具请求必须提供具体问题及预期收益，可以说明取舍；旧内部调用兼容草案说明。无匹配证据只显示一条验证状态，避免重复堆叠空警告。
- [x] 卡片默认展示前两项实际改动，其余可展开；无新增模型调用或依赖。默认 Skill 递增为 `1.0.9`，系统提示与工具协议同步。
- [x] 修复普通审批切换到采纳时的旧 Enter 监听竞态：同步核对当前会话、请求身份和采纳类型，防止 effect 清理延迟导致误批准。隔离 Electron 冒烟先复现错误审批，再验证修复。
- [x] 超过六项改动时列出其余各类改动的数量，避免模型/契约变更被提示词差异淹没；多项风险超过摘要容量时显示剩余数量，长证据不会挤掉该提示。

本轮综合定向回归：`576 pass / 0 fail`，51 个文件、2151 次断言，日志 `/private/tmp/factory-inline-final-tests.log`。主进程与 renderer 隔离构建成功，产物 `/private/tmp/dutydeck-factory-inline-build`，仅有既有 CJS/import.meta 和 chunk 大小警告。整仓类型检查通过，日志 `/private/tmp/factory-inline-final-typecheck.log`。真实 Electron 隔离冒烟通过，包含无独立全局对话框、具体理由和实际差异、确认/拒绝、旧 Enter handler 隔离、双击防重、失败重试、会话隔离及批次/数据集回归。

开发实例继续运行于 `http://127.0.0.1:5174/`；日志确认工厂默认 Skill 已升级到 `1.0.9`。未发送真实模型消息或操作用户的待采纳草案；旧审核快照需要重新发起采纳才能包含新摘要。
