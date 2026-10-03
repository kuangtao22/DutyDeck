# DutyDeck

<img src="./docs/assets/brand/dutydeck-icon-256.png" alt="DutyDeck" width="96" height="96" />

> **本仓库是 Proma 的修改版。** DutyDeck 基于上游开源项目 [Proma](https://github.com/proma-ai/Proma)（AGPL-3.0-only）演进，由 [kuangtao22](https://github.com/kuangtao22) 独立维护，与 Proma 官方没有从属关系，也没有得到官方背书。上游基线与差异说明见[与官方 Proma 的关系](#与官方-proma-的关系)。

DutyDeck 是一个本地优先的工程 Agent 工作台：在 Proma 的 Chat、Agent、项目工作区、Skills、MCP 之上，补上画布编排、运维工作台、接口工作台和今日活动，把核心开发之外的项目维护琐事收拢到同一处，让专注时间能还给产品，数据和配置默认留在你自己的机器上。

[下载 DutyDeck](https://github.com/kuangtao22/Proma/releases/latest) | [Proma 使用教程（上游）](https://github.com/proma-ai/Proma/tree/main/tutorial) | [更新日志](./release-notes/bone) | [English README](./README.en.md)

## 由来与初衷

DutyDeck 起于一句「谢谢」，和一个很具体的问题：个人开发者想专注做产品，但项目的维护琐事一直在把专注切碎。

**谢谢的是上游 Proma。** 在 Agent 还很粗糙的时候，它已经把 Chat / Agent 双模式、项目工作区、Skills、MCP、协作子会话、内嵌浏览器这些难啃的部分做成了可以每天使用的开源产品，并以 AGPL-3.0 持续维护。本仓库的 Chat、Agent、工作区、记忆、远程桥接和本地优先存储全部来自 Proma —— 没有它，就没有这个仓库。

**要解决的是「专注被打断」这件事。** 做产品本身需要长时间不被打断的投入，但围绕一个项目运转的还有一大堆分内杂事：服务器和数据库要看着、接口要联调、环境和脚本要配、日志要翻、发布要盯、issue 和文档要回。单件都不大，却散落在终端、数据库客户端、接口调试工具、云控制台和聊天窗口里，每换一件事就得切一次上下文；等杂事清完，注意力已经回不到产品上了。

所以 DutyDeck 的初衷只有一句话：**给个人开发者一块专注工作台，把核心开发之外的职责性事务集中到一个地方**。Agent、画布、运维和接口共用同一份本地上下文，你在这一处把杂事清掉，再把注意力还给产品；需要人拍板的动作以审批卡的形式停在你面前，而不是事后审计。名字也来自这里：Duty（职责、分内之事）+ Deck（一块集中的操作台）。

我们也给自己划了两条边界：

- **不改上游内核**：Agent 运行时、IPC 契约、数据目录都沿用 Proma，扩展只加在上面，保证上游更新能继续合入。
- **不谈商业豁免**：本仓库以 AGPL-3.0-only 发布，不提供、也无权提供商业授权豁免。

## 为什么值得用

DutyDeck 的意义不在「多几个功能」，而在于把散落的维护工作并成一条链：

- **一个客户端替掉一排工具**：终端、数据库客户端、接口调试工具、日志面板、文件传输都在同一个窗口里，少一次工具切换就少一次上下文重建。
- **Agent 拿得到真实上下文**：它能看到你正在看的那台服务器、那个库、那条接口、那张画布，而不是等你把界面内容复制给它。
- **危险动作停在人面前**：默认只读，写入要么只生成脚本、要么逐条走审批卡；凭据本地加密，Agent 不能替你取出凭据。
- **数据留在你自己的机器上**：会话、工作区、配置、Skills 以 JSON / JSONL 存放在 `~/.proma/`，画布数据跟着项目目录走，不引入本地数据库。
- **站在 Proma 的肩膀上**：Chat、Agent、工作区、Skills、MCP 这些成熟能力继续跟随上游维护，扩展只加在外面，上游的修复仍能合入。

## 我们自己的扩展

下面四块由本仓库自研，也是 DutyDeck 与上游 Proma 的主要区别。每一块都把一类散在各处的维护杂事收拢到同一处，并且各配一篇独立说明页。

### 画布（Canvas）—— 把多步骤交付画成一张图

一次交付很少只有一步：写文案、出图、搭原型，改一版再改一版。画布用节点表示步骤、用连线表示依赖，产物带版本与归属，你能随时看清「现在用的是哪一版、改了上游谁要跟着改」。它不做通用工作流引擎，定位是普通 Agent 的多模态生产现场。

- 节点类型：Agent、图片、文档、原型（WebView），视频标注「即将支持」。
- 三种 Agent 分工：普通 Agent 负责总编排，Canvas Agent 承担长期分支，执行 Agent 跑单次生成。
- 产物先成为候选、采用后才生效：节点卡片和下游只消费正式采用的版本。

详细说明：[画布说明页](./docs/extensions/canvas.md)

### 运维工作台（Server Ops）—— 上线和排障不用离开客户端

登服务器看负载、翻日志、查表结构、跑一条 SQL、传一个文件、看一眼容器——这些事单件都不大，却总把你从产品上拽走。运维工作台把它们收进同一个面板，并让 Agent 只在你显式授权、界面上写着范围和剩余时间的只读范围内帮忙。

- 连接：SSH（密码 / 私钥 / SSH Agent）、MySQL、PostgreSQL、Redis 与本地 SQLite，按项目组织。
- 服务器：概览、远程终端、systemd 服务、实时日志、远程文件与传输、Docker。
- 数据库：库表与结构浏览、分页数据、SQL 工作台与查询历史、只读诊断；Redis 提供连接与只读诊断。
- 安全：凭据本地加密且不回显；默认只读，写操作只生成脚本或逐次审批；Agent 只读授权按会话授予、30 分钟到期、可随时撤销。

详细说明：[运维工作台说明页](./docs/extensions/server-ops.md)

### 接口工作台（API Workbench）—— 联调、鉴权与用例都留在项目里

接口联调最碎：换环境要改地址、鉴权散在各处、用例写在聊天记录里、报错只看到一句 401。接口工作台把「配置」和「证据」分开沉淀：集合保存可复用配置，运行记录保存真实执行证据，手动操作与 Agent 走同一条链路，每个结论都能打开核对。

- 组织：集合 / 文件夹 / 请求，环境与四层变量作用域，界面显示每个值最终来自哪一层。
- 调试：HTTP/1.1 直连与 SSE，完整运行记录（最终请求头、正文原始字节、耗时分段、重定向、TLS、Cookie、断言结果）。
- 加密签名：方案统一放在公共配置，接口只选方案；密钥只引用变量名，缺密钥时如实标记「明文发出」。
- Agent：发送与保存是两次独立审批，重复调用不会重发，人工创建的用例 Agent 改不了。

详细说明：[接口工作台说明页](./docs/extensions/api-workbench.md)

### 今日活动（Today）—— 一天做了什么，一眼看完

在多个项目、多种模式之间来回切一天之后，「今天到底推进了什么」靠记忆往往说不清。今日活动把当天发生对话的会话跨项目汇总成一条按时间排序的流水，点一下就能回到原来的上下文。

- 按最后一次对话时间降序，包含委派子会话与定时任务会话。
- 排除已归档会话、草稿会话与内部执行会话。
- 入口常驻侧栏底部并显示计数，跨零点自动重算。

详细说明：[今日活动说明页](./docs/extensions/today-activity.md)

四块共用同一套约定：凭据、密钥与连接信息本地加密且不回显；读取默认只读并可在界面随时撤销；写入要么只生成脚本、要么逐条走审批卡；Agent 触发的敏感动作会先在消息流里出卡，等确认后才真正执行。

## 继承自上游 Proma

上面那些之外的通用能力都来自上游 Proma，并在本仓库持续维护：

- **Chat 与 Agent**：多模型对话、附件与图片输入、并排对话、系统提示词；Agent 由 Pi Agent Runtime 单一驱动，支持工作区隔离、权限模式、计划确认和长任务流式输出。
- **工作区与项目指令**：每个项目独立配置 Skills 与 MCP Server，可用 `AGENTS.md` 声明受信项目指令，旧 `CLAUDE.md` 自动迁移。
- **协作与工具**：协作子 Agent / Task、内置受管浏览器自动化、联网搜索、工作区记忆与记忆刷新提示。
- **远程与桌面**：飞书 / Lark 机器人桥接（含钉钉、微信入口）、自动更新、代理设置、文件预览、全局快捷键、快速任务、语音输入、深浅主题。
- **本地优先**：会话、工作区、附件、配置、Skills 默认以 JSON / JSONL 存放在 `~/.proma/`，不依赖本地数据库。

「怎么用」这件事和 Proma 完全一致，本仓库不再重复写一遍：

- [Proma 使用教程](https://github.com/proma-ai/Proma/tree/main/tutorial)：环境与渠道配置、Chat 与 Agent 模式、Skills、MCP、远程机器人。
- [Proma 仓库与功能列表](https://github.com/proma-ai/Proma#readme)：上游完整功能与截图说明。
- 本仓库 `tutorial/` 目录保留了一份上游教程的本地副本，产品名与界面入口已按 DutyDeck 更新。

选哪个模式也还是那句话：**只需要回答时用 Chat，需要动手交付结果时用 Agent。**

## 与官方 Proma 的关系

DutyDeck 是 Proma 的修改版，不是官方发行版：

- **许可证**：AGPL-3.0-only，与上游一致，完整条款见 [LICENSE](./LICENSE)。
- **上游基线**：已完整合入的上游内容基线是 `v0.19.31`（2026-09-05），其后的官方版本按需挑选移植，因此功能不等同于官方最新版。
- **版本号含义**：`0.19.53-bone.12` 是「上游版本号 + 本仓库构建号」，`-bone.<构建号>` 只标记本仓库自己的发布顺序，不代表官方迭代进度。
- **本仓库新增**：画布、运维工作台、接口工作台、今日活动，以及围绕它们的权限确认、审计与本地加密。
- **归属**：上游代码的版权归 Proma 作者与贡献者所有，本仓库的修改同样以 AGPL-3.0 授权给任何人。

## 快速开始

### 下载安装

从 [GitHub Releases](https://github.com/kuangtao22/Proma/releases) 下载 DutyDeck，提供 macOS Apple Silicon、macOS Intel、Windows、Ubuntu/Debian x86_64 的 `.deb` 安装包和 Linux x86_64 AppImage，产物名形如 `DutyDeck-<版本>-macos-arm64.dmg`、`DutyDeck-<版本>-windows-x64.exe` 与 `dutydeck_<版本>_amd64.deb`。Linux 的安装、安全边界和支持范围见 [Linux 说明](./docs/linux.md)。

DutyDeck 的模型渠道全部由你自己配置，不提供任何内置订阅通道。上游的商业版 Proma（proma.cool）与本项目无关。

### 首次配置

环境检查（Git、Node.js / Bun 和可用的 Shell）、**设置 > 渠道**、**设置 > Agent**，以及记忆、联网搜索、飞书 / 钉钉 / 微信桥接的配置流程与上游完全一致，跟着[上游教程](https://github.com/proma-ai/Proma/blob/main/tutorial/tutorial.md)走即可。

基础设施上只有一处差异：Agent 由 Pi Agent Runtime 驱动，支持矩阵见[Agent 运行时与模型渠道](#agent-运行时与模型渠道)。其余改动都集中在[我们自己的扩展](#我们自己的扩展)。

## 截图

### 画布

把 Agent 任务、素材与依赖画成节点图：按类型筛选、按上游/下游与关联定位节点，一张图推进多步骤交付。

![DutyDeck 画布](./docs/assets/screenshots/dutydeck-canvas-demo.png)

完整说明见[画布说明页](./docs/extensions/canvas.md)。

### 运维工作台

SSH、MySQL / PostgreSQL / Redis 连接集中管理，默认只读、写操作只生成脚本；概览、终端、服务、日志、远程文件与 Docker 面板在同一个工作台内完成。

![DutyDeck 运维工作台](./docs/assets/screenshots/dutydeck-server-ops-demo.png)

完整说明见[运维工作台说明页](./docs/extensions/server-ops.md)。

### 接口工作台

按集合与环境组织接口：变量与集合级鉴权继承、请求侧加密与签名、用例与断言，以及由 Agent 批量执行并逐条确认。

![DutyDeck 接口工作台](./docs/assets/screenshots/dutydeck-api-workbench-demo.png)

完整说明见[接口工作台说明页](./docs/extensions/api-workbench.md)。

以下截图是继承自上游 Proma 的通用能力（用法见上方教程链接）：

### Chat 快速分析

用 Chat 处理轻量但真实的分析任务：整理读者关注点、生成对比表，并把首屏文案快速定稿。

![DutyDeck Chat 快速分析](./docs/assets/screenshots/proma-chat-demo.png)

### Agent 工作台

Agent 在项目根目录与会话工作台中读取文件、推进任务、输出表格化结论，并把可复用文件保留在右侧文件面板中。

![DutyDeck Agent 工作台](./docs/assets/screenshots/proma-agent-demo.png)

### Skills

每个工作区都可以沉淀专属 Skills。截图中的 `feedback-synthesis` 用于把用户反馈、访谈记录和 issue 聚合成主题、证据与优先级建议。

![DutyDeck 工作区 Skills](./docs/assets/screenshots/proma-skills-demo.png)

### Skills & MCP

同一个工作区可以管理 stdio / HTTP MCP Server，按需启用或关闭，让 Agent 在不同项目里获得不同的外部上下文。

![DutyDeck MCP 配置](./docs/assets/screenshots/proma-mcp-demo.png)

### 流式语音输入(支持全局输入)
DutyDeck 支持豆包的流式语音输入功能，并且支持在 DutyDeck 内使用和 DutyDeck 外部使用：
- DutyDeck 内部使用：Ctrl + ` 触发识别，再次按下结束自动输入到 DutyDeck 内对应的输入框
- DutyDeck 外部使用：Ctrl + ` 触发识别，再次按下结束自动输入到当前的光标所在处，如无光标则默认写入到剪贴板
- 
![DutyDeck 语音输入](./docs/assets/screenshots/proma-typeless-input.png)

## Agent 运行时与模型渠道

DutyDeck 的 Agent 模式由 **Pi Agent Runtime** 单一驱动，内核来自 `@earendil-works/pi-coding-agent`、`pi-agent-core` 和 `pi-ai`，不再依赖任何第三方 Agent 运行时。已启用的 DutyDeck 渠道会动态注册为 Pi provider，支持 OpenAI Chat Completions / Responses、Google Generative AI、Anthropic Messages 及其兼容端点。早期基于 Claude runtime 的历史会话保留为只读记录，可查看但不能继续、分叉或回退。

| 渠道类型 | Chat | Pi Agent |
| --- | --- | --- |
| Anthropic / Anthropic 兼容 | 支持 | 支持 |
| DeepSeek、Kimi API / Coding Plan、智谱 Coding Plan、MiniMax、小米 MiMo 等 Anthropic 协议渠道 | 支持 | 支持 |
| OpenAI、OpenAI Responses、Google、智谱 AI、豆包、通义千问 | 支持 | 支持 |
| OpenAI 兼容自定义端点 | 支持 | 支持 |
| ChatGPT 订阅（Codex OAuth） | — | 支持 |
| xAI 订阅（Grok OAuth） | — | 支持 |

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 运行时 | Bun |
| 桌面框架 | Electron 39 |
| 前端 | React 18 + TypeScript |
| 状态管理 | Jotai |
| 样式 | Tailwind CSS + Radix UI |
| 富文本输入 | TipTap |
| Markdown / 图表 / 公式 | React Markdown + Beautiful Mermaid + KaTeX |
| 代码高亮 | Shiki |
| 构建 | Vite + esbuild |
| 分发 | electron-builder |
| Agent Runtime | Pi: `@earendil-works/pi-* @0.82.1` |

## 架构概览

DutyDeck 的核心通信路径是：

```text
shared 类型和 IPC 常量
  -> main/ipc.ts 注册处理器
  -> preload/index.ts 暴露 window.electronAPI
  -> renderer Jotai atoms 和 React 组件调用
```

主进程服务集中在 `apps/electron/src/main/lib/`：

- `agent-orchestrator.ts`：Pi Agent 编排、环境变量、事件流、错误处理。
- `adapters/pi-agent-adapter.ts`：Pi 运行时适配与会话管理。
- `agent-session-manager.ts`：Agent 会话索引和 JSONL 消息持久化。
- `agent-workspace-manager.ts`：DutyDeck 工作区、项目根目录、MCP 与 Skills 管理。
- `browser-controller.ts`：内置受管浏览器控制、跨会话视图隔离与本地预览。
- `agent-memory-refresh-service.ts`：工作区记忆变更追踪与刷新。
- `chat-service.ts`：Chat 流式调用、Provider Adapter、工具活动。
- `conversation-manager.ts`：Chat 会话索引和消息存储。
- `channel-manager.ts`：渠道 CRUD、API Key 加密、连接测试、模型获取。
- `feishu-bridge.ts` / `dingtalk-bridge.ts` / `wechat-bridge.ts`：远程机器人桥接。
- `chat-tool-*`、`document-parser.ts`、`workspace-watcher.ts`：工具、文档解析和文件监听。

渲染进程以 Jotai 管理状态，关键 atoms 位于 `apps/electron/src/renderer/atoms/`。Agent IPC 监听器在应用顶层全局挂载，避免切换页面时丢失流式事件、权限请求或后台任务状态。

## 打包注意事项

Pi 运行时在主进程中作为 esbuild external 依赖运行。`apps/electron` 的打包脚本会在 `electron-builder` 前执行 `bun run sync:runtime-deps`，把下列依赖及其运行时闭包复制到应用目录：

- `@earendil-works/pi-coding-agent`、`pi-agent-core`、`pi-ai`
- Pi 运行时所需的原生模块和 `pdfjs-dist`

修改打包配置时，请确认：

- `build:main` / `watch:main` 将 Pi runtime 依赖标记为 external。
- `scripts/sync-runtime-deps.ts` 的 external runtime 清单与实际依赖一致。
- `electron-builder.yml` 保留 Pi native addon 所需的 `asarUnpack` 规则。
- 在目标平台测试 `bun run dist:fast` 后，验证 Pi Agent 可以启动、调用工具和恢复会话。

更完整的工程约定见 [AGENTS.md](./AGENTS.md)。

## 贡献

欢迎修 Bug、补文档、加测试、完善体验，也欢迎围绕真实场景提交新的 Skills、MCP 配置或 Agent 工作流。

提交 PR 前建议先确认：

- 使用 Bun 运行脚本，不混用 npm / pnpm lockfile。
- 状态管理使用 Jotai。
- 尽量保持本地优先，优先使用配置文件和 JSON / JSONL。
- TypeScript 不使用 `any`，对象结构优先使用 `interface`。
- 新增 IPC 时同步修改 shared 类型、main handler、preload bridge 和 renderer 调用。
- 影响包行为时递增对应 package 的 patch 版本。
- 能用测试覆盖的行为尽量补上测试，尤其是共享逻辑、IPC 契约和持久化格式。

## 作者与维护

- 上游 Proma 作者：[erlich.fun](https://erlich.fun)
- DutyDeck 维护者：[kuangtao22](https://github.com/kuangtao22)

## 致谢

- [Proma](https://github.com/proma-ai/Proma) 与作者 [erlich.fun](https://erlich.fun)：DutyDeck 的 Chat、Agent、工作区、Skills、MCP、远程桥接与本地优先存储全部来自这个开源项目。它在 AGPL-3.0 下长期开源并持续迭代，是这个仓库能存在的前提，值得被更多人知道。
- [Shiki](https://shiki.style/)：代码高亮。
- [Beautiful Mermaid](https://github.com/lukilabs/beautiful-mermaid) 与 [Mermaid](https://mermaid.js.org/)：Mermaid 图表渲染与官方兜底渲染。

## 许可证

DutyDeck 采用 [GNU Affero General Public License v3.0（AGPL-3.0-only）](./LICENSE) 开源。本仓库的 `LICENSE` 与上游 Proma 逐字节一致，不附加任何额外限制。

**你可以**：自由使用、修改、分发 DutyDeck 及其衍生作品，也可以商业使用。前提是遵守 AGPL-3.0——以源代码或修改后的形式分发，以及通过网络对外提供服务时，都要公开完整的对应源码，衍生作品必须继续以 AGPL-3.0 授权。

**永久开源承诺**：DutyDeck 的每一个发布版本都以 AGPL-3.0 在公开仓库释出，任意历史版本都能取得对应源码。本仓库不收集、也不接受把贡献重新授权为专有许可的权利——包括维护者在内，没有任何人能把这套代码闭源。

**商业授权豁免**：本项目不提供、也无权提供 AGPL 商业豁免。需要闭源集成请自行遵守 AGPL-3.0，或向拥有版权的上游 Proma 申请其商业许可。

向 DutyDeck 提交 Pull Request 即表示你同意你的贡献以 AGPL-3.0-only 授权给任何人；本项目不要求你转让版权。
