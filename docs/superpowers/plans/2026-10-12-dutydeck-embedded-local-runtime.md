# DutyDeck 内置本地模型 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 DutyDeck 内部管理 GGUF 模型的下载、校验、加载、测试和停止，并让通过能力验证的本地模型进入现有渠道与模型选择链路。

**Architecture:** 新增显式 `dutydeck-local` provider。主进程维护活动数据根 `models/`（默认 `~/.DutyDeck/models`）下的不可变模型资产清单和单模型 `llama-server` 子进程；llama.cpp 运行环境不随安装包默认下载，由用户在“设置 → 关于/更新 → 可选环境能力”按需下载、校验并安装到共享引擎目录。renderer 只能通过窄 IPC 发起环境/模型操作和读取脱敏状态；模型供应商详情页保留模型下载、加载、测试和启用，安装入口只提供状态与跳转。Pi 仍是唯一 Agent runtime，构建本地模型时由主进程确保对应模型已加载，再通过 OpenAI 兼容回环端点完成消息、流式输出和工具调用。

**实施状态（2026-10-13）：** Task 1–6 已完成，Task 7 的按需引擎管理、关于/更新页环境能力卡片、模型页状态跳转和交互设计稿已补齐；定向 BDD、IPC、运行时、renderer 回归和全仓类型检查均通过。主进程、agent runtime、preload 与 Vite renderer 构建均通过。完整 `electron:build` 不再默认下载引擎，因此可继续验证软件构建；真实引擎归档、GGUF 权重、真实 llama-server 推理、硬件兼容性和四平台安装包仍需在可联网构建机上验证。

**Tech Stack:** Bun、TypeScript、Electron IPC/preload、Jotai、Node `fetch`/`crypto`/`child_process`、现有 `safe-file` 原子 JSON 写入、`llama-server` + GGUF。

---

### Task 1: 建立显式本地模型与 IPC 契约

**Files:**
- Modify: `packages/shared/src/types/channel.ts`
- Create: `packages/shared/src/types/local-model.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/types/local-model.test.ts`

- [x] **Step 1: Write the failing contract test**

覆盖 provider 显式身份、模型状态、能力三态、IPC 通道唯一性和 renderer 不暴露文件路径/令牌。

- [x] **Step 2: Run the focused test**

Run: `bun test packages/shared/src/types/local-model.test.ts`

Expected: FAIL because the local model types and IPC constants do not exist.

- [x] **Step 3: Add the shared types**

新增 `dutydeck-local` provider、模型目录项、资产状态、下载进度、运行状态、能力结果和下载/加载/测试输入。状态必须区分“已下载”“已校验”“未加载”“运行中”和“能力已验证”；快照只返回相对模型 ID、状态和摘要，不返回绝对路径、启动参数或 bearer token。

- [x] **Step 4: Run the focused test**

Run: `bun test packages/shared/src/types/local-model.test.ts`

Expected: PASS.

### Task 2: 实现本地模型资产存储和版本清单

**Files:**
- Modify: `apps/electron/src/main/lib/config-paths.ts`
- Create: `apps/electron/src/main/lib/local-model-store.ts`
- Create: `apps/electron/src/main/lib/local-model-store.test.ts`

- [x] **Step 1: Write tests for persistence and recovery**

使用临时配置根验证：首次加载得到空清单；下载临时文件不能出现在已安装列表；SHA-256 不匹配不会登记；校验成功后原子登记；重启后重复登记保持幂等；未知字段保留；模型目录固定在活动数据根 `models/` 下（默认 `~/.DutyDeck/models`）。

- [x] **Step 2: Run the focused test**

Run: `bun test apps/electron/src/main/lib/local-model-store.test.ts`

Expected: FAIL until the store and path helper exist.

- [x] **Step 3: Implement the store**

使用 `safe-file.ts` 的原子 JSON 写入。模型文件以 `assetId/revision` 隔离，清单记录来源、文件名、SHA-256、许可、架构、量化、模板、兼容引擎和能力证据。写入成功后再删除临时文件；损坏清单 fail closed 并保留可诊断错误。

- [x] **Step 4: Run the focused test**

Run: `bun test apps/electron/src/main/lib/local-model-store.test.ts`

Expected: PASS.

### Task 3: 实现下载、校验与 llama-server 生命周期

**Files:**
- Create: `apps/electron/src/main/lib/local-model-runtime.ts`
- Create: `apps/electron/src/main/lib/local-model-runtime.test.ts`
- Modify: `apps/electron/src/main/lib/config-paths.ts`

- [x] **Step 1: Write lifecycle tests**

通过注入的 HTTP 下载器和 fake `llama-server` 验证：下载进度、取消不登记半文件、校验失败可重试、单模型互斥、加载超时回收、健康检查后才进入 running、停止释放子进程、子进程异常转为 error、能力测试不改变 enabled 状态。

- [x] **Step 2: Run the focused test**

Run: `bun test apps/electron/src/main/lib/local-model-runtime.test.ts`

Expected: FAIL because lifecycle service is not present.

- [x] **Step 3: Implement the service**

主进程使用 `AbortController` 取消下载，临时文件写入模型目录下的 staging 子目录；使用 SHA-256 流式计算并在通过后调用 store 原子登记。启动时只允许一个模型，随机回环端口和短期认证令牌只保留在主进程；轮询 `/health` 成功后才允许推理。停止、取消、超时和 `exit` 事件都必须清除进程与运行状态。测试调用 `/v1/chat/completions`，同时检查普通回复、工具调用和 JSON 输出能力。

- [x] **Step 4: Run the focused test**

Run: `bun test apps/electron/src/main/lib/local-model-runtime.test.ts`

Expected: PASS.

### Task 4: 接入四层 IPC

**Files:**
- Modify: `packages/shared/src/types/local-model.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/preload/index.ts`
- Create: `apps/electron/src/main/lib/local-model-ipc.test.ts`

- [x] **Step 1: Write IPC contract tests**

验证 list/catalog/download/cancel/start/stop/test handler 都调用 runtime service；事件只推送脱敏快照；非法 asset ID、越界路径和重复操作被拒绝。

- [x] **Step 2: Run the focused test**

Run: `bun test apps/electron/src/main/lib/local-model-ipc.test.ts`

Expected: FAIL until handlers and preload bridge exist.

- [x] **Step 3: Implement handlers and bridge**

在 shared 常量中定义 `local-model:*` 通道；ipc handler 复用现有 renderer 身份校验和错误归一化；preload 仅返回结构化快照和取消函数。不要把 `llama-server` 路径、命令行参数、下载 token 或明文模型仓库凭据传给 renderer。

- [x] **Step 4: Run the focused test**

Run: `bun test apps/electron/src/main/lib/local-model-ipc.test.ts`

Expected: PASS.

### Task 5: 让本地模型进入渠道和 Pi 模型注册

**Files:**
- Modify: `packages/shared/src/types/channel.ts`
- Modify: `apps/electron/src/main/lib/channel-manager.ts`
- Modify: `apps/electron/src/main/lib/agent-model-selection.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-model-registry.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-agent-adapter.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-model-registry.test.ts`

- [x] **Step 1: Write model routing tests**

验证本地渠道只接受已登记且 enabled 的 asset；未加载模型先由 runtime 加载；能力为 unknown/unavailable 的模型不能进入 Agent；停止或失效模型不会静默切换到云端；Pi 注册使用实际上下文窗口和最大输出，不套用 200K 默认。

- [x] **Step 2: Run the focused test**

Run: `bun test apps/electron/src/main/lib/adapters/pi-model-registry.test.ts apps/electron/src/main/lib/local-model-channel.test.ts`

Expected: FAIL until local provider routing exists.

- [x] **Step 3: Implement explicit routing**

`dutydeck-local` 走 OpenAI Completions 适配器，`buildModel` 在注册 provider 前向 runtime 请求受管 endpoint；apiKey 使用主进程短期 token。能力快照绑定 asset hash、engine version、template、context 和 probe version，任一输入变化即失效。历史会话保留原 channel/model 引用，不自动替换。

- [x] **Step 4: Run the focused test**

Run: `bun test apps/electron/src/main/lib/adapters/pi-model-registry.test.ts apps/electron/src/main/lib/local-model-channel.test.ts`

Expected: PASS.

### Task 6: 更新模型配置页和选择器

**Files:**
- Modify: `apps/electron/src/renderer/components/settings/ChannelSettings.tsx`
- Modify: `apps/electron/src/renderer/components/settings/ChannelForm.tsx`
- Modify: `apps/electron/src/renderer/components/chat/ModelSelector.tsx`
- Create: `apps/electron/src/renderer/components/settings/LocalModelSettings.tsx`
- Create: `apps/electron/src/renderer/atoms/local-model-atoms.ts`
- Create: `apps/electron/src/renderer/lib/local-model-state.ts`
- Create: `apps/electron/src/renderer/lib/local-model-state.test.ts`

- [x] **Step 1: Write renderer state tests**

验证下载、校验、加载、运行、错误、停止状态映射；模型测试按钮为每行唯一入口；测试不改变启用开关；无模型和能力未验证状态有明确空态与阻断文案。

- [x] **Step 2: Run the focused test**

Run: `bun test apps/electron/src/renderer/lib/local-model-state.test.ts`

Expected: FAIL until state mapping exists.

- [x] **Step 3: Implement the UI**

在现有“模型配置”渠道详情页中增加 DutyDeck 本地运行时区块，沿用 Settings primitives；模型目录、任务、测试、启用和停止集中在该供应商详情内。ModelSelector 按现有渠道分组显示“DutyDeck 本地”，只有能力已验证且 channel/model enabled 的模型可选。

- [x] **Step 4: Run the focused test**

Run: `bun test apps/electron/src/renderer/lib/local-model-state.test.ts`

Expected: PASS.

### Task 7: 按需安装本地引擎并完成发行边界检查

**Files:**
- Modify: `apps/electron/electron-builder.yml`
- Create: `apps/electron/src/main/lib/local-model-engine-manager.ts`
- Create: `apps/electron/src/main/lib/local-model-engine-manager.test.ts`
- Modify: `.omx/plans/local-model-project-design.html`
- Modify: `.omx/plans/local-model-planning-agent-interactive.html`
- Create: `docs/superpowers/reports/2026-10-12-dutydeck-embedded-local-runtime.md`

- [x] **Step 1: Run focused BDD tests**

Run: `bun test packages/shared/src/types/local-model.test.ts apps/electron/src/main/lib/local-model-store.test.ts apps/electron/src/main/lib/local-model-runtime.test.ts apps/electron/src/main/lib/local-model-ipc.test.ts apps/electron/src/main/lib/local-model-channel.test.ts apps/electron/src/main/lib/local-model-engine.test.ts apps/electron/src/main/lib/adapters/pi-model-registry.test.ts apps/electron/src/renderer/lib/local-model-state.test.ts apps/electron/src/renderer/atoms/local-model-atoms.test.ts apps/electron/src/renderer/components/settings/LocalModelSettings.test.tsx apps/electron/src/renderer/components/chat/ModelSelector.local-model.test.ts`

Expected: all pass.

- [x] **Step 2: Run repository typecheck**

Run: `bun run typecheck`

Expected: all workspaces pass without `any` or preload contract drift.

- [x] **Step 3: Run the Electron build boundary check**

Run: `bun run typecheck`、`bun test apps/electron/src/main/lib/local-model-engine-manager.test.ts`、`node --check /private/tmp/local-model-design.js`

结果：按需引擎管理器、共享契约、renderer 状态和交互设计稿通过定向检查；默认构建不再隐式下载真实引擎，完整安装包仍需在可联网构建机验证引擎资源下载和签名流程。

- [x] **Step 4: Record evidence and remaining limits**

记录实际测试覆盖、平台/后端限制、没有下载真实权重的测试替代物，以及模型许可和引擎构建哈希。不得把 fake server 或静态能力声明写成硬件兼容性结论。
