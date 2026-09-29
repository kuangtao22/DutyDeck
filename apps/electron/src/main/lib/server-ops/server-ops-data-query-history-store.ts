import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  SERVER_OPS_DATA_QUERY_HISTORY_LIMIT,
  parseServerOpsDataQueryHistoryRecordInput,
  parseServerOpsDataQueryHistoryResult,
  parseServerOpsDataQueryHistoryScope,
  parseServerOpsDataWriteInput,
  parseServerOpsDataWriteResult,
} from '@proma/shared'
import type {
  ServerOpsDataQueryHistoryEntry,
  ServerOpsDataQueryHistoryRecordInput,
  ServerOpsDataQueryHistoryResult,
  ServerOpsDataQueryHistoryScope,
  ServerOpsDataWriteInput,
  ServerOpsDataWriteResult,
} from '@proma/shared'
import { getConfigDir } from '../config-paths'
import { readAtomicFileState, readJsonFileStrict, writeJsonFileAtomicSecure } from '../safe-file'
import type { AtomicDestinationExpectation, ReadJsonFileStrictOptions } from '../safe-file'
import {
  createServerOpsConfigTransaction,
  resolveServerOpsConfigFilePath,
} from './server-ops-config-transaction'
import type { ServerOpsConfigTransaction } from './server-ops-config-transaction'

/** 查询历史与其它运维配置共用的固定目录。 */
const SERVER_OPS_DIRECTORY = 'server-ops'
/** 查询历史固定文件名。 */
const SERVER_OPS_DATA_QUERY_HISTORY_FILENAME = 'query-history.json'
/** 查询历史持久化 schema 版本。 */
const SERVER_OPS_DATA_QUERY_HISTORY_VERSION = 1
/** 所有数据源与数据库合计最多保留的历史条数。 */
const SERVER_OPS_DATA_QUERY_HISTORY_GLOBAL_LIMIT = 1_000
/** pretty JSON 文件总预算，避免大量长 SQL 无界占用磁盘与解析内存。 */
const SERVER_OPS_DATA_QUERY_HISTORY_MAX_BYTES = 2 * 1024 * 1024

/** 查询历史文件根结构。 */
interface ServerOpsDataQueryHistoryFile {
  version: typeof SERVER_OPS_DATA_QUERY_HISTORY_VERSION
  entries: ServerOpsDataQueryHistoryEntry[]
}

/** 查询历史 Store 可替换的安全文件、时间与 ID 依赖。 */
export interface ServerOpsDataQueryHistoryStoreDependencies {
  /** 严格读取 JSON；存在但全部损坏时必须抛错。 */
  readJson: <T>(filePath: string, options: ReadJsonFileStrictOptions<T>) => T | null
  /** 使用 safe-file 安全原子写入完整历史快照。 */
  writeJson: (
    filePath: string,
    data: object,
    expectedDestination: AtomicDestinationExpectation,
    priorBackup?: object,
  ) => void
  /** 生成历史条目的稳定唯一 ID。 */
  uuid: () => string
  /** 生成历史创建时间。 */
  now: () => number
  /** 覆盖 fresh-read 与原子提交的同步短事务。 */
  transaction?: ServerOpsConfigTransaction
}

/** 创建生产环境使用的查询历史 Store 依赖。 */
function createDependencies(): ServerOpsDataQueryHistoryStoreDependencies {
  return {
    readJson: readJsonFileStrict,
    writeJson: (filePath, data, expectedDestination, priorBackup) => {
      writeJsonFileAtomicSecure(filePath, data, {
        expectedDestination,
        ...(priorBackup ? { priorBackup: { filePath: `${filePath}.bak`, data: priorBackup } } : {}),
      })
    },
    uuid: randomUUID,
    now: Date.now,
  }
}

/** 克隆单条历史，阻断调用方修改 Store 内部快照。 */
function cloneEntry(entry: ServerOpsDataQueryHistoryEntry): ServerOpsDataQueryHistoryEntry {
  return structuredClone(entry)
}

/** 生成不会改变 SQL 字符串语义的判重文本。 */
function normalizeSqlForDuplicate(sql: string): string {
  return sql.trim()
}

/** 生成 scope 比较键，仅用于内存计数与隔离。 */
function getScopeKey(scope: ServerOpsDataQueryHistoryScope): string {
  return `${scope.sourceId}\u0000${scope.database}`
}

/** 判断时间源是否返回可持久化时间戳。 */
function isValidTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000
}

/** 严格解析完整历史文件，包括全局、scope 与总字节预算。 */
function parseHistoryFile(value: unknown): ServerOpsDataQueryHistoryFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('SERVER_OPS_DATA_QUERY_HISTORY_FILE_INVALID')
  }
  const record = value as Record<string, unknown>
  if (record.version !== SERVER_OPS_DATA_QUERY_HISTORY_VERSION
    || !Array.isArray(record.entries)
    || Object.keys(record).length !== 2
    || !Object.hasOwn(record, 'version')
    || !Object.hasOwn(record, 'entries')
    || record.entries.length > SERVER_OPS_DATA_QUERY_HISTORY_GLOBAL_LIMIT
    || new TextEncoder().encode(JSON.stringify(value, null, 2)).byteLength > SERVER_OPS_DATA_QUERY_HISTORY_MAX_BYTES) {
    throw new Error('SERVER_OPS_DATA_QUERY_HISTORY_FILE_INVALID')
  }
  /** 借助公开结果 parser 逐项校验 entry exact-key 与字段边界。 */
  const entries = record.entries.map((entry) => parseServerOpsDataQueryHistoryResult({ entries: [entry] }).entries[0]!)
  const ids = new Set<string>()
  const counts = new Map<string, number>()
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error('SERVER_OPS_DATA_QUERY_HISTORY_FILE_INVALID')
    ids.add(entry.id)
    const key = getScopeKey(entry)
    const count = (counts.get(key) ?? 0) + 1
    if (count > SERVER_OPS_DATA_QUERY_HISTORY_LIMIT) throw new Error('SERVER_OPS_DATA_QUERY_HISTORY_FILE_INVALID')
    counts.set(key, count)
  }
  return { version: SERVER_OPS_DATA_QUERY_HISTORY_VERSION, entries: entries.map(cloneEntry) }
}

/** safe-file 候选 validator；完整内容不合法时允许继续尝试 tmp/bak。 */
function isHistoryFile(value: unknown): value is ServerOpsDataQueryHistoryFile {
  try {
    parseHistoryFile(value)
    return true
  } catch {
    return false
  }
}

/** 管理 `~/.proma/server-ops/query-history.json` 的本地 SQL 查询历史。 */
export class ServerOpsDataQueryHistoryStore {
  /** 查询历史最终文件路径。 */
  private readonly filePath: string
  /** 运行事实独立落盘，避免旧客户端把新版条目当作损坏并恢复旧 SQL 备份。 */
  private readonly writeFilePath: string
  /** 可替换的安全文件、时间与 ID 边界。 */
  private readonly dependencies: ServerOpsDataQueryHistoryStoreDependencies
  /** 覆盖同目录协作写入的同步短事务。 */
  private readonly transaction: ServerOpsConfigTransaction

  /** 创建查询历史 Store，不在构造期缓存文件内容。 */
  constructor(
    configDir = getConfigDir(),
    dependencies: Partial<ServerOpsDataQueryHistoryStoreDependencies> = {},
  ) {
    const directoryPath = join(configDir, SERVER_OPS_DIRECTORY)
    mkdirSync(directoryPath, { recursive: true })
    this.filePath = resolveServerOpsConfigFilePath(directoryPath, SERVER_OPS_DATA_QUERY_HISTORY_FILENAME)
    this.writeFilePath = resolveServerOpsConfigFilePath(directoryPath, 'write-history.json')
    this.dependencies = { ...createDependencies(), ...dependencies }
    this.transaction = dependencies.transaction ?? createServerOpsConfigTransaction(directoryPath)
  }

  /** 列出单个数据源数据库的完整有界历史，新记录在前。 */
  list(input: ServerOpsDataQueryHistoryScope): ServerOpsDataQueryHistoryResult {
    const scope = parseServerOpsDataQueryHistoryScope(input)
    const loaded = this.readFile()
    const writes = this.readFile(this.writeFilePath)
    return parseServerOpsDataQueryHistoryResult({
      entries: [...writes.file.entries.filter((entry) => entry.execution !== undefined), ...loaded.file.entries]
        .filter((entry) => entry.sourceId === scope.sourceId && entry.database === scope.database)
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, SERVER_OPS_DATA_QUERY_HISTORY_LIMIT)
        .map(cloneEntry),
    })
  }

  /** 保存非重复 SQL 并返回该 scope 的完整列表；重复命中不会写盘或更新时间。 */
  save(input: ServerOpsDataQueryHistoryRecordInput): ServerOpsDataQueryHistoryResult {
    const record = parseServerOpsDataQueryHistoryRecordInput(input)
    return this.transaction(() => {
      const loaded = this.readFile()
      const duplicateSql = normalizeSqlForDuplicate(record.sql)
      const duplicate = loaded.file.entries.some((entry) => entry.sourceId === record.sourceId
        && entry.database === record.database
        && normalizeSqlForDuplicate(entry.sql) === duplicateSql)
      if (duplicate) return this.list({ sourceId: record.sourceId, database: record.database })

      const id = this.dependencies.uuid()
      const createdAt = this.dependencies.now()
      if (!isValidTimestamp(createdAt)) throw new Error('SERVER_OPS_DATA_QUERY_HISTORY_TIMESTAMP_INVALID')
      /** 公开 parser 同时校验生成 ID 与完整 entry。 */
      const created = parseServerOpsDataQueryHistoryResult({ entries: [{ ...record, id, createdAt }] }).entries[0]!
      const nextEntries = this.applyLimits([created, ...loaded.file.entries])
      this.persist(
        nextEntries,
        loaded.expectedDestination,
        loaded.expectedDestination.kind === 'state' ? loaded.file : undefined,
      )
      return this.list({ sourceId: record.sourceId, database: record.database })
    })
  }

  /** 数据库调用前记录真实运行身份；重复身份拒绝执行，不以 SQL 文本去重。 */
  startWrite(input: ServerOpsDataWriteInput): void {
    const request = parseServerOpsDataWriteInput(input)
    this.transaction(() => {
      const loaded = this.readFile(this.writeFilePath)
      if (loaded.file.entries.some((entry) => entry.execution?.writeId === request.writeId)) throw new Error('SERVER_OPS_DATA_WRITE_ALREADY_RECORDED')
      const startedAt = this.dependencies.now()
      const created = parseServerOpsDataQueryHistoryResult({ entries: [{
        id: this.dependencies.uuid(), sourceId: request.sourceId, database: request.database, sql: request.sql,
        createdAt: startedAt, execution: { writeId: request.writeId, startedAt },
      }] }).entries[0]!
      this.persist(this.applyLimits([created, ...loaded.file.entries]), loaded.expectedDestination,
        loaded.expectedDestination.kind === 'state' ? loaded.file : undefined, this.writeFilePath)
    })
  }

  /** 补记同一次执行的真实终态；数据库已经执行，写盘失败由调用方附警告，不重放。 */
  finishWrite(input: ServerOpsDataWriteInput, value: ServerOpsDataWriteResult): void {
    const request = parseServerOpsDataWriteInput(input)
    const result = parseServerOpsDataWriteResult(value)
    if (result.writeId !== request.writeId || result.database !== request.database) throw new Error('SERVER_OPS_DATA_UNEXPECTED_RESULT')
    this.transaction(() => {
      const loaded = this.readFile(this.writeFilePath)
      const entry = loaded.file.entries.find((item) => item.sourceId === request.sourceId && item.database === request.database
        && item.execution?.writeId === request.writeId && item.sql === request.sql)
      if (!entry?.execution || entry.execution.result) throw new Error('SERVER_OPS_DATA_WRITE_HISTORY_RESULT_INVALID')
      /** 原子恢复备份保留修改前的快照，避免再次读取或保存变更后的对象。 */
      const priorBackup = structuredClone(loaded.file)
      const finishedAt = Math.max(entry.execution.startedAt, this.dependencies.now())
      entry.execution = { ...entry.execution, finishedAt, result }
      /** 终态元数据同样计入历史文件字节预算。 */
      this.persist(this.applyLimits(loaded.file.entries), loaded.expectedDestination,
        loaded.expectedDestination.kind === 'state' ? priorBackup : undefined, this.writeFilePath)
    })
  }

  /** 依次应用 scope、全局条数与 pretty JSON 字节预算。 */
  private applyLimits(entries: readonly ServerOpsDataQueryHistoryEntry[]): ServerOpsDataQueryHistoryEntry[] {
    const counts = new Map<string, number>()
    const limited: ServerOpsDataQueryHistoryEntry[] = []
    for (const entry of entries) {
      const key = getScopeKey(entry)
      const count = counts.get(key) ?? 0
      if (count >= SERVER_OPS_DATA_QUERY_HISTORY_LIMIT) continue
      limited.push(cloneEntry(entry))
      counts.set(key, count + 1)
      if (limited.length >= SERVER_OPS_DATA_QUERY_HISTORY_GLOBAL_LIMIT) break
    }
    if (this.getFileBytes(limited) <= SERVER_OPS_DATA_QUERY_HISTORY_MAX_BYTES) return limited
    if (limited.length === 0 || this.getFileBytes(limited.slice(0, 1)) > SERVER_OPS_DATA_QUERY_HISTORY_MAX_BYTES) {
      throw new Error('SERVER_OPS_DATA_QUERY_HISTORY_SIZE_LIMIT')
    }
    /** 字节数随新到旧前缀单调增长；二分最长可保留前缀，避免逐条 pop 后反复序列化。 */
    let lower = 1
    let upper = limited.length - 1
    let acceptedLength = 1
    while (lower <= upper) {
      const middle = Math.floor((lower + upper) / 2)
      if (this.getFileBytes(limited.slice(0, middle)) <= SERVER_OPS_DATA_QUERY_HISTORY_MAX_BYTES) {
        acceptedLength = middle
        lower = middle + 1
      } else {
        upper = middle - 1
      }
    }
    return limited.slice(0, acceptedLength)
  }

  /** 计算与真实安全写入一致的 pretty JSON 字节数。 */
  private getFileBytes(entries: readonly ServerOpsDataQueryHistoryEntry[]): number {
    const file: ServerOpsDataQueryHistoryFile = {
      version: SERVER_OPS_DATA_QUERY_HISTORY_VERSION,
      entries: entries.map(cloneEntry),
    }
    return new TextEncoder().encode(JSON.stringify(file, null, 2)).byteLength
  }

  /** fresh-read 当前文件；所有候选损坏时稳定失败，绝不降级为空。 */
  private readFile(filePath = this.filePath): {
    file: ServerOpsDataQueryHistoryFile
    expectedDestination: AtomicDestinationExpectation
  } {
    try {
      const loaded = this.dependencies.readJson(filePath, {
        validate: isHistoryFile,
        description: 'SQL 查询历史',
        maxBytes: SERVER_OPS_DATA_QUERY_HISTORY_MAX_BYTES,
        secureRecovery: true,
      })
      const expectedDestination = this.captureDestinationExpectation(filePath)
      return {
        file: loaded === null
          ? { version: SERVER_OPS_DATA_QUERY_HISTORY_VERSION, entries: [] }
          : parseHistoryFile(loaded),
        expectedDestination,
      }
    } catch (error) {
      throw new Error('SERVER_OPS_DATA_QUERY_HISTORY_READ_FAILED', { cause: error })
    }
  }

  /** 使用 safe-file 原子边界持久化完整历史快照。 */
  private persist(
    entries: readonly ServerOpsDataQueryHistoryEntry[],
    expectedDestination: AtomicDestinationExpectation,
    priorBackup?: ServerOpsDataQueryHistoryFile,
    filePath = this.filePath,
  ): void {
    const file: ServerOpsDataQueryHistoryFile = {
      version: SERVER_OPS_DATA_QUERY_HISTORY_VERSION,
      entries: entries.map(cloneEntry),
    }
    this.dependencies.writeJson(filePath, file, expectedDestination, priorBackup)
  }

  /** 捕获 fresh-read 对应的目标身份，阻断非协作旧实例迟到覆盖。 */
  private captureDestinationExpectation(filePath = this.filePath): AtomicDestinationExpectation {
    const state = readAtomicFileState(filePath)
    return state === null ? { kind: 'missing' } : { kind: 'state', state }
  }
}
