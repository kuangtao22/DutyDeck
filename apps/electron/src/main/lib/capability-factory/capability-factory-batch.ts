import { randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type {
  CapabilityDataset,
  CapabilityFactoryBatch,
  CapabilityFactoryBatchItem,
  CapabilityFactoryBatchRequest,
  CapabilityFactoryBatchRunOptions,
  CapabilityFactoryBatchSummary,
  CapabilityRun,
  CapabilitySavedTask,
  CapabilityScene,
} from '@proma/shared'
import {
  compareOptimizationPair,
  isAdoptableOptimizationBatch,
  isPromptOnlyOptimization,
  optimizationKey,
  sceneStandardsKey,
} from '@proma/shared'
import { ensureDirectoryDurable, writeJsonFileAtomicSecure } from '../safe-file'

/** 同一进程中的真实活动批次；其它 runner 读取时不能把它误判为中断。 */
const activeBatchKeys = new Set<string>()
/** 同一宿主回合跨场景共享优化额度，避免换场景绕过三轮上限。 */
const comparisonRoundsByScope = new Map<string, { count: number; lastUsedAt: number }>()
const BATCH_SCHEMA_VERSION = 1
const MAX_BATCH_ITEMS = 10
const MAX_BATCH_FILES_PER_SCENE = 100
const MAX_BATCH_FILE_BYTES = 4 * 1024 * 1024
const MAX_COMPARISON_ROUNDS_PER_SCOPE = 3
const MAX_TRACKED_SCOPES = 512
const SCOPE_BUDGET_TTL_MS = 6 * 60 * 60 * 1000

/** 标记宿主归属失效；此错误路径绝不能为了补终态再次写盘。 */
class CapabilityFactoryBatchOwnershipError extends Error {
  constructor(readonly reason: unknown) {
    super(reason instanceof Error ? reason.message : String(reason))
    this.name = 'CapabilityFactoryBatchOwnershipError'
  }
}

/** 批次所需的最小服务端口，避免复制 service 的运行和评测职责。 */
export interface CapabilityFactoryBatchService {
  getScene(sceneId: string): CapabilityScene | null
  listTasks(sceneId: string): CapabilitySavedTask[]
  listDatasets(): CapabilityDataset[]
  getRunsByIds(sceneId: string, runIds: readonly string[]): CapabilityRun[]
}

/** 批次 runner 的宿主依赖；scopeId 由 Host 注入，调用方不能自报。 */
export interface CapabilityFactoryBatchRunnerOptions {
  service: CapabilityFactoryBatchService
  rootDir: string
  run: (
    sceneId: string,
    input: Record<string, unknown>,
    options?: CapabilityFactoryBatchRunOptions,
  ) => Promise<CapabilityRun>
  scopeId?: string
  signal?: AbortSignal
  assertCurrent?: (batch: CapabilityFactoryBatch) => void | Promise<void>
  onProgress?: (batch: CapabilityFactoryBatch) => void
  now?: () => number
  createId?: () => string
}

/** 磁盘记录带显式版本，未知结构不能被下一次写入静默覆盖。 */
interface CapabilityFactoryBatchFile {
  schemaVersion: number
  batch: CapabilityFactoryBatch
}

/** 文件名只接受稳定 ID，阻断路径穿越和隐式目录创建。 */
function assertSafeId(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error(`${label}标识不合法：${value}`)
}

/** 只创建或接受真实目录，符号链接与其它文件类型全部拒绝。 */
function ensureRealDirectory(directoryPath: string, label: string): void {
  if (!existsSync(directoryPath)) ensureDirectoryDurable(directoryPath)
  const stat = lstatSync(directoryPath)
  if (stat.isSymbolicLink()) throw new Error(`${label}不能是符号链接`)
  if (!stat.isDirectory()) throw new Error(`${label}不是目录`)
}

/** 批次文件的最小结构校验；详细业务身份由读取与采纳阶段继续复核。 */
function isBatchFile(value: unknown): value is CapabilityFactoryBatchFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const file = value as Record<string, unknown>
  if (file.schemaVersion !== BATCH_SCHEMA_VERSION || typeof file.batch !== 'object' || file.batch === null) return false
  const batch = file.batch as Record<string, unknown>
  return typeof batch.id === 'string'
    && typeof batch.sceneId === 'string'
    && (batch.kind === 'evaluation' || batch.kind === 'comparison')
    && typeof batch.status === 'string'
    && Array.isArray(batch.items)
    && typeof batch.snapshot === 'object' && batch.snapshot !== null
    && typeof batch.adoptable === 'boolean'
    && typeof batch.startedAt === 'number'
    && typeof batch.updatedAt === 'number'
    && (batch.finishedAt === null || typeof batch.finishedAt === 'number')
}

/** 只读打开并限制字节数；不触发 safe-file 的 tmp/bak 恢复写入。 */
function readBatchFileReadOnly(filePath: string): CapabilityFactoryBatchFile | null {
  if (!existsSync(filePath)) return null
  const pathStat = lstatSync(filePath)
  if (pathStat.isSymbolicLink()) throw new Error('批次文件不能是符号链接')
  if (!pathStat.isFile()) throw new Error('批次路径不是普通文件')
  if (pathStat.size > MAX_BATCH_FILE_BYTES) throw new Error('批次文件超过读取上限')
  const descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const openedStat = fstatSync(descriptor)
    if (!openedStat.isFile() || openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      throw new Error('批次文件身份已变化')
    }
    if (openedStat.size > MAX_BATCH_FILE_BYTES) throw new Error('批次文件超过读取上限')
    const value: unknown = JSON.parse(readFileSync(descriptor, 'utf8'))
    if (!isBatchFile(value)) throw new Error('能力工厂批次 JSON 结构无效')
    return value
  } finally {
    closeSync(descriptor)
  }
}

/** 把运行事实汇总成 evaluation 质量轴；未知评审不会按通过计数。 */
function evaluationSummary(items: readonly CapabilityFactoryBatchItem[], service: CapabilityFactoryBatchService, sceneId: string) {
  const runIds = items.flatMap((item) => item.runId ? [item.runId] : [])
  const runs = service.getRunsByIds(sceneId, runIds)
  return {
    total: items.length,
    completed: items.filter((item) => item.status === 'succeeded' || item.status === 'failed').length,
    valid: runs.filter((run) => run.status === 'succeeded' && run.valid).length,
    reviewed: runs.filter((run) => run.review?.status === 'succeeded').length,
    passedReview: runs.filter((run) => run.status === 'succeeded' && run.valid
      && run.review?.status === 'succeeded' && run.review.passed === true
      && !run.placeholderCapabilities?.length && !run.evidenceIssues?.length).length,
  }
}

/** 创建可恢复批次 runner；执行串行化，单项完成即原子落盘。 */
export function createCapabilityFactoryBatchRunner(options: CapabilityFactoryBatchRunnerOptions) {
  const now = options.now ?? (() => Date.now())
  const createId = options.createId ?? (() => randomUUID())
  const resolvedRootDir = resolve(options.rootDir)
  if (options.scopeId !== undefined && (options.scopeId.length < 1 || options.scopeId.length > 256)) {
    throw new Error('批次 scopeId 不合法')
  }

  /** 活动身份包含固定根、场景与批次，避免不同工作区相同 ID 互相污染。 */
  const activeKey = (sceneId: string, batchId: string): string => `${resolvedRootDir}\u0000${sceneId}\u0000${batchId}`
  /** scope 额度绑定工作区根，两个工作区的同名会话互不影响。 */
  const scopeKey = (scopeId: string): string => `${resolvedRootDir}\u0000${scopeId}`

  /** 淘汰已结束回合的额度记录，并对极端长进程设置硬上限。 */
  const pruneScopeBudgets = (timestamp: number): void => {
    for (const [key, entry] of comparisonRoundsByScope) {
      if (timestamp - entry.lastUsedAt > SCOPE_BUDGET_TTL_MS) comparisonRoundsByScope.delete(key)
    }
    if (comparisonRoundsByScope.size < MAX_TRACKED_SCOPES) return
    const oldest = [...comparisonRoundsByScope.entries()]
      .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)
    for (const [key] of oldest.slice(0, comparisonRoundsByScope.size - MAX_TRACKED_SCOPES + 1)) {
      comparisonRoundsByScope.delete(key)
    }
  }

  /** 返回固定根下的场景批次目录，按需创建且逐层拒绝符号链接。 */
  const sceneDirectory = (sceneId: string, create: boolean): string => {
    assertSafeId(sceneId, '场景')
    if (!existsSync(resolvedRootDir) && !create) return join(resolvedRootDir, 'batches', sceneId)
    ensureRealDirectory(resolvedRootDir, '能力工厂根目录')
    const batchesDirectory = join(resolvedRootDir, 'batches')
    if (!existsSync(batchesDirectory) && !create) return join(batchesDirectory, sceneId)
    ensureRealDirectory(batchesDirectory, '批次目录')
    const directory = join(batchesDirectory, sceneId)
    if (!existsSync(directory) && !create) return directory
    ensureRealDirectory(directory, '场景批次目录')
    return directory
  }

  /** 批次完整路径只由校验后的场景 ID 与批次 ID 构造。 */
  const batchPath = (sceneId: string, batchId: string, create: boolean): string => {
    assertSafeId(batchId, '批次')
    return join(sceneDirectory(sceneId, create), `${batchId}.json`)
  }

  /** 写盘前由宿主复核归属；失败时不允许补写终态或进度。 */
  const assertOwnerCurrent = async (batch: CapabilityFactoryBatch): Promise<void> => {
    try {
      await options.assertCurrent?.(structuredClone(batch))
    } catch (error) {
      throw new CapabilityFactoryBatchOwnershipError(error)
    }
  }

  /** 原子保存完整批次；进度回调收到隔离副本，不能修改持久状态。 */
  const persist = async (batch: CapabilityFactoryBatch): Promise<void> => {
    await assertOwnerCurrent(batch)
    batch.updatedAt = now()
    writeJsonFileAtomicSecure(batchPath(batch.sceneId, batch.id, true), {
      schemaVersion: BATCH_SCHEMA_VERSION,
      batch,
    } satisfies CapabilityFactoryBatchFile)
    options.onProgress?.(structuredClone(batch))
  }

  /** 读取完整记录并投影中断状态；该内部入口不做 scope 过滤。 */
  const readBatch = (sceneId: string, batchId: string): CapabilityFactoryBatch | null => {
    const filePath = batchPath(sceneId, batchId, false)
    const file = readBatchFileReadOnly(filePath)
    if (!file) return null
    if (file.batch.sceneId !== sceneId || file.batch.id !== batchId) throw new Error('批次文件身份不匹配')
    const batch = structuredClone(file.batch)
    if (batch.status === 'running' && !activeBatchKeys.has(activeKey(sceneId, batchId))) batch.status = 'interrupted'
    return batch
  }

  /** 精确读取持久证据；scope 仅用于执行额度，不限制后续回合读取。 */
  const get = (sceneId: string, batchId: string): CapabilityFactoryBatch | null => {
    return readBatch(sceneId, batchId)
  }

  /** 列表只读轻量摘要；完整冻结输入必须通过 get 精确读取。 */
  const list = (sceneId: string): CapabilityFactoryBatchSummary[] => {
    const directory = sceneDirectory(sceneId, false)
    if (!existsSync(directory)) return []
    const entries = readdirSync(directory, { withFileTypes: true })
      .flatMap((entry) => {
        if (entry.isSymbolicLink()) throw new Error('批次文件不能是符号链接')
        if (!entry.isFile() || !entry.name.endsWith('.json')) return []
        return [{ entry, modifiedAt: lstatSync(join(directory, entry.name)).mtimeMs }]
      })
      .sort((left, right) => right.modifiedAt - left.modifiedAt || right.entry.name.localeCompare(left.entry.name))
      .slice(0, MAX_BATCH_FILES_PER_SCENE)
    return entries.flatMap(({ entry }) => {
      const batch = readBatch(sceneId, entry.name.slice(0, -5))
      if (!batch) return []
      return [{
        id: batch.id,
        ...(batch.scopeId === undefined ? {} : { scopeId: batch.scopeId }),
        sceneId: batch.sceneId,
        kind: batch.kind,
        status: batch.status,
        itemCount: batch.items.length,
        completedCount: batch.items.filter((item) => item.status !== 'pending' && item.status !== 'running').length,
        ...(batch.evaluation === undefined ? {} : { evaluation: batch.evaluation }),
        ...(batch.comparison === undefined ? {} : { comparison: batch.comparison }),
        adoptable: batch.adoptable,
        startedAt: batch.startedAt,
        updatedAt: batch.updatedAt,
        finishedAt: batch.finishedAt,
        ...(batch.error === undefined ? {} : { error: batch.error }),
      }]
    }).sort((left, right) => right.startedAt - left.startedAt)
  }

  /** 每次调用前复核版本、草案、数据集及宿主归属，发现冲突立即停止后续模型调用。 */
  const assertSnapshotCurrent = async (batch: CapabilityFactoryBatch): Promise<void> => {
    await assertOwnerCurrent(batch)
    const scene = options.service.getScene(batch.sceneId)
    if (!scene) throw new Error(`场景不存在：${batch.sceneId}`)
    if (scene.currentVersion !== batch.snapshot.sceneVersion) throw new Error('场景版本已变化，批次已停止')
    if (batch.kind === 'comparison') {
      if (!scene.draft
        || scene.draft.createdAt !== batch.snapshot.draftCreatedAt
        || optimizationKey(scene.draft.definition) !== optimizationKey(batch.snapshot.draftDefinition)) {
        throw new Error('候选草案已变化，批次已停止')
      }
    }
    if (batch.snapshot.datasetId) {
      const dataset = options.service.listDatasets().find((item) => item.id === batch.snapshot.datasetId)
      if (!dataset || dataset.version !== batch.snapshot.datasetVersion) throw new Error('数据集版本已变化，批次已停止')
    }
  }

  /** 根据任务或数据集冻结 1–10 条输入，并验证对比范围。 */
  const prepareBatch = (request: CapabilityFactoryBatchRequest): CapabilityFactoryBatch => {
    assertSafeId(request.sceneId, '场景')
    if (request.caseIds !== undefined && request.datasetId === undefined) throw new Error('caseIds 只能与数据集一起使用')
    if (request.datasetId !== undefined && request.taskIds !== undefined) throw new Error('数据集用例与保存任务不能同时选择')
    const scene = options.service.getScene(request.sceneId)
    if (!scene) throw new Error(`场景不存在：${request.sceneId}`)
    if (request.expectedVersion !== undefined && request.expectedVersion !== scene.currentVersion) throw new Error('场景版本已变化')

    let dataset: CapabilityDataset | undefined
    let sources: Array<{ id: string; name: string; input: Record<string, unknown> }>
    if (request.datasetId !== undefined) {
      assertSafeId(request.datasetId, '数据集')
      dataset = options.service.listDatasets().find((item) => item.id === request.datasetId)
      if (!dataset) throw new Error(`数据集不存在：${request.datasetId}`)
      if (request.caseIds !== undefined) {
        if (request.caseIds.length === 0) throw new Error('至少选择 1 条数据集用例')
        if (new Set(request.caseIds).size !== request.caseIds.length) throw new Error('用例选择包含重复标识')
        const cases = new Map(dataset.cases.map((item) => [item.id, item]))
        sources = request.caseIds.map((id) => {
          const item = cases.get(id)
          if (!item) throw new Error(`数据集用例不存在：${id}`)
          return { id: item.id, name: item.name, input: structuredClone(item.input) }
        })
      } else {
        sources = dataset.cases.map((item) => ({ id: item.id, name: item.name, input: structuredClone(item.input) }))
      }
    } else {
      if (request.kind === 'evaluation') throw new Error('evaluation 批次必须指定数据集')
      const requestedIds = request.taskIds ?? []
      if (new Set(requestedIds).size !== requestedIds.length) throw new Error('任务选择包含重复标识')
      const tasks = new Map(options.service.listTasks(request.sceneId).map((item) => [item.id, item]))
      sources = requestedIds.map((id) => {
        const task = tasks.get(id)
        if (!task) throw new Error(`任务不存在：${id}`)
        return { id: task.id, name: task.id, input: structuredClone(task.input) }
      })
    }
    if (sources.length < 1 || sources.length > MAX_BATCH_ITEMS) throw new Error('请选择当前场景的 1–10 条任务或用例')

    let draftDefinition = request.expectedDraftDefinition
    let draftCreatedAt = request.expectedDraftCreatedAt
    if (request.kind === 'comparison') {
      if (!scene.draft) throw new Error('当前没有待验证的候选草案')
      draftDefinition ??= structuredClone(scene.draft.definition)
      draftCreatedAt ??= scene.draft.createdAt
      if (draftCreatedAt !== scene.draft.createdAt
        || optimizationKey(draftDefinition) !== optimizationKey(scene.draft.definition)) throw new Error('候选草案已变化')
      if (sceneStandardsKey(scene) !== optimizationKey(draftDefinition.stepAcceptances ?? draftDefinition.acceptance)) throw new Error('草案修改了评审标准')
      if (optimizationKey(scene.definition.modelSlots) !== optimizationKey(draftDefinition.modelSlots)) throw new Error('草案修改了模型配置')
      if (!isPromptOnlyOptimization(scene.definition, draftDefinition)) throw new Error('提示词优化对比只允许修改模型步骤提示词')
    }

    const timestamp = now()
    const id = createId()
    assertSafeId(id, '批次')
    const items: CapabilityFactoryBatchItem[] = sources.map((source) => ({ ...source, status: 'pending' }))
    return {
      id,
      ...(options.scopeId === undefined ? {} : { scopeId: options.scopeId }),
      sceneId: request.sceneId,
      kind: request.kind,
      status: 'running',
      snapshot: {
        sceneVersion: scene.currentVersion,
        ...(dataset ? { datasetId: dataset.id, datasetVersion: dataset.version } : {}),
        ...(draftCreatedAt === undefined ? {} : { draftCreatedAt }),
        ...(draftDefinition === undefined ? {} : { draftDefinition: structuredClone(draftDefinition) }),
        itemIds: sources.map((source) => source.id),
      },
      items,
      ...(request.kind === 'evaluation' ? { evaluation: { total: items.length, completed: 0, valid: 0, reviewed: 0, passedReview: 0 } } : {}),
      adoptable: false,
      startedAt: timestamp,
      updatedAt: timestamp,
      finishedAt: null,
    }
  }

  /** 汇总 comparison 证据，并只在整批满足共享门槛时标记可采纳。 */
  const updateComparison = (batch: CapabilityFactoryBatch): void => {
    const runIds = batch.items.flatMap((item) => [item.baselineRunId, item.candidateRunId])
      .filter((runId): runId is string => runId !== undefined)
    const runs = new Map(options.service.getRunsByIds(batch.sceneId, runIds).map((run) => [run.id, run]))
    const comparisons = batch.items.flatMap((item) => {
      if (!item.baselineRunId || !item.candidateRunId) return []
      const baseline = runs.get(item.baselineRunId)
      const candidate = runs.get(item.candidateRunId)
      return baseline && candidate ? [compareOptimizationPair(baseline, candidate)] : []
    })
    batch.comparison = {
      comparable: comparisons.filter((item) => item.comparable).length,
      candidatePassed: comparisons.filter((item) => item.candidatePassed).length,
      fixed: comparisons.flatMap((item) => item.fixed),
      regressed: comparisons.flatMap((item) => item.regressed),
      unknown: comparisons.flatMap((item) => item.unknown),
      reasons: [...new Set(comparisons.flatMap((item) => item.reasons))],
    }
    batch.adoptable = batch.items.every((item) => item.status === 'succeeded')
      && isAdoptableOptimizationBatch(comparisons)
  }

  /** 执行批次；前置错误抛出，开始后的取消、冲突和运行失败均持久化为终态。 */
  const run = async (request: CapabilityFactoryBatchRequest): Promise<CapabilityFactoryBatch> => {
    const batch = prepareBatch(request)
    if (batch.kind === 'comparison' && options.scopeId !== undefined) {
      const key = scopeKey(options.scopeId)
      const timestamp = Date.now()
      pruneScopeBudgets(timestamp)
      const usedRounds = comparisonRoundsByScope.get(key)?.count ?? 0
      if (usedRounds >= MAX_COMPARISON_ROUNDS_PER_SCOPE) throw new Error('当前 Agent 回合最多运行 3 轮优化对比')
      comparisonRoundsByScope.set(key, { count: usedRounds + 1, lastUsedAt: timestamp })
    }
    const batchActiveKey = activeKey(batch.sceneId, batch.id)
    activeBatchKeys.add(batchActiveKey)
    let ownershipFailure: unknown
    try {
      await persist(batch)
      for (const item of batch.items) {
        if (options.signal?.aborted) {
          item.status = 'cancelled'
          continue
        }
        await assertSnapshotCurrent(batch)
        item.status = 'running'
        await persist(batch)
        if (batch.kind === 'evaluation') {
          const result = await options.run(batch.sceneId, structuredClone(item.input), {
            saveTask: false,
            target: 'current',
            expectedVersion: batch.snapshot.sceneVersion,
          })
          item.runId = result.id
          item.status = result.status === 'succeeded' && result.valid ? 'succeeded' : 'failed'
          if (item.status === 'failed') item.error = result.error ?? '运行或格式约束未通过'
          batch.evaluation = evaluationSummary(batch.items, options.service, batch.sceneId)
          await persist(batch)
          continue
        }

        const comparisonId = createId()
        assertSafeId(comparisonId, '对比')
        item.comparisonId = comparisonId
        const baseline = await options.run(batch.sceneId, structuredClone(item.input), {
          saveTask: false,
          target: 'current',
          expectedVersion: batch.snapshot.sceneVersion,
          comparisonId,
          comparisonRole: 'baseline',
        })
        item.baselineRunId = baseline.id
        await persist(batch)
        if (options.signal?.aborted) {
          item.status = 'cancelled'
          continue
        }
        await assertSnapshotCurrent(batch)
        if (baseline.status !== 'succeeded' || !baseline.valid || baseline.review?.status !== 'succeeded') {
          throw new Error(baseline.error ?? '基线执行、格式校验或评审未通过')
        }
        const candidate = await options.run(batch.sceneId, structuredClone(item.input), {
          saveTask: false,
          target: 'draft',
          expectedVersion: batch.snapshot.sceneVersion,
          expectedDraftCreatedAt: batch.snapshot.draftCreatedAt,
          expectedDraftDefinition: batch.snapshot.draftDefinition,
          comparisonId,
          comparisonRole: 'candidate',
        })
        item.candidateRunId = candidate.id
        item.status = candidate.status === 'succeeded' && candidate.valid && candidate.review?.status === 'succeeded'
          ? 'succeeded' : 'failed'
        if (item.status === 'failed') item.error = candidate.error ?? '候选执行、格式校验或评审未通过'
        updateComparison(batch)
        await persist(batch)
        if (item.status === 'failed') throw new Error(item.error)
      }
      if (options.signal?.aborted) {
        for (const item of batch.items) if (item.status === 'pending' || item.status === 'running') item.status = 'cancelled'
        batch.status = 'cancelled'
      } else {
        batch.status = batch.items.every((item) => item.status === 'succeeded') ? 'succeeded' : 'failed'
      }
    } catch (error) {
      if (error instanceof CapabilityFactoryBatchOwnershipError) {
        ownershipFailure = error.reason
      } else {
        batch.status = options.signal?.aborted ? 'cancelled' : 'failed'
        batch.error = error instanceof Error ? error.message : String(error)
        for (const item of batch.items) if (item.status === 'pending' || item.status === 'running') {
          item.status = batch.status === 'cancelled' ? 'cancelled' : 'failed'
          item.error ??= batch.error
        }
      }
    } finally {
      try {
        if (ownershipFailure === undefined) {
          batch.finishedAt = now()
          if (batch.kind === 'evaluation') batch.evaluation = evaluationSummary(batch.items, options.service, batch.sceneId)
          if (batch.kind === 'comparison') updateComparison(batch)
          await persist(batch)
        }
      } catch (error) {
        if (error instanceof CapabilityFactoryBatchOwnershipError) ownershipFailure = error.reason
        else throw error
      } finally {
        activeBatchKeys.delete(batchActiveKey)
      }
    }
    if (ownershipFailure !== undefined) throw ownershipFailure
    return structuredClone(batch)
  }

  /** 采纳前重新读取当前定义与所有运行，防止旧批次或缺失证据被复用。 */
  const assertAdoptable = (sceneId: string, batchId: string): CapabilityFactoryBatch => {
    const batch = get(sceneId, batchId)
    if (!batch || batch.kind !== 'comparison' || batch.status !== 'succeeded' || !batch.adoptable) throw new Error('批次不满足采纳条件')
    const scene = options.service.getScene(sceneId)
    if (!scene || scene.currentVersion !== batch.snapshot.sceneVersion) throw new Error('场景版本已变化，旧批次不能采纳')
    if (!scene.draft || scene.draft.createdAt !== batch.snapshot.draftCreatedAt
      || optimizationKey(scene.draft.definition) !== optimizationKey(batch.snapshot.draftDefinition)) throw new Error('候选草案已变化，旧批次不能采纳')
    const runIds = batch.items.flatMap((item) => [item.baselineRunId, item.candidateRunId])
      .filter((runId): runId is string => runId !== undefined)
    /** 每次采纳核验重新批读，不跨阶段缓存，确保审核使用当前最新证据。 */
    const runs = new Map(options.service.getRunsByIds(sceneId, runIds).map((run) => [run.id, run]))
    const comparisons = batch.items.map((item) => {
      const baseline = item.baselineRunId ? runs.get(item.baselineRunId) : undefined
      const candidate = item.candidateRunId ? runs.get(item.candidateRunId) : undefined
      if (!baseline || !candidate
        || baseline.comparisonId !== item.comparisonId || candidate.comparisonId !== item.comparisonId
        || baseline.comparisonRole !== 'baseline' || candidate.comparisonRole !== 'candidate'
        || baseline.sceneId !== batch.sceneId || candidate.sceneId !== batch.sceneId
        || baseline.sceneVersion !== batch.snapshot.sceneVersion || candidate.sceneVersion !== batch.snapshot.sceneVersion
        || optimizationKey(baseline.input) !== optimizationKey(item.input)
        || optimizationKey(candidate.input) !== optimizationKey(item.input)
        || baseline.definitionTarget !== 'current' || candidate.definitionTarget !== 'draft'
        || optimizationKey(baseline.definitionSnapshot) !== optimizationKey(scene.definition)
        || candidate.draftCreatedAt !== batch.snapshot.draftCreatedAt
        || optimizationKey(candidate.definitionSnapshot) !== optimizationKey(batch.snapshot.draftDefinition)) {
        throw new Error('批次运行证据缺失或身份不匹配')
      }
      return compareOptimizationPair(baseline, candidate)
    })
    if (!isAdoptableOptimizationBatch(comparisons)) throw new Error('批次运行证据不再满足采纳条件')
    return batch
  }

  return { run, list, get, assertAdoptable }
}

export type CapabilityFactoryBatchRunner = ReturnType<typeof createCapabilityFactoryBatchRunner>
