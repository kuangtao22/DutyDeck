# 项目知识库两步建立与真实文件 Implementation Plan

> **后续修订：** 用户已确认知识库与记忆独立维护，本文中“知识库确认后关闭原记忆写入/转为只读”的要求已被取代。当前交互与恢复范围以 [知识库与记忆独立交互落地](2026-10-08-knowledge-memory-separation.md) 为准。

> **For agentic workers:** 使用 subagent-driven-development 的独立实现与评审方式，按以下步骤持续执行。用户已要求继续实施；保留全部现有未提交改动，不提交、发布或迁移真实用户资料。

**Goal:** 当前 Agent 提出可确认的分组清单，确认后生成大纲与可外部编辑的 Markdown，统一后续知识检索与维护。

**Architecture:** 扩展现有 knowledge manifest 保存草案、已确认分组和大纲，复用项目写租约与来源校验。真实正文位于确认清单展示的项目相对目录；旧不可变条目继续作为历史与索引元数据。Agent 只能提案，确认仅由受信任 UI/IPC 产生。

**Tech Stack:** Bun、TypeScript、Electron、React/Jotai、现有 Radix、JSON/Markdown、safe-file，无新增依赖。

**本轮状态（2026-10-08）：** 核心流程、真实文件、当前 Agent 接入、确认界面及接口文档视图已实现，自动化验证通过；开发版正在运行。真实模型提炼质量、完整界面操作与 Obsidian 互通尚未验收，具体边界见文末。

## Task 1：共享合同与恢复边界

- [x] 在共享类型 `project-knowledge.ts` 与 `project-knowledge-workflow.ts` 增加分组、清单、大纲、真实文档定位及确认输入；分类改为开放字符串，保留旧值兼容。
- [x] 在 `project-knowledge/types.ts` 和 `store.ts` 增加随 manifest 原子保存的 workflow，不另建独立数据库或模型调度器。
- [x] 合同固定：`proposePlan(input)` 只产生草案；`confirmPlan({workspaceId,planId,expectedRevision,groups})` 记录实际选择；`saveOutline(input)` 和 `writeDocument(input)` 校验已确认 plan 与预期版本。
- [x] BDD 覆盖旧 manifest 无 workflow 仍可读，草案写入不产生知识目录，旧确认不能批准新版本。

## Task 2：可读目录与增量同步

- [x] 新建 `project-knowledge/vault.ts` 与测试，复用路径校验、safe-file 和既有事务；根目录在清单明确展示，已有不归属目录不能接管。
- [x] 当前正文以真实路径保存；条目保留历史、内容版本、来源和稳定身份。先大纲后正文，缺失项只显示计划，不创建虚假链接。
- [x] 加入预期内容版本冲突、人工修改保护、外部新增/移动/删除同步、丢失缓存恢复与中断恢复。
- [x] 定向测试覆盖异步拒绝 staleInput，核对人工正文不变；未确认时知识目录不存在；重启读取与搜索使用真实当前正文。

## Task 3：当前 Agent 工具与记忆维护

- [x] 扩展 `project-knowledge-agent-maintenance.ts`、`agent.ts`、`runtime.ts`、`tools.ts`，沿现有会话绑定、写租约、当前用户证据及读页记录校验新写入。
- [x] 工具顺序为读取状态/来源、提出分组、等待 UI 确认、保存大纲、按项写正文；不暴露 Agent 自行确认入口。
- [x] 更新默认 `knowledge-maintenance` Skill 至 1.0.9 及 prompt，普通新对话按相关文档读取；新知识库模式不继续并行产生旧碎片与独立记忆副本。
- [x] 测试未授权模式、取消后迟到写入、伪造依据、来源变化、当前用户纠正和同项目会话恢复。

## Task 4：确认 UI 与四层 IPC

- [x] shared channel/API、`project-knowledge-ipc.ts`、preload 同步添加确认与暂停/继续接口，保留 sender 和工作区双重守卫。
- [x] 将 `ProjectKnowledgeTab` 默认流程改为扫描后调 Agent 提案，清单可选择/改名及自然语言调整，确认成功后同项目 Agent 继续；恢复操作主动派发续接任务。
- [x] 新组件展示大纲、真实目录、待补项与正文；旧来源、历史和记忆置于辅助入口。动态分组不能回到旧七类过滤器。
- [x] UI/IPC 测试部分确认、过期确认、待补不可打开、真实路径、保留草稿和不重复派发。

## Task 5：关联模块与旧资料

- [x] 原 memory 和旧条目保留作来源；确认前继续支持原记忆，建立已确认范围后将写入入口统一到新知识库，旧记忆只读。旧碎片仅在被新正文按确切版本完整引用后从默认列表收起，历史与直接读取保留；未迁移真实用户资料。
- [x] 自身知识目录与 Obsidian 设置排除原始来源扫描；选定资产保留原格式复制，以真实相对链接归档。
- [x] 接口工作台补只读文档视图，从已保存请求定义呈现并遮蔽常见敏感值，不发真实请求；知识库只保留业务背景和入口。

## Task 6：验证与交付

- [x] 先运行新增定向 BDD，再运行涉及的知识库、Agent、IPC、UI 回归：`bun test --isolate <相关测试路径>`。
- [x] `bun run typecheck`、`bun run electron:build`、`git diff --check`。
- [x] 独立规范评审与代码质量评审，修复实际问题后复测对应范围。
- [ ] 开发版真实验证扫描提案、部分确认、大纲、正文、外部编辑和新对话检索；模型结果质量和 Obsidian 互通按实测范围报告。
- [x] 更新 MEMORY 和此计划的完成状态，明确尚未覆盖的真实模型/跨应用验证，不把旧测试结果当作本轮证据。

## 本轮验证证据

- 知识库、Agent、IPC、UI、接口文档回归：209 项通过、0 失败，19 个文件；日志 `/private/tmp/dutydeck-knowledge-files-final-tests.log`。
- 关联 prompt、orchestrator、文件变更统计和 watcher 回归：67 项通过、0 失败；日志 `/private/tmp/dutydeck-knowledge-files-related-tests.log`。
- 最后补充仅依据当前用户决定的正文回归，修复空来源数组被误判为来源丢失；runtime 与真实文件整链重新运行 10 项通过、0 失败（与前述套件部分重叠，不累加为独立用例数）。
- 全部 8 个工作区类型检查与 Electron 完整构建通过；最后的正文新鲜度修复后主进程重新构建通过。日志分别为 `/private/tmp/dutydeck-knowledge-files-final-typecheck.log`、`/private/tmp/dutydeck-knowledge-files-build.log` 和 `/private/tmp/dutydeck-knowledge-files-main-final.log`。
- 开发服务及本仓库 Electron 进程仍在运行；原生 UI 自动化多次读取超时，因此本轮不声称完成真实点击、模型生成或 Obsidian 验证。

## 保留边界与后续验收

- 已实现目录移动的冲突保护、失败回滚与历史保留，但旧整理器的一键撤销尚未接入新知识目录；不能等同于已有 UI 历史恢复功能。
- 移动文档时会修复该文档内部的相对链接；任意手写文档中指向它的反向链接尚未完整验证。
- 外部变化通过有界扫描、文件状态复用和刷新同步，当前不是完整的增量文件事件缓存；知识库自身保存不会触发全项目原始来源重扫。
- 模型提炼质量、真实项目迁移和 Obsidian 打开/复制仍需实测；本轮仅操作临时测试资料，未删除原文件或已有用户知识。
- 上述自动化通过不代表设计稿全部场景均已人工验收，也不承诺每次对话后所有正文都立即更新。
