import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseServerOpsScriptRun } from '@proma/shared'
import type { ServerOpsScriptRun, ServerOpsScriptRunListInput } from '@proma/shared'
import { getConfigDir } from '../config-paths'
import { readAtomicFileState, readJsonFileSafe, writeJsonFileAtomicSecure } from '../safe-file'
import type { AtomicDestinationExpectation, ReadJsonFileSafeOptions } from '../safe-file'
import {
  createServerOpsConfigTransaction,
  resolveServerOpsConfigFilePath,
} from './server-ops-config-transaction'
import type { ServerOpsConfigTransaction } from './server-ops-config-transaction'

/** 运行记录与其它运维配置共用的固定目录。 */
const SERVER_OPS_DIRECTORY = 'server-ops'
/** 运行记录固定文件名。 */
const SERVER_OPS_SCRIPT_RUNS_FILENAME = 'script-runs.json'
/** 运行记录持久化 schema 版本。 */
const SERVER_OPS_SCRIPT_RUNS_VERSION = 1
/** 单个脚本保留的运行记录条数上限。 */
const SERVER_OPS_SCRIPT_RUN_PER_SCRIPT_LIMIT = 100
/** 全局保留的运行记录条数上限。 */
const SERVER_OPS_SCRIPT_RUN_GLOBAL_LIMIT = 2_000
/** pretty JSON 文件总预算，避免大量运行摘要无界占用磁盘与解析内存。 */
const SERVER_OPS_SCRIPT_RUN_MAX_BYTES = 2 * 1024 * 1024
/** 运行记录列表默认返回条数。 */
const SERVER_OPS_SCRIPT_RUN_DEFAULT_LIMIT = 50

/** 运行记录 Store 可替换的安全文件依赖。 */
export interface ServerOpsScriptRunStoreDependencies {
  /** 允许从主文件、tmp 或 bak 恢复的宽松读取。 */
  readJson: <T>(filePath: string, options: ReadJsonFileSafeOptions<T>) => T | null
  /** 使用 safe-file 安全原子写入完整快照。 */
  writeJson: (filePath: string, data: object, expectedDestination: AtomicDestinationExpectation, priorBackup?: object) => void
  /** 对账中断记录时使用的时钟。 */
  now: () => number
  /** 覆盖 fresh-read 与原子提交的同步短事务。 */
  transaction?: ServerOpsConfigTransaction
}

/** 创建生产环境使用的运行记录 Store 依赖。 */
export function createServerOpsScriptRunStoreDependencies(): ServerOpsScriptRunStoreDependencies {
  return {
    readJson: readJsonFileSafe,
    writeJson: (filePath, data, expectedDestination, priorBackup) => {
      writeJsonFileAtomicSecure(filePath, data, {
        expectedDestination,
        ...(priorBackup ? { priorBackup: { filePath: `${filePath}.bak`, data: priorBackup } } : {}),
      })
    },
    now: Date.now,
  }
}

/** 运行记录文件的版本化根结构。 */
interface ServerOpsScriptRunFile {
  version: typeof SERVER_OPS_SCRIPT_RUNS_VERSION
  runs: ServerOpsScriptRun[]
}

/** 判断未知值是否为普通可枚举对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 严格解析运行记录文件根结构，拒绝未知字段与重复 ID。 */
function parseRunFile(value: unknown): ServerOpsScriptRunFile {
  const errorCode = 'SERVER_OPS_SCRIPT_RUN_FILE_INVALID'
  if (!isRecord(value) || value.version !== SERVER_OPS_SCRIPT_RUNS_VERSION
    || !Array.isArray(value.runs) || Object.keys(value).some((key) => key !== 'version' && key !== 'runs')
    || value.runs.length > SERVER_OPS_SCRIPT_RUN_GLOBAL_LIMIT) {
    throw new Error(errorCode)
  }
  /** 单条不合法的记录统一收敛为文件损坏，避免把半可信运行事实展示给用户。 */
  const runs = value.runs.map((entry) => {
    try {
      return parseServerOpsScriptRun(entry)
    } catch {
      throw new Error(errorCode)
    }
  })
  const seen = new Set<string>()
  for (const run of runs) {
    if (seen.has(run.id)) throw new Error(errorCode)
    seen.add(run.id)
  }
  return { version: SERVER_OPS_SCRIPT_RUNS_VERSION, runs }
}

/** 仅在 safe-file 层做形状判定；完整校验交给 parseRunFile。 */
function isRunFileShape(value: unknown): value is ServerOpsScriptRunFile {
  return isRecord(value) && value.version === SERVER_OPS_SCRIPT_RUNS_VERSION && Array.isArray(value.runs)
}

/**
 * 管理 `~/.proma/server-ops/script-runs.json` 的脚本运行记录。
 *
 * 记录只保存有界摘要（状态、时间、参数、受影响行数、输出片段），
 * 不保存结果集正文，也不因脚本删除而回滚历史事实。
 */
export class ServerOpsScriptRunStore {
  /** 运行记录文件路径。 */
  private readonly filePath: string
  /** 可替换的安全文件边界。 */
  private readonly dependencies: ServerOpsScriptRunStoreDependencies
  /** 覆盖同目录协作写入的同步短事务。 */
  private readonly transaction: ServerOpsConfigTransaction

  /**
   * 创建运行记录 Store。
   *
   * @param configDir Proma 业务配置根
   * @param dependencies 测试可替换依赖
   */
  constructor(configDir = getConfigDir(), dependencies: Partial<ServerOpsScriptRunStoreDependencies> = {}) {
    const directoryPath = join(configDir, SERVER_OPS_DIRECTORY)
    mkdirSync(directoryPath, { recursive: true })
    this.filePath = resolveServerOpsConfigFilePath(directoryPath, SERVER_OPS_SCRIPT_RUNS_FILENAME)
    this.dependencies = { ...createServerOpsScriptRunStoreDependencies(), ...dependencies }
    this.transaction = dependencies.transaction ?? createServerOpsConfigTransaction(directoryPath)
  }

  /**
   * 追加一条运行中记录；同一 runId 重复追加时拒绝，避免重复计费或重复展示。
   *
   * @param run 已通过共享合同解析的运行记录
   * @returns 落盘后的运行记录副本
   */
  append(run: ServerOpsScriptRun): ServerOpsScriptRun {
    return this.transaction(() => {
      const loaded = this.readStoredRuns()
      if (loaded.runs.some((entry) => entry.id === run.id)) throw new Error('SERVER_OPS_SCRIPT_RUN_EXISTS')
      const parsed = parseServerOpsScriptRun(run)
      this.persist(this.prune([...loaded.runs, parsed]), loaded.expectedDestination, loaded.priorBackup)
      return structuredClone(parsed)
    })
  }

  /**
   * 补写运行终态。
   *
   * @param runId 运行 ID
   * @param patch 终态字段；只允许覆盖合同里的终态字段
   * @returns 更新后的运行记录；目标不存在时返回 undefined
   */
  finish(runId: string, patch: Partial<Omit<ServerOpsScriptRun, 'id' | 'scriptId' | 'projectId' | 'startedAt' | 'parameters'>>): ServerOpsScriptRun | undefined {
    return this.transaction(() => {
      const loaded = this.readStoredRuns()
      const index = loaded.runs.findIndex((entry) => entry.id === runId)
      if (index < 0) return undefined
      const existing = loaded.runs[index]!
      /** 终态只允许补写一次；重复补写视为调用方错误而不是静默覆盖。 */
      if (existing.status !== 'running') throw new Error('SERVER_OPS_SCRIPT_RUN_ALREADY_FINISHED')
      const updated = parseServerOpsScriptRun({ ...existing, ...structuredClone(patch) })
      const next = loaded.runs.map((entry, at) => (at === index ? updated : entry))
      this.persist(this.prune(next), loaded.expectedDestination, loaded.priorBackup)
      return structuredClone(updated)
    })
  }

  /**
   * 列出运行记录，按开始时间倒序。
   *
   * @param query 按脚本、项目或条数筛选
   * @returns 有界运行记录副本
   */
  list(query: ServerOpsScriptRunListInput = {}): ServerOpsScriptRun[] {
    const limit = query.limit ?? SERVER_OPS_SCRIPT_RUN_DEFAULT_LIMIT
    return this.readStoredRuns().runs
      .filter((run) => query.scriptId === undefined || run.scriptId === query.scriptId)
      .filter((run) => query.projectId === undefined || run.projectId === query.projectId)
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, limit)
      .map((run) => structuredClone(run))
  }

  /**
   * 对账上一次进程遗留的「运行中」记录。
   *
   * 进程若在写入开始与补写终态之间退出，记录会永久停在 `running`：界面一直显示「运行中」，
   * 而淘汰逻辑又明确不回收运行中记录，于是文件只增不减。启动时调用一次即可，
   * 此刻不可能存在任何在途运行，残留的 `running` 必然是中断的。
   *
   * 语义上改写为 `unknown`（已提交但回执丢失），既不谎称成功也不谎称失败，也不删除记录。
   * 刻意不补写 `finishedAt`：真实结束时间不可知，编造一个时间会让运行记录里的时间失去可信度。
   *
   * @returns 被改写的记录条数
   */
  reconcileInterruptedRuns(): number {
    return this.transaction(() => {
      const loaded = this.readStoredRuns()
      const interruptedCount = loaded.runs.filter((run) => run.status === 'running').length
      if (interruptedCount === 0) return 0
      /** 只改写状态与稳定错误码；开始时间与参数保持原样。 */
      const reconciled = loaded.runs.map((run) => run.status === 'running'
        ? parseServerOpsScriptRun({
          ...structuredClone(run),
          status: 'unknown',
          errorCode: 'SERVER_OPS_SCRIPT_RUN_INTERRUPTED',
        })
        : run)
      this.persist(this.prune(reconciled), loaded.expectedDestination, loaded.priorBackup)
      return interruptedCount
    })
  }

  /**
   * 清理非运行中的陈旧记录；运行中记录永不淘汰，避免用户看到「跑了但没记录」。
   *
   * @param runs 待清理的完整记录
   * @returns 保留后的记录
   */
  private prune(runs: readonly ServerOpsScriptRun[]): ServerOpsScriptRun[] {
    /** 运行中记录先全部保留，只有终态记录参与容量与字节预算淘汰。 */
    const running = runs.filter((run) => run.status === 'running')
    const finished = runs.filter((run) => run.status !== 'running').sort((left, right) => right.startedAt - left.startedAt)
    /** 每脚本限额：按脚本分别统计终态记录，超出部分淘汰最旧的。 */
    const perScriptCounts = new Map<string, number>()
    const keptFinished: ServerOpsScriptRun[] = []
    for (const run of finished) {
      const count = perScriptCounts.get(run.scriptId) ?? 0
      if (count >= SERVER_OPS_SCRIPT_RUN_PER_SCRIPT_LIMIT) continue
      perScriptCounts.set(run.scriptId, count + 1)
      keptFinished.push(run)
    }
    /** 全局限额与文件字节预算一起收口，避免单文件无界增长。 */
    let kept = [...running, ...keptFinished.slice(0, Math.max(0, SERVER_OPS_SCRIPT_RUN_GLOBAL_LIMIT - running.length))]
    while (kept.length > running.length && this.bytesOf(kept) > SERVER_OPS_SCRIPT_RUN_MAX_BYTES) {
      /** 每次都淘汰最旧的一条终态记录，直到落回预算内。 */
      const oldest = kept
        .filter((run) => run.status !== 'running')
        .reduce((left, right) => (left.startedAt <= right.startedAt ? left : right))
      kept = kept.filter((run) => run !== oldest)
    }
    return kept
  }

  /** 统计 pretty JSON 字节数，与落盘格式保持一致。 */
  private bytesOf(runs: readonly ServerOpsScriptRun[]): number {
    return Buffer.byteLength(JSON.stringify({ version: SERVER_OPS_SCRIPT_RUNS_VERSION, runs }, null, 2), 'utf8')
  }

  /** fresh-read 当前运行记录文件；坏文件不得降级为空后被覆盖。 */
  private readStoredRuns(): {
    runs: ServerOpsScriptRun[]
    expectedDestination: AtomicDestinationExpectation
    priorBackup?: object
  } {
    const loaded = this.dependencies.readJson(this.filePath, { validate: isRunFileShape })
    const expectedDestination = this.captureDestinationExpectation()
    if (loaded === null) {
      if (existsSync(this.filePath)) throw new Error('SERVER_OPS_SCRIPT_RUN_READ_FAILED')
      return { runs: [], expectedDestination }
    }
    const parsed = parseRunFile(loaded)
    return {
      runs: parsed.runs.map((run) => structuredClone(run)),
      expectedDestination,
      priorBackup: { version: SERVER_OPS_SCRIPT_RUNS_VERSION, runs: parsed.runs.map((run) => structuredClone(run)) },
    }
  }

  /** 原子提交完整运行记录快照。 */
  private persist(runs: readonly ServerOpsScriptRun[], expectedDestination: AtomicDestinationExpectation, priorBackup?: object): void {
    this.dependencies.writeJson(
      this.filePath,
      { version: SERVER_OPS_SCRIPT_RUNS_VERSION, runs: runs.map((run) => structuredClone(run)) } satisfies ServerOpsScriptRunFile,
      expectedDestination,
      priorBackup,
    )
  }

  /** 捕获 fresh-read 对应的目标身份。 */
  private captureDestinationExpectation(): AtomicDestinationExpectation {
    const state = readAtomicFileState(this.filePath)
    return state === null ? { kind: 'missing' } : { kind: 'state', state }
  }
}
