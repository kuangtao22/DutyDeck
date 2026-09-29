import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  SERVER_OPS_SCRIPT_GLOBAL_LIMIT,
  SERVER_OPS_SCRIPT_PROJECT_LIMIT,
  parseServerOpsScript,
} from '@proma/shared'
import type { ServerOpsScript, ServerOpsScriptSaveInput, ServerOpsScriptUsage } from '@proma/shared'
import { getConfigDir } from '../config-paths'
import { readAtomicFileState, readJsonFileSafe, writeJsonFileAtomicSecure } from '../safe-file'
import type { AtomicDestinationExpectation, ReadJsonFileSafeOptions } from '../safe-file'
import {
  createServerOpsConfigTransaction,
  resolveServerOpsConfigFilePath,
} from './server-ops-config-transaction'
import type { ServerOpsConfigTransaction } from './server-ops-config-transaction'

/** 脚本文件与其它运维配置共用的固定目录。 */
const SERVER_OPS_DIRECTORY = 'server-ops'
/** 脚本库固定文件名。 */
const SERVER_OPS_SCRIPTS_FILENAME = 'scripts.json'
/** 脚本库持久化 schema 版本。 */
const SERVER_OPS_SCRIPTS_VERSION = 1

/** 脚本 Store 可替换的安全文件、时间与 ID 依赖。 */
export interface ServerOpsScriptStoreDependencies {
  /** 允许从主文件、tmp 或 bak 恢复的宽松读取。 */
  readJson: <T>(filePath: string, options: ReadJsonFileSafeOptions<T>) => T | null
  /** 使用 safe-file 安全原子写入完整快照。 */
  writeJson: (filePath: string, data: object, expectedDestination: AtomicDestinationExpectation, priorBackup?: object) => void
  /** 生成脚本稳定唯一 ID。 */
  uuid: () => string
  /** 生成创建与更新时间。 */
  now: () => number
  /** 覆盖 fresh-read 与原子提交的同步短事务。 */
  transaction?: ServerOpsConfigTransaction
}

/** 创建生产环境使用的脚本 Store 依赖。 */
export function createServerOpsScriptStoreDependencies(): ServerOpsScriptStoreDependencies {
  return {
    readJson: readJsonFileSafe,
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

/** 脚本文件的版本化根结构。 */
interface ServerOpsScriptFile {
  version: typeof SERVER_OPS_SCRIPTS_VERSION
  scripts: ServerOpsScript[]
}

/** 判断未知值是否为普通可枚举对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 严格解析脚本文件根结构，拒绝未知字段与重复 ID。 */
function parseScriptFile(value: unknown): ServerOpsScriptFile {
  const errorCode = 'SERVER_OPS_SCRIPT_FILE_INVALID'
  if (!isRecord(value) || value.version !== SERVER_OPS_SCRIPTS_VERSION
    || !Array.isArray(value.scripts) || Object.keys(value).some((key) => key !== 'version' && key !== 'scripts')
    || value.scripts.length > SERVER_OPS_SCRIPT_GLOBAL_LIMIT) {
    throw new Error(errorCode)
  }
  /** 单条不合法的记录统一收敛为文件损坏，避免半可信数据进入业务。 */
  const scripts = value.scripts.map((entry) => {
    try {
      return parseServerOpsScript(entry)
    } catch {
      throw new Error(errorCode)
    }
  })
  /** 重复 ID 的文件不可信，避免按 ID 定位到错误脚本。 */
  const seen = new Set<string>()
  for (const script of scripts) {
    if (seen.has(script.id)) throw new Error(errorCode)
    seen.add(script.id)
  }
  return { version: SERVER_OPS_SCRIPTS_VERSION, scripts }
}

/** 仅在 safe-file 层做形状判定；完整校验交给 parseScriptFile。 */
function isScriptFileShape(value: unknown): value is ServerOpsScriptFile {
  return isRecord(value) && value.version === SERVER_OPS_SCRIPTS_VERSION && Array.isArray(value.scripts)
}

/**
 * 管理 `~/.proma/server-ops/scripts.json` 的运维脚本库。
 *
 * 脚本只承载可复用的执行意图与目标归属，不保存凭据、绝对路径或运行结果；
 * 运行记录由独立的 run store 维护。
 */
export class ServerOpsScriptStore {
  /** 脚本文件路径。 */
  private readonly filePath: string
  /** 可替换的安全文件、时间与 ID 边界。 */
  private readonly dependencies: ServerOpsScriptStoreDependencies
  /** 覆盖同目录协作写入的同步短事务。 */
  private readonly transaction: ServerOpsConfigTransaction

  /**
   * 创建脚本 Store。
   *
   * @param configDir Proma 业务配置根
   * @param dependencies 测试可替换依赖
   */
  constructor(configDir = getConfigDir(), dependencies: Partial<ServerOpsScriptStoreDependencies> = {}) {
    const directoryPath = join(configDir, SERVER_OPS_DIRECTORY)
    mkdirSync(directoryPath, { recursive: true })
    this.filePath = resolveServerOpsConfigFilePath(directoryPath, SERVER_OPS_SCRIPTS_FILENAME)
    this.dependencies = { ...createServerOpsScriptStoreDependencies(), ...dependencies }
    this.transaction = dependencies.transaction ?? createServerOpsConfigTransaction(directoryPath)
  }

  /**
   * 列出脚本；省略项目表示返回全部项目。
   *
   * @param projectId 目标项目 ID
   * @returns 按更新时间倒序的脚本副本
   */
  list(projectId?: string): ServerOpsScript[] {
    return this.readStoredScripts().scripts
      .filter((script) => projectId === undefined || script.projectId === projectId)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((script) => structuredClone(script))
  }

  /**
   * 读取单个脚本。
   *
   * @param scriptId 脚本 ID
   * @returns 脚本副本；不存在时返回 undefined
   */
  get(scriptId: string): ServerOpsScript | undefined {
    const found = this.readStoredScripts().scripts.find((script) => script.id === scriptId)
    return found ? structuredClone(found) : undefined
  }

  /**
   * 新建或更新脚本。
   *
   * 来源 `origin` 与 Agent 建议只在这里盖章：`origin` 由调用方按草稿消费结果传入，
   * 更新时保留首次落盘的来源，避免把 Agent 提议改写成用户自建。
   *
   * @param input 已通过共享合同解析的保存输入
   * @param origin 首次落盘时的来源
   * @param suggestion 仅新建时写入的 Agent 建议频度
   * @returns 落盘后的脚本副本
   */
  save(
    input: ServerOpsScriptSaveInput,
    origin: 'agent' | 'user',
    suggestion?: { usage: ServerOpsScriptUsage; reason?: string },
  ): ServerOpsScript {
    return this.transaction(() => {
      const loaded = this.readStoredScripts()
      const existing = input.scriptId === undefined ? undefined : loaded.scripts.find((script) => script.id === input.scriptId)
      if (input.scriptId !== undefined && !existing) throw new Error('SERVER_OPS_SCRIPT_NOT_FOUND')
      if (existing) {
        /** 乐观并发：界面看到的版本必须仍是当前版本。 */
        if (input.expectedUpdatedAt !== undefined && existing.updatedAt !== input.expectedUpdatedAt) {
          throw new Error('SERVER_OPS_SCRIPT_CONFLICT')
        }
        /** 归属只能由连接移动一类的显式操作改变，编辑不许跨项目迁移。 */
        if (existing.projectId !== input.projectId) throw new Error('SERVER_OPS_SCRIPT_PROJECT_MISMATCH')
      } else {
        const projectCount = loaded.scripts.filter((script) => script.projectId === input.projectId).length
        if (projectCount >= SERVER_OPS_SCRIPT_PROJECT_LIMIT) throw new Error('SERVER_OPS_SCRIPT_PROJECT_LIMIT_REACHED')
        if (loaded.scripts.length >= SERVER_OPS_SCRIPT_GLOBAL_LIMIT) throw new Error('SERVER_OPS_SCRIPT_GLOBAL_LIMIT_REACHED')
      }
      const now = this.dependencies.now()
      /** 待写入脚本；新建与更新共用同一字段重建逻辑。 */
      const script: ServerOpsScript = {
        id: existing?.id ?? this.dependencies.uuid(),
        projectId: input.projectId,
        name: input.name,
        kind: input.kind,
        usage: input.usage,
        risk: input.risk,
        body: input.body,
        parameters: structuredClone(input.parameters),
        origin: existing?.origin ?? origin,
        enabled: input.enabled,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.preconditions === undefined ? {} : { preconditions: input.preconditions }),
        ...(input.expectedImpact === undefined ? {} : { expectedImpact: input.expectedImpact }),
        ...(input.rollbackPlan === undefined ? {} : { rollbackPlan: input.rollbackPlan }),
        ...(input.hostId === undefined ? {} : { hostId: input.hostId }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
        ...(input.database === undefined ? {} : { database: input.database }),
      }
      /** 建议只在新建时随草稿一起落盘，更新不覆盖已有的历史建议。 */
      if (!existing && suggestion) {
        script.suggestedUsage = suggestion.usage
        if (suggestion.reason !== undefined) script.suggestedUsageReason = suggestion.reason
      } else if (existing?.suggestedUsage !== undefined) {
        script.suggestedUsage = existing.suggestedUsage
        if (existing.suggestedUsageReason !== undefined) script.suggestedUsageReason = existing.suggestedUsageReason
      }
      const next = existing
        ? loaded.scripts.map((entry) => (entry.id === script.id ? script : entry))
        : [...loaded.scripts, script]
      this.persist(next, loaded.expectedDestination, loaded.priorBackup)
      return structuredClone(parseServerOpsScript(script))
    })
  }

  /**
   * 删除脚本；运行记录不随之删除，保留历史事实。
   *
   * @param scriptId 脚本 ID
   * @returns 是否实际删除
   */
  remove(scriptId: string): boolean {
    return this.transaction(() => {
      const loaded = this.readStoredScripts()
      const remaining = loaded.scripts.filter((script) => script.id !== scriptId)
      if (remaining.length === loaded.scripts.length) return false
      this.persist(remaining, loaded.expectedDestination, loaded.priorBackup)
      return true
    })
  }

  /**
   * 判断项目下是否仍有脚本，供项目删除前检查。
   *
   * @param projectId 目标项目 ID
   * @returns 是否仍有归属该项目的脚本
   */
  hasProjectReferences(projectId: string): boolean {
    return this.readStoredScripts().scripts.some((script) => script.projectId === projectId)
  }

  /** fresh-read 当前脚本文件；坏文件不得降级为空后被覆盖。 */
  private readStoredScripts(): {
    scripts: ServerOpsScript[]
    expectedDestination: AtomicDestinationExpectation
    priorBackup?: object
  } {
    const existed = existsSync(this.filePath)
    const loaded = this.dependencies.readJson(this.filePath, { validate: isScriptFileShape })
    const expectedDestination = this.captureDestinationExpectation()
    if (loaded === null) {
      if (existed) throw new Error('SERVER_OPS_SCRIPT_READ_FAILED')
      return { scripts: [], expectedDestination }
    }
    const parsed = parseScriptFile(loaded)
    return {
      scripts: parsed.scripts.map((script) => structuredClone(script)),
      expectedDestination,
      priorBackup: { version: SERVER_OPS_SCRIPTS_VERSION, scripts: parsed.scripts.map((script) => structuredClone(script)) },
    }
  }

  /** 原子提交完整脚本快照。 */
  private persist(scripts: readonly ServerOpsScript[], expectedDestination: AtomicDestinationExpectation, priorBackup?: object): void {
    this.dependencies.writeJson(
      this.filePath,
      { version: SERVER_OPS_SCRIPTS_VERSION, scripts: scripts.map((script) => structuredClone(script)) } satisfies ServerOpsScriptFile,
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
