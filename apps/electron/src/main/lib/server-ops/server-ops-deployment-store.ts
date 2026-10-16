import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseServerOpsDeploymentRun, parseServerOpsDeploymentTarget } from '@proma/shared'
import type { ServerOpsDeploymentListInput, ServerOpsDeploymentRun, ServerOpsDeploymentTarget, ServerOpsDeploymentTargetSaveInput } from '@proma/shared'
import { getConfigDir } from '../config-paths'
import { readAtomicFileState, readJsonFileStrict, writeJsonFileAtomicSecure } from '../safe-file'
import type { AtomicDestinationExpectation, ReadJsonFileStrictOptions } from '../safe-file'
import { createServerOpsConfigTransaction, resolveServerOpsConfigFilePath } from './server-ops-config-transaction'
import type { ServerOpsConfigTransaction } from './server-ops-config-transaction'

/** 发布目标与运行记录的固定持久化文件。 */
const TARGETS_FILE = 'deployments.json'
const RUNS_FILE = 'deployment-runs.json'
const VERSION = 1
const TARGET_LIMIT = 100
const TARGET_BYTES_LIMIT = 512 * 1024
const RUN_LIMIT = 500
const RUN_BYTES_LIMIT = 2 * 1024 * 1024

/** Store 可替换的安全文件与时钟边界。 */
export interface ServerOpsDeploymentStoreDependencies {
  readJson: <T>(filePath: string, options: ReadJsonFileStrictOptions<T>) => T | null
  writeJson: (filePath: string, data: object, expected: AtomicDestinationExpectation, backup?: object) => void
  now: () => number
  transaction?: ServerOpsConfigTransaction
}

interface DeploymentFile<T> { version: typeof VERSION; items: T[] }

/** 生产环境安全文件依赖。 */
function createDependencies(): ServerOpsDeploymentStoreDependencies {
  return {
    readJson: readJsonFileStrict,
    writeJson: (filePath, data, expected, backup) => writeJsonFileAtomicSecure(filePath, data, {
      expectedDestination: expected,
      ...(backup === undefined ? {} : { priorBackup: { filePath: `${filePath}.bak`, data: backup } }),
    }),
    now: Date.now,
  }
}

/** 解析并检查部署文件根对象，坏文件必须阻断写入。 */
function parseFile<T>(value: unknown, parseItem: (item: unknown) => T, errorCode: string): DeploymentFile<T> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(errorCode)
  const record = value as Record<string, unknown>
  if (record.version !== VERSION || !Array.isArray(record.items) || Object.keys(record).some((key) => key !== 'version' && key !== 'items')) throw new Error(errorCode)
  const items = record.items.map(parseItem)
  return { version: VERSION, items }
}

/** 严格校验部署目标文件的容量和唯一 ID。 */
function parseTargets(value: unknown): DeploymentFile<ServerOpsDeploymentTarget> {
  const file = parseFile(value, parseServerOpsDeploymentTarget, 'SERVER_OPS_DEPLOYMENT_TARGET_FILE_INVALID')
  if (file.items.length > TARGET_LIMIT || Buffer.byteLength(JSON.stringify(file, null, 2), 'utf8') > TARGET_BYTES_LIMIT) {
    throw new Error('SERVER_OPS_DEPLOYMENT_TARGET_FILE_INVALID')
  }
  const ids = new Set<string>()
  for (const target of file.items) {
    if (ids.has(target.id)) throw new Error('SERVER_OPS_DEPLOYMENT_TARGET_FILE_INVALID')
    ids.add(target.id)
  }
  return file
}

/** 严格校验运行记录文件的容量和唯一 ID。 */
function parseRuns(value: unknown): DeploymentFile<ServerOpsDeploymentRun> {
  const file = parseFile(value, parseServerOpsDeploymentRun, 'SERVER_OPS_DEPLOYMENT_RUN_FILE_INVALID')
  if (file.items.length > RUN_LIMIT || Buffer.byteLength(JSON.stringify(file, null, 2), 'utf8') > RUN_BYTES_LIMIT) throw new Error('SERVER_OPS_DEPLOYMENT_RUN_FILE_INVALID')
  const ids = new Set<string>()
  for (const run of file.items) {
    if (ids.has(run.id)) throw new Error('SERVER_OPS_DEPLOYMENT_RUN_FILE_INVALID')
    ids.add(run.id)
  }
  return file
}

/** 目标保存与运行历史共享的跨进程短事务 Store。 */
export class ServerOpsDeploymentStore {
  private readonly targetsPath: string
  private readonly runsPath: string
  private readonly dependencies: ServerOpsDeploymentStoreDependencies
  private readonly transaction: ServerOpsConfigTransaction

  constructor(configDir = getConfigDir(), dependencies: Partial<ServerOpsDeploymentStoreDependencies> = {}) {
    const directoryPath = join(configDir, 'server-ops')
    mkdirSync(directoryPath, { recursive: true })
    this.targetsPath = resolveServerOpsConfigFilePath(directoryPath, TARGETS_FILE)
    this.runsPath = resolveServerOpsConfigFilePath(directoryPath, RUNS_FILE)
    this.dependencies = { ...createDependencies(), ...dependencies }
    this.transaction = dependencies.transaction ?? createServerOpsConfigTransaction(directoryPath)
  }

  /** 列出指定项目与主机的部署目标。 */
  listTargets(input: ServerOpsDeploymentListInput): ServerOpsDeploymentTarget[] {
    return this.readTargets().file.items.filter((target) => target.projectId === input.projectId && target.hostId === input.hostId).map((target) => structuredClone(target))
  }

  /** 读取单个目标的最新权威快照。 */
  getTarget(targetId: string): ServerOpsDeploymentTarget | undefined {
    const target = this.readTargets().file.items.find((entry) => entry.id === targetId)
    return target === undefined ? undefined : structuredClone(target)
  }

  /** CAS 保存目标；有在途运行时不允许改变目标身份。 */
  saveTarget(input: ServerOpsDeploymentTargetSaveInput): ServerOpsDeploymentTarget {
    return this.transaction(() => {
      const loaded = this.readTargets()
      const index = loaded.file.items.findIndex((target) => target.id === input.target.id)
      const now = this.dependencies.now()
      if (index < 0) {
        if (input.expectedRevision !== 0) throw new Error('SERVER_OPS_DEPLOYMENT_CAS_CONFLICT')
        if (loaded.file.items.length >= TARGET_LIMIT) throw new Error('SERVER_OPS_DEPLOYMENT_TARGET_CAPACITY')
        const created = parseServerOpsDeploymentTarget({ ...input.target, revision: 1, createdAt: now, updatedAt: now })
        this.writeTargets([...loaded.file.items, created], loaded.expected, loaded.file)
        return structuredClone(created)
      }
      const current = loaded.file.items[index]!
      if (current.revision !== input.expectedRevision) throw new Error('SERVER_OPS_DEPLOYMENT_CAS_CONFLICT')
      const runs = this.readRuns().file.items
      if (runs.some((run) => run.targetId === current.id && isActive(run.status))) throw new Error('SERVER_OPS_DEPLOYMENT_TARGET_BUSY')
      const updated = parseServerOpsDeploymentTarget({ ...input.target, revision: current.revision + 1, createdAt: current.createdAt, updatedAt: now })
      const next = loaded.file.items.map((target, position) => position === index ? updated : target)
      this.writeTargets(next, loaded.expected, loaded.file)
      return structuredClone(updated)
    })
  }

  /** 列出指定范围的运行历史，未知记录保留在结果中。 */
  listRuns(input: ServerOpsDeploymentListInput): ServerOpsDeploymentRun[] {
    const targetIds = new Set(this.listTargets(input).map((target) => target.id))
    return this.readRuns().file.items.filter((run) => targetIds.has(run.targetId)).sort((left, right) => right.startedAt - left.startedAt).map((run) => structuredClone(run))
  }

  /** 追加运行意图，限制全局和同目标并发。 */
  appendRun(run: ServerOpsDeploymentRun): ServerOpsDeploymentRun {
    return this.transaction(() => {
      const parsed = parseServerOpsDeploymentRun(run)
      const target = this.getTarget(parsed.targetId)
      if (!target || target.projectId !== parsed.projectId || target.hostId !== parsed.hostId || target.revision !== parsed.targetRevision) throw new Error('SERVER_OPS_DEPLOYMENT_TARGET_REVISION_MISMATCH')
      const loaded = this.readRuns()
      if (loaded.file.items.some((entry) => entry.id === parsed.id)) throw new Error('SERVER_OPS_DEPLOYMENT_RUN_EXISTS')
      if (loaded.file.items.length >= RUN_LIMIT || Buffer.byteLength(JSON.stringify({ version: VERSION, items: [...loaded.file.items, parsed] }, null, 2), 'utf8') > RUN_BYTES_LIMIT) throw new Error('SERVER_OPS_DEPLOYMENT_RUN_CAPACITY')
      if (loaded.file.items.filter((entry) => entry.status === 'running' || entry.status === 'verifying').length >= 2 || loaded.file.items.some((entry) => entry.targetId === parsed.targetId && isActive(entry.status))) throw new Error('SERVER_OPS_DEPLOYMENT_ACTIVE_LIMIT')
      this.writeRuns([...loaded.file.items, parsed], loaded.expected, loaded.file)
      return structuredClone(parsed)
    })
  }

  /** 以 writer + revision CAS 推进已知状态；unknown 只能通过 markUnknown。 */
  transitionRun(input: { id: string; writerId: string; expectedRevision: number; status: Exclude<ServerOpsDeploymentRun['status'], 'unknown'>; summary: string; stoppedEvidenceHash?: string }): ServerOpsDeploymentRun {
    return this.transition(input)
  }

  /** 将无法确认终态的运行永久标记为 unknown，保留占用。 */
  markUnknown(id: string, writerId: string, expectedRevision: number, summary: string): ServerOpsDeploymentRun {
    return this.transition({ id, writerId, expectedRevision, status: 'unknown', summary })
  }

  private transition(input: { id: string; writerId: string; expectedRevision: number; status: ServerOpsDeploymentRun['status']; summary: string; stoppedEvidenceHash?: string }): ServerOpsDeploymentRun {
    return this.transaction(() => {
      const loaded = this.readRuns()
      const index = loaded.file.items.findIndex((run) => run.id === input.id)
      if (index < 0) throw new Error('SERVER_OPS_DEPLOYMENT_RUN_NOT_FOUND')
      const current = loaded.file.items[index]!
      if (current.writerId !== input.writerId || current.revision !== input.expectedRevision) throw new Error('SERVER_OPS_DEPLOYMENT_RUN_CAS_CONFLICT')
      if (current.status === 'unknown' || current.status === 'succeeded' || current.status === 'failed') throw new Error('SERVER_OPS_DEPLOYMENT_RUN_IMMUTABLE')
      if (input.status === 'unknown') {
        const next = parseServerOpsDeploymentRun({ ...current, status: 'unknown', summary: input.summary, updatedAt: this.dependencies.now(), revision: current.revision + 1 })
        this.writeRuns(loaded.file.items.map((run, position) => position === index ? next : run), loaded.expected, loaded.file)
        return structuredClone(next)
      }
      if ((input.status === 'succeeded' || input.status === 'failed') && !/^sha256:[a-f0-9]{64}$/u.test(input.stoppedEvidenceHash ?? '')) throw new Error('SERVER_OPS_DEPLOYMENT_STOPPED_EVIDENCE_REQUIRED')
      const next = parseServerOpsDeploymentRun({ ...current, status: input.status, summary: input.summary, updatedAt: this.dependencies.now(), revision: current.revision + 1, ...(input.status === 'succeeded' || input.status === 'failed' ? { finishedAt: this.dependencies.now() } : {}) })
      this.writeRuns(loaded.file.items.map((run, position) => position === index ? next : run), loaded.expected, loaded.file)
      return structuredClone(next)
    })
  }

  private readTargets(): { file: DeploymentFile<ServerOpsDeploymentTarget>; expected: AtomicDestinationExpectation } {
    return this.readFile(this.targetsPath, parseTargets, TARGET_BYTES_LIMIT)
  }

  private readRuns(): { file: DeploymentFile<ServerOpsDeploymentRun>; expected: AtomicDestinationExpectation } {
    return this.readFile(this.runsPath, parseRuns, RUN_BYTES_LIMIT)
  }

  /** 以固定字节预算读取部署文件，避免损坏配置导致无界内存分配。 */
  private readFile<T>(filePath: string, parser: (value: unknown) => DeploymentFile<T>, maxBytes: number): { file: DeploymentFile<T>; expected: AtomicDestinationExpectation } {
    const expectedState = readAtomicFileState(filePath)
    /** 先构造类型守卫，避免把解析异常泄漏到 safe-file 的候选回退逻辑之外。 */
    const validate = (value: unknown): value is DeploymentFile<T> => {
      try { parser(value); return true } catch { return false }
    }
    const loaded = this.dependencies.readJson(filePath, { description: '部署配置文件', maxBytes, validate })
    if (loaded === null) {
      if (expectedState !== null) throw new Error('SERVER_OPS_DEPLOYMENT_READ_FAILED')
      return { file: { version: VERSION, items: [] }, expected: { kind: 'missing' } }
    }
    return { file: parser(loaded), expected: { kind: 'state', state: expectedState! } }
  }

  private writeTargets(items: ServerOpsDeploymentTarget[], expected: AtomicDestinationExpectation, backup: DeploymentFile<ServerOpsDeploymentTarget>): void { this.dependencies.writeJson(this.targetsPath, { version: VERSION, items }, expected, backup) }
  private writeRuns(items: ServerOpsDeploymentRun[], expected: AtomicDestinationExpectation, backup: DeploymentFile<ServerOpsDeploymentRun>): void { this.dependencies.writeJson(this.runsPath, { version: VERSION, items }, expected, backup) }
}

/** 运行状态是否继续占用目标。 */
function isActive(status: ServerOpsDeploymentRun['status']): boolean { return status === 'running' || status === 'verifying' || status === 'unknown' }
