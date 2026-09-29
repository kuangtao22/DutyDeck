# 提示词编排工厂 · 数据模型与能力包 spec v1

> 本文是**字段级定稿草案**，是开发前的最后一份前置件。与界面的关系：界面（`…-ui-v20.html`）决定"长什么样"，本文决定"存什么"。
> 编码实现见 `packages/capability-runner/`（能力包 spec + 校验 + 参考 runner，零依赖可脱离 DutyDeck）。

---

## 一、总原则

**三个轴分开记，永不合成一个分数。**

| 轴 | 取值 | 回答的问题 | 记在哪 |
| --- | --- | --- | --- |
| 运行状态 | `running` / `succeeded` / `partial` / `failed` / `cancelled` | **完整性**：整件事跑完了吗 | `Run.status` |
| 样本有效性 | `valid` / `invalid` | **约束**：这次输出合法吗 | `StepTrace.status`、评测的 `validSamples` |
| 指标 | 数值 | **质量**：好不好 | `Evaluation.metrics` |

把 `partial` 并进 `failed` 会让"300 个账号里成功 299"被判 0 分；把 `invalid` 并进指标会让一次格式错误掩盖真实质量。两处都是同一个错误。

**版本是贯穿一切的主键。** 运行、评测、导出三类记录都必须带 `sceneVersion`（评测再加 `datasetVersion`），否则"改了提示词之后，之前那些记录是哪一版的"无从回答。

---

## 二、工厂侧七类对象

### 1. Scene（场景）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 稳定标识 |
| `name` / `description` | string | 名称与描述（Agent 与接入方都读） |
| `inputs` | `FieldSchema[]` | **输入契约**：调用方必须按这个传 |
| `outputs` | `OutputDeclaration[]` | **输出声明**：只声明形态与来源，不声明约束 |
| `steps` | `Step[]` | 步骤（含并行组容器） |
| `capabilities` | `CapabilityDeclaration[]` | 需要外部世界提供什么 |
| `modelSlots` | `ModelSlot[]` | 模型槽位 |
| `acceptance` | `Acceptance` | 评审判据 + 评审提示词 + 指标权重（**工厂内部**） |
| `currentVersion` | number | 当前生效版本 |
| `draftVersion` | number \| null | 待采纳草案 |
| `createdAt` / `updatedAt` | number | |

### 2. Step（步骤）—— 三种类型 + 一种容器

| 类型 | 字段 | 说明 |
| --- | --- | --- |
| `llm` | `id` `title` `prompt` `modelSlot` `inputs` `maxAttempts?` | 单次模型调用，输出文本 |
| `extract` | 同 llm，另加 `judgeFields: FieldSchema[]` `strictness: 'strict' \| 'lenient'` | 结构化抽取。**格式要求写在 prompt 里，判定字段只用于校验与评分** |
| `tool` | `id` `title` `capabilityId` `inputBindings` `maxAttempts?` | 调外部能力（由接入方绑定） |
| `map` | `id` `title` `over: InputSource` `body: Step[]` `failurePolicy` `concurrency` | **并行组容器**：对 `over` 指向的数组逐项展开 `body` |

`map` 是容器不是类型枚举的扩张，所以"类型只有 llm/extract/tool"这条收敛规则不被破坏。

#### 扇入契约（并行组的关键）

父步骤引用 `map` 组的输出时，拿到的**永远是带失败项的数组**：

```ts
type ItemResult =
  | { index: number; ok: true; value: unknown }
  | { index: number; ok: false; error: string }
```

`failurePolicy` 决定何时停止：

- `fail-fast`：任一项失败即整组失败（用于"给 3 个模型各跑一次取最佳"——失败项不可比）
- `continue`（默认）：收集全部成果**与失败项**，交给下游（用于"32 个账号巡检"）

**无论哪种策略，失败项都必须进扇入**。否则汇总节点只能把 32 默默当成 31。

### 3. SceneVersion（版本）—— 不可变快照

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `sceneId` / `version` | string / number | |
| `snapshot` | SceneDefinition | **不可变**的定义快照（不含版本元信息） |
| `source` | `'agent' \| 'human'` | 改动来自谁——用于"Agent 提案、人发布"的可追溯 |
| `note` | string | 改动摘要 |
| `createdAt` | number | |

采纳 = 把某版本的 snapshot 提升为 `currentVersion`；回滚 = 把旧版本的 snapshot 重新提升为 current（**不删除任何历史版本**）。

### 4. Run（运行）—— 一次执行

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | |
| `sceneId` / `sceneVersion` | string / number | **必须带版本** |
| `status` | 见上表 | 完整性轴 |
| `input` | Record | 这一次的输入 |
| `steps` | `StepTrace[]` | 逐步轨迹 |
| `outputs` | Record \| null | |
| `startedAt` / `finishedAt` | number | |

`StepTrace`：`stepId`、`status`（`succeeded`/`invalid`/`failed`/`skipped`）、`attempts`、`input`、`prompt`、`rawOutput`、`parsedOutput?`、`constraintErrors?`、`error?`、`model`、`itemResults?`（map 组）、`startedAt`/`finishedAt`。

### 5. Evaluation（评测）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | |
| `sceneId` / `sceneVersion` / `datasetId` / `datasetVersion` | | **四个都必须有**，否则差异不可归因 |
| `status` | `running` / `succeeded` / `failed` | |
| `constraintCompliance` | number | 合规率（约束轴，与指标分列） |
| `validSamples` / `totalSamples` | number | 有效样本；合法样本过少时拒绝给指标结论 |
| `metrics` | Record<string, number> | 质量轴 |
| `judgeResults` | `{ criterionId, passed, total }[]` | 逐条判据——回答"错在哪一条" |
| `baselineId` | string \| null | 对比基线 |
| `startedAt` / `finishedAt` | number | |

### 6. Dataset（数据集）

`Dataset`：`id` `name` `version` `cases: Case[]` `updatedAt`。

`Case`：`id` `name` `input` `expected?` `source: 'human' \| 'agent' \| 'regression'` `tags` `fromRunId?`。

- `source` **由 Host 盖章**，不接受调用方自报（沿用接口工作台 B7b 的纪律）
- `regression` = 从失败运行回灌；`fromRunId` 指回来源运行，可追溯
- **v1 只做最小形态**：一个 JSONL + 列表 + 两个动作（加用例 / 从失败回灌），不做数据集管理平台

### 7. Delivery（导出）

`Delivery`：`id` `sceneId` `sceneVersion` `packageVersion` `fileName` `exportedAt` `adoption: 'unknown' \| 'adopted' \| 'deprecated'` `projectId?`。

导出后场景继续改，包还是旧的——所以**包版本与场景版本的对应关系必须能双向查到**。导出始终是人工动作。

---

## 三、能力包 spec v1

```jsonc
{
  "kind": "proma-ai-capability-package",
  "specVersion": 1,
  "packageVersion": "1.0.0",
  "name": "account-status-query",
  "description": "根据用户问题查询账号状态与到期时间",
  "exportedAt": 1790000000000,

  "inputs":  [ /* FieldSchema：调用方必须按这个传 */ ],
  "outputs": [ { "name": "answer", "from": { "stepId": "answer" }, "shape": "structured" } ],

  "steps": [ /* llm / extract / tool / map，与 Scene 的定义同构 */ ],
  "capabilities": [ /* id / description / inputSchema / outputSchema / sideEffect */ ],
  "modelSlots": [ { "id": "main", "model": "...", "temperature": 0.2 } ],

  "acceptance": { "criteria": [ /* 评审判据文本 */ ] },
  "evidence":   { "metrics": {}, "invalidRate": 0, "sampleCount": 0, "recordedAt": 0 }
}
```

**随包导出 / 不导出**：

| 导出 | 不导出 |
| --- | --- |
| 步骤与提示词、输入契约、输出声明、能力声明、模型槽位 | 评审提示词、评审执行器、数据集正文 |
| `acceptance.criteria`（**只导判据文本**，让接入方知道"合格长什么样"） | 运行记录、场景 ID、工作区路径、任何凭据 |

**兼容策略**：`specVersion` 不匹配时**拒绝加载并明确报错**，不做静默降级——降级会让行为悄悄变化，比报错更糟。

---

## 四、v1 范围（不在范围的明确排除）

**在 v1**：串行步骤 + `map` 并行组、`llm` / `extract` / `tool`、单模型槽位、输入输出契约、约束校验与 `invalid` 判定、`extraction` 评测器、数据集最小形态、能力包导出、参考 runner。

**不在 v1**：条件分支（`branch`）、嵌套并行组、多模型并行对比、评审执行器随包、数据集管理平台、批量提交与排队、成本面板。

排除项的理由都是同一条：**先让"包能脱离 DutyDeck 跑起来"这件事被证明，再扩结构**。
