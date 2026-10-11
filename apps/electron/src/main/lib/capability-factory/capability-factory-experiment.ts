import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { compareOptimizationPair, isAdoptableOptimizationBatch, isPromptOnlyOptimization, stableCapabilityValueKey,
  validateCapabilityEvaluationProtocol, validateCapabilityExperimentSamples } from '@proma/shared'
import type { CapabilityExperimentAdvanceRequest, CapabilityExperimentCandidate, CapabilityExperimentCreateRequest,
  CapabilityExperimentQuality, CapabilityExperimentSample, CapabilityExperimentStage, CapabilityFactoryBatch,
  CapabilityFactoryBatchRequest, CapabilityFactoryExperiment, CapabilityFactoryExperimentView, CapabilityRun,
  CapabilitySceneDefinition } from '@proma/shared'
import { ensureDirectoryDurable, writeJsonFileAtomicSecure } from '../safe-file'
import type { CapabilityFactoryBatchService } from './capability-factory-batch'
import type { CapabilityFactoryModelResolution } from './capability-factory-model-call'
import { createCapabilityFactoryCallLedger } from './capability-factory-budget'
import type { CapabilityFactoryCallLedger } from './capability-factory-budget'
import { assertCapabilityScoringLabels, scoreCapabilityCase, summarizeCapabilityScores } from './capability-factory-scoring'

/** 宿主内部冻结入口；只向既有批次/runner 传可信快照，不接受 renderer 任意定义。 */
export interface CapabilityExperimentBatchContext {
  request: CapabilityFactoryBatchRequest
  baselineDefinition: CapabilitySceneDefinition
  candidate: CapabilityExperimentCandidate
  resolution: CapabilityFactoryModelResolution
  callLedger: CapabilityFactoryCallLedger
  signal: AbortSignal
  assertCurrent(): void
  onProgress(batch: CapabilityFactoryBatch): void
}
/** 实验服务只需要本地数据、既有批次执行口和宿主归属校验。 */
export interface CapabilityFactoryExperimentOptions {
  rootDir: string
  service: CapabilityFactoryBatchService
  resolveModels(definition: CapabilitySceneDefinition): CapabilityFactoryModelResolution
  /** 只返回工具/桩配置的摘要，不保存凭据。 */
  environmentFingerprint?(): string
  runBatch(context: CapabilityExperimentBatchContext): Promise<CapabilityFactoryBatch>
  assertCurrent?(): void
  /** 只在开始执行或业务变更时检查模式；读取历史不依赖它。 */
  assertCanExecute?(): void
  signal?: AbortSignal
  onChanged?(sceneId: string): void
  now?: () => number
  createId?: () => string
}
/** 同进程各 UI/Agent 实例共享活动记录，避免把等待中的阶段误判成重启。 */
const activeExperiments = new Map<string, { record: CapabilityFactoryExperiment; controller: AbortController }>()
/** 实验文件仅保存小规模元数据，拒绝异常大文件。 */
const MAX_FILE_BYTES = 8 * 1024 * 1024
/** 冻结定义与标签预留计量增长空间，防止后续账本无法落盘。 */
const MAX_INITIAL_BYTES = 2 * 1024 * 1024
/** 进程代际仅用于禁止批间恢复，不是用户或会话身份。 */
const PROCESS_ID = randomUUID()
/** 固定阶段顺序；没有恢复、额外候选或后台重复运行。 */
const SPLITS = ['optimization', 'validation', 'held-out'] as const
/** 稳定内容哈希只用于身份，不复制完整输入到指纹。 */
export function capabilityExperimentFingerprint(value: unknown): string {
  return createHash('sha256').update(stableCapabilityValueKey(value)).digest('hex')
}
/** 文件名采用已有工厂 ID 白名单，不允许路径片段。 */
function assertId(value: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('实验或场景标识无效')
}
/** 当前候选仅覆盖一个模型步骤的 prompt，其余契约保持原样。 */
function candidateFrom(definition: CapabilitySceneDefinition, stepId: string, prompt: string, id: 'A' | 'B', timestamp: number): CapabilityExperimentCandidate {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 128_000) throw new Error('候选提示词必须为 1–128000 字')
  const copy = structuredClone(definition)
  let changed = 0
  const visit = (steps: CapabilitySceneDefinition['steps']): void => {
    for (const step of steps) {
      if (step.type === 'map') visit(step.body)
      if (step.id !== stepId) continue
      if (step.type !== 'llm' && step.type !== 'extract') throw new Error('实验仅支持模型步骤提示词')
      if (step.prompt === prompt) throw new Error('候选提示词没有实际改动')
      step.prompt = prompt
      changed += 1
    }
  }
  visit(copy.steps)
  if (changed !== 1 || !isPromptOnlyOptimization(definition, copy)) throw new Error('实验必须且只能修改一个模型步骤提示词')
  return { id, prompt, definition: copy, fingerprint: capabilityExperimentFingerprint(copy), createdAt: timestamp }
}
/** 完整配对才有验证资格；旧采纳门槛与新质量门槛分别计算。 */
export function evaluateCapabilityExperimentStage(record: CapabilityFactoryExperiment, stage: CapabilityExperimentStage, runs: readonly CapabilityRun[]): CapabilityExperimentQuality {
  const samples = record.samples.filter((sample) => sample.split === stage.split)
  const byId = new Map(runs.map((run) => [run.id, run]))
  const candidate = record.candidates.find((item) => item.id === stage.candidateId && item.fingerprint === stage.candidateFingerprint)
  const comparisons: ReturnType<typeof compareOptimizationPair>[] = []
  const before = [] as ReturnType<typeof scoreCapabilityCase>[]
  const after = [] as ReturnType<typeof scoreCapabilityCase>[]
  const reasons: string[] = []
  let paired = 0
  /** 逐项校验引用身份，无法确认的运行按 unknown 保留在全部计划分母。 */
  for (const sample of samples) {
    const pairs = stage.pairs.filter((pair) => pair.caseId === sample.caseId)
    const pair = pairs.length === 1 ? pairs[0] : undefined
    let baseline = pair?.baselineRunId ? byId.get(pair.baselineRunId) : undefined
    let result = pair?.candidateRunId ? byId.get(pair.candidateRunId) : undefined
    const matches = (run: CapabilityRun | undefined, role: 'baseline' | 'candidate'): boolean => Boolean(run && candidate
      && typeof pair?.comparisonId === 'string' && pair.comparisonId.length > 0
      && run.kind !== 'step' && pair.baselineRunId !== pair.candidateRunId
      && stage.pairs.filter((entry) => entry.baselineRunId === run.id || entry.candidateRunId === run.id).length === 1
      && run.sceneId === record.sceneId && run.sceneVersion === record.sceneVersion
      && run.comparisonId === pair?.comparisonId && run.comparisonRole === role
      && run.definitionTarget === (role === 'baseline' ? 'current' : 'draft')
      && capabilityExperimentFingerprint(run.input) === sample.inputFingerprint
      && capabilityExperimentFingerprint(run.modelBindings) === capabilityExperimentFingerprint(record.modelBindings)
      && capabilityExperimentFingerprint(run.definitionSnapshot) === capabilityExperimentFingerprint(role === 'baseline' ? record.baselineDefinition : candidate.definition)
      && (role === 'baseline' || run.draftCreatedAt === candidate.createdAt)
      && (!record.reviewModelBinding || capabilityExperimentFingerprint(run.review?.modelBinding) === capabilityExperimentFingerprint(record.reviewModelBinding)))
    if (!matches(baseline, 'baseline')) baseline = undefined
    if (!matches(result, 'candidate')) result = undefined
    if (baseline && result) { paired += 1; comparisons.push(compareOptimizationPair(baseline, result)) }
    const baselineScore = scoreCapabilityCase(record.protocol, sample, baseline)
    const candidateScore = scoreCapabilityCase(record.protocol, sample, result)
    before.push(baselineScore)
    after.push(candidateScore)
    if (pair) { pair.baselineScore = baselineScore; pair.candidateScore = candidateScore }
  }
  const baseline = summarizeCapabilityScores(samples.map((sample) => sample.caseId), before)
  const candidateSummary = summarizeCapabilityScores(samples.map((sample) => sample.caseId), after)
  const unknown = samples.filter((_sample, index) => before[index]?.outcome === 'unknown' || after[index]?.outcome === 'unknown').length
  if (paired !== samples.length || unknown > 0) reasons.push('完整配对或确定结果不足，未知结果计入分母')
  if (samples.some((sample) => sample.labelStatus !== 'complete')) reasons.push('主质量指标要求完整且已核对的标签')
  if (comparisons.some((comparison) => !comparison.comparable || !comparison.candidatePassed || comparison.regressed.length > 0 || comparison.unknown.length > 0)) reasons.push('既有评审不可比、候选未通过、存在退化或未知')
  const emptyRegressed = before.some((score, index) => score.correctEmpty === true && after[index]?.correctEmpty !== true)
  if (emptyRegressed) reasons.push('无目标实体的样本出现新增误报')
  /** 双方严格共用同一非空完整标签分母，不能因失败而缩小。 */
  const sameF1Denominator = before.every((score, index) => score.f1Eligible === after[index]?.f1Eligible)
  const f1Delta = sameF1Denominator && baseline.macroF1 !== null && candidateSummary.macroF1 !== null
    ? candidateSummary.macroF1 - baseline.macroF1 : null
  const improved = record.protocol.primaryMetric === 'f1' ? f1Delta !== null && f1Delta > 1e-6
    : unknown === 0 && candidateSummary.failed < baseline.failed
  if (!improved) reasons.push('预先选定的主指标没有严格改善')
  const validationEligible = samples.length > 0 && reasons.length === 0
  const adoptionEligible = validationEligible && isAdoptableOptimizationBatch(comparisons)
    && (record.heldOutExposureAtStart ?? record.heldOutExposure) === 'declared-unseen'
  return { planned: samples.length, paired, unknown, baselineMacroF1: baseline.macroF1, candidateMacroF1: candidateSummary.macroF1,
    f1Delta, baselineFailures: baseline.failed, candidateFailures: candidateSummary.failed,
    baselineErrorBounds: [baseline.errorRateLower ?? 0, baseline.errorRateUpper ?? 1],
    candidateErrorBounds: [candidateSummary.errorRateLower ?? 0, candidateSummary.errorRateUpper ?? 1],
    validationEligible, adoptionEligible, reasons }
}

/** 创建持久实验服务；无真实模型数据时所有能力均可离线测试。 */
export function createCapabilityFactoryExperimentService(options: CapabilityFactoryExperimentOptions) {
  const rootDir = resolve(options.rootDir)
  const directory = join(rootDir, 'experiments')
  const workspaceFingerprint = capabilityExperimentFingerprint(rootDir)
  const now = options.now ?? Date.now
  const createId = options.createId ?? randomUUID
  const assertOwner = (): void => options.assertCurrent?.()
  const activeKey = (id: string): string => JSON.stringify([rootDir, id])
  /** 拒绝目录符号链接，不把受管记录写到工作区以外。 */
  const ensureDirectory = (create: boolean): boolean => {
    assertOwner()
    for (const path of [rootDir, directory]) {
      if (!existsSync(path)) { if (!create) return false; ensureDirectoryDurable(path) }
      const stat = lstatSync(path)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('实验目录必须是真实目录')
    }
    return true
  }
  const filePath = (id: string): string => { assertId(id); return join(directory, `${id}.json`) }
  /** 所有额度变化先落盘；写失败不允许继续发请求。 */
  const persist = (record: CapabilityFactoryExperiment): void => {
    assertOwner()
    ensureDirectory(true)
    record.revision += 1
    record.updatedAt = now()
    const file = { schemaVersion: 1, experiment: record }
    if (Buffer.byteLength(JSON.stringify(file), 'utf8') > MAX_FILE_BYTES) throw new Error('实验记录超过写入上限，旧证据已保留')
    writeJsonFileAtomicSecure(filePath(record.id), file)
    options.onChanged?.(record.sceneId)
  }
  /** 有限读取并复核文件和工作区身份，未知格式不得覆盖。 */
  const read = (sceneId: string | undefined, id: string): CapabilityFactoryExperiment | null => {
    if (sceneId !== undefined) assertId(sceneId)
    assertId(id)
    if (!ensureDirectory(false) || !existsSync(filePath(id))) return null
    const active = activeExperiments.get(activeKey(id))
    if (active) { if (sceneId !== undefined && active.record.sceneId !== sceneId) throw new Error('实验不属于当前场景'); return structuredClone(active.record) }
    const descriptor = openSync(filePath(id), constants.O_RDONLY | constants.O_NOFOLLOW)
    let value: unknown
    try {
      const stat = fstatSync(descriptor)
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('实验文件无效或超过读取上限')
      const bytes = Buffer.alloc(stat.size + 1)
      let total = 0
      while (total < bytes.length) {
        const count = readSync(descriptor, bytes, total, bytes.length - total, null)
        if (count === 0) break
        total += count
      }
      if (total > stat.size || fstatSync(descriptor).size !== stat.size) throw new Error('读取期间实验文件已变化')
      value = JSON.parse(bytes.subarray(0, total).toString('utf8'))
    } finally { closeSync(descriptor) }
    if (!value || typeof value !== 'object' || !('schemaVersion' in value) || value.schemaVersion !== 1 || !('experiment' in value)) throw new Error('实验文件版本无效')
    const record = value.experiment as CapabilityFactoryExperiment
    if (!record || record.id !== id || typeof record.sceneId !== 'string' || record.workspaceFingerprint !== workspaceFingerprint
      || !Array.isArray(record.samples) || !Array.isArray(record.stages) || !Array.isArray(record.candidates) || !Array.isArray(record.calls)
      || !Number.isInteger(record.revision)) throw new Error('实验身份或记录结构无效')
    if (sceneId !== undefined && record.sceneId !== sceneId) throw new Error('实验不属于当前场景')
    if (record.running || (record.startedAt !== null && record.processId !== PROCESS_ID
      && ['optimizing', 'validating', 'held-out'].includes(record.status))) {
      record.status = 'interrupted'
      record.running = false
      record.stopReason = '进程中断；已用和预留额度保留，结果未知的请求不重发'
      record.finishedAt = now()
      persist(record)
    }
    return record
  }
  const requireRecord = (sceneId: string, id: string): CapabilityFactoryExperiment => {
    const record = read(sceneId, id)
    if (!record) throw new Error('实验不存在')
    return record
  }
  /** 运行前和每次请求前复核全部冻结身份；普通草案变化不影响独立候选。 */
  const assertSnapshot = (record: CapabilityFactoryExperiment): CapabilityFactoryModelResolution => {
    assertOwner()
    const scene = options.service.getScene(record.sceneId)
    if (!scene || scene.currentVersion !== record.sceneVersion || capabilityExperimentFingerprint(scene.definition) !== capabilityExperimentFingerprint(record.baselineDefinition)) throw new Error('场景版本或定义已变化')
    const dataset = options.service.listDatasets().find((item) => item.id === record.datasetId)
    if (!dataset || dataset.version !== record.datasetVersion || capabilityExperimentFingerprint(dataset) !== record.datasetFingerprint) throw new Error('数据集或标签已变化')
    if (capabilityExperimentFingerprint({ protocol: record.protocol, samples: record.samples }) !== record.protocolFingerprint) throw new Error('评测协议或标签身份已变化')
    if (record.environmentFingerprint !== options.environmentFingerprint?.()) throw new Error('虚拟接入配置已变化')
    const resolution = options.resolveModels(record.baselineDefinition)
    if (resolution.error || capabilityExperimentFingerprint(resolution) !== record.modelFingerprint) throw new Error('实际执行或评审模型已变化')
    return resolution
  }
  const getStageRuns = (record: CapabilityFactoryExperiment, stage: CapabilityExperimentStage): CapabilityRun[] => options.service.getRunsByIds(record.sceneId,
    stage.pairs.flatMap((pair) => [pair.baselineRunId, pair.candidateRunId]).filter((id): id is string => id !== undefined))
  /** 对外脱去验证/留出标签；只有显式详情读取才提供对应原文和标签。 */
  const project = (record: CapabilityFactoryExperiment, detailsSplit?: CapabilityExperimentSample['split']): CapabilityFactoryExperimentView => {
    const { samples, ...rest } = structuredClone(record)
    const view: CapabilityFactoryExperimentView = { ...rest, samples: samples.map(({ expected: _expected, ...sample }) => sample) }
    if (detailsSplit) {
      const dataset = options.service.listDatasets().find((item) => item.id === record.datasetId)
      if (!dataset || capabilityExperimentFingerprint(dataset) !== record.datasetFingerprint) {
        view.detailsUnavailableReason = '数据集已变化，历史冻结输入无法从当前数据集还原'
        return view
      }
      view.details = samples.filter((sample) => sample.split === detailsSplit).flatMap((sample) => {
        const item = dataset?.cases.find((entry) => entry.id === sample.caseId)
        return item ? [{ caseId: item.id, input: structuredClone(item.input), ...(sample.expected === undefined ? {} : { expected: structuredClone(sample.expected) }) }] : []
      })
    }
    return view
  }
  /** 跨场景读取来源使用历史；损坏记录必须显式失败，不能被当成未见材料。 */
  const allRecords = (): CapabilityFactoryExperiment[] => {
    if (!ensureDirectory(false)) return []
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (entry.isSymbolicLink()) throw new Error('实验文件不能是符号链接')
      if (!entry.isFile() || !entry.name.endsWith('.json')) return []
      const record = read(undefined, entry.name.slice(0, -5))
      return record ? [record] : []
    }).sort((left, right) => right.createdAt - left.createdAt)
  }
  /** 面板仅展示本场景摘要，来源退休仍扫描整个工作区。 */
  const list = (sceneId: string): CapabilityFactoryExperimentView[] => {
    assertId(sceneId)
    return allRecords().filter((record) => record.sceneId === sceneId).map((record) => project(record))
  }
  const create = (request: CapabilityExperimentCreateRequest): CapabilityFactoryExperiment => {
    assertOwner()
    options.assertCanExecute?.()
    options.signal?.throwIfAborted()
    assertId(request.sceneId)
    assertId(request.datasetId)
    const scene = options.service.getScene(request.sceneId)
    if (!scene || scene.currentVersion !== request.expectedVersion) throw new Error('场景不存在或版本已变化')
    const dataset = options.service.listDatasets().find((item) => item.id === request.datasetId)
    if (!dataset) throw new Error('数据集不存在')
    const protocol = validateCapabilityEvaluationProtocol(request.protocol)
    if (!Array.isArray(request.assignments) || request.assignments.length > 30) throw new Error('实验最多 30 条样本')
    const samples = validateCapabilityExperimentSamples(request.assignments.map((assignment) => {
      const item = dataset.cases.find((entry) => entry.id === assignment.caseId)
      if (!item) throw new Error('实验用例不存在')
      return { ...assignment, inputFingerprint: capabilityExperimentFingerprint(item.input), ...(item.expected === undefined ? {} : { expected: structuredClone(item.expected) }) }
    }))
    for (const split of SPLITS) {
      const count = samples.filter((sample) => sample.split === split).length
      if (count < 1 || count > 10) throw new Error('优化、验证、留出各需 1–10 条来源独立样本')
    }
    assertCapabilityScoringLabels(protocol, samples)
    if (protocol.primaryMetric === 'f1' && (protocol.mode !== 'tuple-set' || SPLITS.some((split) => !samples.some((sample) =>
      sample.split === split && scoreCapabilityCase(protocol, sample).f1Eligible)))) throw new Error('F1实验每组必须有可评分的非空完整标签集合')
    const limits = request.limits
    if (!limits || !Number.isInteger(limits.maxCalls) || limits.maxCalls < 1 || limits.maxCalls > 1_000
      || !Number.isInteger(limits.maxTransportAttempts) || limits.maxTransportAttempts < 1 || limits.maxTransportAttempts > 2_000
      || !Number.isInteger(limits.durationMs) || limits.durationMs < 1 || limits.durationMs > 86_400_000) throw new Error('实验必须提供有限调用次数、传输次数及一天以内的时限')
    if (!['declared-unseen', 'exposed', 'unknown'].includes(request.heldOutExposure)) throw new Error('留出暴露状态无效')
    const resolution = options.resolveModels(scene.definition)
    if (resolution.error || resolution.bindings.length === 0) throw new Error(resolution.error ?? '实验没有可用模型')
    const timestamp = now()
    const candidate = candidateFrom(scene.definition, request.targetStepId, request.candidatePrompt, 'A', timestamp)
    /** 已见来源不能靠新实验ID重新声明为留出，保留前次花费引用。 */
    const previous = allRecords()
    const seen = previous.flatMap((item) => item.samples.filter((sample) => sample.split === 'optimization'
      || item.heldOutExposure === 'exposed' || item.stages.some((stage) => stage.split === sample.split)))
    const reused = samples.some((sample) => sample.split !== 'optimization' && seen.some((prior) =>
      prior.inputFingerprint === sample.inputFingerprint || prior.sourceGroupId === sample.sourceGroupId))
    const record: CapabilityFactoryExperiment = { id: createId(), sceneId: scene.id, workspaceFingerprint, revision: 0,
      status: 'prepared', running: false, processId: PROCESS_ID, sceneVersion: scene.currentVersion, datasetId: dataset.id, datasetVersion: dataset.version,
      datasetFingerprint: capabilityExperimentFingerprint(dataset), protocol, protocolFingerprint: capabilityExperimentFingerprint({ protocol, samples }),
      samples, targetStepId: request.targetStepId, baselineDefinition: structuredClone(scene.definition),
      modelBindings: structuredClone(resolution.bindings), ...(resolution.reviewBinding ? { reviewModelBinding: structuredClone(resolution.reviewBinding) } : {}),
      modelFingerprint: capabilityExperimentFingerprint(resolution),
      ...(options.environmentFingerprint ? { environmentFingerprint: options.environmentFingerprint() } : {}),
      ...(previous.find((item) => item.sceneId === scene.id) ? { previousExperimentId: previous.find((item) => item.sceneId === scene.id)!.id } : {}),
      candidates: [candidate], stages: [], heldOutExposure: reused ? 'exposed' : request.heldOutExposure,
      limits: structuredClone(limits), calls: [], roundsUsed: 0, runUnitsReserved: 0, createdAt: timestamp, startedAt: null, deadlineAt: null,
      updatedAt: timestamp, finishedAt: null, providerRevision: 'unknown', proposalCost: 'unattributed' }
    if (Buffer.byteLength(JSON.stringify(record), 'utf8') > MAX_INITIAL_BYTES) throw new Error('初始实验元数据超过 2 MiB，请减少标签或定义大小')
    if (existsSync(filePath(record.id))) throw new Error('实验标识已存在')
    persist(record)
    return structuredClone(record)
  }
  /** 每次调用只推进一组；请求前冻结额度，任何异常都保留已完成证据。 */
  const advance = async (request: CapabilityExperimentAdvanceRequest): Promise<CapabilityFactoryExperiment> => {
    options.assertCanExecute?.()
    const record = requireRecord(request.sceneId, request.experimentId)
    if (record.revision !== request.expectedRevision) throw new Error('实验版本已变化，请重新读取')
    if (record.running || activeExperiments.has(activeKey(record.id))) throw new Error('实验正在执行')
    const stageIndex = ['prepared', 'optimizing', 'validating'].indexOf(record.status)
    if (stageIndex < 0 || record.stages.length !== stageIndex) throw new Error('实验已终止或阶段顺序无效')
    if (request.candidatePrompt !== undefined && stageIndex !== 1) throw new Error('仅优化组完成后允许修订一次候选')
    if (stageIndex === 2 && !record.stages[1]?.quality?.validationEligible) throw new Error('验证未通过，不能进入留出')
    const controller = new AbortController()
    activeExperiments.set(activeKey(record.id), { record, controller })
    try {
      options.signal?.throwIfAborted()
      const resolution = assertSnapshot(record)
      if (stageIndex === 2) {
        const validation = record.stages[1]!
        validation.quality = evaluateCapabilityExperimentStage(record, validation, getStageRuns(record, validation))
        if (!validation.quality.validationEligible || validation.candidateFingerprint !== record.candidates.at(-1)?.fingerprint) {
          throw new Error('验证证据已变化或不足，不能进入留出')
        }
        record.heldOutExposureAtStart = record.heldOutExposure
      }
      if (record.heldOutExposure === 'exposed') throw new Error('留出集已暴露，本次实验停止；请使用新来源')
      if (request.candidatePrompt !== undefined && request.candidatePrompt !== record.candidates[0]?.prompt) {
        if (record.candidates.length !== 1) throw new Error('最多两个候选')
        record.candidates.push(candidateFrom(record.baselineDefinition, record.targetStepId, request.candidatePrompt, 'B', now()))
      }
      const candidate = record.candidates.at(-1)!
      const split = SPLITS[stageIndex]!
      const samples = record.samples.filter((sample) => sample.split === split)
      const units = samples.length * 2
      if (record.roundsUsed >= 3 || record.runUnitsReserved + units > 60) throw new Error('实验 3 批 / 60 次运行额度已用尽')
      record.startedAt ??= now()
      record.deadlineAt ??= record.startedAt + record.limits.durationMs
      if (now() >= record.deadlineAt) throw new Error('实验已到截止时间')
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, record.deadlineAt - now())), ...(options.signal ? [options.signal] : [])])
      const assertCurrent = (): void => {
        signal.throwIfAborted()
        if (record.heldOutExposure === 'exposed') throw new Error('实验材料已暴露，停止后续调用')
        assertSnapshot(record)
      }
      record.status = stageIndex === 0 ? 'optimizing' : stageIndex === 1 ? 'validating' : 'held-out'
      record.running = true
      record.roundsUsed += 1
      record.runUnitsReserved += units
      const stage: CapabilityExperimentStage = { split, candidateId: candidate.id, candidateFingerprint: candidate.fingerprint,
        pairs: samples.map((sample) => ({ caseId: sample.caseId })), startedAt: now(), finishedAt: null }
      record.stages.push(stage)
      persist(record)
      const callLedger = createCapabilityFactoryCallLedger({ maxCalls: record.limits.maxCalls, maxTransportAttempts: record.limits.maxTransportAttempts,
        deadlineAt: record.deadlineAt, initialRecords: record.calls, now,
        onChange: (calls) => { record.calls = calls; persist(record) } })
      const progress = (batch: CapabilityFactoryBatch): void => {
        assertOwner()
        stage.batchId = batch.id
        stage.pairs = batch.items.map((item) => ({ caseId: item.id, comparisonId: item.comparisonId,
          baselineRunId: item.baselineRunId, candidateRunId: item.candidateRunId }))
        persist(record)
      }
      const batch = await options.runBatch({ request: { sceneId: record.sceneId, kind: 'comparison', datasetId: record.datasetId,
        caseIds: samples.map((sample) => sample.caseId), expectedVersion: record.sceneVersion,
        expectedDraftCreatedAt: candidate.createdAt, expectedDraftDefinition: structuredClone(candidate.definition) },
        baselineDefinition: structuredClone(record.baselineDefinition), candidate: structuredClone(candidate), resolution: structuredClone(resolution),
        callLedger, signal, assertCurrent, onProgress: progress })
      progress(batch)
      stage.finishedAt = now()
      stage.quality = evaluateCapabilityExperimentStage(record, stage, getStageRuns(record, stage))
      assertCurrent()
      if (batch.status !== 'succeeded') throw new Error(batch.error ?? '阶段未完整完成，不能继续')
      if (stageIndex === 1 && !stage.quality.validationEligible) throw new Error(stage.quality.reasons.join('；'))
      if (stageIndex === 2) { record.status = 'completed'; record.finishedAt = now() }
    } catch (error) {
      record.status = controller.signal.aborted || options.signal?.aborted ? 'cancelled' : 'failed'
      record.stopReason = error instanceof Error ? error.message : String(error)
      record.finishedAt = now()
      const stage = record.stages.at(-1)
      if (stage && !stage.finishedAt) {
        stage.finishedAt = now()
        stage.quality = evaluateCapabilityExperimentStage(record, stage, getStageRuns(record, stage))
      }
    } finally {
      try { record.running = false; persist(record) } finally { activeExperiments.delete(activeKey(record.id)) }
    }
    return structuredClone(record)
  }
  const cancel = (sceneId: string, id: string): CapabilityFactoryExperiment => {
    options.assertCanExecute?.()
    const current = requireRecord(sceneId, id)
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(current.status)) return current
    const active = activeExperiments.get(activeKey(id))
    const record = active?.record ?? current
    active?.controller.abort(new Error('用户停止了实验'))
    record.status = 'cancelled'
    record.stopReason = '用户停止了实验；已用和预留额度保留'
    record.finishedAt = now()
    persist(record)
    return structuredClone(record)
  }
  const view = (sceneId: string, id: string, detailsSplit: CapabilityExperimentSample['split'] = 'optimization'): CapabilityFactoryExperimentView | null => {
    const current = read(sceneId, id)
    if (!current) return null
    const record = activeExperiments.get(activeKey(id))?.record ?? current
    if (detailsSplit === 'held-out' || (detailsSplit === 'validation' && record.stages.length < 2)) {
      record.heldOutExposure = 'exposed'
      persist(record)
    }
    return project(record, detailsSplit)
  }
  /** 旧读取工具仍可看到材料；记录可观察的暴露，不能承诺文件级隔离。 */
  const markExposureForRead = (request: { kind: 'datasets' | 'run' | 'batch' | 'runs'; sceneId?: string; runId?: string; runIds?: readonly string[]; batchId?: string }): void => {
    if (request.sceneId !== undefined) assertId(request.sceneId)
    /** 列表可能为空、被限量或仅含优化运行；只有实际交给 Agent 的受保护运行才算暴露。 */
    const returnedRunIds = new Set(request.kind === 'runs' ? request.runIds ?? [] : request.runId ? [request.runId] : [])
    const records = allRecords().filter((item) => request.sceneId === undefined || item.sceneId === request.sceneId)
    for (const current of records) {
      const record = activeExperiments.get(activeKey(current.id))?.record ?? current
      const relevant = request.kind === 'datasets' || record.stages.some((stage) =>
        (stage.split === 'held-out' || stage.split === 'validation') && ((request.batchId !== undefined && stage.batchId === request.batchId)
          || stage.pairs.some((pair) => (pair.baselineRunId !== undefined && returnedRunIds.has(pair.baselineRunId))
            || (pair.candidateRunId !== undefined && returnedRunIds.has(pair.candidateRunId)))))
      if (relevant && record.heldOutExposure !== 'exposed') { record.heldOutExposure = 'exposed'; persist(record) }
    }
  }
  /** 采纳阶段重读引用结果，不能信任历史汇总或任意整份草案证据。 */
  const assertAdoptable = (sceneId: string, id: string, actualMergedDefinition: CapabilitySceneDefinition): CapabilityFactoryExperiment => {
    const record = requireRecord(sceneId, id)
    assertSnapshot(record)
    if (record.status !== 'completed' || record.running || record.stages.length !== 3) throw new Error('实验尚未完成')
    const validation = record.stages[1]!
    const heldOut = record.stages[2]!
    if (heldOut.candidateFingerprint !== validation.candidateFingerprint || heldOut.candidateId !== validation.candidateId) throw new Error('验证和留出不是同一冻结候选')
    if (capabilityExperimentFingerprint(actualMergedDefinition) !== heldOut.candidateFingerprint) throw new Error('实际合并场景不是已测试候选')
    validation.quality = evaluateCapabilityExperimentStage(record, validation, getStageRuns(record, validation))
    heldOut.quality = evaluateCapabilityExperimentStage(record, heldOut, getStageRuns(record, heldOut))
    if (!validation.quality.validationEligible || !heldOut.quality.adoptionEligible) throw new Error('实验质量、旧采纳规则或独立留出证据不足')
    return structuredClone(record)
  }
  return { create, get: (sceneId: string, id: string) => read(sceneId, id), list, view, advance, cancel, assertAdoptable, markExposureForRead }
}
export type CapabilityFactoryExperimentService = ReturnType<typeof createCapabilityFactoryExperimentService>
