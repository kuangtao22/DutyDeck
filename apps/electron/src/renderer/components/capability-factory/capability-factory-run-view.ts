/**
 * 「运行」这一段的纯函数：状态文案、时长、输入解析、桩骨架。
 *
 * 抽出来是因为这些判断最容易写错又最该被测：什么算 invalid、哪些字段要按 JSON 解析、
 * 骨架长什么样。组件只负责画。
 */
import type {
  CapabilityRun, CapabilitySceneDefinition, ExtractStep, FieldSchema, InputSource, LlmStep, Step,
} from '@proma/shared'
import type { StepStatus } from '@proma/capability-runner'

/** 展示语气：ok 通过 / warn 部分完成 / bad 失败或非法 / idle 未开始。 */
export type RunTone = 'ok' | 'warn' | 'bad' | 'idle'

/** 导航项保存真实轨迹索引，避免并行子项插入后打开错误步骤详情。 */
export interface RunStepNavigationItem {
  key: string
  stepId: string
  title: string
  traceIndex: number | null
  active: boolean
}

/** 根据本轮定义与真实轨迹生成步骤目录；多次执行保留全部轨迹，尚未执行的步骤只显示状态。 */
export function describeRunStepNavigation(run: CapabilityRun): RunStepNavigationItem[] {
  /** 递归展平声明顺序；并行组与子步骤都有自己的观察项。 */
  const flatten = (steps: readonly Step[]): Step[] => steps.flatMap((step) => step.type === 'map' ? [step, ...flatten(step.body)] : [step])
  /** 原始索引是详情页的身份，不能用定义索引替代。 */
  const entries = run.steps.map((trace, traceIndex) => ({
    key: `trace:${traceIndex}`, stepId: trace.stepId, title: trace.title, traceIndex, active: false,
  }))
  if (!run.definitionSnapshot) return entries
  /** 单步试跑只展示目标步骤，不把未运行的整链步骤标成等待。 */
  const declared = flatten(run.definitionSnapshot.steps).filter((step) => run.kind !== 'step' || step.id === run.stepId)
  return declared.flatMap((step): RunStepNavigationItem[] => {
    const matching = entries.filter((entry) => entry.stepId === step.id)
    const active = run.status === 'running' && Boolean(run.activeStepIds?.includes(step.id))
    return active || matching.length === 0
      ? [...matching, { key: `pending:${step.id}`, stepId: step.id, title: step.title, traceIndex: null, active }]
      : matching
  })
}

/** 带名字的字段。能力包 spec 允许 `name` 省略，但**没有名字的输入无法提交**，工厂这一侧不认。 */
export type NamedField = FieldSchema & { name: string }

/** 过滤出可用的输入字段；无名字段会被忽略（它们在运行时的输入契约里本来也校验不了）。 */
export function namedFields(fields: readonly FieldSchema[]): NamedField[] {
  return fields.filter((field): field is NamedField => typeof field.name === 'string' && field.name.length > 0)
}

/** 运行状态 → 中文标签与语气（完整性轴）。 */
export function describeRunStatus(run: CapabilityRun): { label: string; tone: RunTone } {
  switch (run.status) {
    case 'succeeded': return { label: '完成', tone: 'ok' }
    case 'partial': return { label: '部分完成', tone: 'warn' }
    case 'cancelled': return { label: '已中断', tone: 'idle' }
    case 'running': return { label: '运行中', tone: 'idle' }
    default: return { label: '失败', tone: 'bad' }
  }
}

/**
 * 约束轴文案：合法 / 不合法。与完整性轴分列，永不合成一个分数。
 *
 * **含占位桩时不给绿灯**：占位值是空的，模型拿到空输入很容易返回空结果，
 * 而"空数组"恰好是合法结构 —— 直接显示"约束通过"会变成假绿，
 * 让人以为这次结果没问题。这种情况标成不可采信（warn），而不是通过（ok）。
 */
export function describeConstraintAxis(run: CapabilityRun): { label: string; tone: RunTone } {
  if (run.status === 'running') return { label: '约束检查中', tone: 'idle' }
  if (run.placeholderCapabilities && run.placeholderCapabilities.length > 0) {
    return run.valid
      ? { label: '约束通过（含占位桩，不可采信）', tone: 'warn' }
      : { label: '约束不通过', tone: 'bad' }
  }
  return run.valid ? { label: '约束通过', tone: 'ok' } : { label: '约束不通过', tone: 'bad' }
}

/**
 * 内容质量轴文案：旧记录或执行失败都只能标记为未评测，不能根据格式合法性推断达标。
 *
 * @param run 一次运行记录
 * @returns 质量状态的中文标签与展示语气
 */
export function describeReviewStatus(run: CapabilityRun): { label: string; tone: RunTone } {
  if (run.status === 'failed' || run.status === 'cancelled') return { label: '未评测', tone: 'idle' }
  if (!run.review || run.review.status === 'skipped') return { label: '未评测', tone: 'idle' }
  if (run.review.status === 'running') return { label: '评测中', tone: 'idle' }
  if (run.review.status === 'failed') return { label: '评测失败', tone: 'bad' }
  if (run.review.passed === true && (
    run.status !== 'succeeded'
    || !run.valid
    || Boolean(run.placeholderCapabilities?.length)
  )) return { label: '待确认', tone: 'warn' }
  if (run.review.passed === true) return { label: '达标', tone: 'ok' }
  if (run.review.passed === false) return { label: '未达标', tone: 'bad' }
  return { label: '待确认', tone: 'warn' }
}

/**
 * 这次运行能得出什么结论、下一步做什么。
 *
 * 存在的理由：光看"完成 / 约束通过"会以为"这个能力做好了" —— 实际只证明流程没坏。
 * 把结论与下一步直接写在结果上方，用户不必去问别人"这样算完成了吗"。
 */
export function describeRunVerdict(run: CapabilityRun): string {
  if (run.status === 'running') {
    return '正在执行流程，左侧显示各步骤的实时状态；完成后将自动评审。'
  }
  const placeholders = run.placeholderCapabilities ?? []
  if (placeholders.length > 0) {
    return `这次只验证了流程：${run.steps.length} 步按声明跑完了，提示词已经能被模型读到。`
      + `但 ${placeholders.length} 个能力用的是空占位值，输出不可采信 —— `
      + '先把这些桩换成真实返回形状的数据，再跑一次，那时的输出才谈得上质量。'
  }
  if (run.steps.length === 0) {
    return '这次没跑起来（输入不满足契约、定义不合法或没找到可用模型）：先按上面的原因修掉，再重跑。'
  }
  if (!run.valid) {
    return '这次用的是真实桩，但输出没通过约束：展开标红的步骤看约束原因，改那一句提示词后重跑，用提交历史对比两次。'
  }
  if (!run.review) return '这是旧运行记录：输出通过了约束，但没有自动评测记录，不能推断内容质量。'
  switch (run.review.status) {
    case 'running': return '运行与约束检查已完成，自动评测仍在进行，暂时不能得出质量结论。'
    case 'failed': return '运行与约束检查已完成，但自动评测失败；输出已保留，修复评测后可重试。'
    case 'skipped': return '本轮未执行自动评测，只能确认输出通过了约束，不能推断内容质量。'
    default:
      if (run.status !== 'succeeded') return '运行未完整完成；评测结果只覆盖已产出内容，不能判定整轮达标。'
      if (run.review.passed === true) return '自动评测已达标；可继续用同一份输入对比提示词版本。'
      if (run.review.passed === false) return '自动评测未达标；先按失败判据与证据修改提示词，再用同一份输入重跑。'
      return '自动评测已完成，但仍有待确认项，暂时不能得出达标结论。'
  }
}

/** 步骤状态 → 中文标签与语气。 */
export function describeStepStatus(status: StepStatus): { label: string; tone: RunTone } {
  switch (status) {
    case 'succeeded': return { label: '完成', tone: 'ok' }
    case 'invalid': return { label: '不合法', tone: 'warn' }
    case 'skipped': return { label: '未执行', tone: 'idle' }
    default: return { label: '失败', tone: 'bad' }
  }
}

/** 毫秒 → 可读时长；缺结束时间时显示占位横线。 */
export function formatDuration(startedAt: number, finishedAt: number | null): string {
  if (finishedAt === null) return '—'
  const ms = Math.max(0, finishedAt - startedAt)
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

/** 输入控件的种类：数字与布尔用单行，对象/数组要求 JSON，字符串用多行（正文往往很长）。 */
export function inputFieldKind(field: FieldSchema): 'number' | 'boolean' | 'json' | 'text' {
  if (field.type === 'number') return 'number'
  if (field.type === 'boolean') return 'boolean'
  if (field.type === 'object' || field.type === 'array') return 'json'
  return 'text'
}

/** 表单头部的一句话：这个场景要几个输入、其中几个必填。 */
export function describeInputContract(definition: CapabilitySceneDefinition): string {
  const fields = namedFields(definition.inputs)
  const required = fields.filter((field) => field.required !== false && !field.nullable).length
  return `这个场景需要 ${fields.length} 个输入（必填 ${required} 个）`
}

/**
 * 把表单文本解析成运行输入。
 *
 * 规则（刻意直白）：字符串原样作为值；number / boolean 按字面量解析；
 * object / array 必须写 JSON。空字符串视为"没填"，交给运行时的输入契约去拒绝 ——
 * 这里不替它做决定，否则表单的报错会与运行记录的报错口径不一致。
 *
 * @param definition 场景定义（读取输入契约）
 * @param draft 字段名 → 用户输入的原始文本
 * @returns 可提交的输入；有解析错误时只返回错误清单
 */
export function parseWorkflowInput(
  definition: CapabilitySceneDefinition,
  draft: Record<string, string>,
): { input: Record<string, unknown>; errors: string[] } {
  const input: Record<string, unknown> = {}
  const errors: string[] = []

  for (const field of namedFields(definition.inputs)) {
    const raw = (draft[field.name] ?? '').trim()
    if (raw.length === 0) continue
    switch (inputFieldKind(field)) {
      case 'number': {
        const value = Number(raw)
        if (!Number.isFinite(value)) errors.push(`${field.name} 需要数字`)
        else input[field.name] = value
        break
      }
      case 'boolean': {
        if (raw === 'true') input[field.name] = true
        else if (raw === 'false') input[field.name] = false
        else errors.push(`${field.name} 需要 true 或 false`)
        break
      }
      case 'json': {
        try {
          input[field.name] = JSON.parse(raw)
        } catch {
          errors.push(`${field.name} 需要合法 JSON`)
        }
        break
      }
      default:
        input[field.name] = draft[field.name] ?? ''
    }
  }

  return { input, errors }
}

/** 一个字段在表单里的初始文本：对象/数组给空数组/空对象，更接近真实形状。 */
export function initialFieldDraft(field: NamedField): string {
  if (field.type === 'array') return '[]'
  if (field.type === 'object') return '{}'
  if (field.type === 'boolean') return 'false'
  return ''
}

/**
 * 按能力的 outputSchema 生成一份 JSON 骨架。
 *
 * **它只是形状提示，不是桩本身**：值一律留空/零，必须由人改成真实数据。
 * 自动填假数据会让工厂里全绿、真实接入时全部返工，所以这里只帮人省掉打字段名的功夫。
 *
 * @param outputSchema 能力的输出契约
 * @returns 可直接放进编辑框的 JSON 文本
 */
export function stubSkeleton(outputSchema: readonly FieldSchema[] | undefined): string {
  /** 按字段类型给一个安全占位：字符串空、数字 0、布尔 false、数组空、对象递归。 */
  const placeholder = (field: FieldSchema): unknown => {
    switch (field.type) {
      case 'number': return 0
      case 'boolean': return false
      case 'array': return []
      case 'object': return objectSkeleton(field.fields ?? [])
      default: return ''
    }
  }
  const objectSkeleton = (fields: readonly FieldSchema[]): Record<string, unknown> => {
    const result: Record<string, unknown> = {}
    /** 无名字段进不了 JSON 键，直接跳过（它们也无法被输出声明引用）。 */
    for (const field of namedFields(fields)) result[field.name] = placeholder(field)
    return result
  }
  return JSON.stringify(objectSkeleton(outputSchema ?? []), null, 2)
}

/** 能单步试跑的步骤：带提示词的那两种。tool 由接入方实现，没有提示词可训练。 */
export function isPromptStep(step: Step): step is LlmStep | ExtractStep {
  return step.type === 'llm' || step.type === 'extract'
}

/** 场景形状体检结果。 */
export interface CapabilitySceneShape {
  modelSteps: number
  codeSteps: number
  containerSteps: number
  /** 代码步骤的标题，用来指名道姓地建议改写。 */
  codeStepTitles: string[]
  /** 形状偏了才给建议；已经是"只留模型步骤"时为 null。 */
  advice: string | null
}

/**
 * 场景形状体检：**一个场景应该只编排模型要做的那部分**。
 *
 * 判断依据（来自用户的建模要求）：场景 = 模型判断/生成 + 提示词；
 * 由代码在固定位置、固定顺序执行的确定性逻辑（读文件、解析、核对、去重、写库）
 * **不是 agent 流程**，它们是边界 —— 要么作为输入契约给进来，要么作为输出的消费方接出去。
 *
 * 为什么要在界面上体检：这类步骤在工厂里只能用桩替代，而桩给的假输入会让"跑通了"变成假象；
 * 更根本的是，一旦把 app 的整条管线搬进来，场景既训不动也交不出去。
 *
 * @param definition 场景定义
 * @returns 计数与建议
 */
export function describeSceneShape(definition: CapabilitySceneDefinition): CapabilitySceneShape {
  const steps = definition.steps
  const codeSteps = steps.filter((step) => step.type === 'tool')
  const shape: CapabilitySceneShape = {
    modelSteps: steps.filter(isPromptStep).length,
    codeSteps: codeSteps.length,
    containerSteps: steps.filter((step) => step.type === 'map').length,
    codeStepTitles: codeSteps.map((step) => step.title),
    advice: null,
  }
  if (codeSteps.length === 0) return shape

  shape.advice = `有 ${codeSteps.length} 步是代码步骤（${shape.codeStepTitles.join('、')}）：`
    + '它们由 app 在固定位置执行，工厂里只能用桩替代 —— 桩给的假输入会让"跑通了"变成假象，'
    + '而且这样的场景既训不动提示词，也交不出去。'
    + '如果不是"模型决定要不要调"的能力，就把它们移到边界：确定性输入作为输入契约给，'
    + '确定性后处理交给 app 在拿到输出之后做，场景只留模型步骤。'
  return shape
}

/** 输入来源的中文说明：让人知道这个槽平时从哪来、试跑时该填什么。 */
function describeSource(source: InputSource): string {
  if (source.from === 'workflow-input') return `工作流输入 · ${source.field}`
  if (source.from === 'step-output') return `上一步输出 · ${source.stepId}${source.path ? `.${source.path}` : ''}`
  return '固定值'
}

/**
 * 这一步的输入槽列表。
 *
 * 单步试跑时每个槽都要人给值（上游没跑，解析不出东西来），所以界面必须写清
 * "它平时从哪来"，否则用户不知道该粘什么。
 */
export function describeStepSlots(step: Step): { name: string; hint: string }[] {
  const inputs = 'inputs' in step ? step.inputs : undefined
  return Object.entries(inputs ?? {}).map(([name, source]) => ({ name, hint: describeSource(source) }))
}

/**
 * 试跑表单的初始值：**优先复用上一次试跑用过的输入**。
 *
 * 训练回路里改一句话就要再跑一次，而输入通常是同一份；每次都让人重粘一遍，人就会放弃迭代。
 */
export function initialStepRunDraft(step: Step, previous?: CapabilityRun | null): Record<string, string> {
  const draft: Record<string, string> = {}
  for (const slot of describeStepSlots(step)) {
    const value = previous?.input?.[slot.name]
    if (value === undefined) { draft[slot.name] = ''; continue }
    draft[slot.name] = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  }
  return draft
}

/**
 * 把表单文本变成这一步骤的输入值。
 *
 * 规则：看起来像 JSON 对象/数组就按 JSON 解析，否则当纯文本 —— 槽位没有类型信息
 * （`InputSource` 不带类型），而试跑是沙盒：粘正文就是正文、粘 `{...}` 就是结构。
 * 用了什么值会出现在"渲染后的完整提示词"里，写错了立刻看得见。
 */
export function buildStepRunInput(step: Step, draft: Record<string, string>): Record<string, unknown> {
  const input: Record<string, unknown> = {}
  for (const slot of describeStepSlots(step)) {
    const raw = draft[slot.name] ?? ''
    const trimmed = raw.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        input[slot.name] = JSON.parse(trimmed)
        continue
      } catch {
        /** 解析不了就当纯文本：不静默丢掉人粘进来的内容。 */
      }
    }
    input[slot.name] = raw
  }
  return input
}
