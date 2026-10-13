import { createHash } from 'node:crypto'
import { CANVAS_TEXT_ARTIFACT_CONTENT_MAX_BYTES } from '@proma/shared'

/** 只累计有界的本轮分页摘要，不缓存正文或进行后台扫描。 */
const MAX_TRACKED_TEXTS = 32
/** 正式正文最多 256 KiB；留出重叠分页空间，重复页不重复占用。 */
const MAX_TRACKED_PAGES = 128

/** 已通过工具权限与响应预算检查的单页正文。 */
export interface CanvasTextReadPage {
  canvasId: string
  nodeId: string
  version: { kind: 'document' | 'webview'; revision: number }
  content: string
  contentHash: string
  offset: number
  nextOffset: number | null
  totalLength: number
}

/** 已送达区段只保存位置和摘要，最终与权威正文逐段复验。 */
interface DeliveredTextRange {
  start: number
  end: number
  hash: string
}

/** 解析 Host 分页结果；无正文的旧处理器与异常结果不参与证据累计。 */
export function parseCanvasTextReadPage(value: unknown): CanvasTextReadPage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  /** 分页字段仍需逐项验证，不能通过类型断言信任完整性。 */
  const page = value as Record<string, unknown>
  if (!page.version || typeof page.version !== 'object' || Array.isArray(page.version)) return undefined
  /** 精确版本与正文摘要共同约束覆盖范围。 */
  const version = page.version as Record<string, unknown>
  if (typeof page.canvasId !== 'string' || typeof page.nodeId !== 'string'
    || !['document', 'webview'].includes(String(version.kind)) || !Number.isSafeInteger(version.revision)
    || (version.revision as number) < 0 || typeof page.content !== 'string'
    || typeof page.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(page.contentHash)
    || !Number.isSafeInteger(page.offset) || (page.offset as number) < 0
    || !Number.isSafeInteger(page.totalLength) || (page.totalLength as number) <= 0
    || (page.totalLength as number) > CANVAS_TEXT_ARTIFACT_CONTENT_MAX_BYTES
    || page.content.length === 0 || page.content.length > 8192) return undefined
  /** 真实送达范围必须位于正文内，nextOffset 不可伪装跳过未读部分。 */
  const end = (page.offset as number) + page.content.length
  if (end > (page.totalLength as number)
    || page.nextOffset !== (end === page.totalLength ? null : end)) return undefined
  return page as unknown as CanvasTextReadPage
}

/** 对实际送达文本取摘要，用于比对权威正文而非替代内容读取。 */
function contentDigest(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/** 为一次 Agent 运行累计分页；scope 将不同交付任务的读取隔离。 */
export function createCanvasTextReadCoverage() {
  /** 每个键包含画布、节点、版本、摘要、长度与当前交付任务身份。 */
  const texts = new Map<string, DeliveredTextRange[]>()
  return {
    /** 先准备候选覆盖；调用方确认响应可返回并完成作用域复验后才 commit。 */
    prepare(page: CanvasTextReadPage, scope: string | undefined) {
      /** 版本或任务变化必须从独立覆盖开始，不能拼接成完整读取。 */
      const key = JSON.stringify([scope, page.canvasId, page.nodeId, page.version.kind, page.version.revision, page.contentHash, page.totalLength])
      /** 替换相同位置的重复页，读取次数不参与完整性判断。 */
      const ranges = (texts.get(key) ?? []).filter(range => range.start !== page.offset)
      if (ranges.length >= MAX_TRACKED_PAGES) ranges.length = 0
      ranges.push({ start: page.offset, end: page.offset + page.content.length, hash: contentDigest(page.content) })
      ranges.sort((left, right) => left.start - right.start)
      /** 从零开始寻找第一个缺口，支持乱序、重叠与重复分页。 */
      let nextOffset = 0
      for (const range of ranges) {
        if (range.start > nextOffset) break
        nextOffset = Math.max(nextOffset, range.end)
      }
      /** 完整只表示正文送达覆盖，不代表交互或内容质量通过。 */
      const complete = nextOffset === page.totalLength
      return {
        readCoverage: { complete, nextOffset: complete ? null : nextOffset },
        /** 完整正文读取一次，复验整体身份以及模型实际收到的每个区段。 */
        matches(content: string): boolean {
          return complete && content.length === page.totalLength && contentDigest(content) === page.contentHash
            && ranges.every(range => contentDigest(content.slice(range.start, range.end)) === range.hash)
        },
        /** 只保存已成功送达的区段摘要，并淘汰最久未使用的有界记录。 */
        commit(): void {
          texts.delete(key)
          texts.set(key, ranges)
          if (texts.size > MAX_TRACKED_TEXTS) texts.delete(texts.keys().next().value!)
        },
      }
    },
  }
}
