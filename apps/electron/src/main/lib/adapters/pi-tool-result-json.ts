import type { JsonValue } from '@earendil-works/pi-ai'

/** Pi 工具结果写入 transcript 前使用的 JSON 值。 */
export type PiToolResultJson = JsonValue

export interface SerializedPiToolResultPayload {
  details: PiToolResultJson
  text: string
}

/**
 * 将业务工具的宽类型结果统一转换成 Pi transcript 可持久化的 JSON 值。
 * 每个运行时边界独立收口；跨进程 structured clone 后仍会在接收侧重新校验并快照。
 */
export function normalizePiToolResultDetails(value: unknown): PiToolResultJson {
  try {
    const normalized = normalize(value, new WeakSet<object>(), 'root')
    if (normalized === undefined) throw new Error('根值不能是 undefined、function 或 symbol')
    return normalized
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`PI_TOOL_RESULT_JSON_NORMALIZATION_FAILED: ${reason}`, { cause: error })
  }
}

/** 单次序列化内让正文与 details 共用同一份归一化结果，避免工具内部重复深拷贝。 */
export function serializePiToolResultPayload(value: unknown): SerializedPiToolResultPayload {
  const details = normalizePiToolResultDetails(value)
  try {
    const text = JSON.stringify(details)
    if (text === undefined) throw new Error('JSON.stringify 未生成文本')
    return { details, text }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`PI_TOOL_RESULT_JSON_SERIALIZATION_FAILED: ${reason}`, { cause: error })
  }
}

type JsonValuePosition = 'root' | 'array' | 'object'

/** 递归归一化值；ancestors 只识别当前路径中的循环，不误伤兄弟节点共享引用。 */
function normalize(
  value: unknown,
  ancestors: WeakSet<object>,
  position: JsonValuePosition,
): PiToolResultJson | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return position === 'array' ? null : undefined
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error('检测到循环引用')
    ancestors.add(value)
    /** 数组长度必须来自数据描述符，禁止代理或异常对象通过属性读取执行代码。 */
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (!lengthDescriptor || !('value' in lengthDescriptor)) throw new Error('不支持访问器属性: length')
    /** 普通数组的 length 始终是非负整数；异常描述符明确拒绝。 */
    const length = lengthDescriptor.value
    if (!Number.isSafeInteger(length) || length < 0) throw new Error('数组 length 无效')
    const normalized: PiToolResultJson[] = []
    for (let index = 0; index < length; index += 1) {
      /** 缺失索引是稀疏项，按 JSON 数组语义写入 null。 */
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor) {
        normalized.push(null)
        continue
      }
      if (!('value' in descriptor)) throw new Error(`不支持访问器属性: ${index}`)
      normalized.push(normalize(descriptor.value, ancestors, 'array') ?? null)
    }
    ancestors.delete(value)
    return normalized
  }

  if (typeof value === 'object') {
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null
    if (value instanceof Error) return normalizeError(value, ancestors)
    if (ancestors.has(value)) throw new Error('检测到循环引用')
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      const typeName = value.constructor?.name || 'unknown'
      throw new Error(`不支持的对象类型: ${typeName}`)
    }

    ancestors.add(value)
    const normalized: Record<string, PiToolResultJson> = Object.create(null)
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) throw new Error(`不支持访问器属性: ${key}`)
      const normalizedValue = normalize(descriptor.value, ancestors, 'object')
      if (normalizedValue !== undefined) {
        Object.defineProperty(normalized, key, {
          value: normalizedValue,
          enumerable: true,
          configurable: true,
          writable: true,
        })
      }
    }
    ancestors.delete(value)
    return normalized
  }

  return null
}

/** Error 不带 stack 进入 transcript，避免泄露宿主路径，同时保留可诊断信息。 */
function normalizeError(error: Error, ancestors: WeakSet<object>): PiToolResultJson {
  if (ancestors.has(error)) throw new Error('检测到循环引用')
  ancestors.add(error)
  const normalized: Record<string, PiToolResultJson> = Object.create(null)
  /** Error.name 通常来自 Error.prototype，必须沿描述符链安全读取。 */
  const normalizedName = normalize(readDataProperty(error, 'name'), ancestors, 'object')
  /** Error.message 通常是自有属性，也可能由子类原型提供。 */
  const normalizedMessage = normalize(readDataProperty(error, 'message'), ancestors, 'object')
  if (normalizedName !== undefined) normalized.name = normalizedName
  if (normalizedMessage !== undefined) normalized.message = normalizedMessage
  for (const key of Object.keys(error)) {
    if (key === 'stack' || key === 'name' || key === 'message') continue
    const descriptor = Object.getOwnPropertyDescriptor(error, key)
    if (!descriptor || !('value' in descriptor)) throw new Error(`不支持访问器属性: ${key}`)
    const normalizedValue = normalize(descriptor.value, ancestors, 'object')
    if (normalizedValue !== undefined) normalized[key] = normalizedValue
  }
  ancestors.delete(error)
  return normalized
}

/** 沿自有与原型链读取数据描述符；访问器一律拒绝，避免诊断字段执行用户代码。 */
function readDataProperty(value: object, key: string): unknown {
  /** 当前检查的实例或原型对象。 */
  let current: object | null = value
  while (current) {
    /** 当前层级对应字段的属性描述符。 */
    const descriptor = Object.getOwnPropertyDescriptor(current, key)
    if (descriptor) {
      if (!('value' in descriptor)) throw new Error(`不支持访问器属性: ${key}`)
      return descriptor.value
    }
    current = Object.getPrototypeOf(current)
  }
  return undefined
}
