/** 定点补评只读取冻结运行；独立报告不能改写旧批次的质量轴。 */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { diagnoseCapabilityRun, getReviewSteps, getStepAcceptance, stableCapabilityValueKey } from '@proma/shared'
import type { CapabilityFactoryReviewRetryLimits, CapabilityFactoryReviewRetryRecord, CapabilityFactoryReviewRetryRequest,
  CapabilityFactoryRunDiagnosis, CapabilityRun, CapabilityRunModelBinding } from '@proma/shared'
import { ensureDirectoryDurable, writeJsonFileAtomicSecure } from '../safe-file'
import type { CapabilityFactoryService } from './capability-factory-service'
import type { CapabilityFactoryModelCall, CapabilityFactoryModelResolution } from './capability-factory-model-call'
import { createCapabilityFactoryCallLedger } from './capability-factory-budget'
import { reviewCapabilityRun } from './capability-factory-review'

/** 宿主提供归属与模型端口，Agent 不能替换原文、输出、标准或模型。 */
export interface CapabilityFactoryReviewRetryOptions {
  rootDir: string
  service: Pick<CapabilityFactoryService, 'getRun' | 'getScene'>
  resolveModels: (definition: NonNullable<CapabilityRun['definitionSnapshot']>) => CapabilityFactoryModelResolution
  callModel: CapabilityFactoryModelCall
  assertCurrent?(): void
  assertCanExecute?(): void
  isExperimentRun?(sceneId: string, runId: string): boolean
  signal?: AbortSignal
  onChanged?(sceneId: string): void
  now?: () => number
}
/** 同进程所有会话共享在途记录，读报告不把进行中的请求误判成崩溃。 */
const activeRetries = new Map<string, CapabilityFactoryReviewRetryRecord>()
/** 新进程只读旧证据，不恢复结果未知的请求。 */
const PROCESS_ID = randomUUID()
/** 十个步骤的报告与账本也必须保持有限，超限保留先前有效文件。 */
const MAX_RETRY_BYTES = 2 * 1024 * 1024
/** 异常后才收到的原始响应只保留排障片段，不无限扩展历史或 Agent 上下文。 */
const MAX_EXCLUDED_RESPONSE_CHARS = 24_000
/** 稳定摘要绑定全部原运行事实；补评不写入原运行，不需要排除字段。 */
function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableCapabilityValueKey(value)).digest('hex')
}
/** 与现有工厂文件名相同的身份白名单。 */
function assertId(value: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('场景或运行标识无效')
}
/** 预算只能收紧，不接受模型自行扩大的无限重试。 */
function assertLimits(limits: CapabilityFactoryReviewRetryLimits): void {
  if (!limits || !Number.isSafeInteger(limits.maxCalls) || limits.maxCalls < 1 || limits.maxCalls > 10
    || !Number.isSafeInteger(limits.maxTransportAttempts) || limits.maxTransportAttempts < 1 || limits.maxTransportAttempts > 20
    || !Number.isSafeInteger(limits.durationMs) || limits.durationMs < 1 || limits.durationMs > 600_000) {
    throw new Error('补评预算必须为 1–10 次调用、1–20 次可观察传输及 10 分钟以内')
  }
}

/** 输入同一工作区的真实服务；返回无模型诊断与每条源运行至多一次的补评方法。 */
export function createCapabilityFactoryReviewRetryService(options: CapabilityFactoryReviewRetryOptions) {
  /** 所有路径仅由宿主根目录与经过验证的身份派生。 */
  const rootDir = resolve(options.rootDir)
  const directory = join(rootDir, 'review-retries')
  const now = options.now ?? Date.now
  const assertOwner = (): void => { options.assertCurrent?.() }
  /** 写入前只查所有权；取消仍须保存已付出证据。 */
  const ensureDirectory = (create: boolean): boolean => {
    assertOwner()
    for (const path of [rootDir, directory]) {
      if (!existsSync(path)) { if (!create) return false; ensureDirectoryDurable(path) }
      const stat = lstatSync(path)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('补评记录目录必须是真实目录')
    }
    return true
  }
  /** 固定一源一文件，换会话或重复点击都不能刷新补评次数。 */
  const recordPath = (sceneId: string, runId: string): string => {
    assertId(sceneId); assertId(runId)
    return join(directory, `${fingerprint([sceneId, runId])}.json`)
  }
  const persist = (record: CapabilityFactoryReviewRetryRecord): void => {
    ensureDirectory(true)
    const file = { schemaVersion: 1, retry: record }
    if (Buffer.byteLength(JSON.stringify(file), 'utf8') > MAX_RETRY_BYTES) throw new Error('补评记录超过大小上限')
    writeJsonFileAtomicSecure(recordPath(record.sceneId, record.sourceRunId), file)
    try { options.onChanged?.(record.sceneId) } catch { /* 展示失败不否定已经落盘的额度。 */ }
  }
  /** 有界读取独立报告；坏文件显式拒绝，不能被当作尚未使用过补评机会。 */
  const read = (sceneId: string, runId: string): CapabilityFactoryReviewRetryRecord | null => {
    const path = recordPath(sceneId, runId)
    assertOwner()
    const active = activeRetries.get(path)
    if (active) return structuredClone(active)
    if (!ensureDirectory(false) || !existsSync(path)) return null
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    let value: unknown
    try {
      const stat = fstatSync(descriptor)
      if (!stat.isFile() || stat.size > MAX_RETRY_BYTES) throw new Error('补评文件无效或超过读取上限')
      const bytes = Buffer.alloc(stat.size + 1)
      let total = 0
      while (total < bytes.length) {
        const count = readSync(descriptor, bytes, total, bytes.length - total, null)
        if (count === 0) break
        total += count
      }
      if (total !== stat.size || fstatSync(descriptor).size !== stat.size) throw new Error('读取期间补评文件变化')
      value = JSON.parse(bytes.subarray(0, total).toString('utf8'))
    } finally { closeSync(descriptor) }
    if (!value || typeof value !== 'object' || !('schemaVersion' in value) || value.schemaVersion !== 1 || !('retry' in value)) throw new Error('补评文件版本无效')
    const record = value.retry as CapabilityFactoryReviewRetryRecord
    if (!record || record.sceneId !== sceneId || record.sourceRunId !== runId || typeof record.id !== 'string'
      || !['running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(record.status)
      || !Array.isArray(record.stepIds) || record.stepIds.length < 1 || record.stepIds.length > 10
      || !record.stepIds.every((id) => typeof id === 'string') || new Set(record.stepIds).size !== record.stepIds.length
      || !record.reviews || typeof record.reviews !== 'object' || Array.isArray(record.reviews) || !Array.isArray(record.calls)
      || !Number.isFinite(record.startedAt) || !Number.isFinite(record.deadlineAt)
      || (record.finishedAt !== null && !Number.isFinite(record.finishedAt))
      || typeof record.processId !== 'string' || typeof record.summary !== 'string' || typeof record.nextAction !== 'string'
      || typeof record.sourceFingerprint !== 'string' || typeof record.modelFingerprint !== 'string') throw new Error('补评记录身份或结构无效')
    assertLimits(record.limits)
    /** 复用账本的严格恢复校验，不能把损坏的已用量当成零。 */
    createCapabilityFactoryCallLedger({ ...record.limits, initialRecords: record.calls })
    if (record.status === 'running') {
      record.status = 'interrupted'
      record.finishedAt = now()
      record.summary = '上次补评已中断，已用和预留额度保留，不重发结果未知的请求。'
      record.nextAction = '检查已保存的原输出和补评记录，未完成部分保持未知。'
      persist(record)
    }
    return record
  }
  const requireRun = (sceneId: string, runId: string): CapabilityRun => {
    assertOwner(); assertId(sceneId); assertId(runId)
    if (!options.service.getScene(sceneId)) throw new Error('场景不存在')
    const run = options.service.getRun(sceneId, runId)
    if (!run || run.id !== runId || run.sceneId !== sceneId) throw new Error('运行记录不存在或不属于当前场景')
    return run
  }
  /** 只返回问题与补充报告，不把业务输入/输出再次打包进上下文。 */
  const diagnose = (sceneId: string, runId: string): CapabilityFactoryRunDiagnosis => {
    const run = requireRun(sceneId, runId)
    const diagnosis = diagnoseCapabilityRun(run)
    const retry = read(sceneId, runId)
    if (options.isExperimentRun?.(sceneId, runId)) {
      diagnosis.retryableStepIds = []
      diagnosis.nextAction = '本运行属于冻结实验，不能从补评入口追加调用；请按实验的预算与终止规则处理。'
    } else if (retry) {
      diagnosis.retryableStepIds = []
      diagnosis.nextAction = retry.nextAction
    }
    return { ...diagnosis, sceneId, runId, sourceFingerprint: fingerprint(run), retry }
  }
  /** 只补原评审故障；所有新报告独立于原始质量轴和采纳证据。 */
  const retry = async (request: CapabilityFactoryReviewRetryRequest): Promise<CapabilityFactoryReviewRetryRecord> => {
    assertOwner(); options.assertCanExecute?.(); options.signal?.throwIfAborted()
    assertLimits(request.limits)
    const source = requireRun(request.sceneId, request.runId)
    const sourceFingerprint = fingerprint(source)
    if (request.expectedSourceFingerprint !== sourceFingerprint) throw new Error('原运行已变化，请重新诊断')
    if (read(request.sceneId, request.runId)) throw new Error('每条原运行最多补评一次，已有记录不能重新消费')
    if (options.isExperimentRun?.(request.sceneId, request.runId)) throw new Error('冻结实验不能通过独立补评追加预算')
    const diagnosis = diagnoseCapabilityRun(source)
    if (!diagnosis.retryableStepIds.length || !source.definitionSnapshot) throw new Error(diagnosis.nextAction)
    const stepIds = diagnosis.retryableStepIds
    if (stepIds.length > 10 || request.limits.maxCalls < stepIds.length || request.limits.maxTransportAttempts < stepIds.length) throw new Error('补评预算不足以覆盖失败步骤，请先明确预算')
    const resolution = options.resolveModels(source.definitionSnapshot)
    if (resolution.error) throw new Error(`评审模型不可用：${resolution.error}`)
    const modelFingerprint = fingerprint(resolution)
    /** 按冻结步骤找原评审模型；模型已经换过时不能以新模型补旧证据。 */
    const definitions = getReviewSteps(source.definitionSnapshot.steps)
    const bindings = new Map<string, CapabilityRunModelBinding>()
    for (const stepId of stepIds) {
      const step = definitions.find((item) => item.id === stepId)
      const saved = source.stepReviews?.[stepId]?.modelBinding ?? (stepIds.length === 1 ? source.review?.modelBinding : undefined)
      const resolved = resolution.reviewBinding ?? resolution.bindings.find((item) => item.slotId === step?.modelSlot)
      if (!step || !saved || !resolved || stableCapabilityValueKey(saved) !== stableCapabilityValueKey(resolved)) throw new Error('实际评审模型与原记录不一致，不能静默换模型补评')
      bindings.set(stepId, structuredClone(saved))
    }
    const startedAt = now()
    const record: CapabilityFactoryReviewRetryRecord = { id: randomUUID(), sceneId: request.sceneId, sourceRunId: request.runId,
      sourceFingerprint, modelFingerprint, processId: PROCESS_ID, status: 'running', stepIds: [...stepIds],
      limits: structuredClone(request.limits), calls: [], reviews: {}, startedAt, deadlineAt: startedAt + request.limits.durationMs,
      finishedAt: null, summary: '正在按原标准补评已保存输出，不重新执行业务步骤。', nextAction: '等待本次补评结束。' }
    const path = recordPath(request.sceneId, request.runId)
    activeRetries.set(path, record)
    try {
      /** 第一次落盘就消耗唯一机会；进程崩溃不会导致自动重发。 */
      persist(record)
      const deadlineSignal = AbortSignal.timeout(request.limits.durationMs)
      const signal = options.signal ? AbortSignal.any([options.signal, deadlineSignal]) : deadlineSignal
      const storedLedger = createCapabilityFactoryCallLedger({ ...request.limits, deadlineAt: record.deadlineAt, now,
        onChange: (calls) => { record.calls = calls; persist(record) } })
      const assertSend = (): void => {
        assertOwner(); options.assertCanExecute?.(); signal.throwIfAborted()
        if (now() >= record.deadlineAt) throw new Error('补评总时限已用尽')
        if (fingerprint(requireRun(request.sceneId, request.runId)) !== sourceFingerprint) throw new Error('原运行已变化，停止补评')
        if (fingerprint(options.resolveModels(source.definitionSnapshot!)) !== modelFingerprint) throw new Error('评审模型配置已变化，停止补评')
      }
      /** 凭据等待与底层网络重试之后也复核身份；结算仅检查归属，取消后仍保存已用额度。 */
      const ledger: typeof storedLedger = {
        ...storedLedger,
        reserve: (reservation) => { assertSend(); return storedLedger.reserve(reservation) },
        markSent: (id, sendSignal, hiddenRetriesPossible) => {
          assertSend()
          storedLedger.markSent(id, sendSignal, hiddenRetriesPossible)
        },
      }
      for (const stepId of stepIds) {
        assertSend()
        const acceptance = getStepAcceptance(source.definitionSnapshot, stepId)
        if (!acceptance) throw new Error('原步骤评审标准缺失')
        const originalReview = source.stepReviews?.[stepId] ?? source.review
        if (!originalReview || stableCapabilityValueKey(originalReview.acceptance) !== stableCapabilityValueKey(acceptance)) throw new Error('原评审标准与冻结快照不一致')
        const traces = source.steps.filter((trace) => trace.stepId === stepId)
        const binding = bindings.get(stepId)!
        /** 清除原开始时间，补评耗时独立计量；材料形状与原步骤评审保持一致。 */
        const stepRun: CapabilityRun = { ...source, kind: 'step', stepId, review: undefined, steps: traces,
          outputs: { output: traces.map((trace) => trace.parsedOutput ?? trace.rawOutput) }, modelBindings: [binding] }
        record.reviews[stepId] = await reviewCapabilityRun({ run: stepRun, acceptance: structuredClone(acceptance), binding,
          signal, now, timeoutMs: Math.max(1, Math.min(120_000, record.deadlineAt - now())),
          callModel: async (invocation) => {
            assertSend()
            const response = await options.callModel({ ...invocation, signal: AbortSignal.any([signal, invocation.signal]), callLedger: ledger, purpose: 'review' })
            try {
              invocation.signal.throwIfAborted()
              assertSend()
            } catch (error) {
              /** 迟到或漂移后的材料只能作排障证据，不恢复已取消任务、不覆盖正式报告。 */
              record.excludedResponses ??= {}
              record.excludedResponses[stepId] = {
                text: response.text.slice(0, MAX_EXCLUDED_RESPONSE_CHARS),
                truncated: response.text.length > MAX_EXCLUDED_RESPONSE_CHARS,
                receivedAt: now(),
                reason: `不纳入质量结论：${error instanceof Error ? error.message : String(error)}`,
              }
              persist(record)
              throw error
            }
            return response
          },
        })
        persist(record)
        /** 单项再次故障就停，不继续消耗其它步骤来凑完整报告。 */
        if (record.reviews[stepId]!.status !== 'succeeded') break
      }
      record.status = options.signal?.aborted ? 'cancelled'
        : signal.aborted || Object.keys(record.reviews).length !== stepIds.length || Object.values(record.reviews).some((review) => review.status !== 'succeeded') ? 'failed' : 'completed'
      const reports = Object.values(record.reviews)
      record.summary = record.status === 'completed' ? '补评已完成，原输出和原评审记录保持不变。'
        : options.signal?.aborted ? '用户已停止补评，已用额度和报告已保留。'
          : `补评未完整完成：${reports.find((review) => review.error)?.error ?? '预算时限已用尽'}；已用额度保留。`
      record.nextAction = record.status !== 'completed' ? '本次补评机会已用完，请检查故障原因；未完成的内容质量保持未知。'
        : reports.some((review) => review.passed === false) ? '补评发现内容未达标，请按报告定位提示词问题；本报告不替代原批次认证。'
          : reports.some((review) => review.passed === null) ? '补评仍缺少判断依据，请补充可靠标签或核对标准，不能宣称质量通过。'
            : '所补步骤的评审已通过；请结合原运行其他步骤判断，本报告不改变原批次或实验的采纳资格。'
    } catch (error) {
      record.status = options.signal?.aborted ? 'cancelled' : 'failed'
      record.summary = `补评停止：${error instanceof Error ? error.message : String(error)}`
      record.nextAction = '保留原输出并排查停止原因；同一原运行不自动重复补评。'
    } finally {
      record.finishedAt = now()
      try { persist(record) } finally { activeRetries.delete(path) }
    }
    return structuredClone(record)
  }
  return { diagnose, retry }
}
