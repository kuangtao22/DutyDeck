# 编排工厂失败诊断与定点补评实施计划

> 使用测试驱动开发；用户“请继续”已授权上一轮提出的失败诊断、保留输出、有预算补评与下一步建议。直接完成实施和离线验证。

**Goal:** Agent 能说明失败发生在哪个环节，并在不重新生成业务输出的前提下，为可恢复的评审故障执行一次有界补评。

**Architecture:** 复用原评审器、模型端口和调用账本。诊断不调用模型；补评读取原运行的冻结材料，独立保存补充报告。原始 review/stepReviews、批次和实验证据不变，不自动采纳。

**Tech Stack:** Bun、TypeScript、Pi/SSE、safe-file 原子 JSON；不新增依赖、后台任务或数据库。

## 设计与取舍

- 采用“诊断 + 一次补评”。只加长超时无法解决原因不明和重复消费；重跑整链会重复生成已成功输出，因此不作为评审失败的默认动作。
- 新评审记录带结构化 failureKind：timeout、cancelled、invalid-response、model-error。旧记录仅对明确的“内容评审超时”兼容识别；未知供应商错误不能猜成可重试故障。
- 诊断分开报告执行、结构/引用约束、内容未达标、证据不足与评审异常。只有执行和约束通过、保存了完整快照的 timeout/invalid-response 步骤可补评。
- 新增 Agent 工具 `factory_diagnose_run` 与 `factory_retry_review`。只使用当前普通前台会话的工厂访问边界；计划模式可诊断、不可启动模型；取消后不发新请求。
- 每条 sourceRunId 一次补评，至多 10 个失败步骤；请求必须传诊断返回的 sourceFingerprint 和显式 maxCalls/maxTransportAttempts/durationMs，硬上限分别为 10/20/600000。Agent 每回合最多 3 次补评，并占既有 60 次操作额度。
- 补评复用原输入、步骤轨迹和原评审标准，不接受新提示词、模型或原文。实际渠道/模型必须与原评审绑定一致；开始时冻结当前配置指纹，后续发送前复核。供应商隐藏修订仍不可证明。
- 用 `review-retries/<hash(sceneId,runId)>.json` 保存独立补评记录与调用账本；原运行零修改，旧批次/采纳继续只看原始评审。正在运行的记录经进程重启后为 interrupted，不恢复和重发。
- 已属于有界实验的 run 不从补评入口追加调用，保持既有实验预算和不可恢复合同。普通批测的补评只能用于诊断参考，不改变该批次认证。
- 请求前记录尝试及预留额度，写失败不允许发送；单进程锁覆盖同一根目录/源运行，源运行指纹改变拒绝继续。所有权检查与新调用检查分开，取消后仍保留已用额度与结果。
- 每次底层传输（含凭据等待后的首次发送和可观察网络重试）均复核原材料、模型配置、模式与时限。取消、超时或漂移后才收到的响应独立保存为 `excludedResponses`，每步截断到 24000 字符，只供排障，不改变终态或质量结论。
- 新的成功单步运行同步保存实际定义快照，以便用原步骤轨迹补评；旧历史缺少快照时继续拒绝，不借当前场景补造历史。
- 此轮不增加 renderer/IPC 操作。诊断与报告由当前 Agent 会话呈现，持久报告可再次读取；原运行面板继续显示原始状态。后续若补 UI，应明确区分原评审与补充报告。

## 实施顺序与验收

- [x] 共享故障/诊断/补评类型和无模型诊断函数；先验证 timeout、解析失败、取消、执行/约束失败、内容未达标、旧未知报告、缺快照等分支。
- [x] 评审器产生稳定故障分类，支持外部取消与超时结束等待；不吞掉旧运行输出，既有解析与评审回归通过。
- [x] 新建宿主补评服务，离线证明业务模型执行次数不增加、只补失败步骤、保持原运行字节等价、调用预算、重复/并发/重启、身份漂移、取消、持久化失败及实验运行拒绝。
- [x] Runtime/Facade/工具注册接入，测试只读、取消、回合额度、工具白名单和参数不能覆盖宿主身份；默认 Skill patch 升级并写明用途与停止条件。
- [x] 定向测试后运行工厂完整测试、相关共享/权限测试、workspace typecheck、Electron build、diff-check；独立审查证据边界。
- [x] 记录验收结果与 MEMORY 决策；不调用真实模型，不替用户修改场景或采纳候选。

涉及文件：共享 `types/capability-factory-review-retry.ts`、`utils/capability-factory-run-diagnosis.ts`；主进程 `capability-factory-review.ts`、新 `capability-factory-review-retry.ts`、`capability-factory-session-runtime.ts`、Facade/Agent tools、`agent-orchestrator.ts`；默认 Skill 与对应测试。

## 影响与性能

常规运行增加可选故障字段，旧历史兼容；没有额外常驻进程。只有显式补评才新增评审模型请求，不重跑执行步骤。独立文件只保存至多十条补评结果、摘要与计量，原文/输出通过指纹和 runId 引用；文件按次数和大小限制，不逐 token 落盘。金额未知保持未知，不承诺货币硬封顶。

## 验证记录

核心与宿主接线已完成。独立审查提出的传输边界复核、普通评审取消信号和迟到响应保存三项均已修复，并经复查无新增 P1/P2。

- 工厂完整测试、共享工厂协议/诊断、默认 Skill 与 Agent 权限回归：32 个文件、572 项测试、2075 个断言，全部通过。补评服务 20 项、普通 runner 37 项包含在内。日志 `/tmp/review-recovery-all-tests.log`。
- 全部 8 个 workspace 的 `bun run typecheck` 通过。日志 `/tmp/review-recovery-typecheck.log`。
- `bun run electron:build` 通过；原生编译缓存显式放在 `/tmp/dutydeck-measured-clang-cache` 与 `/tmp/dutydeck-measured-swift-cache`，避免沙箱外缓存写入。现有 EventKit availability 编译警告不影响构建。日志 `/tmp/review-recovery-build.log`。
- `git diff --check` 通过。MEMORY 已记录补评证据归属、一次性额度和取消后的结算边界；保留并行会话新增的其它记忆条目。未提交或推送代码。
- 全部使用离线替身，未调用真实模型、修改真实场景或采纳候选；没有真实质量、费用与耗时收益结论。Nowledge 定向检索已尝试，本机服务不可达，未同步跨工具记忆。
