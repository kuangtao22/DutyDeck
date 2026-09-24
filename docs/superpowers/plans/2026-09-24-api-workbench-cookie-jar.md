# 接口工作台 B8：自动 Cookie Jar（实施计划）

> 前置：阶段 A 已明确「SSE、上传、代理、自动 Cookie Jar 和导入属于已批准路线中的下一增量」；B1–B7b 已交付导入导出、事件流、事件断言、变量提取、运行时变量面板、按用例执行与 Agent 出题。
> 本轮只做 **自动 Cookie Jar**，其余三项各自单独评估。

## 1. 要解决的问题

会话型接口（登录拿 `Set-Cookie`，后续请求带 `Cookie`）现在只能靠人工复制：手工加 `Cookie` 头，或用「提取」把 `Set-Cookie` 抄进运行时变量再拼 `{{token}}`。这正是「重复三遍就该自动化」的场景，但自动化带来两个必须由设计兜住的风险：**隐形的成功/失败变化**（某条请求因为上次的 cookie 而通过）与 **凭据外泄**（cookie 值进入运行记录、模型上下文或磁盘）。

## 2. 设计（三条硬约束）

1. **默认关闭，按请求显式开启**：`ApiRequestDraft.useCookieJar`（缺省 `false`，向后兼容）。关闭时既不读也不写 cookie，行为与今天完全一致，不存在「悄悄成功」。
2. **只活在主进程内存**：按 workspace 隔离，跟随主进程生命周期（服务关闭即清空），不落盘、不新增加密文件格式、不进入运行记录与历史摘要。元数据（名/域/路径/过期/HttpOnly）可回传界面；**值永不出主进程**。
3. **只回送到同一 host，且人写的头优先**：第一版不做 Domain 跨域共享（收到 `Domain=` 也不放宽作用域，按 host-only 处理）；路径前缀、`Secure`、过期时间参与匹配；草稿里已经显式写了 `Cookie` 头时以人的写法为准，不再叠加 jar。

## 3. 分层改动（不需要改 Utility 与传输协议）

- 传输层已经采集每次跳转的响应头（含重复 `Set-Cookie`），因此**主进程即可完成读写**：注入在请求解析阶段，采集在运行终态。
- 共享合同：`useCookieJar` 字段、`ApiCookieJarEntry` 元数据、`getCookieJar` / `clearCookieJar` 两条命令与严格回执解析（出现 `value` 之类字段直接判为损坏协议）。
- 请求解析器：`useCookieJar` 为真时按最终 URL（插值后）选 cookie，合成单个 `Cookie` 头并标记为敏感头（记录与预览按既有敏感规则脱敏）。
- 服务：**每 workspace 一份 jar**，与运行时变量同一套隔离与清理方式；运行终态采集所有跳转的 `Set-Cookie`（`Max-Age` / `Expires` 参与过期，`Max-Age=0` 或已过期即删除），条目数与值长度有界。
- 界面：请求「设置」页新增「自动 Cookie（仅本机内存）」开关；工具栏新增「Cookie」面板，列出元数据并支持刷新与一键清空。
- Agent：`api_prepare_request` 的草稿允许 `useCookieJar`（描述里写明只影响宿主内存），**不新增任何读取 cookie 值的工具**；模型看不到值，只能看到自己请求后端的响应头事实。

## 4. 明确不做（本轮范围外）

- 持久化 cookie、导入浏览器 cookie、Public Suffix List 级的 Domain/Path 矩阵、SameSite 强制策略。
- 代理与 multipart 文件上传（各自需要单独的授权模型决策）。
- 让 Agent 读取 cookie 值，或新增 Agent 侧批量运行工具。

## 5. 验收标准

1. 共享合同：`useCookieJar` 缺省 `false` 且合法；`ApiCookieJarEntry` 拒绝携带值字段；`getCookieJar` / `clearCookieJar` 命令与回执严格解析（拒绝伪造 workspace）。
2. 解析器：关闭时不注入；开启时按 host/路径/过期/secure 选值；显式 `Cookie` 头优先；注入的头被标记为敏感。
3. 服务：`Set-Cookie` 采集（含 `Max-Age`、`Expires`、删除语义）、跨 workspace 与跨 host 隔离、关闭时不写入、条目上限、清空、关闭服务即清空。
4. 四层契约与界面：IPC/preload/界面面板接线；请求设置开关；记录与预览里不出现 cookie 值。
5. 真实验收：`bun test`（共享合同 / 主进程工作台 / 工作台界面 / preload / agent 组件）、`bun run typecheck`、`bun run electron:build`、真实 Electron 端到端（登录后 jar 开启的后续请求确实带上 cookie，且运行记录与预览中查不到该值）、界面 smoke（开关、面板、清空）。
