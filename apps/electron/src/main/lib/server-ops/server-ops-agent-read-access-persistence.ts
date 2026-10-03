import { closeSync, constants as fsConstants, existsSync, mkdirSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir } from '../config-paths'
import { readAtomicFileState, writeJsonFileAtomicSecure } from '../safe-file'
import type { AtomicDestinationExpectation, AtomicFileState } from '../safe-file'
import { createServerOpsConfigTransaction, resolveServerOpsConfigFilePath } from './server-ops-config-transaction'
import type { ServerOpsConfigTransaction } from './server-ops-config-transaction'

/** 共享业务配置中的 SSH/Redis Agent 只读授权文件名。 */
const FILE_NAME = 'agent-read-access.json'
/** 限制持久快照大小，避免异常配置造成无界读取或写入。 */
const MAX_FILE_BYTES = 1_048_576

/** 持久授权 Store 使用的原子读写接口。 */
export interface ServerOpsAgentReadAccessPersistence {
  /** 读取并校验版本头；授权字段由 AccessStore 再做领域校验。 */
  load(): unknown
  /** 按授权代次比较并原子替换整个快照。 */
  save(value: object, expectedRevision: number): void
}

/** 持久读写器的短事务注入点；生产使用与其它运维配置共用的目录锁。 */
export interface ServerOpsAgentReadAccessPersistenceOptions {
  transaction?: ServerOpsConfigTransaction
}

/** 将 SSH/Redis 读取授权保存到共享业务配置，文件只含资源 ID、权限范围与指纹。 */
export class ServerOpsAgentReadAccessPersistenceStore implements ServerOpsAgentReadAccessPersistence {
  /** 授权快照的固定绝对路径。 */
  private readonly filePath: string
  /** 与其他 Server Ops 配置共用的跨进程事务锁。 */
  private readonly transaction: ServerOpsConfigTransaction
  /** 当前实例见过的最高全局授权代次，用于拒绝文件回滚。 */
  private highestRevision = 0
  /** 标记文件是否曾存在；已创建后再消失时必须拒绝读取。 */
  private hasObservedFile = false
  /** 上次读取的原子文件状态；null 表示权威文件尚不存在。 */
  private cachedState: AtomicFileState | null | undefined
  /** 与缓存文件状态对应的已解析快照。 */
  private cachedValue: Record<string, unknown> | null = null

  /** 绑定固定配置路径并创建共享运维配置目录。 */
  constructor(configDir = getConfigDir(), options: ServerOpsAgentReadAccessPersistenceOptions = {}) {
    const directoryPath = join(configDir, 'server-ops')
    mkdirSync(directoryPath, { recursive: true })
    this.filePath = resolveServerOpsConfigFilePath(directoryPath, FILE_NAME)
    this.transaction = options.transaction ?? createServerOpsConfigTransaction(directoryPath)
  }

  /** 读取权威授权快照；坏文件、回滚或不完整原子提交均 fail closed。 */
  load(): unknown {
    return structuredClone(this.readCurrent().value)
  }

  /** 在跨进程短事务内核对全局授权代次，再安全原子写入。 */
  save(value: object, expectedRevision: number): void {
    this.transaction(() => {
      const current = this.readCurrent()
      if (current.revision !== expectedRevision) throw new Error('SERVER_OPS_AGENT_ACCESS_CHANGED')
      const nextRevision = this.readRevision(value)
      if (nextRevision <= expectedRevision) throw new Error('SERVER_OPS_AGENT_ACCESS_REVISION_INVALID')
      if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_FILE_BYTES) {
        throw new Error('SERVER_OPS_AGENT_ACCESS_STORE_TOO_LARGE')
      }
      writeJsonFileAtomicSecure(this.filePath, value, { expectedDestination: current.expectedDestination })
      this.highestRevision = nextRevision
      this.hasObservedFile = true
      this.cachedState = undefined
      this.cachedValue = null
    })
  }

  /** 读取固定文件并在读取前后复核 inode 与内容状态。 */
  private readCurrent(): { value: Record<string, unknown>; revision: number; expectedDestination: AtomicDestinationExpectation } {
    const before = readAtomicFileState(this.filePath)
    if (before === null) {
      if (this.hasObservedFile || existsSync(`${this.filePath}.bak`)) throw new Error('SERVER_OPS_AGENT_ACCESS_STORE_READ_FAILED')
      if (this.cachedState === null && this.cachedValue) {
        return { value: this.cachedValue, revision: 0, expectedDestination: { kind: 'missing' } }
      }
      this.cachedState = null
      this.cachedValue = { version: 1, revision: 0, accesses: [] }
      return { value: this.cachedValue, revision: 0, expectedDestination: { kind: 'missing' } }
    }
    if (this.cachedState && this.cachedValue && sameFileState(this.cachedState, before)) {
      return { value: this.cachedValue, revision: this.highestRevision, expectedDestination: { kind: 'state', state: before } }
    }
    this.hasObservedFile = true
    try {
      if (before.size > MAX_FILE_BYTES) throw new Error('store too large')
      const descriptor = openSync(this.filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
      let raw: string
      try {
        const buffer = Buffer.allocUnsafe(before.size + 1)
        let used = 0
        while (used < buffer.length) {
          const bytes = readSync(descriptor, buffer, used, buffer.length - used, used)
          if (bytes === 0) break
          used += bytes
        }
        if (used !== before.size) throw new Error('store changed while reading')
        raw = buffer.toString('utf8', 0, used)
      } finally {
        closeSync(descriptor)
      }
      const after = readAtomicFileState(this.filePath)
      if (!after || !sameFileState(before, after)) throw new Error('store changed while reading')
      const parsed = JSON.parse(raw) as unknown
      const revision = this.readRevision(parsed)
      if (revision < this.highestRevision) throw new Error('SERVER_OPS_AGENT_ACCESS_STORE_ROLLBACK')
      this.highestRevision = revision
      this.cachedState = after
      this.cachedValue = parsed as Record<string, unknown>
      return { value: this.cachedValue, revision, expectedDestination: { kind: 'state', state: after } }
    } catch {
      throw new Error('SERVER_OPS_AGENT_ACCESS_STORE_READ_FAILED')
    }
  }

  /** 校验文件版本头和全局代次，不接受未知持久化格式。 */
  private readRevision(value: unknown): number {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid store')
    const state = value as Record<string, unknown>
    if (Object.keys(state).length !== 3 || !('version' in state) || !('revision' in state) || !('accesses' in state)
      || state.version !== 1 || !Array.isArray(state.accesses)
      || typeof state.revision !== 'number' || !Number.isSafeInteger(state.revision) || state.revision < 0) {
      throw new Error('invalid store')
    }
    return state.revision
  }
}

/** 比较完整文件状态，避免读取期间目标被替换或原位改写。 */
function sameFileState(left: AtomicFileState, right: AtomicFileState): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}
