/** 一次性恢复有证据的旧 Pi 用量；不以当前会话配置倒填历史归属。 */
import { open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, join } from 'node:path'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import type { TokenUsageRecord } from '@proma/shared'
import type { TokenUsageStore } from './token-usage-store'

/** 并发页面查询共用一次恢复任务，失败可再次尝试。 */
const imports = new WeakMap<TokenUsageStore, Promise<void>>()
/** 单条 transcript 的读取预算；超限后丢弃至换行，仍可恢复下一条。 */
const MAX_HISTORY_LINE_BYTES = 2 * 1024 * 1024
/** 只使用恢复所需的最小元数据。 */
interface HistoricalSession { id: string; title: string; rootSessionId?: string; piSessionFile?: string }
/** 旧 usage 是未知输入，必须逐字段验证。 */
function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
/** 有界读取索引，不通过会话管理器触发迁移或重写历史。 */
async function readIndex(path: string): Promise<HistoricalSession[]> {
  const file = await open(path, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('历史索引过大或不是普通文件')
    const buffer = Buffer.alloc(stat.size + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > stat.size) throw new Error('历史索引读取期间发生变化')
    const parsed = object(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')))
    if (!Array.isArray(parsed?.sessions)) throw new Error('历史索引格式无效')
    return parsed.sessions.flatMap(value => {
      const session = object(value)
      if (typeof session?.id !== 'string' || typeof session.title !== 'string') return []
      return [{ id: session.id, title: session.title, rootSessionId: typeof session.rootSessionId === 'string' ? session.rootSessionId : undefined, piSessionFile: typeof session.piSessionFile === 'string' ? session.piSessionFile : undefined }]
    })
  } finally { await file.close() }
}
/** 从原生 entry 提取一次可靠用量；旧复制分支用同一个 entry 身份去重。 */
function historicalCall(value: unknown, session: HistoricalSession, cutoff: number): TokenUsageRecord | null {
  const entry = object(value)
  const message = object(entry?.message)
  const usage = object(message?.usage)
  if (entry?.type !== 'message' || message?.role !== 'assistant' || typeof entry.id !== 'string' || !usage || usage.reported === false) return null
  const timestamp = typeof message.timestamp === 'number' ? message.timestamp : typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp >= cutoff) return null
  const count = (value: unknown): number | null => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
  const input = count(usage.input)
  const output = count(usage.output)
  const read = usage.cacheRead === undefined ? 0 : count(usage.cacheRead)
  const write = usage.cacheWrite === undefined ? 0 : count(usage.cacheWrite)
  if (input === null || output === null || read === null || write === null || !Number.isSafeInteger(input + read + write)) return null
  const failed = message.stopReason === 'error' || message.stopReason === 'aborted'
  if (failed && input + output + read + write === 0 && usage.reported !== true) return null
  /** Pi entry ID 仅有 32 位且只在单会话去重；时间和用量指纹隔离不同会话的碰撞，fork 原样复制仍去重。 */
  const identity = createHash('sha256').update(JSON.stringify([entry.id, timestamp, message.model, input, output, read, write])).digest('hex')
  return { id: `history:pi:${identity}`, taskId: `agent:${session.rootSessionId ?? session.id}`, taskTitle: session.title || '历史 Agent 任务', sessionId: session.id, sessionType: 'agent', projectId: null, projectName: '历史项目未知', channelId: null, channelName: '历史渠道未知', modelId: typeof message.model === 'string' && message.model ? message.model : '历史模型未知', source: 'agent', startedAt: timestamp, finishedAt: timestamp, status: message.stopReason === 'aborted' ? 'cancelled' : failed ? 'failed' : 'completed', origin: 'history', hiddenRetriesPossible: true, inputTokens: input + read + write, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write }
}

/** 有界逐字节分行，null 表示单行超预算；不会先拼完整巨型消息再检查。 */
export async function* boundedHistoryLines(path: string): AsyncGenerator<string | null> {
  const stream = createReadStream(path, { highWaterMark: 64 * 1024 })
  let chunks: Buffer[] = []
  let size = 0
  let oversized = false
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer
      let offset = 0
      while (offset < buffer.length) {
        const newline = buffer.indexOf(10, offset)
        const end = newline < 0 ? buffer.length : newline
        const segment = buffer.subarray(offset, end)
        if (!oversized) {
          size += segment.length
          if (size > MAX_HISTORY_LINE_BYTES) { oversized = true; chunks = [] }
          else if (segment.length) chunks.push(segment)
        }
        if (newline >= 0) {
          yield oversized ? null : Buffer.concat(chunks, size).toString('utf8')
          chunks = []; size = 0; oversized = false
        }
        offset = end + 1
      }
    }
    if (oversized || size) yield oversized ? null : Buffer.concat(chunks, size).toString('utf8')
  } finally { stream.destroy() }
}
/** 恢复只读索引引用且仍在数据根内的原生 artifact，逐行让出事件循环。 */
async function importHistory(root: string, store: TokenUsageStore): Promise<void> {
  const coverage = store.coverage()
  if (coverage.historyImportedAt !== null) return
  let sessions: HistoricalSession[]
  try { sessions = await readIndex(join(root, 'agent-sessions.json')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { store.markHistoryImported(0); return }
    throw new Error('历史用量索引无法读取，请修复后重试')
  }
  const canonicalRoot = await realpath(root)
  const visited = new Set<string>()
  let skipped = 0
  let processed = 0
  for (const session of sessions) {
    if (!session.piSessionFile) { skipped += 1; continue }
    let path: string
    try { path = await realpath(session.piSessionFile) } catch { skipped += 1; continue }
    const relation = relative(canonicalRoot, path)
    if (!relation || relation.startsWith('..') || isAbsolute(relation)) { skipped += 1; continue }
    if (visited.has(path)) continue
    visited.add(path)
    try {
      for await (const line of boundedHistoryLines(path)) {
        if (line === null) { skipped += 1; continue }
        if (!line.trim()) continue
        let parsed: unknown
        try { parsed = JSON.parse(line) } catch { skipped += 1; continue }
        const record = historicalCall(parsed, session, coverage.trackingStartedAt)
        if (record) store.record(record)
        processed += 1
        if (processed % 50 === 0) await new Promise<void>(resolve => setImmediate(resolve))
      }
    } catch (error) {
      /** 文件消失可跳过；存储写入失败必须暴露并允许下次幂等重试。 */
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') skipped += 1
      else throw error
    }
  }
  const historyCount = store.read().filter(record => record.origin === 'history').length
  store.markHistoryImported(historyCount, ['历史渠道与项目无法确认时标记未知，未按当前设置倒填；复制分支按原生调用身份去重。', ...(skipped ? [`历史恢复跳过 ${skipped} 个缺失、损坏或不具备安全读取条件的项目。`] : [])])
}
/** 对同一账本只执行一次，失败移除 single-flight 状态以支持页面重试。 */
export function importTokenUsageHistory(root: string, store: TokenUsageStore): Promise<void> {
  const existing = imports.get(store)
  if (existing) return existing
  const promise = importHistory(root, store).catch(error => { imports.delete(store); throw error })
  imports.set(store, promise)
  return promise
}
