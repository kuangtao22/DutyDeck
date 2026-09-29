/**
 * 受限字段 schema 的判定与描述生成。
 *
 * 一份 schema 驱动三件事：①生成提示词里的格式说明；②运行时判定输出是否合法；
 * ③告诉评测器该比对哪些字段。三者共用同一份定义，避免手写两遍产生漂移。
 *
 * 注意：schema **不约束**模型输出（真正约束输出的是提示词），它只做判定。
 */
import type { FieldSchema, FieldType } from './spec'

/** 判定一个值属于哪个受限类型；object 排除 null 与数组，避免把它们误判成对象。 */
export function valueTypeOf(value: unknown): FieldType | null {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  const t = typeof value
  if (t === 'string' || t === 'boolean') return t
  if (t === 'number') return Number.isFinite(value as number) ? 'number' : null
  if (t === 'object') return 'object'
  return null
}

/** 类型名的中文说明，用于错误信息。 */
const TYPE_LABEL: Record<FieldType, string> = {
  string: '字符串', number: '数字', boolean: '布尔', object: '对象', array: '数组', null: 'null',
}

/** 字段是否必填：缺省为必填 —— 声明一个字段的默认意图就是"必须有"。 */
function isRequired(schema: FieldSchema): boolean {
  return schema.required !== false
}

/**
 * 按 schema 校验值，返回中文错误清单；空数组表示通过。
 * @param schema 字段声明
 * @param value 待校验的值
 * @param path 出错时展示的路径，递归时自动拼接
 */
export function validateValue(schema: FieldSchema, value: unknown, path = ''): string[] {
  const at = path || schema.name || '(根)'

  if (value === null || value === undefined) {
    if (schema.nullable) return []
    if (isRequired(schema)) return [`${at}: 缺少必填字段`]
    return []
  }

  const actual = valueTypeOf(value)
  if (actual !== schema.type) {
    return [`${at}: 期望 ${TYPE_LABEL[schema.type]}，实际是 ${actual ? TYPE_LABEL[actual] : '不支持的类型'}`]
  }

  if (schema.enum && schema.enum.length > 0) {
    const allowed = schema.enum as unknown[]
    if (!allowed.includes(value)) {
      return [`${at}: 取值必须是 ${schema.enum.join(' / ')} 之一`]
    }
  }

  if (schema.type === 'array' && schema.items) {
    const list = value as unknown[]
    const errors: string[] = []
    list.forEach((item, index) => {
      errors.push(...validateValue(schema.items as FieldSchema, item, `${at}[${index}]`))
    })
    return errors
  }

  if (schema.type === 'object' && schema.fields) {
    const record = value as Record<string, unknown>
    const errors: string[] = []
    for (const field of schema.fields) {
      const key = field.name
      if (!key) continue // 无名字段只在数组元素里出现，对象字段必须有名字
      const childPath = path ? `${path}.${key}` : key
      if (!(key in record) && isRequired(field) && !field.nullable) {
        errors.push(`${childPath}: 缺少必填字段`)
        continue
      }
      errors.push(...validateValue(field, record[key], childPath))
    }
    return errors
  }

  return []
}

/** 渲染单个字段的类型短语，如 `array<string>`。 */
function typePhrase(schema: FieldSchema): string {
  if (schema.type === 'array' && schema.items) return `array<${typePhrase(schema.items)}>`
  if (schema.type === 'object' && schema.fields) return 'object'
  if (schema.enum && schema.enum.length > 0) return schema.enum.map(String).join(' | ')
  return schema.type
}

/**
 * 把 schema 渲染成给模型看的格式说明。
 * 这段文字由 schema 自动生成，所以提示词里不必再手写一份格式要求。
 */
export function describeSchema(schema: FieldSchema, indent = ''): string {
  const lines = describeFields(schema, indent)
  return [
    `${indent}请只返回一个 JSON 对象，字段如下：`,
    ...lines,
    `${indent}不要输出解释文字，也不要用 Markdown 代码块包裹。`,
  ].join('\n')
}

/** 递归渲染字段清单（object 展开子字段，array 展开元素结构）。 */
function describeFields(schema: FieldSchema, indent: string): string[] {
  const pad = indent + '  '
  const lines: string[] = []

  if (schema.type === 'object' && schema.fields) {
    for (const field of schema.fields) {
      if (!field.name) continue
      const flag = isRequired(field) ? '必填' : '可选'
      const note = field.description ? `：${field.description}` : ''
      lines.push(`${pad}- ${field.name} (${typePhrase(field)}, ${flag})${note}`)
      // 嵌套对象继续展开，让模型看到完整形状
      if (field.type === 'object' && field.fields) lines.push(...describeFields(field, pad))
      if (field.type === 'array' && field.items?.type === 'object' && field.items.fields) {
        lines.push(...describeFields(field.items, pad))
      }
    }
  }

  return lines
}
