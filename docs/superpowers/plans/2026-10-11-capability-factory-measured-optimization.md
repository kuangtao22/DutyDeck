# 编排工厂可信评测与有界优化计划

> **For agentic workers:** 使用 `executing-plans` 按任务验证；独立实现任务按 `subagent-driven-development` 协调。用户已要求开始实施，下列复选框跟踪实际完成情况。

**Goal:** 让用户知道提示词为什么改善、在什么输入上改善、花了多少调用，以及是否值得采纳。

**Architecture:** 保留 DutyDeck 当前 Agent、工厂批测、Pi 模型调用和逐次采纳审批。增加工厂内部的评测协议、实验记录与调用账本；候选仍由当前会话 Agent 提出，宿主控制样本、预算、版本与结果判定。借鉴 Agent Lightning Skill/APO 的实验方法，第一期不引入其 Python、GPU 或训练服务。

**Tech Stack:** Bun、TypeScript、Electron、React/Jotai、既有 Pi runtime、工作区 JSON/JSONL 原子持久化；不新增依赖。

**状态 / 日期:** 2026-10-11，第一期已实施，相关回归与构建通过；全仓类型检查存在同期改动阻塞（见第 9 节）。用户已确认首个试点为“小说角色提取，优先提高质量，同时限制费用与耗时”，并以“请开始”授权实施及离线验证；真实付费实验仍须明确数据与预算，尚未测得模型收益。

---

## 1. 结论与范围

推荐先实现可靠评测与调用预算，再做一个场景的受控实验。有可靠输入和标签时，预期能减少反复人工挑样本、读日志和猜测提示词效果的工作；具体准确率、费用和速度收益必须由试验决定。

| 方案 | 可以得到什么 | 代价与判断 |
| --- | --- | --- |
| 只修改默认 Skill | Agent 更有纪律地分析失败和复测 | 成本最低，但不能补上标签评分、真实计量和持久实验身份；作为辅助，不单独算完成 |
| **通用评测协议 + 有界实验（推荐）** | 可追溯的正确性、成本、耗时对比，以及明确的停止与采纳依据 | 复用现有工厂，工程量适中，先验证收益再扩大 |
| 接入 Agent Lightning 训练/搜索后端 | v0.x APO 单模板候选搜索；v1 可训练权重模型的 RL | Python 集成、重复评测及训练环境成本更大；当前收益未证明，后置评估 |

已确认首个试点为“小说角色提取”，优先减少漏提、错关系和错引用，同时限制费用与耗时；底座不能写死小说字段。输入、输出路径、实体匹配字段和业务判据全部由场景协议配置。后续其他抽取场景复用；自由文本创作、复杂工具决策并不自动获得可计算的正确率。

一期优化变量仅为一个 `llm/extract` 步骤的 `prompt`。执行/评审模型、参数、输入输出结构、依赖关系、重试策略和评审标准保持冻结。模型对比、流程搜索、GPU 训练各自是不同实验，不混入本计划的提示词收益。

## 2. 实施前确认的现状

以下以 2026-10-11 开始实施时的工作树为准，保留当时的差距记录；实际实现与验证见第 9 节。包含同期模型设置改动，实施时保留了已有工作。

- 已有版本、草案、步骤输入输出轨迹、自动评审、逐条判据聚合、持久批次、精确运行 ID、证据检查、局部采纳与能力包导出。
- `CapabilityCase.expected` 可保存 JSON，但当前评测只把 `input` 交给运行器，没有据此计算标签正确率；不可把字段存在误称为评分能力存在。
- 数据集没有受校验的优化/验证/留出划分。步骤有时间戳，但没有统一的每次模型调用 usage/cost 账本；失败重试也不是完整逐次轨迹。
- 每个 Agent 回合最多 3 个 comparison 批次、60 次场景运行，每批最多 10 条。单步诊断也占额度；不能靠新会话、另一个入口或内部后台任务重置预算。
- 执行与评审可选择不同模型；换模型发布场景新版本并保留草案，旧实验身份不能继续背书。
- 局部采纳禁止借用整份草案的测试批次；新方案必须保留这个边界。
- 普通 SSE 模型端口和 Pi 模型端口当前都只向工厂返回文本/模型；普通 `streamSSE` 还可能进行首事件前重试，调用计数不能忽略这一层。

关键实现位置（实施从这些文件进入，不另建平行工厂）：

| 路径 | 责任 |
| --- | --- |
| `packages/shared/src/types/capability-factory.ts` | 场景、数据集、运行与评测类型 |
| `apps/electron/src/main/lib/capability-factory/capability-factory-evaluate.ts` | 用例评测与判据聚合 |
| `apps/electron/src/main/lib/capability-factory/capability-factory-batch.ts` | 冻结批次、成对运行、持久证据 |
| `apps/electron/src/main/lib/capability-factory/capability-factory-agent-facade.ts` | 当前回合额度与 Agent 访问 |
| `apps/electron/src/main/lib/capability-factory/capability-factory-run.ts` | 执行及逐步骤内容评审 |
| `apps/electron/src/main/lib/capability-factory/capability-factory-model-call.ts`、`capability-factory-pi-call.ts` | 普通 API / Pi 调用与计量入口 |
| `packages/shared/src/utils/capability-factory-optimization.ts` | 同口径比较与现有采纳门槛 |
| `apps/electron/src/main/lib/capability-factory/capability-factory-draft-adoption.ts` | 真实局部合并结果 |

## 3. 实验合同

### 3.1 数据与标签

首轮准备 30 条有代表性的真实输入，分为优化、验证、留出各 10 条；数量是上限内的推荐试点规模，不是统计充分性的承诺。不足时缩小并明确样本数，不用模型编造数据补足“真实样本”。

候选生成前冻结划分。以作品或独立来源为分组单位，同一作品相邻章节、同一输入的切片和近似副本不得跨组。要求各组覆盖普通、长输入、别名/代称、容易错引或漏提等主要难度；覆盖不足直接记录。保留来源分组、输入内容指纹和去重检查；文字相似性检查不能声称发现所有语义重复。

标签由 Agent 辅助整理、由可复核原文或人工标注确认；模型输出不能给自身当正确答案。标签状态分为完整、部分、未核对；有界优化实验创建前要求三组标签均完整且可评分，通用评分器仍保留部分/未核对状态。只有完整标签才能计算召回率/F1；部分标签可以报告已知错误与证据通过情况，不能把未知当通过或当零。

新增 `protocolVersion` 绑定划分、标签、评分器及其版本、输出映射、匹配规范、阈值和主要指标。标签/评分标准修改创建新协议版本，旧结果仍可阅读，但不能直接和新分数比较。旧数据集不自动伪装成已标注实验集。

### 3.2 可计算评分与语义评审分开

第一期内置两个有界评分器，不接受模型生成的任意 JavaScript：

1. **字段精确比对 / 元组集合比对**：用配置的输出字段路径与匹配键，从标签和输出提取原子项。保留大小写/空白处理等显式规范；角色别名映射来自冻结标注，不由被测模型即时发明。
2. **既有证据检查**：复用原文与引用归属检查，不另写一套近似逻辑。引用存在与引用支持某项事实分开；后者仍需冻结的语义判据或人工复核。

集合匹配使用 `TP / (TP + FP)`、`TP / (TP + FN)`、`2TP / (2TP + FP + FN)`。双空集合单独计“空结果正确”，F1 标为不适用，不能靠大量空输入抬高宏平均。重复项另报重复率，不能静默去重后掩盖坏输出。结构无效的完整标注样本计业务失败；基础设施或评审异常单列，未完成时不得仅对成功子集宣称整体提升。

业务错误率按冻结的整条任务通过规则计算：结果完整可判定且违反任一关键规则的任务计错。总分母为全部预定样本；存在未完成或未知项时同时报告已知错误率下界与把未知计错的上界，不能把未知排除后给出通过结论。F1 与整条任务成功率分别报告，不互换名称。

小说样例优先统计角色 precision/recall/F1；关系匹配只有在方向、类别与别名标注充分时启用。无法可靠离散化的关系摘要继续做语义评审，不硬凑“关系准确率”。质量、格式、证据、完成率、费用和耗时分列，不合成一个可互相抵消的总分。

### 3.3 一次试点的固定流程

```text
冻结数据/标签/模型/判据与基线
  → 当前 Agent 根据优化集及已有失败轨迹提出候选 A
  → 第 1 批：优化集 10 条，基线 vs A
  → 最多修订一次得到 B（也可保持 A）
  → 第 2 批：验证集 10 条，基线 vs B
  → 验证失败则结束；通过则冻结 B
  → 第 3 批：留出集 10 条，基线 vs 同一 B
  → 报告改善/退化/未知、成本与范围
  → 用户按现有审批决定是否采纳
```

这是 **3 个比较批次、至多 2 个候选、60 次整链运行**，不是“3 轮各自搜索很多候选”。本回合没有额外预跑或复测额度；如果已经消耗额度，宿主缩减样本或停止。需要更多样本或重复试验时，另建用户明确发起、有总预算的新实验，不能自动开启新回合绕过限额。

三批分别标注实际候选 A/B，不把 A 的优化集成绩拼进 B 的整体收益。B 的验证与留出结果分开展示，只有与最终 B 内容完全一致的记录才能作为其证据；A 的失败仅用于解释迭代原因。

**进入留出测试的门槛 `validationEligible`：**验证集每个计划输入都有完整的基线/B 配对、标签覆盖满足协议、两版身份一致；既有比较器的 comparable 与 candidatePassed 均为 true，regressed/unknown 均为空；冻结的主指标严格改善。F1 模式用完整标注且正确答案非空的同一组输入做逐输入宏平均，两版共用分母，差值须大于 `1e-6`；正确答案为空的样本另外计算空结果正确率且不得退化。业务错误率模式要求错误任务数严格减少且无未知项。两种主指标实验前选定，不能事后切换；缺少足够完整标签时不进入自动优化试点。这个门槛只决定是否值得消耗最后一批预算，不表示统计显著或可采纳，也不要求旧比较器已经把新 F1 识别成 fixed。

**最终采纳资格 `adoptionEligible`：**继续按现有采纳规则和实际合并快照验证，额外核对协议、实验完整性与数据暴露状态。即使 validationEligible 成立、新 F1 有改善，若旧采纳规则尚未认可其改善证据，仍只能展示效果报告，不自动变更为可认证采纳。

首轮场景优先选无 map、无真实写入副作用且无需多次重试的既有场景。现有场景若不是该形状，先在计划中记录真实展开次数与预算；不能为了省费悄悄改掉原场景的重试或流程，再声称仅优化提示词。

### 3.4 留出范围与污染处理

一期做到**流程留出**：候选准备接口仅打包优化集，验证后的候选冻结，最终评测才使用留出输入，评分标签不放入被测模型提示词。验证失败不再按验证样本细调同一轮；留出反馈用于下一次修改时，该集合退役为已见数据，新实验需要新留出来源。

当前 `factory_list_datasets/get_run/get_batch` 和普通文件工具仍可能读取原文/标签，因此不能承诺技术上的防泄漏。记录 `declared-unseen / exposed / unknown` 暴露状态；来源是否已见无法确认时，报告只能称回归验证。界面被动列表刷新不计作优化器读取；Agent 显式读取数据集、验证/留出详情或包含受保护运行的列表才记录可观察的暴露。候选冻结与摘要接口能降低意外污染，不能证明 Agent 没经其他路径看到数据。强隔离需要受限优化会话和专用存储/读取边界，不属于一期。

### 3.5 实验身份、草案与采纳

实验记录独立保存候选快照与实验 ID，不覆盖用户现有多块草案。宿主构造“当前生效整份场景 + 本次步骤 prompt”的准确候选，整链测试以此为准；其余用户草案保持待审。需要给 runner 增加仅供宿主实验服务调用的冻结快照入口，不向 renderer/Agent 暴露任意 definition 执行接口。

冻结身份包含工作区、场景版本、协议版本、标签/输入指纹、候选内容、执行与评审渠道/模型/参数及可用供应商修订信息。供应商不提供模型修订标识时明确记录未知，不能承诺跨日期完全可复现。

效果报告与采纳资格是两层：F1 提升不自动覆盖现有“候选通过、无退化、无未知、至少一项改善”的规则。基线格式失败而候选修好时可报告修复事实，但现有比较器仍可能判不可采纳，不能偷偷放宽。第一期保留旧 `testedBatchId` 与局部采纳禁用该字段的规则；新增实验报告若用于局部审核，必须校验实际合并后的整份场景等于已测快照，并绑定独立的实验指纹。无法证明时只显示参考证据。

采纳仍复用现有 Agent 审批卡，冻结步骤范围、实际差异、实验指纹及来源。换模型、修改判据、更新标签、并发修改场景或其他草案造成合并结果变化，旧审批失效。普通明确采纳与“经过优化认证”继续分开，不能把推荐目标当成批准。

## 4. 预算、性能与成本

### 4.1 两本账与停止条件

- **实验账本**：最多 3 比较批次、60 整链运行、2 个候选，记录已用/已预留额度、开始时间和截止时间；已有回合上限与实验上限取更严格者。已经开始的实验在进程退出后为 interrupted 终态（包括阶段间退出）；未启动的 prepared 实验仍可执行，保留已花额度和不完整配对，不恢复或重发在途请求；若用户另行发起实验，保留前次花费关联并重新冻结身份，不能把旧半对结果当完整新证据。
- **调用账本**：执行、评审、重试分别计数，记录模型、耗时、可得 usage 与价格来源。请求前预留，完成/失败后结算；map 并发共享同一账本。未知用量/价格为 unknown，订阅额度不是免费。
- 当前会话中生成提案的 Agent 成本单列；无法从混合回合准确归因时报告未归因，不用零补齐，也不把工厂调用费称总优化费。
- 软件可以限制后续整链与逻辑模型调用的启动。普通 SSE 的内部重试须通过工厂注入的 fetch 包装额外计量；Pi/供应商内部无法观测的重试不得被当作已精确计数。
- 有可靠单价和上界时可做金额预留；其余模式只提供金额估算及调用次数/时间限制。不能保证未知价格、缓存计费、订阅额度和取消后的供应商账单不超某个人民币值。一期拒绝硬金额封顶参数，只开放逻辑调用、可观察传输与时间上限；宿主最高允许 1,000 次逻辑调用、2,000 次可观察传输、24 小时，真实试点应配置更小预算。
- 用户取消、期限或配额耗尽、模型/版本漂移、协议变化、验证失败、污染或证据缺失均停止后续调用，报告具体原因；停止不把已完成运行抹去。

### 4.2 可复算的调用与费用示例

```text
整链数 = 3 批 × 10 条 × 2 版本 = 60
工厂模型请求 = Σ每次整链(各步骤实际执行次数及重试 + 内容评审请求)
总优化费用 = 工厂请求实际/估算费用 + 可归因提案 Agent 费用 + 未归因费用说明
串行耗时 ≈ 60 × 单次整链平均耗时（含评审）+ 提案/等待时间
```

无 map、无重试且每一步都评审时：1 个模型步骤约 120 次模型请求；3 个模型步骤约 360 次。失败重试、截断重跑和提案调用额外计算，不能把 60 次整链说成 60 次模型请求。

| 假设一次整链含评审费用 | 60 次整链费用 | 说明 |
| --- | --- | --- |
| ¥0.10 | ¥6 | 假设值，不是当前渠道报价 |
| ¥0.50 | ¥30 | 另加提案 Agent 费用和未归因部分 |
| ¥2.00 | ¥120 | 长输入/昂贵模型应先缩小样本 |

若整链平均耗时 20 秒，60 次约 20 分钟；若平均 60 秒，约 60 分钟，均另计提案、排队和重试。一期不通过放开并发获得虚假提速，也不复用未经完全身份校验的历史基线。

运行记录继续复用现有 JSONL，不复制一份完整轨迹到实验文件；实验只存指纹、分组、计量与 runId/batchId。新元数据按一次调用结算或阶段终态写入，不逐 token 写磁盘；原有历史文件整文件原子重写的开销须用 60 次试点监测，首期不新增数据库或重写存储架构。

## 5. 预计能达到什么效果

| 层次 | 可以合理预期的结果 | 如何验收 |
| --- | --- | --- |
| 工程能力，高把握 | 每次优化有冻结基线、样本、指标、模型、差异、调用与停止原因；能识别证据缺失和模型漂移 | 离线回归 + 真实 UI 冒烟；无法识别供应商隐藏变化的范围明确 |
| 人工工作，中高潜力 | Agent 组织样本、定位失败、提出至多两个候选并汇总；用户集中核对标签和最终采纳 | 记录相同任务下人工操作数/用时；尚无基线，不承诺节省百分比 |
| 已知格式/引用规则，高把握检测 | 已定义校验覆盖的违例能被报告和阻止背书 | 注入漏字段、错引用、重复项等反例；不等于模型永不犯错或所有语义错引都可检测 |
| 任务质量，中等潜力 | 提示词造成的遗漏、格式歧义或错误示例污染有机会改善 | 独立来源数据成对对比；模型能力或输入信息不足时可能完全没有收益 |
| 成本/速度，不能预设下降 | 能看清代价并拒绝昂贵的“改善”；更长提示词也可能变慢、变贵 | 相同模型下报告每次业务运行与一次优化的不同成本 |
| 自训练/跨任务泛化 | 一期不提供 | 不以 Microsoft 基准提升代替本项目实测 |

**建议作为继续投入门槛的目标，不是收益预测：**在后续足量留出样本上，预先选定的业务错误率相对降低至少 20%，或主质量指标绝对提高至少 5 个百分点；两者按场景提前选一个，不能事后挑好看的。关键判据无新增退化，单次业务运行成本增幅不超过 10%，耗时增幅不超过 20%；真实价格未知时，不能宣称已通过费用门槛。

例：错误率 20% → 16% 是相对减少 20%，对应成功率 80% → 84%；不是成功率增加 20 个百分点。若基线已很好或错误非常稀少，用是否修复预先列明的关键错误衡量，不强求百分比。

首轮只有 10 条留出输入，一条变化就是 10 个百分点（按整条任务成功率计算）；它只用于判断是否值得扩大验证。即使 10 条零退化，在独立样本假设下，单侧 95% 退化率上界仍约 26%，更不能把同一作品中很多角色当独立样本夸大置信度。

扩大验证时建议使用 100–200 条新来源输入，分组留出，并对选定案例重复运行以观察随机波动；具体样本量由基线错误率、目标差异与来源相关性确定，100–200 也不保证识别 5 个百分点的小差异。统计以独立来源分组的成对差异/区间报告；证据不足就写“方向积极但未确定”，不强行颁发优化成功。

## 6. 实施任务与验证

所有路径相对于仓库根 `/Users/xutaoyu/CodeSource/GPL/DutyDeck`。每个任务先建立失败用例、确认失败原因，再实现最小改动并运行该组测试。新类型/方法/变量配中文用途注释，边界参数和返回值写清；不使用 any。提交若另获授权，使用中文说明且仅选择本任务文件。

### Task 1：定义协议、评分与实验记录

**Create:** `packages/shared/src/types/capability-factory-experiment.ts` 与同名 `.test.ts`。
**Modify:** `packages/shared/src/index.ts`、`packages/shared/src/types/capability-factory.ts`。

- [x] 定义版本化协议、样本分组与标签完整性、冻结的模型/候选指纹、调用计量、实验阶段和报告类型；`expected` 旧字段继续兼容。
- [x] 为旧记录缺少协议/usage、不同 split 共享 sourceGroupId、重复输入、标签不完整、未知费用分别编写解析测试；重复来源禁止实验开始，旧记录正常阅读。
- [x] 实验状态仅允许 `prepared → optimizing → validating → held-out → completed`，任一执行状态可转 failed/cancelled/interrupted；completed 不代表可采纳。验证后候选变化须拒绝继续。
- [x] `bun test packages/shared/src/types/capability-factory-experiment.test.ts` 通过，且现有类型/IPC 测试保持通过。

### Task 2：连接标签评分与既有证据检查

**Create:** `apps/electron/src/main/lib/capability-factory/capability-factory-scoring.ts` 与同名 `.test.ts`。
**Modify:** `capability-factory-evaluate.ts`、`capability-factory-batch.ts` 及其测试；复用 `capability-factory-evidence.ts`。

- [x] 以冻结字段路径和匹配规则实现精确值/元组集合评分；普通对象键顺序不影响相等性，数组是否视集合由协议决定。
- [x] 标注 `{A,B}` 对预测 `{A,C}` 应得到 TP=1/FP=1/FN=1、precision=recall=F1=0.5；双空返回不适用 F1；部分标签不计算 recall/F1；重复项另外报告。
- [x] 验证批次和旧 evaluate 入口使用同一个评分函数；评审失败、格式无效、取消、无标签不得被平均成通过。
- [x] 评分结果记录协议与运行身份，保持原有 `review` 和采纳判断，不把机器分数偷偷塞进模型评审指标。
- [x] `bun test apps/electron/src/main/lib/capability-factory/capability-factory-scoring.test.ts apps/electron/src/main/lib/capability-factory/capability-factory-evaluate.test.ts apps/electron/src/main/lib/capability-factory/capability-factory-batch.test.ts` 通过。

### Task 3：实现调用账本与有限计量

**Create:** `apps/electron/src/main/lib/capability-factory/capability-factory-budget.ts` 与同名 `.test.ts`。
**Modify:** `capability-factory-model-call.ts`、`capability-factory-pi-call.ts`、`capability-factory-run.ts`、`capability-factory-session-runtime.ts` 及相应测试。

- [x] 在执行/评审共用模型端口加入预留与结算；先记录逻辑调用、真实耗时、目的与终态；Pi 能返回的 usage 按实际字段提取，未知不估零。
- [x] 普通 SSE 在工厂自己的 fetch 包装中统计可观察的传输重试；不改变聊天全局重试政策。现有普通 SSE 无 usage 合同时先显示 unknown；若试点渠道必须精确计费，仅补该协议的可选 usage 透传与官方样例测试，不一次改所有 provider。
- [x] 调用额度剩 1 时两个并发申请只能启动一个；取消后不启动评审；失败不能返还已可能计费的调用额度；刷新/新会话不重置实验账本。
- [x] 区分取消前未发送、已发送结果未知与完成计费；金额预算无法形成可靠上界时，接口拒绝宣称硬金额封顶。
- [x] 运行模型、Pi、预算和运行器相关定向测试；若修改 `packages/core` 的事件/返回类型，增加其 provider 与 SSE 全组回归，再运行 workspace 类型检查。

### Task 4：持久实验服务与冻结快照运行

**Create:** `apps/electron/src/main/lib/capability-factory/capability-factory-experiment.ts` 与同名 `.test.ts`。
**Modify:** `capability-factory-store.ts`、`capability-factory-service.ts`、`capability-factory-run.ts`、`capability-factory-batch.ts`、`capability-factory-batch-control.ts`。

- [x] 以 safe-file 原子写保存 `<factoryRoot>/experiments/<id>.json`，仅保存冻结元数据与证据引用；使用现有 ID/工作区归属校验。
- [x] 以当前生效完整定义叠加单步 prompt 生成内部候选；复用实际 runner 和评审逻辑，禁止绕过模型解析、输入验证、停止信号或权限检查。
- [x] 第 1/2/3 批严格绑定 optimization/validation/held-out 划分；仅第 1 批后允许一次修订，验证失败短路第 3 批。
- [x] 用户已有多块草案时不覆盖；历史批次和草案 CAS 行为保持。进程重启将活跃实验标 interrupted 终态，不支持一期恢复；半对结果保留为不完整证据，不重新发送结果未知的在途请求。
- [x] 独立测试 validationEligible 与 adoptionEligible：标签完整且主指标改善可以进入留出，旧采纳规则仍不满足时不得认证；主指标无改善、任意配对缺失、空结果组退化或 unknown 均不得进入留出。
- [x] 测试三个批次 60 次运行边界、已有额度不足、重启、并发模型变更、标签/标准变更、迟到结果写入、草案保护和版本冲突；各异常都保留已完成证据。

### Task 5：Agent/IPC/审批接入

**Modify:** `packages/shared/src/types/capability-factory-ipc.ts`、`apps/electron/src/main/lib/capability-factory/capability-factory-ipc.ts`、`apps/electron/src/main/ipc.ts`、`apps/electron/src/preload/capability-factory-preload.ts`、`apps/electron/src/preload/index.ts`、`capability-factory-agent-facade.ts`、`capability-factory-agent-tools.ts`、`capability-factory-agent-operations.ts`、`capability-factory-adoption-summary.ts`、`apps/electron/src/main/lib/agent-orchestrator.ts`。

- [x] 四层同步新增创建/读取/推进/取消实验的有界命令；调用方只传实验 ID、允许的候选 prompt 和期望版本，身份/预算由宿主决定。
- [x] 新工具与 `runBatch/runScene/runStep` 共用回合和实验记账，不允许以实验入口绕过 3/60 限额；Automation/委派/受限来源维持现有拒绝边界。
- [x] 候选生成材料默认只返回优化集；读取验证/留出细节时标记可观察的暴露，但明确普通文件旁路不在证明范围内。
- [x] 在现有审批卡显示实际单步合并差异、实验范围、收益与不确定性；实验指纹与实际合并快照不一致时拒绝背书，旧 partial + testedBatchId 禁令不放开。
- [x] 测试直接工具调用、伪造实验 ID/阶段/approved、bypassPermissions 下采纳、计划模式、跨工作区和审批等待期间变更；运行 shared IPC、主 IPC、preload、Facade 和 permission integration 回归。

### Task 6：面板展示与默认 Skill

**Create:** `apps/electron/src/renderer/components/capability-factory/CapabilityFactoryExperimentSummary.tsx` 与同名 `.test.tsx`。
**Modify:** `CapabilityFactoryEvaluationSection.tsx`、`CapabilityFactoryOptimizationSection.tsx`、`CapabilityFactoryPanel.tsx`、`apps/electron/default-skills/capability-factory-scene-design/SKILL.md`。

- [x] 在现有运行/优化区域增加紧凑实验摘要：三组进度、样本数、标签状态、实际模型、质量变化、预算和停止原因；细节折叠，复用 Radix/shadcn 与主题变量。
- [x] 不再新增聊天输入框或第二个设计 Agent；面板仅展示/查看，设计和修改仍由当前会话承担。未知费用显示未知，10 条留出显示“小样本初步结果”。
- [x] Skill 写入固定三批流程、评分与事实区别、污染后退役、费用范围、停止与审批纪律；已将 frontmatter version 从 1.0.9 递增至 1.0.10。
- [x] 测试空数据、无标签、预算用尽、取消、失败、仅部分计费、对比无改善、模型变更和旧历史；真实窗口验证深浅主题、键盘焦点和窄面板可读性。

### Task 7：离线验收、试点与扩大验证决策

- [x] 离线评分/状态/额度/审批回归通过，以下命令均已执行；全仓类型检查尚未通过，具体阻塞如第 9 节所列：

```bash
bun test packages/capability-runner/src
bun test apps/electron/src/main/lib/capability-factory
bun test apps/electron/src/renderer/components/capability-factory
bun test apps/electron/src/preload/capability-factory-preload.test.ts
bun run typecheck
bun run electron:build
```

- [x] workspace 未定义独立 lint 脚本；使用现有类型/构建检查与 diff 审查，不临时安装 lint 依赖。若实施时新增相应仓库脚本，执行其规定检查。
- [ ] 真实试点仅在用户另行要求执行实验且数据/预算确定后运行；本计划不是本轮发起付费请求的授权。先核对标签与分组，然后按 3 批执行，记录所有真实运行 ID。
- [x] 报告同时列“功能验收通过”和“模型效果是否改善”，后者允许无收益。成本未知、留出来源不明、结果不稳定时不进入扩大验证。
- [ ] 小试点显示改善且关键错误不增加，才提出新来源的扩大实验与预算；扩大验证仍受每回合限制，不后台自行连续消费。

## 7. 关联影响、工作量与退出条件

| 模块 | 风险与处理 |
| --- | --- |
| 聊天/订阅/模型目录 | 复用当前模型绑定；若补 SSE usage，字段可选且覆盖现有 provider 回归，不改变路由/凭据/推理行为 |
| 参考 runner / 导出能力包 | 实验、标签、计费留在工厂；能力包 specVersion 不因内部评测改变，消费方无新依赖 |
| 草案/审批 | 逐块采纳范围与真实整份合并快照一致；旧普通采纳及旧批次仍能阅读，不伪造认证 |
| Automation / Collaboration | 不注册或扩权实验工具；现有前台限定不变 |
| 本地存储与性能 | 不新增数据库、常驻进程或后台轮询；按阶段/调用结算写元数据，原始轨迹只存现有记录 |
| 数据维护 | 标注是主要新增人工成本；错误标注会驱动错误优化，发现后新建协议并重验 |

粗略工程量按单人串行、当前模型设置实现稳定估算：协议/评分 2–3 人日，计量/实验服务 3–5 人日，IPC/审批/UI/回归 3–5 人日，总计约 8–13 人日；属于规划估算，尚未通过实施验证。人工标注、额外协议计费适配和真实实验等待另计。先交付前两项可独立使用的评测/计量能力，不等所有 UI 完成才验证方向。

到以下任一条件停止扩大投入：可靠标签无法形成；主要失败来自缺失输入或模型能力而非提示词；新数据不改善；代价超过预定门槛；为了得到正分数必须改判据。此时保留评分与可追溯底座，不继续堆候选或引入 GPU 训练栈。

## 8. 来源与验证范围

- [Agent Lightning v1.0.2 Release](https://github.com/microsoft/agent-lightning/releases/tag/v1.0.2)
- [官方 v1 架构与 rollout 定义](https://github.com/microsoft/agent-lightning/blob/main/docs/05-basics.md)
- [优化 Skill](https://github.com/microsoft/agent-lightning/tree/main/skills)
- [legacy APO 单模板限制](https://github.com/microsoft/agent-lightning/blob/v0.x/docs/algorithm-zoo/apo.md)

外部能力沿用同会话上一轮已核查的官方源码与文档；本轮补查了当前工厂的配额、模型、评分和审批路径。Nowledge Mem 定向检索已执行，本机服务连接被拒绝，未拿它的旧摘要代替当前源码。本轮已实现下述功能并离线验证；未运行真实模型、未修改真实业务数据、未安装依赖。


## 9. 实施记录与交付范围（2026-10-11）

已实现协议/评分、持久实验状态、调用账本、四层 IPC、Agent 工具、证据绑定审批与面板摘要。Agent Lightning 只作为实验方法参考，没有引入其依赖或训练进程。默认 Skill 已升级到 1.0.10。验证中的模型输出均为离线替身，不能据此推断角色提取的真实改善。

实际落点除任务列出的入口外，包含共享的 `capability-factory-experiment-record.ts`、`capability-factory-call-ledger.ts` 与宿主 `capability-factory-session-runtime.ts`。冻结候选通过宿主内部场景视图交给既有 batch/runner，不新增面向 renderer 的任意定义执行接口；UI 摘要直接接入现有 Panel，未另设设计 Agent 或输入区。

已补齐的边界：

- 修复旧 `listDatasets` IPC 命令误分派到 `listDeliveries` 的问题，使面板真实读取数据集，并以真实实验创建/推进回归验证。
- 评分保留关系元组字段位置，集合规范化只作用于字段值；互换 subject/object 不能得满分。
- 运行列表按实际返回的验证/留出 runId 判断暴露，界面挂载及变更刷新不污染实验。保留 Agent 显式材料读取与用户详情读取的记录。
- 持久化只检查真实工作区归属，发送前另检查取消/模式/身份/暴露，确保取消后的已用额度与半对结果仍能保存。计划模式可读历史但不能启动新调用。
- 留出开始时的暴露状态单独冻结，完成后查看结果不改写历史事实；后续复用在整个工作区检查来源/输入是否已退役，跨场景或更换实验 ID 不能重新声明未见。
- 记录采用有界文件读取与原子写入；初始冻结元数据上限 2 MiB，持久文件上限 8 MiB。额度写入失败即停止后续发送，不以旧磁盘值继续消费。

离线验证记录：

| 检查 | 结果 |
| --- | --- |
| 工厂主进程（含权限/审批与真实 runtime 离线链路） | 376 通过，0 失败，23 文件 |
| 工厂 renderer | 188 通过，0 失败，27 文件 |
| runner/shared 协议与 IPC/preload | 69 通过，0 失败，6 文件 |
| 独立最终审查 | 两项问题均修复并复核关闭；关系方向、被动刷新均有先失败后通过的回归 |
| Electron UI 冒烟 | 隔离真实窗口通过；深浅主题、390px 窄窗口、Space 展开/收起、费用未知与证据表，并检查截图 |
| `bun run electron:build` | 通过，包含 Swift/native helper；Clang/Swift 模块缓存定向到 `/tmp`，未改构建脚本 |
| `bun run typecheck` | 未通过；早先运维类型错误修正后重跑，又遇到同期 `AgentView.tsx` 的 4 处未定义变量（2464 行的 `lastUserRawMessage` / `lastUserMessage`，2761–2762 行的 `retryMentions`）。本轮工厂文件无类型报错；未覆盖并行工作来强行消除错误 |
| `git diff --check` | 通过；仓库无独立 lint 脚本，未新增 lint 依赖 |

相关测试合计 633 项，均为功能验证，不是模型效果统计。保留在 `codex/factory-measured-optimization` 的当前工作树，未提交或推送；同期模型设置、知识面板、运维等改动继续保留。

真实 30 条样本试点与后续扩大验证仍未执行，需可复核标注和明确的实验调用/时间预算。10 条留出只能给出初步信号，真实费用未知时不能宣称费用门槛已达成。
