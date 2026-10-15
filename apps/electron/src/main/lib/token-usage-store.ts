/** 独立 Token 账本：UTC 日目录 + 16 个哈希分片，单次结束时原子写入。 */
import { createHash } from 'node:crypto'
import { readdirSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { TOKEN_USAGE_SOURCE_LABELS } from '@proma/shared'
import type { TokenUsageRecord, TokenUsageQuery, TokenUsageCoverage } from '@proma/shared'
import { readJsonFileStrict, writeJsonFileAtomic } from './safe-file'
import { isUsageDate } from './token-usage-query'

/** 分片版本独立于应用版本。 */
interface UsagePartition { version: 1; records: TokenUsageRecord[] }
/** 持久覆盖信息，重启后不重置统计起点。 */
interface UsageMetadata extends TokenUsageCoverage { version: 1 }
/** 任务仅指向实际涉及的日分片，详情无需遍历整个生命周期账本。 */
interface UsageTaskIndex { version: 1; taskId: string; partitions: string[] }
/** 所有供应商数值必须为有限非负安全整数或显式未知。 */
function tokenCount(value: unknown): boolean { return value === null || (Number.isSafeInteger(value) && Number(value) >= 0) }
/** 验证白名单快照，避免异常报告和损坏数据产生假总量。 */
export function isTokenUsageRecord(value: unknown): value is TokenUsageRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  for (const key of ['id', 'taskId', 'taskTitle', 'projectName', 'channelName', 'modelId']) if (typeof record[key] !== 'string' || !(record[key] as string).length || (record[key] as string).length > 2000) return false
  for (const key of ['projectId', 'channelId']) if (record[key] !== null && (typeof record[key] !== 'string' || (record[key] as string).length > 500)) return false
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) if (!tokenCount(record[key])) return false
  for (const key of ['startedAt', 'finishedAt']) if (!Number.isSafeInteger(record[key]) || Number(record[key]) < 0 || Number(record[key]) > 8.64e15) return false
  if (Number(record.finishedAt) < Number(record.startedAt)) return false
  if (typeof record.source !== 'string' || !Object.hasOwn(TOKEN_USAGE_SOURCE_LABELS, record.source)) return false
  if (!['completed', 'failed', 'cancelled'].includes(String(record.status)) || !['live', 'history'].includes(String(record.origin))) return false
  if (record.sessionType !== undefined && record.sessionType !== 'agent' && record.sessionType !== 'chat') return false
  return record.sessionId === undefined || (typeof record.sessionId === 'string' && record.sessionId.length <= 500)
}
/** 覆盖元数据须完整可解释，损坏时不能静默变成首次启用。 */
function isMetadata(value: unknown): value is UsageMetadata {
  const metadata = value as UsageMetadata | null
  return !!metadata && metadata.version === 1 && Number.isSafeInteger(metadata.trackingStartedAt) && (metadata.historyImportedAt === null || Number.isSafeInteger(metadata.historyImportedAt)) && Number.isSafeInteger(metadata.historyRecords) && Array.isArray(metadata.notes) && metadata.notes.every(note => typeof note === 'string')
}
/** 可注入目录与时钟，生产由 locator 解析，测试只用临时目录。 */
export class TokenUsageStore {
  /** 一次会话使用固定业务根，避免热切换写到其他项目。 */
  constructor(readonly directory: string, private readonly now: () => number = Date.now) {}

  /** 元信息首次访问时创建；不主动扫描旧会话。 */
  coverage(): TokenUsageCoverage {
    mkdirSync(this.directory, { recursive: true })
    const path = join(this.directory, 'coverage.json')
    const saved = readJsonFileStrict<UsageMetadata>(path, { description: 'Token 统计覆盖信息', validate: isMetadata, maxBytes: 256 * 1024 })
    if (saved) return saved
    const metadata: UsageMetadata = { version: 1, trackingStartedAt: this.now(), historyImportedAt: null, historyRecords: 0, notes: ['仅汇总供应商报告的用量；未知用量不补零。', '调用次数统计可观察请求；供应商内部重试及异常退出前未完成的请求可能无法记录。', '历史仅恢复具有真实时间与用量的 Pi 调用；旧 Chat、标题和工厂记录未完整覆盖。', '自动压缩未暴露独立用量，暂未计入；媒体生成、向量化与外部独立调用不在本页统计范围内。'] }
    writeJsonFileAtomic(path, metadata, true)
    return metadata
  }

  /** 完成历史恢复后保存数量与边界；幂等重试由调用 ID 去重。 */
  markHistoryImported(count: number, notes: string[] = []): void {
    writeJsonFileAtomic(join(this.directory, 'coverage.json'), { ...this.coverage(), version: 1, historyImportedAt: this.now(), historyRecords: count, notes: [...this.coverage().notes, ...notes] } satisfies UsageMetadata)
  }

  /** 读取一个有限分片；损坏时抛出可见错误，禁止当成空数组覆盖。 */
  private partition(path: string): UsagePartition {
    return readJsonFileStrict<UsagePartition>(path, { description: 'Token 调用记录', maxBytes: 32 * 1024 * 1024, validate: (value): value is UsagePartition => { const partition = value as UsagePartition | null; return !!partition && partition.version === 1 && Array.isArray(partition.records) && partition.records.every(isTokenUsageRecord) } }) ?? { version: 1, records: [] }
  }

  /** 任务索引路径仅来自哈希，不将 renderer 身份当作文件路径。 */
  private taskIndexPath(taskId: string): string {
    return join(this.directory, 'tasks', `${createHash('sha256').update(taskId).digest('hex')}.json`)
  }

  /** 严格验证相对分片引用，索引不能越出账本目录。 */
  private taskIndex(taskId: string): UsageTaskIndex {
    return readJsonFileStrict<UsageTaskIndex>(this.taskIndexPath(taskId), { description: 'Token 任务索引', maxBytes: 2 * 1024 * 1024, validate: (value): value is UsageTaskIndex => {
      const index = value as UsageTaskIndex | null
      return !!index && index.version === 1 && index.taskId === taskId && Array.isArray(index.partitions) && index.partitions.every(path => typeof path === 'string' && /^\d{4}-\d{2}-\d{2}\/[a-f0-9]\.json$/.test(path))
    } }) ?? { version: 1, taskId, partitions: [] }
  }

  /** 先写引用再写分片：异常退出最多留下空引用，不会留下不可定位的已入账调用。 */
  private indexRecord(taskId: string, partition: string): void {
    const index = this.taskIndex(taskId)
    if (index.partitions.includes(partition)) return
    index.partitions.push(partition)
    mkdirSync(join(this.directory, 'tasks'), { recursive: true })
    writeJsonFileAtomic(this.taskIndexPath(taskId), index, true)
  }

  /** 详情只读取任务实际涉及的分片；无关旧分片损坏不拖累当前任务。 */
  readTask(taskId: string): TokenUsageRecord[] {
    return this.taskIndex(taskId).partitions.flatMap(path => this.partition(join(this.directory, path)).records.filter(record => record.taskId === taskId))
  }

  /** 一次调用只写一次，返回是否新增；仅提取合同字段，不保存任意调用载荷。 */
  record(record: TokenUsageRecord): boolean {
    if (!isTokenUsageRecord(record)) throw new Error('Token 调用记录无效')
    this.coverage()
    const day = new Date(record.startedAt).toISOString().slice(0, 10)
    const shard = createHash('sha256').update(record.id).digest('hex').slice(0, 1)
    const path = join(this.directory, day, `${shard}.json`)
    const partition = this.partition(path)
    this.indexRecord(record.taskId, `${day}/${shard}.json`)
    if (partition.records.some(existing => existing.id === record.id)) return false
    const { id, taskId, taskTitle, sessionId, sessionType, projectId, projectName, channelId, channelName, modelId, source, startedAt, finishedAt, status, hiddenRetriesPossible, origin, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = record
    partition.records.push({ id, taskId, taskTitle, sessionId, sessionType, projectId, projectName, channelId, channelName, modelId, source, startedAt, finishedAt, status, hiddenRetriesPossible, origin, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens })
    mkdirSync(join(this.directory, day), { recursive: true })
    writeJsonFileAtomic(path, partition, true)
    return true
  }

  /** 日期只缩小磁盘扫描范围，精确本地日过滤由查询层完成；详情可省略范围。 */
  read(query?: Pick<TokenUsageQuery, 'from' | 'to'>): TokenUsageRecord[] {
    if (!existsSync(this.directory)) return []
    const earliest = query ? new Date(Date.parse(query.from) - 86400000).toISOString().slice(0, 10) : ''
    const latest = query ? new Date(Date.parse(query.to) + 86400000).toISOString().slice(0, 10) : '9999-12-31'
    const records: TokenUsageRecord[] = []
    for (const day of readdirSync(this.directory, { withFileTypes: true })) {
      if (!day.isDirectory() || !isUsageDate(day.name) || day.name < earliest || day.name > latest) continue
      const shards = new Set(readdirSync(join(this.directory, day.name)).filter(name => /^[a-f0-9]\.json(?:\.tmp|\.bak)?$/.test(name)).map(name => name.slice(0, 6)))
      for (const shard of shards) records.push(...this.partition(join(this.directory, day.name, shard)).records)
    }
    return records
  }
}
