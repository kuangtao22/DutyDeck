/** 单框任务输入与场景变量之间的转换；复用时不改变原始测试材料。 */
import type { CapabilitySceneDefinition } from '@proma/shared'
import { validateValue } from '@proma/capability-runner'
import { initialFieldDraft, namedFields, type NamedField } from './capability-factory-run-view'

/** 默认自动识别；手动选择和旧任务回填可固定变量映射，避免误拆 JSON 正文。 */
export interface TaskInputDraft {
  format: 'auto' | 'text' | 'json'
  content: string
}

/** 内容格式与可选 JSON 解析值；格式识别不负责改写内容或决定变量映射。 */
export interface TaskContentInspection {
  format: 'empty' | 'text' | 'json' | 'markdown'
  value?: unknown
}

/** 本地识别完整输入格式；只对独立 JSON 围栏解包，混合文档保留为 Markdown。 */
export function inspectTaskContent(content: string): TaskContentInspection {
  const trimmed = content.trim()
  if (!trimmed) return { format: 'empty' }
  /** 围栏必须完整包住文档，不从正文中截取一段 JSON 冒充全部内容。 */
  const fence = trimmed.match(/^(`{3,}|~{3,})(?:json)?[^\S\r\n]*\r?\n([\s\S]*?)\r?\n\1$/i)
  const jsonText = fence?.[2] ?? trimmed
  try {
    return { format: 'json', value: JSON.parse(jsonText) as unknown }
  } catch {
    /** 非 JSON 是正常输入，不显示错误；完整输入模式在提交时单独校验。 */
  }
  /** Markdown 无法严格区分普通文字；只检测常见明确标记，限制扫描量以照顾长篇正文。 */
  const sample = trimmed.slice(0, 32_768)
  const markdown = /^(?: {0,3}#{1,6}\s+| {0,3}>\s?|\s*[-+*]\s+|\s*\d+[.)]\s+| {0,3}(?:`{3,}|~{3,})|\s*\|?\s*:?-{3,}:?\s*\|)/m.test(sample)
    || /\*\*[^*\n]+\*\*|__[^_\n]+__|!?\[[^\]\n]+\]\([^\s)]+\)|`[^`\n]+`/.test(sample)
  return { format: markdown ? 'markdown' : 'text' }
}

/** 内容格式与变量用途分开：只把含场景字段的 JSON 对象自动作为完整输入。 */
export function taskInputMapping(
  definition: CapabilitySceneDefinition,
  draft: TaskInputDraft,
  inspection: TaskContentInspection = inspectTaskContent(draft.content),
): 'text' | 'json' {
  if (draft.format !== 'auto') return draft.format
  if (!taskTextField(definition)) return 'json'
  const value = inspection.value
  if (inspection.format === 'json' && value !== null && typeof value === 'object' && !Array.isArray(value)
    && namedFields(definition.inputs).some((field) => Object.hasOwn(value, field.name))) return 'json'
  return 'text'
}

/** 只在主要文本字段唯一、其他字段可省略时开放直接粘贴正文。 */
export function taskTextField(definition: CapabilitySceneDefinition): NamedField | undefined {
  const fields = namedFields(definition.inputs)
  const required = fields.filter((field) => field.required !== false && !field.nullable)
  const candidate = required.length === 1 ? required[0] : fields.length === 1 ? fields[0] : undefined
  return candidate?.type === 'string' ? candidate : undefined
}

/** 完整输入的编辑骨架；数字不虚构默认值，留给用户填写。 */
export function taskInputTemplate(definition: CapabilitySceneDefinition): Record<string, unknown> {
  return Object.fromEntries(namedFields(definition.inputs).map((field) => [field.name,
    field.type === 'string' ? '' : JSON.parse(initialFieldDraft(field) || 'null'),
  ]))
}

/** 将保存的输入转换为当前场景的编辑文本；新任务才使用字段默认值。 */
export function savedTaskDraft(
  definition: CapabilitySceneDefinition,
  input?: Record<string, unknown>,
): TaskInputDraft {
  /** 已移除的契约字段不参与新运行；仍存在的字段连同空值原样保留。 */
  const currentInput = input === undefined ? undefined : Object.fromEntries(
    namedFields(definition.inputs).filter((field) => Object.hasOwn(input, field.name))
      .map((field) => [field.name, input[field.name]]),
  )
  const field = taskTextField(definition)
  if (currentInput === undefined) {
    return { format: 'auto', content: field ? '' : JSON.stringify(taskInputTemplate(definition), null, 2) }
  }
  if (field && Object.keys(currentInput).length === 1 && typeof currentInput[field.name] === 'string') {
    return { format: 'text', content: (currentInput?.[field.name] as string | undefined) ?? '' }
  }
  return { format: 'json', content: JSON.stringify(currentInput ?? taskInputTemplate(definition), null, 2) }
}

/** 将单框内容映射为场景变量；格式和类型不符时留在弹窗，不发起运行。 */
export function parseSavedTaskInput(
  definition: CapabilitySceneDefinition,
  draft: TaskInputDraft,
): { input: Record<string, unknown>; errors: string[] } {
  /** 每次提交只解析一次，复用检测值；输入框中的原文保持不变。 */
  const inspection = inspectTaskContent(draft.content)
  let input: Record<string, unknown>
  if (taskInputMapping(definition, draft, inspection) === 'text') {
    const field = taskTextField(definition)
    if (!field) return { input: {}, errors: ['这个场景需要完整 JSON 输入'] }
    input = { [field.name]: draft.content }
  } else {
    if (inspection.format !== 'json') {
      return { input: {}, errors: ['JSON 格式有误，请检查引号、逗号和括号'] }
    }
    const value = inspection.value
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { input: {}, errors: ['完整输入需要一个 JSON 对象'] }
    }
    input = value as Record<string, unknown>
  }
  const fields = namedFields(definition.inputs)
  const errors = fields.flatMap((field) => validateValue(field, input[field.name], field.name))
  /** 拒绝未知字段，避免用户以为额外材料已经传入提示词。 */
  for (const key of Object.keys(input)) {
    if (!fields.some((field) => field.name === key)) errors.push(`${key} 未在场景输入中定义`)
  }
  return { input, errors }
}

/** 以输入摘要识别任务，不增加强制命名步骤，也不把整篇正文塞进下拉菜单。 */
export function savedTaskLabel(input: Record<string, unknown>): string {
  const text = Object.values(input).find((value): value is string => typeof value === 'string' && value.trim().length > 0)
  const summary = (text ?? JSON.stringify(input)).replace(/\s+/g, ' ').trim()
  return summary.length > 52 ? `${summary.slice(0, 52)}…` : summary || '空输入任务'
}
