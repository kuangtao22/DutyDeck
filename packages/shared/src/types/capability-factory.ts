/**
 * 提示词编排工厂的领域类型（DutyDeck 侧）。
 *
 * 与能力包 spec 的分工：
 * - `@proma/capability-runner` 定义**包**的格式 —— 可脱离 DutyDeck 运行，消费方直接用。
 * - 本文件定义**工厂内部**的对象 —— 场景、版本、运行、评测、数据集、导出。
 *
 * 两者共用同一套步骤与字段类型（`Step` / `FieldSchema` / `ItemResult`），避免两份定义漂移。
 * 对应设计文档：docs/superpowers/specs/2026-09-27-ai-capability-factory-data-model.md
 */
import type {
  CapabilityDeclaration, CapabilityPackage, FieldSchema, ItemResult, ModelSlot, Step, StepTrace,
} from '@proma/capability-runner'
import { parseCapabilityPackageValue } from '@proma/capability-runner'

/**
 * 把能力包 spec 的类型从 shared 转出：应用侧（主进程/渲染层）统一从 `@proma/shared` 取类型，
 * 不必再关心它定义在哪个包 —— 但**定义只有一处**，仍在 `@proma/capability-runner`。
 */
export type {
  CapabilityDeclaration, CapabilityPackage, ExtractStep, FailurePolicy, FieldSchema, InputSource,
  ItemResult, LlmStep, MapGroup, ModelSlot, Step, StepTrace, ToolStep,
} from '@proma/capability-runner'

/** 输出的形态声明（契约部分）。约束不进这里 —— 真正约束模型的是提示词。 */
export interface SceneOutputDeclaration {
  name: string
  from: { stepId: string; path?: string }
  shape: 'text' | 'structured'
  /** 声明给接入方看、并驱动评审；不是运行时强制。 */
  fields?: FieldSchema[]
  description?: string
}

/** 指标项：权重与方向。方向为 negative 表示"越低越好"（如编造率）。 */
export interface SceneMetric {
  name: string
  weight: number
  direction: 'positive' | 'negative'
}

/**
 * 评审（工厂内部资产，不随包导出执行器）：
 * - `criteria` 随包导出，让接入方知道"合格长什么样"；
 * - `judgePrompt` 与 `metrics` 留在工厂，用于优化与修改提示词。
 */
export interface SceneAcceptance {
  criteria: string[]
  judgePrompt: string
  metrics: SceneMetric[]
}

/** 展开并行容器，只返回需要内容评审的模型步骤，供定义页、执行和评测共用。 */
export function getReviewSteps(steps: readonly Step[]): Array<Extract<Step, { type: 'llm' | 'extract' }>> {
  return steps.flatMap((step) => step.type === 'map' ? getReviewSteps(step.body)
    : step.type === 'llm' || step.type === 'extract' ? [step] : [])
}

/** 取得步骤评审标准；旧版本场景暂时回退到顶层标准，保证历史数据可继续运行。 */
export function getStepAcceptance(definition: CapabilitySceneDefinition, stepId: string): SceneAcceptance | null {
  /** 新场景只认步骤自己的标准；只有没有 stepAcceptances 字段的旧场景才回退顶层标准。 */
  if (definition.stepAcceptances !== undefined) {
    const configured = definition.stepAcceptances[stepId]
    return configured && (configured.criteria.length > 0 || configured.judgePrompt.trim() || configured.metrics.length > 0)
      ? configured : null
  }
  const legacy = definition.acceptance
  return legacy.criteria.length > 0 || legacy.judgePrompt.trim() || legacy.metrics.length > 0 ? legacy : null
}

/** 场景定义快照：**不可变**，是版本的全部内容。改场景 = 产生新快照。 */
export interface CapabilitySceneDefinition {
  name: string
  description: string
  inputs: FieldSchema[]
  outputs: SceneOutputDeclaration[]
  steps: Step[]
  capabilities: CapabilityDeclaration[]
  modelSlots: ModelSlot[]
  acceptance: SceneAcceptance
  /** 工厂内部按流程步骤保存的内容评审标准；旧场景缺失时回退到 acceptance。 */
  stepAcceptances?: Record<string, SceneAcceptance>
}

/** 输入任意 JSON 值，返回忽略对象键顺序、保留数组顺序与正文空白的比较键。 */
export function stableCapabilityValueKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableCapabilityValueKey).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableCapabilityValueKey(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

/** 输入两版场景快照，返回是否仅修改模型步骤提示词；供 UI 与 Agent 宿主使用同一范围约束。 */
export function isPromptOnlyOptimization(before: CapabilitySceneDefinition, after: CapabilitySceneDefinition): boolean {
  /** 隐去允许改动的提示词，递归保留并行组与所有其它配置。 */
  const normalizeStep = (step: Step): Step => {
    if (step.type === 'llm' || step.type === 'extract') return { ...step, prompt: '__PROMPT_CHANGE__' }
    if (step.type === 'map') return { ...step, body: step.body.map(normalizeStep) }
    return step
  }
  /** 归一化只用于比较，不修改原快照。 */
  const normalize = (definition: CapabilitySceneDefinition): CapabilitySceneDefinition => ({ ...definition, steps: definition.steps.map(normalizeStep) })
  return stableCapabilityValueKey(normalize(before)) === stableCapabilityValueKey(normalize(after))
    && stableCapabilityValueKey(before) !== stableCapabilityValueKey(after)
}

/** 待采纳草案的元信息。 */
export interface CapabilitySceneDraft {
  definition: CapabilitySceneDefinition
  /** 改动来自谁 —— 支撑"Agent 提案、人发布"的可追溯。 */
  source: 'agent' | 'human'
  note: string
  createdAt: number
}

/** 场景：一个可交付的 AI 能力。 */
export interface CapabilityScene {
  id: string
  /** 当前生效的定义。 */
  definition: CapabilitySceneDefinition
  /** 当前生效版本号。 */
  currentVersion: number
  /** 待采纳草案；同时只允许一份。 */
  draft: CapabilitySceneDraft | null
  createdAt: number
  updatedAt: number
}

/** 版本：不可变快照。回滚 = 把旧快照重新提升为 current，不删除任何历史版本。 */
export interface CapabilitySceneVersion {
  sceneId: string
  version: number
  definition: CapabilitySceneDefinition
  source: 'agent' | 'human'
  note: string
  createdAt: number
}

/** 用户提交过的整链任务输入；独立于运行结果，便于下次直接复用。 */
export interface CapabilitySavedTask {
  id: string
  sceneId: string
  input: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

/** 运行状态：**完整性轴**，与 valid/invalid（约束轴）和 metrics（质量轴）分开记。 */
export type CapabilityRunStatus = 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled'

/** 单次内容评审：独立于运行成功与格式合法，旧记录可没有这一项。 */
export interface CapabilityRunReview {
  status: 'running' | 'succeeded' | 'failed' | 'skipped'
  /** 无法判断或尚未评完时为 null，不能按通过处理。 */
  passed: boolean | null
  summary: string
  /** 运行开始时固定的评审规则，防止等待期间的场景编辑污染结果。 */
  acceptance: SceneAcceptance
  criteria: { criterion: string; passed: boolean | null; evidence: string }[]
  /** 指标可因缺少事实依据而无法计算；不得用零补齐。 */
  metrics: { name: string; value: number | null; evidence: string }[]
  suggestions: string[]
  /** 用于追溯评审的实际模型；默认复用本轮执行模型，不新增手工绑定步骤。 */
  modelBinding?: CapabilityRunModelBinding
  error?: string
  startedAt: number
  finishedAt: number | null
}

/** 一次运行。`sceneVersion` 是贯穿主键 —— 没有它，"改了提示词之后旧记录是哪一版"无从回答。 */
export interface CapabilityRun {
  id: string
  sceneId: string
  sceneVersion: number
  /** 本轮执行的定义来源；旧记录缺失时按 current 处理。 */
  definitionTarget?: 'current' | 'draft'
  /** 本轮真正执行的定义快照，避免草案覆盖后无法还原候选内容。 */
  definitionSnapshot?: CapabilitySceneDefinition
  /** 候选运行绑定的草案创建时间；当前定义运行不填。 */
  draftCreatedAt?: number
  /** 前后两次运行共用的对比标识，用于重启后仍能配对。 */
  comparisonId?: string
  /** 对比中的身份：当前定义是基线，草案是候选。 */
  comparisonRole?: 'baseline' | 'candidate'
  /**
   * 运行范围：`full` 整链运行（默认，老记录没有这个字段按 full 处理）；
   * `step` 单步试跑 —— 提示词训练的主回路，**不需要整条链可跑**。
  */
  kind?: 'full' | 'step'
  /** 正在执行的步骤 ID；并行组可同时有多项，仅用于请求级实时快照。 */
  activeStepIds?: string[]
  /** 新版整链运行是否已作为用户任务保存；旧记录缺失时按可兼容任务处理。 */
  taskSaved?: boolean
  /** 单步试跑针对的步骤 id。 */
  stepId?: string
  /** 单步试跑用的**提示词模板原文**（不是渲染后的）：对比两次尝试时 diff 的就是它。 */
  stepPrompt?: string
  status: CapabilityRunStatus
  /** 约束轴：任一步骤判定不通过即为 false。 */
  valid: boolean
  /** 证据轴：逐字引用无法回溯到原文时保留问题，不改写模型原文；摘要语义由评审器核对。 */
  evidenceIssues?: string[]
  input: Record<string, unknown>
  outputs: Record<string, unknown> | null
  steps: StepTrace[]
  /** 并行组的部分失败摘要，用于界面一眼看出"哪个子项挂了"。 */
  itemResults?: ItemResult[]
  /**
   * 这次运行实际用到的模型绑定：场景声明了什么、实际调了哪个渠道的哪个模型。
   * 没有它，"为什么跑的不是 gpt-5.4" 只能靠猜（场景里的模型名可能只是模板默认值）。
   */
  modelBindings?: CapabilityRunModelBinding[]
  /**
   * 这次运行里用的是**占位桩**的能力 id。
   * 有它才能事后判断"这份结果能不能当质量依据"—— 占位值跑通只说明流程没坏。
   */
  placeholderCapabilities?: string[]
  /** 工厂自动内容评审，不进入导出能力包。 */
  review?: CapabilityRunReview
  /** 每个已配置评审标准的流程步骤各自产出的评审结果。 */
  stepReviews?: Record<string, CapabilityRunReview>
  error?: string
  startedAt: number
  finishedAt: number | null
}

/** 模型绑定：声明值 → 实际调用值。`substituted` 表示声明的模型没找到、改用了会话模型。 */
export interface CapabilityRunModelBinding {
  slotId: string
  declaredModel: string
  channelId: string
  channelName: string
  modelId: string
  substituted: boolean
}

/**
 * 虚拟接入（能力桩）：**工厂侧的本地测试装置**。
 *
 * 三条边界，写在这里免得以后被"顺手"破坏：
 * ① 桩**不进场景版本、不进能力包** —— 它替代的是消费方运行时才有的能力；
 * ② 桩的 payload 必须按能力的 `outputSchema` 填成**真实形状**（字段名/类型/嵌套一致）；
 *    只求跑通的假数据会让工厂里全绿、真实接入时提示词全部返工，这是最难发现的一类失败；
 * ③ 缺桩时那一步**必须失败并指名到能力 id**，不允许静默跳过或自动造占位值。
 */
/** 桩的来源。**必须一直带着它**：占位值能让你跑通流程，但不能作为质量结论的依据。 */
export type CapabilityStubSource = 'placeholder' | 'human' | 'agent'

export interface CapabilityStub {
  capabilityId: string
  payload: unknown
  source: CapabilityStubSource
  note?: string
  updatedAt: number
}

/**
 * 按能力的输出契约生成**占位值**：形状与类型正确，内容为空。
 *
 * 与"随便造假数据"的区别：占位值一律留空（字符串空、数字 0、数组空），
 * 所以它只能证明"流程与提示词长什么样"，**证明不了质量**；
 * 因此带着它的运行记录会被标成"含占位桩"，导出与评测也不该采信。
 *
 * @param fields 能力的 outputSchema
 * @returns 可直接当桩用、也可当编辑骨架用的对象
 */
export function capabilityStubPlaceholder(fields: readonly FieldSchema[] | undefined): Record<string, unknown> {
  /** 按类型给最空的合法值；对象递归下去，保证嵌套字段名也在。 */
  const placeholderOf = (field: FieldSchema): unknown => {
    switch (field.type) {
      case 'number': return 0
      case 'boolean': return false
      case 'array': return []
      case 'object': return objectPlaceholder(field.fields ?? [])
      default: return ''
    }
  }
  const objectPlaceholder = (list: readonly FieldSchema[]): Record<string, unknown> => {
    const result: Record<string, unknown> = {}
    for (const field of list) {
      if (typeof field.name !== 'string' || field.name.length === 0) continue
      result[field.name] = placeholderOf(field)
    }
    return result
  }
  return objectPlaceholder(fields ?? [])
}

/** 逐条判据的通过情况 —— 回答"错在哪一条"，聚合指标回答不了这个问题。 */
export interface CapabilityJudgeResult {
  criterionId: string
  criterion: string
  passed: number
  total: number
}

/** 一次评测。四个版本字段缺一不可，否则差异不可归因。 */
export interface CapabilityEvaluation {
  id: string
  sceneId: string
  sceneVersion: number
  datasetId: string
  datasetVersion: number
  status: 'running' | 'succeeded' | 'failed'
  /** 约束轴：合规率，与 metrics 分列。 */
  constraintCompliance: number
  validSamples: number
  totalSamples: number
  /** 已成功完成内容评审的样本数；旧记录没有该字段，界面应显示为“未评审”。 */
  reviewedSamples?: number
  /** 内容评审明确通过的样本数；评审缺失、失败或无法判断均不计入。 */
  passedReviewSamples?: number
  /** 质量轴。 */
  metrics: Record<string, number>
  /**
   * 逐条判据的通过情况。**v1 恒为空数组**：判据逐条通过率需要评审器
   * （用 `acceptance.judgePrompt` 对每条输出打分），那是下一步；现在只给约束轴与逐条用例结果，不假装有质量分。
   */
  judgeResults: CapabilityJudgeResult[]
  baselineId: string | null
  startedAt: number
  finishedAt: number | null
  /** 逐条用例的结果，用于回答"是哪几条没过"。 */
  caseResults?: CapabilityEvaluationCaseResult[]
  /** 评测整体失败的原因（例如数据集里一条用例都没有）。 */
  error?: string
}

/** 一条用例在这次评测里的结果。 */
export interface CapabilityEvaluationCaseResult {
  caseId: string
  caseName: string
  /** 这次运行记录 id；为 null 表示没跑成（例如输入不满足契约）。 */
  runId: string | null
  status: CapabilityRunStatus
  /** 约束轴：这条用例的输出合法吗。 */
  valid: boolean
  /** 单次运行自动产生的内容评审；旧运行可能没有，不能据此推断为通过。 */
  review?: CapabilityRunReview
  /** 运行成功、格式有效且未使用占位桩时才可计入质量通过。 */
  reviewEligible?: boolean
  startedAt: number
  finishedAt: number | null
  /** 失败或不合法的原因摘要，供界面一眼看出问题。 */
  detail?: string
}

/** 用例来源由 Host 盖章，不接受调用方自报（沿用接口工作台 B7b 的纪律）。 */
export type CapabilityCaseSource = 'human' | 'agent' | 'regression'

/** 数据集里的一条用例。 */
export interface CapabilityCase {
  id: string
  name: string
  input: Record<string, unknown>
  expected?: unknown
  source: CapabilityCaseSource
  tags: string[]
  /** 来自失败回灌时指回来源运行，可追溯。 */
  fromRunId?: string
}

/** 数据集：v1 只做最小形态（一个列表 + 加用例 / 从失败回灌两个动作）。 */
export interface CapabilityDataset {
  id: string
  name: string
  version: number
  cases: CapabilityCase[]
  updatedAt: number
}

/** 导出记录：包版本与场景版本必须能双向查到。 */
export interface CapabilityDelivery {
  id: string
  sceneId: string
  sceneVersion: number
  packageVersion: string
  fileName: string
  exportedAt: number
  adoption: 'unknown' | 'adopted' | 'deprecated'
  projectId?: string
  /**
   * 导出时这份包**有没有在真实数据上验证过**（存在一次非占位桩的成功运行且跑的是当前版本）。
   * 不拦着导出 —— 包的内容本身是定义与提示词，桩不进包；但必须记下来，
   * 否则"这份包验证过没有"以后谁也说不清。
   */
  verified?: boolean
  /** 未验证的原因；verified 为 true 时缺省。 */
  unverifiedReason?: string
  /** 落盘路径（导出时由主进程写入并回填），用户据此把包交给关联项目。 */
  filePath?: string
}

/** 由场景定义与版本生成能力包的参数。 */
export interface BuildCapabilityPackageOptions {
  /** 包自身的语义化版本，由人工在导出时确定。 */
  packageVersion: string
  exportedAt: number
  /** 导出时的评测基线；没有跑过评测时不传。 */
  evidence?: CapabilityPackage['evidence']
}

/**
 * 把场景定义编译成能力包。
 *
 * **随包导出什么、不导出什么，全部收在这个函数里** —— 这是交付边界唯一的执行点：
 * - 导出：步骤与提示词、输入契约、输出声明、能力声明、模型槽位、评审判据文本。
 * - 不导出：评审提示词、指标权重、数据集、运行记录、场景 ID、任何凭据。
 */
export function buildCapabilityPackage(
  definition: CapabilitySceneDefinition,
  options: BuildCapabilityPackageOptions,
): CapabilityPackage {
  const pkg: CapabilityPackage = {
    kind: 'proma-ai-capability-package',
    specVersion: 1,
    packageVersion: options.packageVersion,
    name: definition.name,
    description: definition.description,
    exportedAt: options.exportedAt,
    inputs: definition.inputs,
    outputs: definition.outputs,
    steps: definition.steps,
    capabilities: definition.capabilities,
    modelSlots: definition.modelSlots,
    // 只导判据文本：让接入方知道"合格长什么样"，但不给评审执行器与数据集。
    // 新场景把各步骤标准合并为包级契约，旧场景继续使用顶层 acceptance。
    acceptance: { criteria: definition.stepAcceptances === undefined
      ? definition.acceptance.criteria
      : getReviewSteps(definition.steps).flatMap((step) => getStepAcceptance(definition, step.id)?.criteria ?? []) },
    ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
  }

  /**
   * **导出的包必须能通过我们自己的 spec 校验。**
   *
   * 场景定义可能来自 Agent 的宽松 JSON（见 `capability-factory-agent-tools.ts`），
   * 因此"构建成功"不等于"包合法"。如果不在导出这一刻校验，坏包就会直接交给消费方，
   * 而失败会发生在别人的项目里 —— 那是最难排查的位置。
   */
  try {
    parseCapabilityPackageValue(pkg)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`能力包未通过 spec 校验，已阻止导出：${reason}`)
  }
  return pkg
}

/** 创建一份空白场景定义；供"新建场景"使用。 */
export function createEmptySceneDefinition(name: string): CapabilitySceneDefinition {
  return {
    name,
    description: '',
    inputs: [{ name: 'text', type: 'string', description: '调用方传入的正文' }],
    outputs: [],
    steps: [],
    capabilities: [],
    modelSlots: [{ id: 'main', model: 'gpt-5.4' }],
    acceptance: { criteria: [], judgePrompt: '', metrics: [] },
    stepAcceptances: {},
  }
}

/**
 * 一条改动。`kind` 供界面分组，`detail` 是给人看的中文说明。
 *
 * **为什么放在共享层**：同一个改动清单要出现两次 ——
 * ①Agent 写草案前的审批卡（主进程签发快照）；②面板里人点「采纳」前的复查。
 * 两处必须是同一份措辞，否则人会在两个界面看到对"改了什么"的不同说法。
 */
export interface CapabilitySceneChange {
  kind: 'name' | 'description' | 'inputs' | 'outputs' | 'steps' | 'capabilities' | 'modelSlots' | 'acceptance'
  detail: string
}

/** 比较带 id 的列表，返回增删改的摘要。 */
function diffById<T extends { id: string }>(before: T[], after: T[], label: string): string[] {
  const beforeMap = new Map(before.map((item) => [item.id, item]))
  const afterMap = new Map(after.map((item) => [item.id, item]))
  const details: string[] = []
  const added = after.filter((item) => !beforeMap.has(item.id))
  const removed = before.filter((item) => !afterMap.has(item.id))
  const changed = after.filter((item) => {
    const previous = beforeMap.get(item.id)
    return previous !== undefined && JSON.stringify(previous) !== JSON.stringify(item)
  })
  if (added.length > 0) details.push(`新增 ${label} ${added.length} 项：${added.map((item) => item.id).join('、')}`)
  if (removed.length > 0) details.push(`删除 ${label} ${removed.length} 项：${removed.map((item) => item.id).join('、')}`)
  if (changed.length > 0) details.push(`修改 ${label} ${changed.length} 项：${changed.map((item) => item.id).join('、')}`)
  return details
}

/**
 * 计算两份场景定义之间的差异；无差异返回空数组。
 *
 * @param before 当前生效的定义
 * @param after 待比较的定义（通常是待采纳草案）
 * @returns 逐条改动说明，供审批卡与面板共用
 */
export function diffSceneDefinition(
  before: CapabilitySceneDefinition,
  after: CapabilitySceneDefinition,
): CapabilitySceneChange[] {
  const changes: CapabilitySceneChange[] = []

  if (before.name !== after.name) {
    changes.push({ kind: 'name', detail: `名称：「${before.name}」→「${after.name}」` })
  }
  if (before.description !== after.description) {
    changes.push({ kind: 'description', detail: '描述已修改' })
  }

  for (const detail of diffById(before.steps, after.steps, '步骤')) {
    changes.push({ kind: 'steps', detail })
  }
  /** 相同步骤的顺序变化会改变执行结果，增删之外也要明确告知用户。 */
  const previousOrder = before.steps.filter((step) => after.steps.some((item) => item.id === step.id)).map((step) => step.id)
  const nextOrder = after.steps.filter((step) => before.steps.some((item) => item.id === step.id)).map((step) => step.id)
  if (JSON.stringify(previousOrder) !== JSON.stringify(nextOrder)) {
    changes.push({ kind: 'steps', detail: `步骤顺序已调整：${after.steps.map((step) => step.id).join(' → ')}` })
  }
  for (const detail of diffById(before.capabilities, after.capabilities, '能力声明')) {
    changes.push({ kind: 'capabilities', detail })
  }
  for (const detail of diffById(before.modelSlots, after.modelSlots, '模型槽位')) {
    changes.push({ kind: 'modelSlots', detail })
  }

  const names = (list: { name?: string }[]): string => list.map((item) => item.name ?? '').filter(Boolean).join('、')
  if (JSON.stringify(before.inputs) !== JSON.stringify(after.inputs)) {
    changes.push({ kind: 'inputs', detail: `输入契约已修改（现为：${names(after.inputs) || '空'}）` })
  }
  if (JSON.stringify(before.outputs) !== JSON.stringify(after.outputs)) {
    changes.push({ kind: 'outputs', detail: `输出声明已修改（现为：${names(after.outputs) || '空'}）` })
  }
  if (JSON.stringify(before.acceptance) !== JSON.stringify(after.acceptance)
    || JSON.stringify(before.stepAcceptances ?? null) !== JSON.stringify(after.stepAcceptances ?? null)) {
    // 评审是工厂内部资产，改动要单独提示 —— 它会直接影响评测口径
    changes.push({ kind: 'acceptance', detail: '评审（判据 / 评审提示词 / 指标权重）已修改' })
  }

  return changes
}

/**
 * 交付前的**验证状态**：这份包有没有在真实数据上跑通过。
 *
 * 为什么放在共享层：主进程要把它写进导出记录，面板要拿同一份结论提示用户 ——
 * 两处口径必须一致，否则用户会在界面看到"已验证"、记录里却是"未验证"。
 *
 * 判据（四件事缺一不可）：①有一次**整链**运行；②那次运行完成且约束通过；
 * ③用的是当前生效版本、且**没有用占位桩**（空占位值跑出来的通过不算验证）；
 * ④自动内容评审成功且明确通过。只跑通 LLM 与 JSON 格式不能代表结果质量已验证。
 */
export interface CapabilityPackageReadiness {
  verified: boolean
  /** 未验证的原因；已验证时为 null。 */
  reason: string | null
}

/**
 * 由运行记录判断交付前的验证状态。
 *
 * @param input.sceneVersion 当前生效版本
 * @param input.runs 该场景的运行记录（顺序无关）
 * @returns 是否验证过；未验证时给出可读原因
 */
export function describePackageReadiness(input: {
  sceneVersion: number
  runs: readonly CapabilityRun[]
}): CapabilityPackageReadiness {
  const fullRuns = input.runs.filter((run) =>
    (run.kind ?? 'full') === 'full' && (run.definitionTarget ?? 'current') === 'current')
  if (fullRuns.length === 0) {
    return { verified: false, reason: '这个场景还没有跑过一次整链运行' }
  }

  const currentVersionRuns = fullRuns.filter((run) => run.sceneVersion === input.sceneVersion)
  if (currentVersionRuns.length === 0) {
    return {
      verified: false,
      reason: `v${input.sceneVersion} 还没有跑过 —— 跑通过的是更早的版本`,
    }
  }

  const realRuns = currentVersionRuns.filter((run) =>
    (run.placeholderCapabilities ?? []).length === 0)
  if (realRuns.length === 0) {
    return {
      verified: false,
      reason: 'v' + input.sceneVersion + ' 上的运行用的是占位桩：只能证明流程跑通，不能证明结果可信',
    }
  }

  const succeeded = realRuns.filter((run) => run.status === 'succeeded' && run.valid)
  if (succeeded.length === 0) {
    return {
      verified: false,
      reason: `v${input.sceneVersion} 在真实数据上还没跑通过（有运行，但没一次既完成又满足约束）`,
    }
  }

  if (succeeded.some((run) => !run.evidenceIssues?.length && run.review?.status === 'succeeded' && run.review.passed === true)) {
    return { verified: true, reason: null }
  }

  if (succeeded.some((run) => run.evidenceIssues?.length)) {
    return { verified: false, reason: `v${input.sceneVersion} 已跑通格式与约束，但证据引用无法回溯，不能作为已验证交付` }
  }

  if (succeeded.some((run) => run.review?.status === 'running')) {
    return { verified: false, reason: `v${input.sceneVersion} 已跑通格式与约束，但内容评审还在进行` }
  }
  const failedReview = succeeded.find((run) => run.review?.status === 'failed')?.review
  if (failedReview?.status === 'failed') {
    const detail = failedReview.error?.trim()
    return {
      verified: false,
      reason: `v${input.sceneVersion} 已跑通格式与约束，但内容评审失败${detail ? `：${detail}` : ''}`,
    }
  }
  if (succeeded.some((run) => run.review?.status === 'succeeded' && run.review.passed !== true)) {
    return { verified: false, reason: `v${input.sceneVersion} 已跑通格式与约束，但内容评审未通过` }
  }
  if (succeeded.some((run) => run.review?.status === 'skipped')) {
    return { verified: false, reason: `v${input.sceneVersion} 已跑通格式与约束，但内容评审未完成（本次已跳过）` }
  }
  return { verified: false, reason: `v${input.sceneVersion} 已跑通格式与约束，但还没有完成内容评审` }
}
