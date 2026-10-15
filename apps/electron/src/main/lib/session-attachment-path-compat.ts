import { posix, win32 } from 'node:path'
import { isDataRootReference } from './data-root-reference'
import type { AgentMessage, SDKMessage } from '@proma/shared'

/** 判断输入是否为可读取字段的普通消息记录，不接受数组或空值。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 按需投影数组元素；没有元素变化时返回输入数组，避免复制历史消息。 */
function projectArray(value: unknown, project: (entry: unknown) => unknown): unknown {
  if (!Array.isArray(value)) return value
  /** 仅在首次变化时创建新数组。 */
  let result: unknown[] | undefined
  for (let index = 0; index < value.length; index += 1) {
    /** 当前元素经过限定层级投影后的值。 */
    const next = project(value[index])
    if (next !== value[index]) {
      result ??= value.slice()
      result![index] = next
    }
  }
  return result ?? value
}

/** 单条非法引用只影响该附件；全局定位器或其他解析故障继续向调用方传播。 */
function projectAttachmentPath(path: string, resolvePath: (path: string) => string): string {
  try {
    return resolvePath(path)
  } catch (error) {
    // 编解码器的语法拒绝不应抹掉历史正文；真正读文件时仍须严格校验。
    if (isDataRootReference(path) && error instanceof Error && error.message === '无效的数据根引用') return path
    throw error
  }
}

/** 只映射附档协议行中的绝对路径或受管引用，保留标签、文件名、空白与普通正文。 */
function projectAttachedText(text: string, resolvePath: (path: string) => string): string {
  return text.replace(/<attached_files>([\s\S]*?)<\/attached_files>/g, (_block: string, body: string) =>
    '<attached_files>' + body.replace(/^(-[^\S\r\n]+.+?:[^\S\r\n]+)([^\r\n]+)$/gm, (line: string, prefix: string, path: string) => {
      /** 尾随空白不属于路径，与渲染器 trim 语义一致。 */
      const trimmed = path.trimEnd()
      if (!posix.isAbsolute(trimmed) && !win32.isAbsolute(trimmed) && !isDataRootReference(trimmed)) return line
      return prefix + projectAttachmentPath(trimmed, resolvePath) + path.slice(trimmed.length)
    }) + '</attached_files>',
  )
}

/** 投影一层已知附件数组，仅 localPath / targetPath 具备路径语义。 */
function projectAttachments(record: Record<string, unknown>, resolvePath: (path: string) => string): Record<string, unknown> {
  /** 无字段变化时复用原记录。 */
  let result = record
  for (const key of ['attachments', 'imageAttachments', 'mediaAttachments']) {
    /** 当前附件数组按需映射后的结果。 */
    const next = projectArray(record[key], (entry) => {
      if (!isRecord(entry)) return entry
      /** 附件对象同样只在路径变化时复制。 */
      let attachment = entry
      for (const pathKey of ['localPath', 'targetPath']) {
        /** 当前字段仅接受字符串路径。 */
        const path = entry[pathKey]
        if (typeof path !== 'string') continue
        /** resolver 负责实际迁移范围判断，本模块不授予任何访问权限。 */
        const resolved = projectAttachmentPath(path, resolvePath)
        if (resolved !== path) attachment = { ...attachment, [pathKey]: resolved }
      }
      return attachment
    })
    if (next !== record[key]) result = { ...result, [key]: next }
  }
  return result
}

/** 投影文本块；对工具输入、普通字符串和其他内容块保持原样。 */
function projectTextBlock(block: unknown, resolvePath: (path: string) => string): unknown {
  if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return block
  /** 仅附档协议区块可能产生新的文本。 */
  const text = projectAttachedText(block.text, resolvePath)
  return text === block.text ? block : { ...block, text }
}

/**
 * 为历史会话提供只读附件路径投影。
 * @param message 原始 SDK 或旧版 Agent 消息，永不修改或写回。
 * @param resolvePath 由调用方提供的受控路径解析器，未迁移路径应原样返回。
 * @returns 附件引用更新后的消息；无变化时返回原对象。
 */
export function projectSessionAttachmentPaths<T extends SDKMessage | AgentMessage>(message: T, resolvePath: (path: string) => string): T {
  // JSONL 可能含空值或原始值，交还调用方沿用既有容错策略。
  if (!isRecord(message)) return message
  /** 联合类型中的历史扩展字段只通过已知层级读取。 */
  const record = message as unknown as Record<string, unknown>
  /** 顶层附件先做结构共享投影。 */
  let result = projectAttachments(record, resolvePath)
  // 旧 AgentMessage 的正文和事件只处理明确的附件协议与字段。
  if ('role' in record && !('type' in record)) {
    if (typeof record.content === 'string') {
      /** 旧消息正文只转换附档协议行。 */
      const content = projectAttachedText(record.content, resolvePath)
      if (content !== record.content) result = { ...result, content }
    }
    /** 旧事件仅允许直接附件数组，不遍历 result/input 任意载荷。 */
    const events = projectArray(record.events, (event) => isRecord(event) ? projectAttachments(event, resolvePath) : event)
    if (events !== record.events) result = { ...result, events }
  }
  if (isRecord(record.message)) {
    /** message 层允许独立附件及已知内容块。 */
    let body = projectAttachments(record.message, resolvePath)
    /** 工具结果只投影附件数组和直接文本块，不递归任意工具载荷。 */
    const content = typeof body.content === 'string' ? projectAttachedText(body.content, resolvePath) : projectArray(body.content, (block) => {
      if (!isRecord(block) || block.type !== 'tool_result') return projectTextBlock(block, resolvePath)
      /** 工具结果的直接附件引用。 */
      const tool = projectAttachments(block, resolvePath)
      /** 工具结果文本只处理带 type=text 的标准内容块。 */
      const toolContent = projectArray(tool.content, (entry) => projectTextBlock(entry, resolvePath))
      return toolContent === tool.content ? tool : { ...tool, content: toolContent }
    })
    if (content !== body.content) body = { ...body, content }
    if (body !== record.message) result = { ...result, message: body }
  }
  return result as unknown as T
}
