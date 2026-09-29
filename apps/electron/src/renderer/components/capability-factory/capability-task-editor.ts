import type { Text } from '@codemirror/state'

/** JSON 解析错误的位置，使用编辑器的 UTF-16 偏移。 */
export interface TaskJsonDiagnostic { from: number; message: string }

/** 独立代码围栏只在操作 JSON 时解包，编辑器始终保留用户完整内容。 */
function jsonSource(content: string): { source: string; prefix: string; suffix: string } {
  const fence = content.match(/^(\s*(`{3,}|~{3,})(?:json)?[^\S\r\n]*\r?\n)([\s\S]*?)(\r?\n\2\s*)$/i)
  return fence ? { source: fence[3]!, prefix: fence[1]!, suffix: fence[4]! } : { source: content, prefix: '', suffix: '' }
}

/** 给出可点击的 JSON 错误；不向模型发送内容，也不尝试自动修正。 */
export function taskJsonDiagnostic(content: string): TaskJsonDiagnostic | null {
  const { source, prefix } = jsonSource(content)
  try { JSON.parse(source); return null } catch (error) {
    const detail = error instanceof Error ? error.message : '格式不合法'
    const position = detail.match(/position (\d+)/i)
    const from = prefix.length + (position ? Number(position[1]) : source.length)
    return { from: Math.min(content.length, from), message: `JSON 格式有误：${detail}` }
  }
}

/** 手动格式化只改字符串外的空白，保留大整数、重复键、转义与数字字面量。 */
export function formatTaskJson(content: string): string {
  const { source, prefix, suffix } = jsonSource(content)
  JSON.parse(source)
  /** 先去除字符串外空白，再插入缩进，避免解析后序列化造成精度损失。 */
  let compact = ''
  let quoted = false
  let escaped = false
  for (const char of source) {
    if (quoted || !/\s/.test(char)) compact += char
    if (escaped) escaped = false
    else if (quoted && char === '\\') escaped = true
    else if (char === '"') quoted = !quoted
  }
  let result = ''
  let depth = 0
  quoted = false
  escaped = false
  for (let index = 0; index < compact.length; index += 1) {
    const char = compact[index]!
    if (quoted) {
      result += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"') { quoted = true; result += char }
    else if (char === '{' || char === '[') {
      result += char
      depth += 1
      if (compact[index + 1] !== '}' && compact[index + 1] !== ']') result += `\n${'  '.repeat(depth)}`
    } else if (char === '}' || char === ']') {
      depth -= 1
      if (compact[index - 1] !== '{' && compact[index - 1] !== '[') result += `\n${'  '.repeat(depth)}`
      result += char
    } else if (char === ',') result += `,\n${'  '.repeat(depth)}`
    else if (char === ':') result += ': '
    else result += char
  }
  return prefix + result + suffix
}

/** 按不可变文档缓存折叠范围；滚动时不反复扫描全文，旧文档可自动回收。 */
const foldCache = new WeakMap<Text, Map<number, { from: number; to: number }>>()

/** 扫描字符串之外的成对括号，返回每行最外层多行结构的折叠区间。 */
export function taskJsonFolds(doc: Text): Map<number, { from: number; to: number }> {
  const cached = foldCache.get(doc)
  if (cached) return cached
  const result = new Map<number, { from: number; to: number }>()
  const stack: Array<{ char: string; from: number; line: number }> = []
  let quoted = false
  let escaped = false
  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
    const line = doc.line(lineNumber)
    for (let index = 0; index < line.length; index += 1) {
      const char = line.text[index]!
      if (escaped) { escaped = false; continue }
      if (quoted && char === '\\') { escaped = true; continue }
      if (char === '"') { quoted = !quoted; continue }
      if (quoted) continue
      if (char === '{' || char === '[') stack.push({ char, from: line.from + index + 1, line: lineNumber })
      else if (char === '}' || char === ']') {
        const open = stack.pop()
        if (open && ((open.char === '{' && char === '}') || (open.char === '[' && char === ']')) && open.line < lineNumber) {
          result.set(open.line, { from: open.from, to: line.from + index })
        }
      }
    }
  }
  foldCache.set(doc, result)
  return result
}
