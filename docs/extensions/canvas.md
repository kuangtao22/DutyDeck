# 画布（Canvas）

> 一句话定位：把一次多步骤交付画成节点图——节点即步骤、连线即依赖，产物有版本、有归属，你随时能看到任务跑到哪一步、用的是哪一版。

## 它解决什么问题

做产品的过程中，「做一个东西」往往不是一步：查资料、写文案、出图、搭一个页面看看效果、不满意再改一版。这些步骤散落在聊天记录、下载文件夹、截图和脑子里，做完一轮之后很难说清三件事：现在用的是哪一版、这一步依赖谁的输出、改了上游以后哪些东西需要跟着改。

画布把这类**多步骤、多产物**的工作收拢到一张图上。它刻意不做「任意节点自动触发的通用工作流引擎」，定位是**普通 Agent 的多模态生产工作区**：Agent 负责理解目标、规划、协调与验收，画布负责保存执行者、产物、版本和它们之间的关系。

![DutyDeck 画布](../assets/screenshots/dutydeck-canvas-demo.png)

## 能做什么

**节点与关系**

- 当前可用节点类型：**Agent**、**图片（生图）**、**文档**、**原型（WebView）**；视频在菜单中显示为「即将支持」，不提供假执行。
- 节点即步骤、连线即依赖：没有连线的节点彼此独立；下游只读取直接入边节点的**已提交快照**；上游变化只把直接下游标记为「待更新」，不会自动触发模型、生图或原型执行。
- 顶部 `+` 每次都打开类型菜单，选择类型后立即创建空节点并选中，但不展开工作台、不自动连线、不启动任务；新节点按全画布最右侧向后追加，不改变当前视口、缩放与已有节点位置。
- 节点侧 `+` 表示「从该节点创建下游并自动连线」，这是建立上下文关系的主要方式。

**三类 Agent 分工**

- **普通 Agent**：你日常对话的那个 Agent，负责理解目标、跨画布总编排与验收。
- **Canvas Agent**：只承担需要长期状态、独立上下文或反复迭代的专业分支，每个 Canvas Agent 是一个真实会话。
- **执行 Agent**：图片这类单次模型调用由不可见的执行 Agent 完成，不占用你的会话列表。

**节点内工作台**

- 所有复杂编辑都在节点内部完成：节点默认保持紧凑固定尺寸，图面始终可读。
- 用户显式展开后，完整工作台以「锚定该节点」的屏幕空间浮窗出现，不改变图布局、节点位置或连线端点；同一画布同一时间只挂载一个完整工作台。
- 工作台内部滚动、列表与输入不会带动画布缩放和平移。

**产物与版本**

- 节点卡片始终展示**正式采用版本**，下游也只消费同一正式版本。
- 新生成结果先形成候选并显示「有新版本」徽标；打开详情后才能比较、采用或放弃，只有采用成功才原子切换卡片与下游输入绑定。
- 图片节点的配置、当前图片、任务、取消、重试与历史版本统一归属 `projectId + canvasId + nodeId + imageModuleId`，不与其他节点串味。
- 批量生成的候选可以整体继续、采用或放弃，不必逐个点。

**执行**

- 可以启动**单个 Canvas Agent**，也可以从指定起点**按依赖运行一次可达下游工作流**；普通 Agent 侧对应 `canvas_run_agent`、`canvas_run_workflow` 工具。
- 图片批量执行仍走独立的 `canvas_run_nodes`，不会被扩张成混合工作流入口。
- 工作流运行可以列出、查看、恢复与取消，运行状态在画布和聊天卡片里都能看到。

**画布管理**

- 左侧覆盖式抽屉承载当前项目的画布新建、切换、设为默认、归档、恢复与删除；只在需要管理时出现，不挤压节点区域，操作完成后自动收起。
- 当前画布标题支持原地编辑；删除当前画布有独立确认，并会阻断仍在运行的任务。

## 典型使用流程

1. 在普通 Agent 对话里把业务目标说清楚，例如「给这个产品做一版介绍文档、三张宣传图和一个移动端活动页」。
2. Agent 建立 Plan，在默认画布中一次创建文档、图片与原型节点，并建立明确关系；文档与原型草稿自动生成，**付费的图片任务汇总成一次审批**，审批里展示节点数量、模型、成本范围与影响对象。
3. 执行期间聊天只更新一张画布任务卡；详细提示词、运行日志、版本和产物留在画布里，不刷屏会话。
4. 需要局部修改时直接说要求，例如「保留页面结构，把目标用户改成大学生，整体更年轻」；Agent 通过 `depends-on` / `reference` 关系找出受影响的文案、图片与页面，只创建这些产物的新 revision，未受影响的节点保持不动。
5. 在画布中比较新旧版本、采用或放弃，需要交付时导出产物。

## 安全与边界

- **数据跟着项目走**：画布的正式数据存放在**项目根目录**下的 `.proma/design/`（`canvases/`、`assets/`、`context/`），可重建缓存放在 `~/.proma/design-cache/<projectId>/`（偏好、缩略图、任务、trace、暂存）。项目可移动、可备份。
- **权限与结构锁**：整理布局、批量改动这类异步操作会在异步边界两侧重新校验当前项目与快照权限；权限变化或节点被占用时中止操作，不覆盖用户的新改动。
- **删除可恢复**：节点删除进入可恢复删除目录（trash），可以列出并恢复；画布删除有独立确认与运行任务阻断。
- **Agent 的权力边界**：普通 Agent 可以控制当前项目已关联画布中的受支持节点，但只能调用按节点类型公开的能力，不能修改会话 ID、素材路径、版本指针、任务 ID、权限上限等内部字段；Agent 不能隐式跨画布读取。
- **第三方 Skill 不越权**：网上下载的专业 `SKILL.md` 通过通用适配器生成本地能力画像，不会获得额外权限、不能注册任意代码，也不能绕过宿主合同。

## 数据存在哪里

- 项目内正式数据：`<项目根>/.proma/design/`
  - `canvases/index.json` 与各画布目录：画布文档、节点内容、事务 tombstone 与可恢复删除目录。
  - `assets/`：画布素材与产物。
  - `context/`：项目创作上下文（`manifest.json`、`documents/`、`references/`）。
- 全局可重建缓存：`~/.proma/design-cache/<projectId>/`（`preferences.json`、`thumbnails/`、`jobs/`、`traces/`、`staging/`）。
- Agent 与画布的关联（默认画布、最近活动画布）由主进程登记，Renderer 只持久化「打开了哪些标签、哪个在前台」这类界面意图，且不构成访问权限。

## 与其他模块的关系

- **与 Agent**：画布是普通 Agent 的生产现场。一个普通 Agent 对话默认维护一张画布；后续相关任务继续进入默认画布，不相关的任务在同一画布建立无连线的独立分支。
- **与运维工作台 / 接口工作台**：没有直接耦合，各自独立；共同点是都沿用本地优先的配置与审批习惯。

## 已知限制

- 视频节点仅占位（菜单显示「即将支持」），没有执行器。
- 画布不是通用工作流引擎：上游变化只标记下游「待更新」，不会自动运行下游。
- 同一画布同一时间只挂载一个完整节点工作台，不允许同时开多个节点浮窗。
- 跨画布读取必须由用户显式关联，Agent 不得隐式跨画布取上下文。

## 相关文档与代码位置

- 设计文档（按时间顺序）：
  - [Canvas 会话与 Agent 创作编排](../superpowers/specs/2026-08-25-canvas-session-agent-orchestration-design.md)
  - [多类型节点与节点内工作台](../superpowers/specs/2026-08-27-canvas-multi-node-workbench-design.md)
  - [生图节点工作台](../superpowers/specs/2026-08-28-canvas-image-workbench-design.md)
  - [产物联动与 WebView 原子写入](../superpowers/specs/2026-08-30-agent-canvas-artifact-handoff-design.md)
  - [Agent 画布生产系统总设计](../superpowers/specs/2026-08-31-agent-canvas-production-system-design.md)
  - [详情浮窗与节点紧凑布局](../superpowers/specs/2026-09-01-canvas-workbench-and-node-layout-design.md)
  - [工作区画布抽屉与标题管理](../superpowers/specs/2026-09-03-canvas-workspace-sidebar-design.md)
  - [Agent Canvas 工作区恢复](../superpowers/specs/2026-09-04-agent-canvas-workspace-persistence-design.md)
  - [Agent 与工作流执行](../superpowers/specs/2026-09-05-canvas-workflow-execution-design.md)
- 渲染层：`apps/electron/src/renderer/components/design/`（节点、工作台、布局与交互）
- 渲染层状态与逻辑：`apps/electron/src/renderer/atoms/native-canvas-atoms.ts`、`canvas-session-atoms.ts`、`canvas-orchestration-atoms.ts`、`apps/electron/src/renderer/lib/agent-canvas-*.ts`
- 主进程：`apps/electron/src/main/lib/design/`（画布存储、产物版本、执行服务、Agent 工具）与 `apps/electron/src/main/lib/agent-canvas-message-preparation.ts`
- 共享合同：`packages/shared/src/types/canvas.ts`、`design.ts`、`canvas-media.ts`、`canvas-workflow-run.ts`
