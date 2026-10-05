# Proma 存储清理实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不误删用户项目、凭据和仍可恢复的会话的前提下，清理 Proma 长期累积的会话工作目录、Agent JSONL 和未引用 Pi artifact，并让界面显示真实可回收空间。

**Architecture:** 将清理拆成“只读扫描 → 用户确认 → 二次校验 → 有界删除”四个阶段。清理资格由会话索引、运行中会话状态、Pi artifact 引用关系和文件年龄共同决定；工作区级元数据与外部项目根始终不在自动删除范围内。启动自动清理只处理用户显式开启且超过宽限期的已归档会话，所有大规模扫描放在后台并限制并发与文件数。

**Tech Stack:** Bun、TypeScript、Electron 主进程 IPC、React、Jotai 现有设置页、`safe-file.ts` 原子写入、现有 `rmSyncWithRetry` 文件清理封装。

---

## 范围与不变量

### 本计划包含

- `~/.proma/agent-sessions/*.jsonl` 的归档会话清理。
- `~/.proma/agent-workspaces/<workspace>/<sessionId>/` 的会话工作目录清理。
- `~/.proma/sdk-config/sessions/` 中 Pi artifact 的引用感知回收。
- 孤儿文件/目录的只读扫描、预览、显式清理和失败重试。
- 磁盘管理界面的真实可回收空间、候选列表、确认和结果展示。
- 启动时自动清理的正确接线与保守默认值。

### 本计划不包含

- 不删除用户选择的外部 `projectRootPath`、附加目录或附加文件。
- 不删除 `workspace-files/`、`skills/`、`skills-inactive/`、`.claude/`、`.context/`、`plan/`、`todo.md`、`note.md`、`handoff.md`。
- 不删除凭据、渠道配置、服务端配置、附件和对话正文。
- 不在本轮改写活动 JSONL 格式，也不引入压缩依赖；流式快照压缩另做独立方案。
- 不在启动主线程同步递归扫描几十 GB 的目录。

### 当前实现事实

- [storage-service.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/main/lib/storage-service.ts:531) 的归档清理目前只删除 Agent JSONL。
- [storage-service.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/main/lib/storage-service.ts:584) 将 `sdk-config` 当作清理入口，但实际仍重复调用 Agent JSONL 清理，没有回收 Pi artifact。
- [agent-session-manager.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/main/lib/agent-session-manager.ts:992) 删除会话时会删除 JSONL 和会话工作目录，但不会删除 `piSessionFile`。
- [StorageSettings.tsx](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/renderer/components/settings/StorageSettings.tsx:210) 的“SDK 数据”文案与实际清理行为不一致。
- 当前 `ORPHAN_DATA_CLEANUP_ENABLED` 为 `false`，这是正确的默认安全方向，但需要改成“只读扫描默认开启、删除必须显式确认”。

## 文件边界

- 修改 `apps/electron/src/main/lib/storage-service.ts`：保留 IPC 门面和统计聚合，调用新的清理核心。
- 新建 `apps/electron/src/main/lib/storage-cleanup.ts`：纯文件系统清理策略、候选计算、引用图、二次校验和删除结果。
- 新建 `apps/electron/src/main/lib/storage-cleanup.test.ts`：使用临时数据根覆盖正常、边界、竞态和失败恢复。
- 修改 `apps/electron/src/main/lib/agent-session-manager.ts`：暴露只读会话引用快照与删除后 artifact 清理所需的安全接口，不让 storage service 重新解析索引。
- 修改 `apps/electron/src/main/lib/config-paths.ts`：增加 Pi artifact 目录路径函数，所有路径仍绑定活动数据根。
- 修改 `apps/electron/src/types/settings.ts`：补齐 typed storage request/response 与可选的自动清理宽限期设置。
- 修改 `apps/electron/src/main/ipc.ts`：接入扫描、预览、确认清理和启动自动清理，启动只触发有界任务。
- 修改 `apps/electron/src/preload/index.ts`：将存储 API 从 `unknown` 改为具体类型。
- 修改 `apps/electron/src/renderer/components/settings/StorageSettings.tsx`：展示可回收候选、清理范围、确认状态和错误结果。
- 新建 `apps/electron/src/renderer/components/settings/StorageSettings.test.tsx`：验证候选展示、确认和失败状态。
- 必要时修改 `apps/electron/src/main/lib/agent-renderer-session-access.test.ts`：同步新增存储 IPC 的受管通道白名单断言。

## 实施步骤

### Task 1: 固定清理数据模型和安全边界

**Files:**
- Create: `apps/electron/src/main/lib/storage-cleanup.ts`
- Modify: `apps/electron/src/types/settings.ts`
- Modify: `apps/electron/src/main/lib/config-paths.ts`
- Test: `apps/electron/src/main/lib/storage-cleanup.test.ts`

- [ ] **Step 1: 定义候选和结果类型**

在 `storage-cleanup.ts` 定义以下类型，所有字段使用明确的联合类型，不使用 `any`：

```ts
export type StorageCleanupKind = 'agent-session' | 'workspace-session' | 'pi-artifact'
export type StorageCleanupMode = 'archived' | 'orphaned'

export interface StorageCleanupOptions {
  mode: StorageCleanupMode
  beforeDays: number
  gracePeriodMs: number
  maxCandidates: number
}

export interface StorageCleanupCandidate {
  kind: StorageCleanupKind
  id: string
  path: string
  bytes: number
  updatedAt: number
  reason: 'archived-expired' | 'unreferenced-expired' | 'missing-index'
  workspaceSlug?: string
  sessionId?: string
}

export interface StorageCleanupPreview {
  generatedAt: number
  mode: StorageCleanupMode
  gracePeriodMs: number
  candidates: StorageCleanupCandidate[]
  reclaimableBytes: number
  truncated: boolean
}

export interface StorageCleanupResult {
  operationId: string
  freedBytes: number
  deletedCount: number
  skippedCount: number
  errors: string[]
}
```

清理核心只接受“当前活动数据根、会话引用快照、运行中会话 ID、当前时间和宽限期”作为输入；不接受 renderer 传入的任意路径。

- [ ] **Step 2: 增加安全路径函数**

在 `config-paths.ts` 增加只返回路径、不创建目录的函数：

```ts
export function getPiSessionsDir(): string {
  return join(getSdkConfigDir(), 'sessions')
}

```

所有候选路径必须通过 `resolveContainedDataFile` 或同等的根目录包含校验；路径不在活动数据根内时直接标记错误，不删除。

- [ ] **Step 3: 写安全边界测试**

在 `storage-cleanup.test.ts` 先写失败测试并运行：

```bash
bun test apps/electron/src/main/lib/storage-cleanup.test.ts
```

测试至少覆盖：

- 活跃会话不生成候选。
- 未归档会话不生成 `archived-expired` 候选。
- `updatedAt` 在宽限期内的归档会话不生成候选。
- 外部路径、路径穿越、符号链接逃逸均返回错误且不删除。
- 当前 workspace 级 `workspace-files`、`skills`、`.claude` 不进入会话候选。

- [ ] **Step 4: 实现最小纯函数逻辑并重跑测试**

实现候选筛选、路径归一化和安全边界，不接入 IPC 或自动删除。预期该测试文件全部通过。

### Task 2: 建立引用感知的 Pi artifact 扫描

**Files:**
- Modify: `apps/electron/src/main/lib/agent-session-manager.ts`
- Modify: `apps/electron/src/main/lib/storage-cleanup.ts`
- Test: `apps/electron/src/main/lib/storage-cleanup.test.ts`

- [ ] **Step 1: 暴露只读引用快照**

在 `agent-session-manager.ts` 增加只读函数，返回每个会话的 `id`、`archived`、`updatedAt`、`workspaceId`、`piSessionFile`，不把内部索引对象直接暴露给调用方。引用快照必须是深拷贝或只读投影，防止清理服务修改缓存。

- [ ] **Step 2: 实现 Pi 引用图**

扫描 `getPiSessionsDir()` 时建立绝对路径集合：

1. 所有当前索引会话的 `piSessionFile`。
2. 所有运行中会话的 artifact 路径。
3. 当前清理操作中已锁定的候选路径。

只有“不在引用集合、文件是普通文件、修改时间早于宽限期、文件名符合 Pi session artifact 规则”的文件才能成为 `unreferenced-expired` 候选。

- [ ] **Step 3: 写引用保护测试**

测试以下场景：

- 一个 Pi 文件被活跃会话引用时必须保留。
- 一个 Pi 文件被两个会话引用时，删除任一归档会话都不能删除该文件。
- 被删除会话唯一引用的旧 Pi 文件才进入候选。
- 最近修改但暂时无引用的文件因宽限期保留。
- 非 JSONL、目录、损坏路径和符号链接不被误删。

- [ ] **Step 4: 增加老版本兼容策略**

历史 Claude artifact 和 `sdk-config/projects`、`file-history` 继续保留；扫描报告将其标记为“未纳入自动清理”，不能因为当前 Pi 索引没有引用就删除。

### Task 3: 实现会话、工作目录和 artifact 的有界清理

**Files:**
- Modify: `apps/electron/src/main/lib/storage-cleanup.ts`
- Modify: `apps/electron/src/main/lib/agent-session-manager.ts`
- Modify: `apps/electron/src/main/lib/storage-service.ts`
- Test: `apps/electron/src/main/lib/storage-cleanup.test.ts`

- [ ] **Step 1: 增加扫描入口**

实现 `previewStorageCleanup(options)`，其中 `options.mode` 明确区分 `archived` 与 `orphaned`：

- `archived` 模式只扫描已归档且超过宽限期的会话。
- `orphaned` 模式只扫描索引中不存在、名称符合会话 ID 规则且超过更长宽限期的 JSONL、工作目录和 Pi artifact；该模式只能由用户在磁盘管理界面显式触发，不能被启动自动清理调用。
- 每个工作区、会话和 artifact 都有独立候选项。
- 限制最大候选数量和单次文件扫描数量，达到上限时返回 `truncated: true`。
- 统计值使用实际 `stat.size`；扫描失败的文件不估算为零，而是进入错误列表。
- 扫描过程使用异步 `fs/promises`，不在主进程同步递归大目录。

- [ ] **Step 2: 增加删除入口**

实现 `cleanupStoragePreview(preview, options)`，删除前逐项重新校验：

1. 会话仍存在且 `archived === true`。
2. `updatedAt` 与预览快照一致，避免用户确认后会话被重新使用。
3. 会话不在运行、排队、恢复或删除状态。
4. 路径身份、大小和修改时间仍与预览一致。
5. 删除会话时复用 `deleteAgentSession` 的工作目录和 JSONL 清理语义。
6. 会话删除成功后，再运行引用扫描决定是否删除对应 Pi artifact。

任何一项校验失败只跳过当前候选并记录错误，不影响其他候选，也不报告未释放的空间。

- [ ] **Step 3: 处理删除失败和重试**

每个候选独立返回状态；删除失败保留原文件和索引，不通过“写空文件”或强制修改索引来掩盖失败。重复执行同一预览必须幂等：已经删除的候选计为 skipped，不报为错误。孤儿数据不建立应用内回收站，避免清理后仍占用同样空间；界面必须在执行前显示“不可恢复删除”的明确提示，建议用户先备份活动数据根。

- [ ] **Step 4: 写清理测试**

测试至少覆盖：

- 正常清理归档会话同时释放 JSONL 与会话工作目录。
- 清理不会触碰 workspace 级 `workspace-files`、Skills 和上下文资料。
- 确认前会话被解归档或产生新消息时，清理跳过该会话。
- 一个候选删除失败时，其余候选仍继续处理。
- Pi artifact 只有在所有索引引用消失后才释放。
- 释放字节数、删除数量、跳过数量和错误数量与实际结果一致。

### Task 4: 修正 IPC 和启动自动清理接线

**Files:**
- Modify: `apps/electron/src/types/settings.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/preload/index.ts`
- Modify: `apps/electron/src/main/lib/agent-renderer-session-access.test.ts`
- Test: `apps/electron/src/main/lib/storage-cleanup.test.ts`

- [ ] **Step 1: 扩展 typed IPC 合同**

保留现有 `GET_STATS`、`CLEANUP_TEMP`，将 `CLEANUP` 的参数改为具体类型，并新增：

- `storage:preview-cleanup`：只读返回候选。
- `storage:execute-cleanup`：接收预览 ID、候选 ID 和宽限期，返回清理结果。

`preload/index.ts` 的 `getStorageStats`、`cleanupStorage` 不再使用 `Promise<unknown>`。

- [ ] **Step 2: 保护 renderer 输入**

主进程只接受候选 ID、清理模式和合法天数，不接受绝对路径、shell 命令或任意删除目标。候选 ID 由主进程生成并绑定当前活动数据根、索引版本和预览时间；`orphaned` 模式必须额外收到用户确认标记，启动自动清理永远拒绝该模式。

- [ ] **Step 3: 修正启动清理语义**

`runStartupCleanup()` 继续默认清理临时预览/安装文件；`autoCleanupArchivedDays` 大于 0 时调用新的预览与执行服务，默认宽限期设置为 24 小时，并且只处理：

- 已归档。
- 超过配置天数。
- 不在运行状态。
- 二次校验通过。

启动任务失败只记录日志，不阻断应用启动；单次任务必须有最大执行时长和最大候选数。

- [ ] **Step 4: 同步访问策略测试**

更新存储 IPC 的受管通道白名单测试，验证 renderer 能调用统计、预览和执行，但不能传任意路径删除文件。

### Task 5: 重做磁盘管理界面

**Files:**
- Modify: `apps/electron/src/renderer/components/settings/StorageSettings.tsx`
- Create: `apps/electron/src/renderer/components/settings/StorageSettings.test.tsx`

- [ ] **Step 1: 展示“总量”和“可回收量”**

每个类别同时显示总占用与可回收占用。`SDK 会话数据` 改为明确的“Pi 会话 artifact”，归档 JSONL 与会话工作目录分别显示，避免用户误以为一次清理会覆盖全部数据。

- [ ] **Step 2: 增加预览流程**

用户选择“清理已归档会话”后先调用预览 IPC，展示：

- 可释放总大小。
- 会话标题、所属项目、最后更新时间。
- 会删除的目录类型：消息、会话工作目录、未引用 Pi artifact。
- 被保护的工作区级内容说明。
- 扫描被截断或部分失败时的明确提示。

- [ ] **Step 3: 增加显式确认和结果**

确认按钮必须带出预计释放空间；执行期间禁止重复提交。结果显示实际释放、删除、跳过和错误数量，并提供刷新入口。用户取消确认时不产生任何删除动作。

- [ ] **Step 4: 编写 renderer 回归测试**

测试：

- 无候选时不展示危险确认按钮。
- 预览结果正确显示可释放大小和会话标题。
- 用户取消不会调用执行 IPC。
- 执行失败保留候选列表并展示错误。
- 执行成功后刷新统计并清除旧预览。

### Task 6: 自动清理设置和默认值

**Files:**
- Modify: `apps/electron/src/types/settings.ts`
- Modify: `apps/electron/src/renderer/components/settings/StorageSettings.tsx`
- Modify: `apps/electron/src/main/ipc.ts`
- Test: `apps/electron/src/main/lib/storage-cleanup.test.ts`

- [ ] **Step 1: 保持安全默认值**

`autoCleanupArchivedDays` 默认继续为 `0`，避免升级后突然删除历史。用户选择 7/30/90 天后，设置描述必须明确“仅清理已归档会话及其 Proma 托管工作目录，不删除外部项目根”。

- [ ] **Step 2: 增加运行日志摘要**

自动清理只记录数量、字节数、跳过数和错误码，不记录会话正文、凭据或完整用户路径。日志必须在单次任务结束后汇总，避免每个文件写一条日志造成额外 I/O。

- [ ] **Step 3: 验证升级兼容**

缺少新设置字段时沿用旧默认值；非法天数、损坏预览 ID 和旧版本预览必须 fail closed，不执行删除。

### Task 7: 验收和发布前检查

**Files:**
- Test: `apps/electron/src/main/lib/storage-cleanup.test.ts`
- Test: `apps/electron/src/renderer/components/settings/StorageSettings.test.tsx`
- Check: `apps/electron/src/main/lib/agent-renderer-session-access.test.ts`

- [ ] **Step 1: 运行定向测试**

```bash
bun test apps/electron/src/main/lib/storage-cleanup.test.ts
bun test apps/electron/src/renderer/components/settings/StorageSettings.test.tsx
```

预期：全部通过，且测试只使用临时数据根，不读取或删除真实 `~/.proma`。

- [ ] **Step 2: 运行类型检查**

```bash
bun run typecheck
```

预期：新增 storage IPC、preload 和 renderer 类型全部通过；若出现既有无关错误，必须单独记录，不把它们归因于清理功能。

- [ ] **Step 3: 进行真实只读扫描**

在开发实例中只执行预览，不执行删除，确认：

- 统计结果与 `du` 的主要目录量级一致。
- 活跃会话、置顶会话和最近更新会话不在候选中。
- 当前实例中最大的归档工作目录能显示标题、项目和大小。
- Pi artifact 被引用时不会显示为可回收。

- [ ] **Step 4: 进行小规模真实清理**

在已备份的数据根中选择一个明确的旧归档会话，确认后执行；核对 JSONL、会话工作目录和唯一 Pi artifact 均被清理，外部项目根和工作区级资料仍存在。之后重启应用并验证历史列表、会话恢复和新会话创建。

- [ ] **Step 5: 运行构建检查**

```bash
bun run electron:build
```

只有主进程、preload 和 renderer 构建通过，并完成一次真实启动/预览/小规模清理验证后，才允许开启默认自动清理设置；发布说明是否更新另行确认，不在本计划自动修改。

## 执行顺序与用户影响

1. 先完成 Task 1–2，只读扫描和引用保护，用户数据不会被删除。
2. 再完成 Task 3–5，提供显式预览和确认；这是释放当前几十 GB 空间的主要阶段。
3. 最后完成 Task 6–7，默认仍关闭自动归档清理，用户主动选择保留期限后才自动运行。

性能上，扫描和删除都必须异步、有界、可中断；不在每次启动同步遍历 50 GB 工作区。Pi artifact 引用扫描的开销与会话索引和 artifact 文件数量线性相关，适合在设置页刷新、用户确认前和空闲启动阶段运行。清理后会减少后续会话索引读取、文件列表和备份的 I/O，但删除大型目录本身可能短暂占用磁盘 I/O。

## 当前机器的首次清理建议

- 第一批只选超过 30 天、已归档且不再需要的会话，预计优先释放 `agent-workspaces` 和 `agent-sessions`。
- 第二批在引用扫描通过后处理未引用 Pi artifact；不能直接删除整个 `sdk-config/sessions`。
- 不要把 `node_modules`、外部项目构建目录或用户附件交给 Proma 的会话清理器；它们应由项目级清理脚本或系统磁盘工具单独管理。
