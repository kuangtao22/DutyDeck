# 交互设计模块功能对齐与资源架构实施计划

> **实施状态（2026-10-14 更新）**：用户随后要求开始，并指定按 V3 样式接入。当前已完成正式工作区、版本/候选/资源持久化、主会话 Pi 工具与项目源码还原入口。下面保留原始规划作为范围依据，其中“尚未实施”描述属于规划时点；不能把全部远期验收项视为已完成。实际交付和边界见 [本轮实施记录](../../../.omx/reports/2026-10-14-interaction-design-implementation.md)。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将已确认的 V3 可点击原型收敛为 DutyDeck 的正式交互设计模块合同，明确页面、流程、Agent 候选、图片资源和交付版本的归属，使后续实现能逐步接入而不改变 Canvas、会话和现有资源的语义。

**Architecture:** 模块作为项目级工作区工具接入现有 DutyDeck shell，继续使用主会话和 Pi Agent；原型拥有独立的 `prototypeId/pageId/groupId/elementId/revisionId` 身份，页面目录以工作区内覆盖层呈现，预览只运行当前页面。正式内容和图片放在项目根 `.proma/interaction-design/`，预览缓存和界面偏好分开存入活动用户数据根；Agent 修改先生成绑定基线的候选，用户采纳后才原子提交 head。

**Tech Stack:** Electron 主进程、React renderer、Jotai、Radix/shadcn primitives、Bun、现有 `safe-file.ts` 原子写、Pi Agent runtime、现有 HTML sandbox 与媒体生成服务。

---

## 0. 范围和已经确定的事实

本计划只规划正式功能，**不接入生产代码，不修改已经确认的 V3 HTML，不接触真实项目数据**。V3 HTML 是交互依据，不是生产服务的实现证明；其中 Agent 回复、生成等待、候选和检查结果仍是模拟体验。

业务定位：在当前项目内，把需求变成可点击、可修改、可回看、可交接的 App / Web 原型。完成标准是一条目标业务路径及其关键状态能被演示，且能指出固定版本、模拟范围和未覆盖项。本轮交付功能和架构规划，下面的任务是分阶段验收范围，未展开为完整生产补丁。

当前事实来自以下源码和原型：

| 事实 | 依据 | 对设计的影响 |
| --- | --- | --- |
| 工作区组件是项目级内容，并在当前会话右侧工作区呈现 | `apps/electron/src/renderer/atoms/agent-atoms.ts` 的 `WorkspaceComponentTab`；`workspace-tools.ts` | 交互设计应新增一个项目级工具入口，不能在页面里再造孤立应用壳或聊天历史 |
| 项目正式路径由 workspace slug 解析，不能把 workspace ID 直接拼成路径 | `apps/electron/src/main/lib/agent-workspace-manager.ts:getProjectFilesPath`；`config-paths.ts:getConfigDir` | 所有路径必须经过 resolver；`workspaceId` 只作为身份，不能当目录名 |
| Canvas 资产删除/恢复只看 Canvas 文档引用 | `design-asset-service.ts:deleteAsset`、`recoverPromotionJournals` | 原型图片不能只放入共享 Design assets；必须拥有独立清单和生命周期 |
| Canvas WebView 当前支持受限 `srcDoc` 预览，但 MessageChannel 只有缩放手势 | `CanvasWebviewWorkbench.tsx` | 可以复用 sandbox 安全边界，元素选择、局部 patch、页面路由和点击回放仍需新增协议 |
| 预览服务负责离线截图和缓存，不是交互测试服务 | `canvas-webview-preview-service.ts` | “截图成功”不能当作“流程可点击通过”；结构检查和实际回放必须分开记录 |
| 生成媒体输出带 `assetId/revision/hash/mediaKind`，导入有授权校验 | `media-run-service.ts`、`media-design-assets.ts` | 新模块应从可信 `MediaAssetRef` 导入并复制，不读取裸临时路径 |
| 工作区迁移/删除已有 write lease | `workspace-operation-lock.ts` | 新模块写入必须同时取得工作区 lease 和模块自己的 revision/CAS 锁 |

## 1. 功能对齐合同

| V3 已确认行为 | 正式模块行为 | 复用 / 新增 | 用户影响 |
| --- | --- | --- | --- |
| V3 作为工作区内的主会话 + 单页预览 | 在 `WorkspaceComponentTab` 和工作区工具列表注册 `interaction-design`；仍使用当前主会话 | 接入现有 shell；新增模块入口 | 用户从 DutyDeck 熟悉的工具栏进入，Agent 上下文和原会话连续 |
| 页面目录悬浮覆盖工作区 | 目录打开时覆盖预览，不改变预览坐标、尺寸或缩放；外部点击和 Escape 逐层关闭 | 新增 renderer overlay 状态；复用主题和焦点管理 | 页面多时不会挤压预览，也不会让用户丢失当前体验位置 |
| 分组、搜索、页面排序、跨组移动 | `Group` 和 `Page` 使用稳定 ID；目录顺序、折叠状态和入口页持久化；分组拖拽排序列为正式实现补充项 | 新增模块目录模型；不写 Canvas 边关系 | 页面组织可以长期增长，流程顺序不会被目录顺序误导 |
| 页面行五项浮动菜单 | 复制、重命名、移动到、设为入口、删除在行旁浮层展开；入口页和最后一页有删除保护 | 新增模块命令和菜单状态 | 菜单不顶开布局；用户能知道操作作用于哪个页面 |
| 页头集中页面、版本、交互流程、导出 | 生产页头保留这些模块级入口；不再保留重复的页面总览、右侧单项模块栏或底部导航 | 复用页头容器；新增 tab 绑定 | 目录、流程、版本职责清晰，减少重复按钮 |
| 体验/选择修改、手机/桌面、重新体验、专注 | 保留为预览控制；演示临时状态不进入设计 revision；专注退出恢复原会话显隐 | 新增预览状态协议；复用 workspace navigation guard | 用户可反复演示而不污染设计版本，切会话也不会被迟到结果抢焦点 |
| 主路径点击反馈 | 页面跳转、输入、弹窗、空态、失败态和恢复路径写入独立 `Flow`；按 revision 回放 | 新增 Flow 和 replay 证据 | 能区分“页面看起来可用”和“目标任务实际走通” |
| V3 中的 Agent 预设模拟 | 正式 Agent 继续走 Pi 主会话，输出候选，不直接覆盖 head；候选带基线 revision、范围和锁定项 | 复用 Pi/权限包装；新增 prototype 工具和候选持久化 | 用户始终能比较、拒绝或采纳，手工修改不会被下一轮生成覆盖 |
| 离线导出 | 从指定已采纳 revision 生成 HTML/CSS/JS、相对资源、manifest、流程说明和检查证据 | 新增 delivery 服务；复用现有导出安全约束 | 导出包可在离线环境复现，不能携带本机绝对路径或临时协议 |

以下能力属于正式模块的新增场景，不能从 V3 已有交互推断已经实现：空项目创建、资产选择/替换、生成任务进度、失败/取消/未知结果、候选冲突提示、历史 revision 恢复和项目 relink 后的路径重解析。

新增 UI 场景建议：无原型时提供“描述需求创建”和“导入 HTML”；当前原型名称作为选择器管理项目内多个原型；图片选择/替换放在选中图片的属性区，项目素材选择在此按需展开；生成进度和候选通过主会话卡片与当前预览展示。暂不增加第二条素材侧栏或独立 Agent 聊天栏。没有有效项目或 Agent 会话时，沿用现有工作区工具的禁用提示；这些新增界面细节需要在对应实施阶段补充评审。

## 2. 业务对象、版本和并发规则

### 2.1 身份和归属

`workspaceId` 映射既有 `AgentWorkspace.id`；服务端通过已登记 workspace 的 slug 解析 `P = getProjectFilesPath(workspace.slug)`。它不是目录名，也不能由 renderer 任意提供路径。

一个项目可以有多个原型，一个原型包含分组、页面、流程和入口页：

| 对象 | 必需字段 | 规则 |
| --- | --- | --- |
| Prototype | `prototypeId`, `name`, `platform`, `headRevisionId` | 当前 workspace 绑定由主进程解析；删除原型不删除共享历史资源 |
| Group | `groupId`, `name`, `sortKey` | 所属原型由 manifest 确定；删除前必须迁移全部页面 |
| Page | `pageId`, `groupId`, `name`, `sortKey`, `contentHash` | ID 稳定，标题可改；入口由 revision 的 `entryPageId` 唯一指定 |
| Element | `elementId`, `pageId`, `kind`, `editableFields`, `actionRefs` | 只允许声明过的字段；不能按相似文案替换失效元素 |
| Flow | `flowId`, `steps`, `transitions` | 所属原型和版本由 manifest 确定；与 Canvas 关系模型分离 |
| Revision | `schemaVersion`, `revisionId`, `parentRevisionId`, `brief`, `groups`, `pages`, `entryPageId`, `flows`, `themeRef`, `assetRefs` | 页面目录、内容、流程和资源引用必须同一快照；manifest hash 由外部 head/候选/交付记录持有 |
| Job | `jobId`, `sessionId`, `target`, `baseRevisionId`, `scope`, `status` | 运行状态与内容状态分开，取消/崩溃/未知结果不自动重放付费生成 |
| Candidate | `candidateId`, `jobId`, `baseRevisionId`, `affectedIds`, `patch`, `manifestHash`, `validation` | patch 用于说明差异，完整候选 manifest 是预览和采纳依据；基线匹配才允许采纳 |
| Delivery | `deliveryId`, `revisionId`, `manifestHash`, `evidenceRefs` | 固定交付内容，后续编辑不改变已交付包 |

### 2.2 提交和冲突

1. 用户手工修改直接生成新 revision；Agent 修改先写 candidate。
2. 采纳 candidate 时在模块写锁内重新读取 head，执行 compare-and-swap；基线不一致则标记 `stale`。
3. 工作区迁移/删除前取得 `acquireWorkspaceWriteLease(workspaceId)`；模块 revision 锁不能代替工作区 lease。
4. 预览临时输入、演示计数、当前选择和专注模式不进入 revision。
5. 结构检查结果和点击回放证据分别绑定 `revisionId + scenarioId`；任何受影响内容变更都会使旧检查失效。

模块锁需要覆盖共享数据根的进程间写入，不能仅用 renderer 状态或单进程队列声称互斥；可沿用既有文件锁模式并在锁内复核 head。工作区 lease 覆盖正式 staging、资源导入和提交的实际 I/O 阶段；模型等待期间不持锁，返回后重新解析项目根及目标版本。`schemaVersion` 升级需保留旧数据并以完整迁移验证后切换，不能半更新文件集合。

目录展开/收起、最近选择页面和设备属于视图偏好，持久化到全局 UI 偏好文件；排序、分组归属和入口属于设计版本。恢复旧版会生成一个指向旧内容的新 revision，不删除之后的历史。手工修改按完成一次动作或表单提交合并保存，不按每次击键创建版本；未保存内容要有明确标识。

内容事实源采用不可变页面包（HTML/CSS/JS/模拟状态）及其受控编辑声明。属性编辑直接修改页面包的声明字段，再生成新 content hash，不另存一棵可漂移的组件树。导入普通 HTML 先作为整体页面预览；只有加入稳定元素 ID 和可编辑字段声明后才开放局部编辑。完整 manifest 的 checksum 不写进自身，避免自引用哈希。

页面复制使用新 `pageId`，共享不可变内容/图片；不复制入口身份或指向原页面的入站连接。删除页面时在同一 revision 中清理相关连接并标出未连接动作，不把用户自动导向目录里的下一页。页面重命名、拖拽和跨组移动仅改变目录，保留原有路由；空分组且不是最后一个分组时才允许删除。

## 3. Agent 协作能力

### 3.1 用户工作流

1. 用户在主会话描述目标、平台、主要任务和约束。
2. Agent 读取当前项目的原型摘要；若已有匹配原型，继续沿用其 `prototypeId`，只有用户明确要求独立方案时才创建新的原型。
3. Agent 先提出页面结构、入口、流程和缺失状态；范围不明确时集中澄清。
4. Agent 生成候选或局部 patch，显示影响的页面/元素、锁定项、资源变化和未验证项。
5. 用户在预览中演示、比较或继续手动编辑；采纳动作由用户界面明确触发。
6. 采纳后固定 revision，检查并导出该 revision；当前会话切换不改变候选归属。

### 3.2 Agent 能力和边界

| 能力 | 目标效果 | 必须保留的边界 |
| --- | --- | --- |
| 需求 → 页面结构 | 产出页面、分组、入口和任务路径草案 | 不擅自重排已有目录，不把假设当作业务事实 |
| 页面/流程生成 | 形成可点击候选和模拟数据 | 真实鉴权、支付、外部 API、原生安装不在首版 |
| 元素局部修改 | 修改文字、颜色、间距、动作等声明字段 | 绑定 `elementId + baseRevisionId`；失效 ID 直接报错 |
| 状态补齐 | 补空态、加载态、错误态和恢复路径 | 依赖明确业务规则；不凭空发明接口行为 |
| 图片生成/替换 | 生成或导入视觉素材并挂到候选 | 必须使用可信媒体输出引用；不会绕过资源授权 |
| 结构检查/回放 | 发现孤立页面、不可达连接和主路径断点 | 只对实际覆盖的场景给出结果，不把静态截图当通过 |
| 交付整理 | 固定资源、说明和检查证据 | 不修改用户业务代码，不承诺生产部署 |

以下工具名均是**拟新增接口，不代表当前已有 API**：`prototype_list`、`prototype_read`、`prototype_create`、`prototype_propose`、`prototype_validate`、`prototype_export`、`prototype_asset_prepare`、`prototype_asset_import`、`prototype_asset_attach`。它们应仿照 Canvas 工具的项目/会话权限合同，由服务端复核 `workspaceId/sessionId/prototypeId` 归属。

上下文至少包含：`workspaceId`、`sessionId`、`prototypeId`、`pageId`、`elementId`、`baseRevisionId`、锁定字段、引用资源的 `assetId/revision/hash` 和用户本轮指令。切会话、切项目、关闭面板后，迟到结果仍回到原目标，不抢新视图焦点。

### 3.3 图片与 Agent 的完整链路

例如“保留布局，把欢迎页配图换成暖色阅读场景”：选择页面/图片 → 固定元素、原图 hash 和基线 → 使用现有图片模型配置生成 → 获得可信媒体输出引用 → 校验并导入模块资产库 → 形成仅替换该图片的候选 → 预览采纳。页面先用占位图或现有素材仍可完成交互，不把每轮页面修改都变成一次图片生成。

现有统一媒体服务会经 `MediaDesignAssets` 登记到 Design registry。首期允许沿这条现有结果链完成登记，再复制到交互模块资产库；生成结果在复制前丢失或 hash 不匹配时明确失败，不引用失效路径，也不自动再次付费生成。无需创建隐藏 Canvas 节点或假 `nodeId`。后续只有明确需要时才抽出多个模块可用的资产登记适配，不在一期改写整个媒体系统。

增加专用默认 Skill 约束“先读取已有原型、锁定范围、候选校验、资源使用、检查证据”，但 Skill 不是权限控制：工具后端仍独立校验归属、工具模式、计划/执行权限和每轮范围。已有会话工具注册与权限包装负责准入；模型沿用当前会话配置，图片沿用现有媒体模型选择和消费规则，不建立第二套模型设置。

只将当前请求涉及的页面、选中元素和必要相邻流程送入模型上下文；完整项目图片用 ID/hash 引用，按需读取，避免每轮注入全项目源码或图片字节。

## 4. 图片与模块资源存储规划

### 4.1 路径合同

由现有 resolver 计算：

```text
D = getConfigDir()                         # 活动用户数据根，默认可能是 ~/.DutyDeck
P = getProjectFilesPath(workspace.slug)    # 本地项目根；托管项目回退 workspace-files
正式根 = P/.proma/interaction-design/
缓存根 = D/interaction-design-cache/<workspaceId>/
视图偏好 = D/interaction-design-preferences/<workspaceId>.json
```

不能硬编码 `~/.DutyDeck`，不能把 `workspaceId` 直接当路径，也不能把正文或正式图片放入会话目录、全局附件临时目录或只可再生的 cache。

建议目录树：

```text
P/.proma/interaction-design/
  index.json                         # 可重建原型/版本索引
  prototypes/<prototypeId>/
    head.json                         # 唯一当前提交点
    revisions/<revisionId>/manifest.json
    content/<contentHash>/            # 不可变页面 HTML/CSS/JS/状态定义
  assets/
    records/<assetId>.json            # 来源、hash、尺寸、用途、保留信息
    blobs/sha256/<prefix>/<hash>.<ext> # 原图或交付所需不可变字节
  jobs/<jobId>/                        # 状态、候选、基线、事件
  checks/<checkId>/                    # 固定版本的检查结果和必要截图证据
  deliveries/<deliveryId>/            # 固定交付清单和证据
  trash/                               # 用户删除后的可恢复项
  .staging/                            # 校验完成前的临时提交目录

D/interaction-design-cache/<workspaceId>/
  thumbnails/                          # 可重建缩略图
  previews/                            # 当前 revision 的预览包/截图
  scratch/                             # 不作为候选或证据的可丢弃中间文件
```

例如本地项目 `/Users/xutaoyu/CodeSource/GPL/DutyDeck` 的拟定正式目录是 `/Users/xutaoyu/CodeSource/GPL/DutyDeck/.proma/interaction-design/`。在默认数据根下，托管项目则为 `/Users/xutaoyu/.DutyDeck/agent-workspaces/<slug>/workspace-files/.proma/interaction-design/`，缓存为 `/Users/xutaoyu/.DutyDeck/interaction-design-cache/<workspaceId>/`；这些只是规划路径，本轮不创建真实业务目录。

项目内 `.proma` 是既有兼容约定；用户级根由 locator 选择，可能仍是旧根或自定义位置。重新关联文件夹只切换 `P`，不会自动搬迁原型文件：目标没有模块数据就展示缺失/空态，不能伪装恢复成功。实际项目搬迁/复制才需要包含模块正式目录并验证清单；新项目身份在服务端重新绑定，旧会话 ID 只作来源记录，不继承执行授权。缓存键包含项目根代次、manifest hash、视口和运行时版本，避免同 workspace relink 后显示旧目录内容。

### 4.2 资源分类

| 资源 | 正式存储与用途 | 生命周期 |
| --- | --- | --- |
| 页面、样式、脚本、模拟数据、主题变量 | `prototypes/<prototypeId>/content/<contentHash>/`，由 revision manifest 引用 | 内容不可变；改变后创建新 hash |
| 上传图片、截图参考、AI 生成图 | `assets/records` + `assets/blobs`；记录来源、媒体运行身份、格式、尺寸和角色 | 设计使用与仅作参考分开标记；都可由历史/候选保留 |
| 用于页面的裁剪图、压缩图 | 与原图一样存为新 asset/blob，记录源 hash 和变换参数 | 交付所需正式内容，不当作随意清理的缩略图 |
| 图标、字体 | 内置图标/系统字体优先；需随包携带的授权本地文件同样登记 asset/hash | 不依赖外链字体；导入文件格式校验，SVG 需受控处理后才执行预览 |
| 目录缩略图、普通预览截图 | `D/interaction-design-cache` | 可删除重建，不参与正文事实 |
| 验收截图、交互回放、交付说明 | `checks/` 或 `deliveries/`，绑定 manifest hash | 属于正式证据，不能仅放缓存 |
| Agent 输入基线、候选、运行终态和事件 | `jobs/` | 会话删除不影响原型恢复；敏感配置值不写入记录 |

### 4.3 图片身份、导入和删除

- 逻辑 `assetId` 与来源记录独立；文件内容以 SHA-256 去重，同一项目内跨页/跨原型复用同一 blob。
- 从 Canvas 或通用媒体导入时，按 `assetId + revision + sha256` 校验后复制一次到模块资产库，并保存 `sourceRef`；不使用跨模块硬链接。
- 复用现有媒体生成引擎和校验方法，但不复用 Canvas 的删除所有权；生成结果必须来自可信 `MediaAssetRef`，不能读取裸临时路径。
- 更换图片生成新的不可变记录；历史 revision 继续引用旧图。
- 删除页面不删除历史图片；删除原型、版本、候选、运行和交付前先做引用检查。首期清理只允许用户可见的手动回收，不擅自清除用户历史。
- renderer 只接收受控资源 URL；manifest 内只保存相对路径和稳定 ID，禁止本机绝对路径、临时协议和任意目录读取。

资产记录保存名称、媒体类型、字节数、宽高、hash、原始文件名和可用的来源说明；路径/URL只是来源说明，不能代替保存的字节。用户本地文件通过既有文件选择/目录授权导入，远程引用不能让沙箱任意联网。读取限额、真实格式/解码验证和软链接越界检查复用既有安全模式。

资源回收采用从 head、保留 revision、candidate/job、checks/delivery 和 trash 扫描引用的标记/清理，索引只作加速而不是删除依据。发现损坏或缺失清单时停止物理回收并报告；不把“读不到引用”当成“没有引用”。第一期无定时历史删除，清理界面展示可回收字节和受影响项，清理前在同一写锁内重新核验。

### 4.4 保存、备份和离线交付

提交顺序为：在项目内 staging 写入新内容及资源 → 校验格式/hash/引用 → 形成完整不可变 revision → 工作区 lease 和模块锁内重查基线 → 用 `safe-file.ts` 原子更新 `head.json` → 更新可重建 index。head 提交前崩溃保留旧版；head 成功但响应丢失时按 operation ID 查询已提交结果，不再创建重复版本。运行期间保持必要资源 pin；不长时间持有 revision 锁等待模型返回。

备份包含整个 `.proma/interaction-design/`，缓存可排除；副本中不能包含 API key、登录态或 Cookie。恢复先验证 schemaVersion、manifest 和资源 hash，不能让失败的部分恢复覆盖完整原型。

默认交付是一个目录包：`index.html`、页面代码/样式/脚本、`assets/`、`manifest.json`、交互说明和检查记录。内部路由、脚本加载和资源引用必须适配离线打开；不依赖 `fetch(file:)` 或外部 CDN。在干净目录通过真实点击验证 `file://` 运行，不能仅检查文件存在。只收集该 revision 需要的资源，不携带整个项目或未采纳候选。开发接手时可让主会话引用固定 delivery 继续实现，写入业务代码仍由那次明确的开发任务决定。

### 4.5 性能和资源开销

只运行当前活动页面的 sandbox，其他页面使用带 revision 身份的缩略图；编辑只重载受影响页面。缩略图和预览包按 hash 缓存、按需生成，截图任务串行排队并合并相同输入。页面数量增加不应线性增加常驻 iframe、离屏窗口或模型请求；超过几十页再启用虚拟列表和更严格的缩略图预算。

## 5. 与现有代码的接入面

以下是实施时需要落点的文件职责，当前均为规划，不表示已经存在对应模块：

| 文件 / 目录 | 计划职责 |
| --- | --- |
| `packages/shared/src/types/interaction-design.ts`（新增）与 `packages/shared/src/types/index.ts` | 原型、页面、分组、流程、revision、candidate、asset ref、delivery 和 IPC 请求/响应类型；通道常量与其他业务模块一样在类型文件定义并导出 |
| `apps/electron/src/main/lib/interaction-design/paths.ts` | 使用 `getConfigDir/getProjectFilesPath` 解析正式根和缓存根，拒绝任意 renderer 路径 |
| `apps/electron/src/main/lib/interaction-design/store.ts` | 用 `safe-file.ts` 原子读写 index/head/manifest/jobs，维护模块写锁和 CAS |
| `apps/electron/src/main/lib/interaction-design/preview-service.ts` | 准备受控资源和截图；复用 Canvas 的窄能力，保留其 adapter 和原有测试 |
| `apps/electron/src/main/lib/interaction-design/validation-service.ts`（新增） | 独立负责结构校验、固定场景回放和证据落盘 |
| `apps/electron/src/main/lib/interaction-design/agent-tool-provider.ts` | 绑定 Pi 主会话、权限模式和项目归属；实现上表拟新增工具 |
| `apps/electron/src/main/lib/interaction-design/asset-service.ts` | 校验媒体引用、hash 去重、复制、引用统计、回收站和导出收集 |
| `apps/electron/src/renderer/atoms/agent-atoms.ts`、`workspace-tools.ts` | 注册项目级工作区工具和导航守卫，防迟到请求抢焦点 |
| `apps/electron/src/renderer/components/agent/SidePanel.tsx`、`apps/electron/src/renderer/components/app-shell/WorkspaceTools.tsx` | 在真实 shell 中呈现模块，不复制原型里的模拟顶栏/聊天记录 |
| `apps/electron/src/renderer/components/design/InteractionDesignWorkspace.tsx` | 页头、悬浮目录、单页预览、流程/版本/导出入口和窄面板适配 |
| `apps/electron/src/renderer/components/design/interaction-design/`（新增） | 拆分目录、页面菜单、预览桥接、元素属性和候选视图；工作区容器只负责组装 |
| `apps/electron/src/main/lib/media/media-run-service.ts`、`media-design-assets.ts` | 只复用可信输出和授权校验；新增模块导入适配，不改变 Canvas 删除语义 |
| `apps/electron/src/main/ipc.ts`、`apps/electron/src/preload/index.ts` | 主进程 handler 和类型安全 bridge；所有资源路径在主进程解析 |
| `packages/shared/src/types/workspace-menu.ts` | 新入口经过原生工具菜单时同步 action 白名单 |
| `apps/electron/default-skills/interaction-design/SKILL.md`（拟新增） | 原型创作与校验流程；初始版本 1.0.0，以后变更递增 patch |
| 对应 `*.test.ts` / `*.test.tsx` | BDD 覆盖路径、权限、竞态、资源引用、回放和 UI 键盘行为 |

## 6. 分阶段实施任务和可审查结果

建议按三个可体验阶段交付：① Task 1–4 做出真实保存的多页面工作台；② Task 5 接通主会话 Agent 的生成、局部修改和候选采纳；③ Task 6–7 完成图片生成/导入、交付和迁移回收验收。第一阶段预览用可控本地 fixture 验证协议；正式资源入库从 Task 2 开始遵循路径和不可变引用规则，第三阶段再完成完整媒体与回收闭环。

### Task 1: 锁定共享合同和边界

**Files:**
- Create: `packages/shared/src/types/interaction-design.ts`
- Modify: `packages/shared/src/types/index.ts`；新通道常量随 `interaction-design.ts` 定义
- Test: `packages/shared/src/types/interaction-design.test.ts`

- [ ] 定义对象 ID、revision manifest、candidate status、asset ref、delivery manifest 和四层 IPC 的请求/响应，不复用 `CanvasNodeId` 或假造 Canvas node。
- [ ] 为入口唯一性、页面稳定 ID、候选基线、过时状态和导出相对路径写 BDD 测试；覆盖入口删除、失效元素 ID、基线不一致和未知 job 状态。
- [ ] 用 `bun test packages/shared/src/types/interaction-design.test.ts` 验证类型运行时守卫和序列化边界。

**结果:** 形成可被 main/preload/renderer 共用的最小合同，旧 Canvas 类型和新模块身份不会混淆。

### Task 2: 建立项目正式根、缓存根和原子提交

**Files:**
- Create: `apps/electron/src/main/lib/interaction-design/paths.ts`
- Create: `apps/electron/src/main/lib/interaction-design/store.ts`
- Test: `apps/electron/src/main/lib/interaction-design/paths.test.ts`, `store.test.ts`

- [ ] 通过受信 workspace id→slug→`P` 解析正式路径，拒绝 `..`、绝对路径和未知 workspace。
- [ ] 用 `safe-file.ts` 写 staging manifest、hash 校验、lease 内 CAS head；index 仅作为可重建派生索引。
- [ ] 覆盖首次创建、重复写、崩溃留 staging、head 已变化、workspace relink、workspace 删除 lease 和缓存失效。
- [ ] 用 `bun test apps/electron/src/main/lib/interaction-design/paths.test.ts apps/electron/src/main/lib/interaction-design/store.test.ts` 验证。

**结果:** 页面、版本和资源能在项目移动后按身份重解析，半写入不会出现混合版本。

### Task 3: 接入真实工作区和 V3 目录行为

**Files:**
- Modify: `agent-atoms.ts`, `workspace-tools.ts`, `WorkspaceTools.tsx`, `SidePanel.tsx`
- Create: `apps/electron/src/renderer/components/design/InteractionDesignWorkspace.tsx`
- Test: renderer 组件和工作区导航回归测试

- [ ] 注册 `interaction-design` 项目级工具，复用现有主题、Jotai 和 workspace navigation guard。
- [ ] 迁移 V3 已确认的目录功能：浮动覆盖、搜索、分组折叠、排序、跨组移动、五项页面菜单、入口保护、窄屏抽屉、多层 Escape 和焦点恢复。
- [ ] 页头集中页面/版本/流程/导出；不恢复右侧单项模块栏、重复聊天入口或底部页面导航。
- [ ] 交互测试固定预览 DOM 坐标和尺寸：目录开关、菜单开关和抽屉切换均不能推动或重建当前页面。

**结果:** V3 的信息架构进入真实 DutyDeck shell，用户影响与原型一致，生产全局工具栏仍保留其导航职责。

### Task 4: 受限预览、元素选择和流程回放

**Files:**
- Create: `preview-service.ts`、renderer preview protocol/controller
- Modify: 复用 `CanvasWebviewWorkbench` 的窄 sandbox 能力，但保持 Canvas adapter 不变
- Test: sandbox/CSP、元素选择、路由、回放和资源注入测试

- [ ] 为页面 HTML 注入稳定元素 ID、受控动作和内部路由状态；编辑模式点击只选中，演示模式点击只执行。
- [ ] 仅允许本地资源和受控 URL，保留禁止网络、顶层导航、frame 和外发提交的 CSP。
- [ ] 将结构检查（孤立/不可达）与实际点击回放（输入/跳转/失败/恢复）存为两类证据，并绑定 revision。
- [ ] 只运行当前页面；切页、刷新、关闭和取消释放 iframe、截图和在途任务。

**结果:** “可点击”和“可检查”有可复核证据，同时不会放宽现有 WebView 的安全边界或线性增加资源常驻。

### Task 5: Agent 候选、权限和并发

**Files:**
- Create: `agent-tool-provider.ts`、job/candidate service
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts` 及相关工具策略，在服务端传入现有 Pi `customTools`；不为此另建 runtime
- Create: `apps/electron/default-skills/interaction-design/SKILL.md`
- Test: 工具归属、candidate CAS、取消、迟到结果、切会话和权限测试

- [ ] 将目标上下文和锁定项注入主会话，服务端再次校验 workspace/session/prototype/page/element 归属。
- [ ] 首期只允许用户 UI 明确采纳；候选展示影响范围、资源变化、验证状态和未验证项。
- [ ] 生成中取消、进程崩溃、未知结果不自动重放可能计费的媒体/模型调用；迟到结果回到原 job。基线变化标记 stale，取消后的结果保留为不可采纳记录，不能恢复为成功。
- [ ] 覆盖手工修改后候选过时、重复采纳幂等、切换项目不抢焦点、越权工具调用拒绝。

**结果:** Agent 负责降低往返成本，但用户始终掌握方案选择，人工修改和业务权限不会被模型覆盖。

### Task 6: 媒体资产、导出、回收和迁移

**Files:**
- Create: `asset-service.ts`, `delivery-service.ts`, cleanup/migration tests
- Modify: 媒体导入适配、storage category 统计和项目迁移边界
- Test: hash 去重、来源校验、历史引用、导出离线运行、回收站和 relink 测试

- [ ] 将可信 `MediaAssetRef` 复制到模块资产库，按 SHA-256 去重；替换图片生成新记录，旧 revision 继续可读。
- [ ] 导出指定 revision 的 HTML/CSS/JS、资源、manifest、流程说明和证据；禁止绝对路径和临时协议。
- [ ] 页面/原型删除只移动到模块 trash；引用检查覆盖 head、历史 revision、candidate、job 和 delivery。
- [ ] relink 后重解析 `P` 并区分目标含原型/不含原型；搬迁或项目副本流程完整复制正式目录并重新绑定权限。托管项目既有 `workspace-files` 元目录保护继续生效，本地项目资源统计另加分类；正式数据不进入 orphan session 清理，新增缓存清理只针对明确可重建内容。

**结果:** 图片不会被 Canvas 清理误删，历史和交付可复现，项目迁移不会留下不可解释的绝对路径。

### Task 7: 端到端验收和性能基线

**Files:**
- Create: 模块 BDD 端到端测试与验证记录
- Modify: 模块文档和发布前检查清单

- [ ] 用 Bun 定向测试覆盖正常路径和主要边界，再运行 `bun run typecheck`；涉及 IPC、预览和打包规则时追加 `bun run electron:build`。
- [ ] 在 390/820/1040/1440px、深浅主题、键盘和多层 Escape 下验证目录覆盖不位移、菜单不顶布局、专注可恢复。
- [ ] 记录单活动页面内存、缩略图命中率、重复 hash 导入、截图排队和 30/100 页面目录渲染；性能结论只基于实测。
- [ ] 运行 `git diff --check`，确认计划和 V3 说明不再把模拟 Agent 或旧布局写成已接入能力。

**结果:** 有可重复的功能、资源、安全和性能证据，仍明确哪些能力尚未通过真实模型或生产接口验证。

### 最小业务验收场景

| Given（前置） | When（操作） | Then（期望） |
| --- | --- | --- |
| 同原型有 30 个页面和 4 个分组 | 拖拽页面、移动到其他分组、关闭并重开应用 | 目录顺序保持，页面跳转不被重排改变 |
| 今日页正在演示且已输入内容 | 打开页面目录、子菜单，再逐层 Escape | 预览位置/尺寸不变，未执行菜单外的业务点击 |
| Agent 基于 revision A 修改一个按钮 | 用户先手动保存 revision B，再收到候选 | 候选显示过时且不能覆盖 B，当前手工修改保留 |
| 生成图片的 job 已取消 | 底层图片结果迟到 | 保存来源和已发生消费，不采纳、不自动再次请求 |
| 欢迎页已从 Canvas 导入图片并完成保存 | 在 Canvas 中删除源素材 | 原型当前版、历史版和导出包仍能读取模块副本 |
| 两个页面引用同一 hash 图片 | 删除其中一页，再清理缓存 | 另一页面及保留历史不缺图，正式资源不被缓存清理 |
| head A 已保存，新 revision 写入中 | 在更新 head 前故障退出，或在提交后丢失响应 | 重开读到完整旧版或已完整提交的新版本，重试不产生重复采纳 |
| 项目重新关联到新目录 | 新目录含完整模块资料或根本不含资料 | 前者按新路径读取，后者明确提示缺失，不能展示旧缓存冒充新数据 |
| 一个已采纳 revision 完成主路径检查 | 导出到干净目录并离线打开 | 相同路径能点击，资源来自包内，证据标注该 revision 和覆盖范围 |

这些是后续实现必须执行的验收合同，本轮只完成规划文档与引用一致性检查，未执行产品集成或真实模型测试。

## 7. 明确不纳入首期

- 任意外部 HTML 的全量双向可视化编辑；无法稳定映射的内容走源码或 Agent 候选。
- 直接移植上游 Next.js 服务端、常驻本地服务器、真实 API 联调、真实鉴权/支付和多人实时协作。
- 将页面路由写入 Canvas 的素材生产关系，或把新模块图片登记进 Canvas 文档来“借用”删除语义。
- Agent 自动采纳、自动重放未知结果、按标题匹配页面、静默重排目录或绕过用户确认。
- 跨项目硬链接去重、无人确认的历史资源自动删除和任何依赖本机绝对路径的导出包。

## 8. 评审结论

本方案把 V3 视为交互信息架构基线，把正式模块拆成 shell 接入、独立版本合同、受限预览、Agent 候选和独立资产库五个边界。最关键的长期决策是图片和原型 revision 放在项目 `.proma/interaction-design/`，因为 Canvas 当前删除/恢复只认识自己的 registry；这样会产生一次跨模块复制成本，但避免图片被错误回收，也让历史版本和离线交付有稳定归属。

本文件是规划，不代表已创建上述生产文件、IPC、Agent 工具或资源目录。
