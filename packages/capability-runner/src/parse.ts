/**
 * 能力包的严格解析。
 *
 * 纪律（沿用接口工作台集合快照的做法）：
 * - **白名单字段**：出现未知键直接拒绝，避免旧 runner 静默忽略新语义。
 * - **specVersion 不匹配即拒绝**，不做降级 —— 降级会让行为悄悄变化，比报错更糟。
 * - **引用完整性**：步骤 id 唯一；step-output / modelSlot / capability / outputs 引用的目标必须存在。
 *
 * 所有失败都抛 `Error`，消息以 `CAPABILITY_PACKAGE_INVALID` 开头并附中文原因。
 */
import {
  CAPABILITY_PACKAGE_KIND, CAPABILITY_PACKAGE_SPEC_VERSION,
  type CapabilityDeclaration, type CapabilityPackage, type FieldSchema,
  type InputSource, type OutputDeclaration, type Step,
} from './spec'

/** 统一的失败构造：调用方只需判断前缀，不必解析对象的形状。 */
function invalid(reason: string): never {
  throw new Error(`CAPABILITY_PACKAGE_INVALID: ${reason}`)
}

/** 判断是否为普通对象（排除数组与 null）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 白名单校验：未知键一次性列出，便于定位。 */
function assertKeys(value: Record<string, unknown>, where: string, allowed: readonly string[]): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) invalid(`${where} 含未知字段：${unknown.join(', ')}`)
}

/** 读取必填字符串。 */
function readString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) invalid(`${where} 必须是非空字符串`)
  return value
}

/** 读取可选字符串。 */
function readOptionalString(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') invalid(`${where} 必须是字符串`)
  return value
}

/** 读取可选正整数。 */
function readOptionalInt(value: unknown, where: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    invalid(`${where} 必须是不小于 1 的整数`)
  }
  return value
}

/** 解析字段 schema（递归）。 */
function parseFieldSchema(value: unknown, where: string, requireName: boolean): FieldSchema {
  if (!isRecord(value)) invalid(`${where} 必须是对象`)
  assertKeys(value, where, ['name', 'type', 'description', 'required', 'nullable', 'enum', 'items', 'fields'])

  const type = value.type
  if (type !== 'string' && type !== 'number' && type !== 'boolean'
    && type !== 'object' && type !== 'array' && type !== 'null') {
    invalid(`${where}.type 必须是 string / number / boolean / object / array / null`)
  }

  const name = readOptionalString(value.name, `${where}.name`)
  if (requireName && !name) invalid(`${where}.name 不能为空`)

  const schema: FieldSchema = { type }
  if (name !== undefined) schema.name = name
  const description = readOptionalString(value.description, `${where}.description`)
  if (description !== undefined) schema.description = description
  if (value.required !== undefined) {
    if (typeof value.required !== 'boolean') invalid(`${where}.required 必须是布尔`)
    schema.required = value.required
  }
  if (value.nullable !== undefined) {
    if (typeof value.nullable !== 'boolean') invalid(`${where}.nullable 必须是布尔`)
    schema.nullable = value.nullable
  }
  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length === 0) invalid(`${where}.enum 必须是非空数组`)
    for (const item of value.enum) {
      if (typeof item !== 'string' && typeof item !== 'number') invalid(`${where}.enum 只能包含字符串或数字`)
    }
    schema.enum = value.enum as (string | number)[]
  }
  if (value.items !== undefined) {
    if (type !== 'array') invalid(`${where}.items 只能出现在 array 上`)
    schema.items = parseFieldSchema(value.items, `${where}.items`, false)
  }
  if (value.fields !== undefined) {
    if (type !== 'object') invalid(`${where}.fields 只能出现在 object 上`)
    if (!Array.isArray(value.fields)) invalid(`${where}.fields 必须是数组`)
    schema.fields = value.fields.map((item, index) =>
      parseFieldSchema(item, `${where}.fields[${index}]`, true))
  }
  return schema
}

/** 解析字段数组。 */
function parseFields(value: unknown, where: string): FieldSchema[] {
  if (!Array.isArray(value)) invalid(`${where} 必须是数组`)
  return value.map((item, index) => parseFieldSchema(item, `${where}[${index}]`, true))
}

/** 解析输入来源。 */
function parseInputSource(value: unknown, where: string): InputSource {
  if (!isRecord(value)) invalid(`${where} 必须是对象`)
  const from = value.from
  if (from === 'workflow-input') {
    assertKeys(value, where, ['from', 'field'])
    return { from, field: readString(value.field, `${where}.field`) }
  }
  if (from === 'step-output') {
    assertKeys(value, where, ['from', 'stepId', 'path'])
    const source: InputSource = { from, stepId: readString(value.stepId, `${where}.stepId`) }
    const path = readOptionalString(value.path, `${where}.path`)
    return path === undefined ? source : { ...source, path }
  }
  if (from === 'literal') {
    assertKeys(value, where, ['from', 'value'])
    return { from, value: value.value }
  }
  return invalid(`${where}.from 必须是 workflow-input / step-output / literal`)
}

/** 解析输入绑定表。 */
function parseInputs(value: unknown, where: string): Record<string, InputSource> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) invalid(`${where} 必须是对象`)
  const result: Record<string, InputSource> = {}
  for (const [key, source] of Object.entries(value)) {
    result[key] = parseInputSource(source, `${where}.${key}`)
  }
  return result
}

/** 步骤白名单：按类型区分，避免把 json 步骤的字段写进 extract 步骤。 */
const STEP_KEYS: Record<Step['type'], readonly string[]> = {
  llm: ['type', 'id', 'title', 'prompt', 'modelSlot', 'inputs', 'maxAttempts'],
  extract: ['type', 'id', 'title', 'prompt', 'modelSlot', 'inputs', 'maxAttempts', 'judgeFields', 'strictness'],
  tool: ['type', 'id', 'title', 'capabilityId', 'bindings', 'maxAttempts'],
  map: ['type', 'id', 'title', 'over', 'body', 'failurePolicy', 'concurrency', 'inputs', 'maxAttempts'],
}

/** 解析单个步骤（递归处理 map 容器）。 */
function parseStep(value: unknown, where: string, seenIds: Set<string>): Step {
  if (!isRecord(value)) invalid(`${where} 必须是对象`)
  const type = value.type
  if (type !== 'llm' && type !== 'extract' && type !== 'tool' && type !== 'map') {
    invalid(`${where}.type 必须是 llm / extract / tool / map`)
  }
  assertKeys(value, where, STEP_KEYS[type])

  const id = readString(value.id, `${where}.id`)
  if (seenIds.has(id)) invalid(`步骤 id 重复：${id}`)
  seenIds.add(id)
  const title = readString(value.title, `${where}.title`)
  const maxAttempts = readOptionalInt(value.maxAttempts, `${where}.maxAttempts`)

  if (type === 'llm' || type === 'extract') {
    const inputs = parseInputs(value.inputs, `${where}.inputs`)
    const step = {
      type, id, title,
      modelSlot: readString(value.modelSlot, `${where}.modelSlot`),
      prompt: readString(value.prompt, `${where}.prompt`),
      ...(maxAttempts === undefined ? {} : { maxAttempts }),
      ...(inputs === undefined ? {} : { inputs }),
    }
    if (type === 'llm') return step as Step
    const strictness = value.strictness
    if (strictness !== undefined && strictness !== 'strict' && strictness !== 'lenient') {
      invalid(`${where}.strictness 必须是 strict 或 lenient`)
    }
    return {
      ...step, type: 'extract',
      judgeFields: parseFields(value.judgeFields, `${where}.judgeFields`),
      ...(strictness === undefined ? {} : { strictness }),
    } as Step
  }

  if (type === 'tool') {
    const bindings = parseInputs(value.bindings, `${where}.bindings`) ?? {}
    return { type, id, title, capabilityId: readString(value.capabilityId, `${where}.capabilityId`), bindings, ...(maxAttempts === undefined ? {} : { maxAttempts }) }
  }

  // map：并行组容器。over 必填，body 递归解析。
  const failurePolicy = value.failurePolicy
  if (failurePolicy !== undefined && failurePolicy !== 'fail-fast' && failurePolicy !== 'continue') {
    invalid(`${where}.failurePolicy 必须是 fail-fast 或 continue`)
  }
  if (!Array.isArray(value.body) || value.body.length === 0) invalid(`${where}.body 必须是非空数组`)
  return {
    type, id, title,
    over: parseInputSource(value.over, `${where}.over`),
    body: value.body.map((item, index) => parseStep(item, `${where}.body[${index}]`, seenIds)),
    ...(failurePolicy === undefined ? {} : { failurePolicy }),
    ...(readOptionalInt(value.concurrency, `${where}.concurrency`) === undefined
      ? {} : { concurrency: readOptionalInt(value.concurrency, `${where}.concurrency`) as number }),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
  } as Step
}

/** 收集所有 step-output 引用，用于引用完整性检查。 */
function collectStepRefs(steps: Step[], refs: string[]): void {
  for (const step of steps) {
    if (step.inputs) for (const source of Object.values(step.inputs)) {
      if (source.from === 'step-output') refs.push(source.stepId)
    }
    if (step.type === 'tool') for (const source of Object.values(step.bindings)) {
      if (source.from === 'step-output') refs.push(source.stepId)
    }
    if (step.type === 'map') {
      if (step.over.from === 'step-output') refs.push(step.over.stepId)
      collectStepRefs(step.body, refs)
    }
  }
}

/** 收集所有步骤 id（含 map 内部），用于引用完整性检查。 */
function collectStepIds(steps: Step[], ids: string[]): void {
  for (const step of steps) {
    ids.push(step.id)
    if (step.type === 'map') collectStepIds(step.body, ids)
  }
}

/** 解析能力包 JSON 文本。 */
export function parseCapabilityPackage(text: string): CapabilityPackage {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return invalid('不是合法的 JSON')
  }
  return parseCapabilityPackageValue(raw)
}

/** 解析已经 JSON.parse 过的值；便于调用方复用对象。 */
export function parseCapabilityPackageValue(raw: unknown): CapabilityPackage {
  if (!isRecord(raw)) invalid('顶层必须是对象')
  assertKeys(raw, '能力包', [
    'kind', 'specVersion', 'packageVersion', 'name', 'description', 'exportedAt',
    'inputs', 'outputs', 'steps', 'capabilities', 'modelSlots', 'acceptance', 'evidence',
  ])

  if (raw.kind !== CAPABILITY_PACKAGE_KIND) invalid(`kind 必须是 ${CAPABILITY_PACKAGE_KIND}`)
  if (raw.specVersion !== CAPABILITY_PACKAGE_SPEC_VERSION) {
    invalid(`specVersion 必须是 ${CAPABILITY_PACKAGE_SPEC_VERSION}，收到 ${String(raw.specVersion)}；本 runner 不做降级`)
  }

  const packageVersion = readString(raw.packageVersion, 'packageVersion')
  const name = readString(raw.name, 'name')
  if (typeof raw.exportedAt !== 'number' || !Number.isSafeInteger(raw.exportedAt)) {
    invalid('exportedAt 必须是整数时间戳')
  }

  const inputs = parseFields(raw.inputs, 'inputs')
  if (!Array.isArray(raw.outputs)) invalid('outputs 必须是数组')
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) invalid('steps 必须是非空数组')
  if (!Array.isArray(raw.capabilities)) invalid('capabilities 必须是数组')
  if (!Array.isArray(raw.modelSlots)) invalid('modelSlots 必须是数组')

  const stepIds: string[] = []
  const seen = new Set<string>()
  const steps = raw.steps.map((item, index) => parseStep(item, `steps[${index}]`, seen))
  collectStepIds(steps, stepIds)

  // 引用完整性：步骤引用的 stepId / modelSlot / capabilityId 必须存在。
  const refs: string[] = []
  collectStepRefs(steps, refs)
  for (const ref of refs) {
    if (!stepIds.includes(ref)) invalid(`步骤引用了不存在的 stepId：${ref}`)
  }

  const slotIds = new Set<string>()
  const modelSlots = raw.modelSlots.map((item, index) => {
    const where = `modelSlots[${index}]`
    if (!isRecord(item)) invalid(`${where} 必须是对象`)
    assertKeys(item, where, ['id', 'model', 'temperature', 'maxTokens', 'description'])
    const id = readString(item.id, `${where}.id`)
    if (slotIds.has(id)) invalid(`modelSlot id 重复：${id}`)
    slotIds.add(id)
    const description = readOptionalString(item.description, `${where}.description`)
    if (item.temperature !== undefined && typeof item.temperature !== 'number') invalid(`${where}.temperature 必须是数字`)
    return {
      id, model: readString(item.model, `${where}.model`),
      ...(item.temperature === undefined ? {} : { temperature: item.temperature as number }),
      ...(readOptionalInt(item.maxTokens, `${where}.maxTokens`) === undefined
        ? {} : { maxTokens: readOptionalInt(item.maxTokens, `${where}.maxTokens`) as number }),
      ...(description === undefined ? {} : { description }),
    }
  })
  for (const step of walkSteps(steps)) {
    if ((step.type === 'llm' || step.type === 'extract') && !slotIds.has(step.modelSlot)) {
      invalid(`步骤 ${step.id} 引用了不存在的 modelSlot：${step.modelSlot}`)
    }
  }

  const capabilityIds = new Set<string>()
  const capabilities = raw.capabilities.map((item, index) => {
    const where = `capabilities[${index}]`
    if (!isRecord(item)) invalid(`${where} 必须是对象`)
    assertKeys(item, where, ['id', 'description', 'inputSchema', 'outputSchema', 'sideEffect'])
    const id = readString(item.id, `${where}.id`)
    if (capabilityIds.has(id)) invalid(`capability id 重复：${id}`)
    capabilityIds.add(id)
    const sideEffect = item.sideEffect
    if (sideEffect !== 'read' && sideEffect !== 'write' && sideEffect !== 'irreversible') {
      invalid(`${where}.sideEffect 必须是 read / write / irreversible`)
    }
    return {
      id, description: readString(item.description, `${where}.description`),
      inputSchema: parseFields(item.inputSchema, `${where}.inputSchema`),
      outputSchema: parseFields(item.outputSchema, `${where}.outputSchema`),
      // 运行时已按三值白名单校验过，此处仅补回字面量类型
      sideEffect: sideEffect as CapabilityDeclaration['sideEffect'],
    } satisfies CapabilityDeclaration
  })
  for (const step of walkSteps(steps)) {
    if (step.type === 'tool' && !capabilityIds.has(step.capabilityId)) {
      invalid(`步骤 ${step.id} 引用了不存在的 capabilityId：${step.capabilityId}`)
    }
  }

  if (!Array.isArray(raw.outputs)) invalid('outputs 必须是数组')
  const outputs = raw.outputs.map((item, index) => {
    const where = `outputs[${index}]`
    if (!isRecord(item)) invalid(`${where} 必须是对象`)
    assertKeys(item, where, ['name', 'from', 'shape', 'fields', 'description'])
    const shape = item.shape
    if (shape !== 'text' && shape !== 'structured') invalid(`${where}.shape 必须是 text 或 structured`)
    if (!isRecord(item.from)) invalid(`${where}.from 必须是对象`)
    assertKeys(item.from, `${where}.from`, ['stepId', 'path'])
    const stepId = readString(item.from.stepId, `${where}.from.stepId`)
    if (!stepIds.includes(stepId)) invalid(`${where} 引用了不存在的 stepId：${stepId}`)
    const path = readOptionalString(item.from.path, `${where}.from.path`)
    const description = readOptionalString(item.description, `${where}.description`)
    return {
      name: readString(item.name, `${where}.name`),
      from: path === undefined ? { stepId } : { stepId, path },
      // 运行时已按 text / structured 白名单校验过，此处仅补回字面量类型
      shape: shape as OutputDeclaration['shape'],
      ...(item.fields === undefined ? {} : { fields: parseFields(item.fields, `${where}.fields`) }),
      ...(description === undefined ? {} : { description }),
    } satisfies OutputDeclaration
  })

  if (!isRecord(raw.acceptance)) invalid('acceptance 必须是对象')
  assertKeys(raw.acceptance, 'acceptance', ['criteria'])
  if (!Array.isArray(raw.acceptance.criteria) || raw.acceptance.criteria.length === 0) {
    invalid('acceptance.criteria 必须是非空字符串数组')
  }
  const criteria = raw.acceptance.criteria.map((item, index) =>
    readString(item, `acceptance.criteria[${index}]`))

  const evidence = raw.evidence
  if (evidence !== undefined && !isRecord(evidence)) invalid('evidence 必须是对象')

  const description = readOptionalString(raw.description, 'description')
  return {
    kind: CAPABILITY_PACKAGE_KIND,
    specVersion: CAPABILITY_PACKAGE_SPEC_VERSION,
    packageVersion, name,
    ...(description === undefined ? {} : { description }),
    exportedAt: raw.exportedAt,
    inputs, outputs, steps, capabilities, modelSlots,
    acceptance: { criteria },
    ...(evidence === undefined ? {} : { evidence: evidence as unknown as CapabilityPackage['evidence'] }),
  }
}

/** 深度遍历所有步骤（含 map 内部），供引用完整性检查使用。 */
function* walkSteps(steps: Step[]): Generator<Step> {
  for (const step of steps) {
    yield step
    if (step.type === 'map') yield* walkSteps(step.body)
  }
}
