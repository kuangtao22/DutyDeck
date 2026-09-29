/**
 * 能力包的参考 runner。
 *
 * 存在的理由：如果只给 spec 不给 runner，每个消费方会各自解释它，结果就是
 * "在工厂里通过 ≠ 在产品里通过" —— 工厂的评测分数不再能预测生产行为。
 * 所以这个 runner 必须与工厂内部执行使用同一套语义。
 *
 * 语义要点：
 * - 三个轴分开：`status`（完整性）/ `valid`（约束）/ 步骤级 `status`。
 * - 并行组（map）的扇入**永远带失败项**，下游据此如实报告部分失败。
 * - 模型调用与外部能力都由调用方注入，runner 自身不做 IO、不依赖任何包。
 */
import { describeSchema, validateValue } from './schema'
import type { CapabilityPackage, FieldSchema, InputSource, ItemResult, Step } from './spec'

/** 一次模型调用的请求。 */
export interface ModelRequest {
  stepId: string
  model: string
  temperature?: number
  maxTokens?: number
  /** 渲染后的提示词。 */
  prompt: string
  /** extract 步骤由 runner 依判定字段自动生成；llm 步骤为空。 */
  formatInstruction?: string
}

/** 模型调用的返回。 */
export interface ModelResponse {
  text: string
  model?: string
}

/** 外部能力的一个实现（由消费方绑定）。 */
export interface CapabilityBinding {
  call(input: Record<string, unknown>): Promise<unknown> | unknown
}

/** runner 依赖：全部注入，便于离线测试与消费方接自己的 provider。 */
export interface CapabilityRunnerDependencies {
  callModel(request: ModelRequest): Promise<ModelResponse>
  /** capabilityId → 实现；缺绑定时遇到该步骤会明确失败，不会静默跳过。 */
  capabilities?: Record<string, CapabilityBinding>
  /**
   * 步骤级实时进度：开始和完成各回调一次。
   * 回调只用于观察，不参与执行结果；抛错会被 runner 吞掉，避免 UI 断开导致流程中止。
   */
  onStepProgress?: (event: CapabilityStepProgress) => void
}

/** 单个步骤的实时进度；并行组内可同时存在多个 started 事件。 */
export interface CapabilityStepProgress {
  phase: 'started' | 'completed'
  step: Step
  input: Record<string, unknown>
  trace?: StepTrace
  traces: readonly StepTrace[]
  startedAt: number
}

/** 步骤状态：succeeded 完成 / invalid 约束不通过 / failed 执行失败 / skipped 未执行。 */
export type StepStatus = 'succeeded' | 'invalid' | 'failed' | 'skipped'

/** 单步轨迹。 */
export interface StepTrace {
  stepId: string
  title: string
  type: Step['type']
  status: StepStatus
  attempts: number
  input: Record<string, unknown>
  prompt?: string
  rawOutput?: string
  parsedOutput?: unknown
  /** 约束不通过的具体原因，逐字段列出。 */
  constraintErrors?: string[]
  /** 并行组的扇入结果（带失败项）。 */
  itemResults?: ItemResult[]
  error?: string
  model?: string
  startedAt: number
  finishedAt: number
}

/** 整次运行的结果。 */
export interface RunResult {
  /** 完整性轴：跑完了吗。 */
  status: 'succeeded' | 'partial' | 'failed'
  /** 约束轴：这次输出合法吗（任一 strict 步骤判定不通过即为 false）。 */
  valid: boolean
  /** 调用方传入的输入不满足输入契约时的错误清单；非空表示未开始执行。 */
  inputErrors?: string[]
  outputs: Record<string, unknown> | null
  steps: StepTrace[]
  error?: string
  startedAt: number
  finishedAt: number
}

/** 运行上下文：逐步累积的输出，供后续步骤按 stepId 取用。 */
interface RunContext {
  input: Record<string, unknown>
  stepOutputs: Map<string, unknown>
  traces: StepTrace[]
}

/** 将观察回调与执行解耦；窗口关闭或 IPC 断开不能影响模型链路。 */
function notifyStepProgress(deps: CapabilityRunnerDependencies, event: CapabilityStepProgress): void {
  try {
    deps.onStepProgress?.(event)
  } catch {
    // 进度只是观察信号，观察端失败不能改变运行结果。
  }
}

/** 渲染提示词模板：把 {{变量}} 换成输入绑定解析出来的值。 */
function renderPrompt(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, key: string) => {
    if (!(key in values)) return ''
    const value = values[key]
    return typeof value === 'string' ? value : JSON.stringify(value)
  })
}

/** 按点路径读取嵌套值；路径不存在返回 undefined。 */
export function readPath(value: unknown, path: string): unknown {
  if (path.length === 0) return value
  let current: unknown = value
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined
    if (Array.isArray(current)) {
      const index = Number(segment)
      if (!Number.isSafeInteger(index)) return undefined
      current = current[index]
      continue
    }
    if (typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** 解析一个输入来源。`item` / `index` 只在并行组内部可用。 */
function resolveSource(
  source: InputSource,
  context: RunContext,
  itemScope: { item: unknown; index: number } | null,
): unknown {
  if (source.from === 'literal') return source.value
  if (source.from === 'step-output') {
    return readPath(context.stepOutputs.get(source.stepId), source.path ?? '')
  }
  // workflow-input：在并行组内部，item / index 指向当前元素；否则指向工作流输入字段。
  if (itemScope && source.field === 'item') return itemScope.item
  if (itemScope && source.field === 'index') return itemScope.index
  return readPath(context.input, source.field)
}

/** 解析一个步骤的全部输入绑定。 */
function resolveInputs(
  inputs: Record<string, InputSource> | undefined,
  context: RunContext,
  itemScope: { item: unknown; index: number } | null,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, source] of Object.entries(inputs ?? {})) {
    result[key] = resolveSource(source, context, itemScope)
  }
  return result
}

/** 从模型返回里抽出 JSON —— 容忍被 ```json 包裹或前后带解释文字的情况。 */
function extractJson(text: string): { value: unknown } | { error: string } {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = (fenced?.[1] ?? trimmed).trim()
  try {
    return { value: JSON.parse(candidate) }
  } catch {
    // 退化尝试：截取第一个 { 到最后一个 }，覆盖"前后多说了几句"的常见形态
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return { value: JSON.parse(candidate.slice(start, end + 1)) }
      } catch { /* 落到下面的统一错误 */ }
    }
    return { error: '返回内容不是合法 JSON' }
  }
}

/** 执行单个步骤（不递归 map 的 body，由 map 自行调度）。 */
async function executeStep(
  step: Step,
  /** 已经解析好的输入绑定结果 —— 整链运行由上下文解析，单步试跑由调用方直接给。 */
  input: Record<string, unknown>,
  context: RunContext,
  deps: CapabilityRunnerDependencies,
  pkg: CapabilityPackage,
  itemScope: { item: unknown; index: number } | null,
): Promise<{ trace: StepTrace; value: unknown }> {
  const startedAt = Date.now()
  const base = { stepId: step.id, title: step.title, type: step.type, input, startedAt }

  if (step.type === 'tool') {
    const binding = deps.capabilities?.[step.capabilityId]
    if (!binding) {
      return {
        trace: { ...base, status: 'failed', attempts: 1, finishedAt: Date.now(),
          error: `能力 ${step.capabilityId} 未绑定实现` },
        value: undefined,
      }
    }
    const args: Record<string, unknown> = {}
    for (const [key, source] of Object.entries(step.bindings)) {
      args[key] = resolveSource(source, context, itemScope)
    }
    try {
      const value = await binding.call(args)
      return { trace: { ...base, status: 'succeeded', attempts: 1, parsedOutput: value, finishedAt: Date.now() }, value }
    } catch (error) {
      return {
        trace: { ...base, status: 'failed', attempts: 1, finishedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error) },
        value: undefined,
      }
    }
  }

  // llm / extract 共用模型调用；extract 额外注入格式说明并校验。
  const slot = pkg.modelSlots.find((item) => item.id === (step as { modelSlot: string }).modelSlot)
  if (!slot) {
    return {
      trace: { ...base, status: 'failed', attempts: 1, finishedAt: Date.now(),
        error: `模型槽位 ${(step as { modelSlot: string }).modelSlot} 不存在` },
      value: undefined,
    }
  }

  const prompt = renderPrompt((step as { prompt: string }).prompt, input)
  const judgeFields = step.type === 'extract' ? step.judgeFields : null
  const objectSchema: FieldSchema | null = judgeFields
    ? { type: 'object', fields: judgeFields }
    : null
  const formatInstruction = objectSchema ? describeSchema(objectSchema) : undefined
  const strict = step.type === 'extract' ? (step.strictness ?? 'strict') === 'strict' : true
  const attempts = step.maxAttempts ?? 1

  let lastErrors: string[] = []
  let lastRaw = ''
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await deps.callModel({
        stepId: step.id, model: slot.model,
        ...(slot.temperature === undefined ? {} : { temperature: slot.temperature }),
        ...(slot.maxTokens === undefined ? {} : { maxTokens: slot.maxTokens }),
        prompt,
        ...(formatInstruction === undefined ? {} : { formatInstruction }),
      })
      lastRaw = response.text
      if (!objectSchema) {
        return {
          trace: { ...base, status: 'succeeded', attempts: attempt, prompt, rawOutput: response.text,
            parsedOutput: response.text, model: response.model ?? slot.model, finishedAt: Date.now() },
          value: response.text,
        }
      }
      const parsed = extractJson(response.text)
      if ('error' in parsed) {
        lastErrors = [parsed.error]
        continue
      }
      const errors = validateValue(objectSchema, parsed.value, '')
      if (errors.length === 0) {
        return {
          trace: { ...base, status: 'succeeded', attempts: attempt, prompt, rawOutput: response.text,
            parsedOutput: parsed.value, model: response.model ?? slot.model, finishedAt: Date.now() },
          value: parsed.value,
        }
      }
      lastErrors = errors
    } catch (error) {
      // 模型端口负责网络重试；调用异常不属于格式修复，避免再次长时间等待同一失败。
      return {
        trace: { ...base, status: 'failed', attempts: attempt, prompt, model: slot.model,
          error: error instanceof Error ? error.message : String(error), finishedAt: Date.now() },
        value: undefined,
      }
    }
  }

  // 用尽尝试仍不通过：strict 判 invalid（整条链无法继续），lenient 也判 invalid 但交付原始文本。
  return {
    trace: { ...base, status: 'invalid', attempts, prompt, rawOutput: lastRaw,
      constraintErrors: lastErrors, model: slot.model, finishedAt: Date.now() },
    value: strict ? undefined : lastRaw,
  }
}

/** 以有界并发执行一批任务；返回顺序与输入一致。 */
async function runBounded<T, R>(
  items: T[], concurrency: number, task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      const item = items[index] as T
      results[index] = await task(item, index)
    }
  })
  await Promise.all(workers)
  return results
}

/** 递归执行步骤数组；返回最后的步骤值（供并行组内部使用）。 */
async function runSteps(
  steps: Step[],
  context: RunContext,
  deps: CapabilityRunnerDependencies,
  pkg: CapabilityPackage,
  itemScope: { item: unknown; index: number } | null,
): Promise<{ ok: boolean; value: unknown; invalid: boolean }> {
  let lastValue: unknown
  let invalidSeen = false

  for (const step of steps) {
    if (step.type === 'map') {
      const over = resolveSource(step.over, context, itemScope)
      /** 并行组从展开校验开始，到全部子项扇入后结束。 */
      const startedAt = Date.now()
      notifyStepProgress(deps, { phase: 'started', step, input: { over }, traces: [...context.traces], startedAt })
      if (!Array.isArray(over)) {
        const trace: StepTrace = {
          stepId: step.id, title: step.title, type: 'map', status: 'failed', attempts: 1,
          input: { over }, error: '并行组的展开来源不是数组',
          startedAt, finishedAt: Date.now(),
        }
        context.traces.push(trace)
        notifyStepProgress(deps, { phase: 'completed', step, input: trace.input, trace, traces: [...context.traces], startedAt })
        return { ok: false, value: undefined, invalid: invalidSeen }
      }

      const policy = step.failurePolicy ?? 'continue'
      let aborted = false

      const results = await runBounded(over, step.concurrency ?? 1, async (item, index) => {
        if (aborted) return { index, ok: false, error: '因 fail-fast 未执行' } as ItemResult
        const child = await runSteps(step.body, context, deps, pkg, { item, index })
        if (!child.ok) {
          if (policy === 'fail-fast') aborted = true
          return { index, ok: false, error: child.invalid ? '子步骤约束不通过' : '子步骤执行失败' } as ItemResult
        }
        if (child.invalid) invalidSeen = true
        return { index, ok: true, value: child.value } as ItemResult
      })

      const failedCount = results.filter((item) => !item.ok).length
      const trace: StepTrace = {
        stepId: step.id, title: step.title, type: 'map',
        status: failedCount === 0 ? 'succeeded' : policy === 'fail-fast' ? 'failed' : 'invalid',
        attempts: 1, input: { over: `共 ${over.length} 项` }, itemResults: results,
        startedAt, finishedAt: Date.now(),
      }
      context.traces.push(trace)
      notifyStepProgress(deps, { phase: 'completed', step, input: trace.input, trace, traces: [...context.traces], startedAt })
      if (policy === 'fail-fast' && failedCount > 0) {
        return { ok: false, value: results, invalid: invalidSeen }
      }
      // continue：即使有失败项也把完整结果（含失败）交给下游
      context.stepOutputs.set(step.id, results)
      lastValue = results
      continue
    }

    const boundInput = resolveInputs('inputs' in step ? step.inputs : undefined, context, itemScope)
    const startedAt = Date.now()
    notifyStepProgress(deps, { phase: 'started', step, input: boundInput, traces: [...context.traces], startedAt })
    const { trace, value } = await executeStep(step, boundInput, context, deps, pkg, itemScope)
    context.traces.push(trace)
    notifyStepProgress(deps, { phase: 'completed', step, input: boundInput, trace, traces: [...context.traces], startedAt })
    if (trace.status === 'succeeded') {
      context.stepOutputs.set(step.id, value)
      lastValue = value
      continue
    }
    if (trace.status === 'invalid') {
      invalidSeen = true
      const strict = step.type !== 'extract' || (step.strictness ?? 'strict') === 'strict'
      if (strict) return { ok: false, value: undefined, invalid: true }
      context.stepOutputs.set(step.id, value)
      lastValue = value
      continue
    }
    return { ok: false, value: undefined, invalid: invalidSeen }
  }

  return { ok: true, value: lastValue, invalid: invalidSeen }
}

/** 创建参考 runner。 */
export function createCapabilityRunner(dependencies: CapabilityRunnerDependencies) {
  return {
    /**
     * **单步试跑**：只执行一个带提示词的步骤，输入由调用方直接给（不做整链解析）。
     *
     * 存在的理由：训练一个提示词不需要整条链可跑 —— 尤其是上游是"读库/调接口"这类
     * 工厂里根本没有的能力时，要求先把整链搭起来等于把提示词训练卡在环境上。
     * 这里绕开上游，只跑这一步，人能直接看"这段输入 + 这段提示词 → 模型返回什么"。
     *
     * @param pkg 已通过严格解析的能力包
     * @param stepId 目标步骤；必须是**顶层**的 llm / extract 步骤
     * @param input 该步骤输入槽的值（键为步骤 `inputs` 里的变量名；可直接写模板引用的变量）
     */
    async runSingleStep(
      pkg: CapabilityPackage,
      stepId: string,
      input: Record<string, unknown>,
    ): Promise<{ step: StepTrace; valid: boolean } | { error: string }> {
      const step = pkg.steps.find((item) => item.id === stepId)
      if (!step) return { error: `步骤不存在或不在顶层：${stepId}` }
      if (step.type === 'map') return { error: '并行组是容器，不是可单跑的步骤' }
      if (step.type === 'tool') {
        return { error: '这一步没有提示词（tool 步骤由接入方实现），单步试跑只针对提示词步骤' }
      }
      /** 空上下文：不解析任何上游绑定，输入完全来自调用方。 */
      const context: RunContext = { input: {}, stepOutputs: new Map(), traces: [] }
      const startedAt = Date.now()
      notifyStepProgress(dependencies, { phase: 'started', step, input, traces: [], startedAt })
      const { trace } = await executeStep(step, input, context, dependencies, pkg, null)
      context.traces.push(trace)
      notifyStepProgress(dependencies, { phase: 'completed', step, input, trace, traces: [...context.traces], startedAt })
      return { step: trace, valid: trace.status === 'succeeded' }
    },

    /**
     * 执行一次能力包。
     * @param pkg 已通过严格解析的能力包
     * @param input 调用方输入
     */
    async run(pkg: CapabilityPackage, input: Record<string, unknown>): Promise<RunResult> {
      const startedAt = Date.now()

      // 输入契约先校验：不满足就地拒绝，不浪费模型调用。
      const inputErrors: string[] = []
      for (const field of pkg.inputs) {
        const key = field.name ?? ''
        if (!key) continue
        if (!(key in input) && field.required !== false && !field.nullable) {
          inputErrors.push(`${key}: 缺少必填输入`)
          continue
        }
        inputErrors.push(...validateValue(field, input[key], key))
      }
      if (inputErrors.length > 0) {
        return { status: 'failed', valid: false, inputErrors, outputs: null, steps: [],
          error: '输入不满足输入契约', startedAt, finishedAt: Date.now() }
      }

      const context: RunContext = { input, stepOutputs: new Map(), traces: [] }
      const outcome = await runSteps(pkg.steps, context, dependencies, pkg, null)

      let outputs: Record<string, unknown> | null = null
      if (outcome.ok) {
        outputs = {}
        for (const declaration of pkg.outputs) {
          const value = readPath(context.stepOutputs.get(declaration.from.stepId), declaration.from.path ?? '')
          outputs[declaration.name] = value ?? null
        }
      }

      // 完整性轴：全部子项成功 = succeeded；有失败项但仍交付 = partial；未完成 = failed。
      let status: RunResult['status'] = 'succeeded'
      if (!outcome.ok) status = 'failed'
      else if (context.traces.some((trace) =>
        trace.type === 'map' && (trace.itemResults ?? []).some((item) => !item.ok))) status = 'partial'

      return {
        status,
        valid: outcome.ok && !outcome.invalid,
        outputs,
        steps: context.traces,
        ...(outcome.ok ? {} : { error: '执行未完成' }),
        startedAt,
        finishedAt: Date.now(),
      }
    },
  }
}
