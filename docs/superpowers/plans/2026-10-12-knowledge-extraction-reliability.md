# 知识提炼可靠性与内容准入实施计划

> 执行方式：本会话持续完成，按独立文件所有权并行实施并汇总验证；用户已于 2026-10-12 以“请开始吧”批准实施，不重复请求实施确认。

**Goal:** 可靠逐篇保存知识，内容按价值、证据和业务边界准入；中断和局部失败可恢复。

**Architecture:** 复用当前普通 Pi 会话、主进程写租约和原子 JSON 清单。来源短引用只属于当前运行；内容评估绑定正文与证据版本；宿主管理最多三回合和十分钟活跃额度，续接使用已有 deferred queue。

**Tech Stack:** Bun、TypeScript、Electron、React/Jotai；不新增依赖。

## 范围与已有改动

保留当前工作区工厂和会话失败提示等已有修改；只更改知识库及必要的 Agent 生命周期接点。不操作真实知识库，不调用真实模型，不提交或发布版本。固定真实材料的语义实验需要单独明确模型/预算，离线行为与固定材料检查本轮完成。

## 任务与验收

- [x] 共享合同：`packages/shared/src/types/project-knowledge-{workflow,admission,execution}.ts`；逐项 sources/dependencyState、准入评估、执行状态互不混用。
- [x] 内容准入：`project-knowledge/vault.ts`、`service.ts` 与新 admission helper；BDD 覆盖真实引文但正文断言不匹配、缺口降级、未评估默认排除/显式可读、来源变化失效、旧正文保留。先运行失败测试，再实现并复验。
- [x] 短引用：`project-knowledge-agent.ts`、`project-knowledge-agent-maintenance.ts`、`project-knowledge-tools.ts` 与新 references helper；BDD 覆盖跨运行引用拒绝、页证据复验、旧接口互斥、状态 offset、单项失败继续、正文仅真实变化计进展。
- [x] 宿主执行：新增 `project-knowledge-execution.ts`、测试；runtime、IPC、preload、orchestrator 接点。BDD 覆盖三回合预算、重复页无进展、暂停只取消本任务、迟到回执、重启不自动调用、完成要求准入、精确用户证据。
- [x] UI：`KnowledgeWorkflowPanel.tsx`、`ProjectKnowledgeTab.tsx`、`KnowledgeFileTree.tsx` 及相关测试。展示真实状态、准入结论、用途/章节/来源/缺口，局部重试，事件更新与低频补偿；missing 显示文件已删除。
- [x] Skill：升级 `knowledge-maintenance` patch 版本；明确逐篇产出、业务质量与证据类型、局部恢复，禁止空引用绕过失败。
- [x] 集成：检查四层 IPC、工具权限、普通会话/自动化隔离；执行知识库定向回归、`bun run typecheck`、`bun run electron:build`；完成差异审查，记录真实验证缺口。

## 执行记录

2026-10-12：已读取约束、当前方案与主要业务链路。Nowledge 定向搜索不可达。已把内容准入、工具引用分给有独立文件所有权的原生子代理；主代理负责生命周期与最终验证。

2026-10-12 实施结果：宿主短来源/页/流程/目标引用；分组与单项详情分页；稳定错误分类；逐项依赖与局部恢复；执行预算跨轮累计并限制重复恢复；排队取消和预检失败的精确终态；暂停及事务锁内代次复验；固定渠道/模型选择；重启仅显示中断。内容准入绑定实际落盘正文与证据，原用户消息按文本 SHA-256 精确复核，未评估或失效内容不进入默认上下文。UI 展示真实状态、保存与达标数、业务评估和局部重试。默认 Skill 升至 1.0.11。

## 验证与剩余边界

- 最终逐文件隔离执行全部知识、准入、来源、执行器、runtime、IPC、队列和 renderer 回归：288 pass / 0 fail（22 文件）。分进程执行避免 Bun mock.module 跨文件污染；observer 单独执行亦通过。日志 `/tmp/knowledge-all-isolated.log`。
- Electron 隐藏窗口与内存 fixture 冒烟通过：宿主执行、无 pendingPrompt、持久会话恢复、blocked 通知、准入详情、单项重试、规划会话、来源复扫及记忆 CAS/跨 Tab/窄屏隔离；未连接真实模型或真实知识库。
- `bun run typecheck` 已执行：知识相关文件无诊断；全仓仍受并行本地模型代码的类型错误阻塞（`local-model-runtime.test.ts`、`pi-model-registry.ts`、`LocalModelSettings.tsx`）。日志 `/tmp/knowledge-typecheck-postall.log`。
- 完整 `bun run electron:build` 通过。首跑因沙箱禁止默认 Swift 缓存写入失败，改用 `/private/tmp` 的 `CLANG_MODULE_CACHE_PATH` 与 `SWIFT_MODULECACHE_PATH` 后通过，最终代码再次完整构建通过，日志 `/tmp/knowledge-build-verified.log`。
- 默认检索只复核当前结果页，首页复核并发最多四条；`total` 表示候选数，不代表全库实时达标数。结构校验与同模型自查不是独立语义事实证明，真实样本提炼质量、首篇耗时和费用实验未执行。
- 用户于 2026-10-12 追加授权 Git 提交；仅提交本次知识库与必要集成改动，保留其他并行任务内容。发布与推送不属于本次提交操作。

2026-10-12 提交前验证：从 HEAD 与本任务的 50 个相关文件/改动块构造独立提交快照，22 文件的 288 项回归再次全部通过；公共文件内的本地模型、工厂及其他改动不进入本提交。该快照的共享包等七个工作区类型检查通过；Electron 检查与其他会话多份检查并发，近五分钟未完成，主动结束本次检查，不能宣称全量类型检查通过。日志 `/private/tmp/knowledge-commit-tests.log`、`/private/tmp/knowledge-commit-typecheck.log`。
