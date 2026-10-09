/**
 * 「评测」这一段的适配器：**对一组固定输入跑当前版本，产出可比的一行分数**。
 *
 * 与单次运行的区别就在这里：单次运行回答"这一条跑出了什么"，评测回答
 * "在 20 条真实输入上，有多少条输出合法" —— 没有它，改完提示词只能说"看起来好点了"。
 *
 * 质量与约束是两条独立轴：
 * ① 约束轴统计合法输出；质量轴复用每次运行自动产生的 `review`，聚合明确判定过的判据。
 *    评审缺失、失败或无法判断都不能算通过。
 * ② 指标的单位和方向由场景自行定义，批量层不擅自平均，因此 `metrics` 保持为空。
 * ② 每条用例就是一次**整链运行**（记录照常落盘），所以"是哪几条没过"点得进去看。
 * ③ 分数永远挂 (场景版本, 数据集版本)：用例改了、场景改了，都不能和旧分直接比。
 */
import type {
  CapabilityCase, CapabilityEvaluation, CapabilityEvaluationCaseResult, CapabilityRun,
} from '@proma/shared'
import { getReviewSteps, getStepAcceptance } from '@proma/shared'
import {
  CapabilityFactoryError, stableCapabilityValueKey, type CapabilityFactoryService,
} from './capability-factory-service'

/** 评测适配器依赖。 */
export interface CapabilityFactoryEvaluateDeps {
  service: CapabilityFactoryService
  /** 跑一次整链运行的入口（与「运行」页共用同一个 runner）。 */
  run: (
    sceneId: string,
    input: Record<string, unknown>,
    options?: { saveTask?: boolean; expectedVersion?: number },
  ) => Promise<CapabilityRun>
  now?: () => number
  createId?: () => string
  /** 当前 Agent 回合的停止信号；已完成用例仍保留在批次终态。 */
  signal?: AbortSignal
  /** 会话、工作区与写权限归属复核；失败后禁止保存迟到批次。 */
  assertCurrent?: () => void
}

/** 从运行记录里取一句"这条为什么不算过"。 */
function describeCaseFailure(run: CapabilityRun): string {
  if (run.error) return run.error
  const constraintErrors = run.steps.flatMap((step) => step.constraintErrors ?? [])
  if (constraintErrors.length > 0) return constraintErrors[0] ?? ''
  const failedStep = run.steps.find((step) => step.status !== 'succeeded')
  if (failedStep) return `${failedStep.title}：${failedStep.error ?? '未完成'}`
  return '输出不满足约束'
}

/**
 * 创建评测适配器。
 *
 * @param deps 服务与整链运行入口
 * @returns `evaluate(sceneId, datasetId)`：跑完并落盘，返回带逐条结果的评测记录
 */
export function createCapabilityFactoryEvaluator(deps: CapabilityFactoryEvaluateDeps) {
  const now = deps.now ?? (() => Date.now())
  const createId = deps.createId ?? (() => crypto.randomUUID())

  /** 每次外部调用与写盘前复核当前归属。 */
  const assertCurrent = (): void => deps.assertCurrent?.()

  return {
    /**
     * 对一个数据集跑一次评测。
     *
     * 失败也落盘（记 status=failed + 原因）："为什么没评起来"同样是要观察的过程。
     */
    async evaluate(sceneId: string, datasetId: string): Promise<CapabilityEvaluation> {
      assertCurrent()
      const scene = deps.service.getScene(sceneId)
      if (!scene) throw new CapabilityFactoryError('SCENE_NOT_FOUND', `场景不存在：${sceneId}`)
      /** 批次开始时固定版本与判据，后续不再从可变的场景对象读取。 */
      const sceneVersion = scene.currentVersion
      /** 固定本批每个模型步骤的判据；多步骤用前缀避免同名标准互相覆盖。 */
      const reviewable = getReviewSteps(scene.definition.steps)
        .flatMap((step) => {
          const acceptance = getStepAcceptance(scene.definition, step.id)
          return acceptance ? [{ stepId: step.id, criteria: acceptance.criteria }] : []
        })
      const acceptanceCriteria = reviewable.length <= 1
        ? (reviewable[0]?.criteria ?? [])
        : reviewable.flatMap(({ stepId, criteria }) => criteria.map((criterion) => `[${stepId}] ${criterion}`))
      const currentDataset = deps.service.listDatasets().find((item) => item.id === datasetId)
      if (!currentDataset) throw new CapabilityFactoryError('DATASET_NOT_FOUND', `数据集不存在：${datasetId}`)
      /** 批次开始即冻结用例与版本，后续数据集编辑不影响本轮。 */
      const dataset = structuredClone(currentDataset)

      const startedAt = now()
      const record = (partial: Omit<CapabilityEvaluation, 'id' | 'sceneId' | 'sceneVersion' | 'datasetId' | 'datasetVersion' | 'startedAt'>): CapabilityEvaluation => {
        assertCurrent()
        return deps.service.recordEvaluation({
          id: createId(), sceneId, sceneVersion,
          datasetId, datasetVersion: dataset.version, startedAt, ...partial,
        })
      }

      if (dataset.cases.length === 0) {
        return record({
          status: 'failed', constraintCompliance: 0, validSamples: 0, totalSamples: 0,
          reviewedSamples: 0, passedReviewSamples: 0,
          metrics: {}, judgeResults: [], baselineId: null, finishedAt: now(),
          error: '数据集里还没有用例：先把一次真实运行的输入「固化成用例」再评测。',
        })
      }

      if (dataset.cases.length > 10) {
        return record({
          status: 'failed', constraintCompliance: 0, validSamples: 0, totalSamples: dataset.cases.length,
          reviewedSamples: 0, passedReviewSamples: 0,
          metrics: {}, judgeResults: [], baselineId: null, finishedAt: now(),
          error: `单批评测最多 10 条用例，当前为 ${dataset.cases.length} 条；请拆分数据集后重试。`,
        })
      }

      if (deps.signal?.aborted) {
        return record({
          status: 'failed', constraintCompliance: 0, validSamples: 0, totalSamples: dataset.cases.length,
          reviewedSamples: 0, passedReviewSamples: 0,
          metrics: {}, judgeResults: [], baselineId: null, caseResults: [], finishedAt: now(),
          error: '评测已取消，尚未启动用例。',
        })
      }

      /** 逐条跑：串行即可（并发会在同一工作区里争用运行记录文件），且失败不中断整轮。 */
      const caseResults: CapabilityEvaluationCaseResult[] = []
      /** 第一条完成运行冻结实际模型绑定；同版本中途切模型也不能混进同一批次。 */
      let frozenModelBinding: string | null | undefined
      for (const item of dataset.cases) {
        if (deps.signal?.aborted) return recordStoppedEvaluation('评测已取消，已保留完成用例。')
        assertCurrent()
        let result: Awaited<ReturnType<typeof evaluateCase>>
        try {
          result = await evaluateCase(item)
        } catch (error) {
          if (deps.signal?.aborted) return recordStoppedEvaluation('评测已取消，已保留完成用例。')
          throw error
        }
        if (result.kind === 'version-changed') {
          return recordStoppedEvaluation(`评测期间场景版本发生变化：本批固定为 v${sceneVersion}，已停止后续用例，避免混合版本。`)
        }
        if (result.kind === 'model-changed') {
          return recordStoppedEvaluation('评测期间实际模型绑定发生变化，已停止后续用例，避免混合模型结果。')
        }
        caseResults.push(result.result)
        if (frozenModelBinding === undefined) frozenModelBinding = result.modelBinding
        if (deps.signal?.aborted) return recordStoppedEvaluation('评测已取消，已保留完成用例。')
      }

      const validSamples = caseResults.filter((result) => result.valid).length
      const reviewedSamples = caseResults.filter(isCompletedReview).length
      const passedReviewSamples = caseResults.filter(isPassedReview).length
      return record({
        status: 'succeeded',
        constraintCompliance: validSamples / caseResults.length,
        validSamples,
        totalSamples: caseResults.length,
        reviewedSamples,
        passedReviewSamples,
        /** 指标缺少统一单位与方向，不在批量层做无依据的平均。 */
        metrics: {},
        judgeResults: summarizeJudgeResults(caseResults, acceptanceCriteria),
        baselineId: null,
        caseResults,
        finishedAt: now(),
      })

      /** 跑一条用例：整链运行 + 取一句失败原因。 */
      async function evaluateCase(item: CapabilityCase): Promise<
        | { kind: 'completed'; result: CapabilityEvaluationCaseResult; modelBinding: string | null }
        | { kind: 'version-changed' }
        | { kind: 'model-changed' }
      > {
        const caseStartedAt = now()
        let run: CapabilityRun
        try {
          run = await deps.run(sceneId, item.input, { saveTask: false, expectedVersion: sceneVersion })
        } catch (error) {
          if (deps.signal?.aborted) throw error
          assertCurrent()
          return {
            kind: 'completed',
            modelBinding: null,
            result: {
              caseId: item.id, caseName: item.name, runId: null, status: 'failed', valid: false,
              reviewEligible: false, startedAt: caseStartedAt, finishedAt: now(),
              detail: error instanceof Error ? error.message : String(error),
            },
          }
        }
        assertCurrent()
        /** 场景定义在批次开始时固定；运行返回其它版本时终止，不能产生混版本评测。 */
        if (run.sceneVersion !== sceneVersion) return { kind: 'version-changed' }
        /** 实际渠道与模型也属于批次身份，避免同版本在渠道切换后混算。 */
        const modelBinding = run.modelBindings?.length
          ? stableCapabilityValueKey(run.modelBindings.map((binding) => ({
              slotId: binding.slotId, channelId: binding.channelId, modelId: binding.modelId,
            })))
          : null
        if (frozenModelBinding !== undefined && modelBinding !== frozenModelBinding) return { kind: 'model-changed' }
        const passed = run.status === 'succeeded' && run.valid
        const reviewEligible = passed && (run.placeholderCapabilities?.length ?? 0) === 0
          && (run.evidenceIssues?.length ?? 0) === 0
        return {
          kind: 'completed',
          modelBinding,
          result: {
            caseId: item.id,
            caseName: item.name,
            runId: run.id,
            status: run.status,
            valid: passed,
            ...(run.review === undefined ? {} : { review: run.review }),
            reviewEligible,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            ...(!passed ? { detail: describeCaseFailure(run) }
              : run.evidenceIssues?.length ? { detail: `证据检查未通过：${run.evidenceIssues.join('；')}` } : {}),
          },
        }
      }

      /** 以当前已完成结果生成失败终态，停止原因不覆盖既有逐条证据。 */
      function recordStoppedEvaluation(error: string): CapabilityEvaluation {
        const validSamples = caseResults.filter((caseResult) => caseResult.valid).length
        const reviewedSamples = caseResults.filter(isCompletedReview).length
        const passedReviewSamples = caseResults.filter(isPassedReview).length
        return record({
          status: 'failed',
          constraintCompliance: validSamples / dataset.cases.length,
          validSamples,
          totalSamples: dataset.cases.length,
          reviewedSamples,
          passedReviewSamples,
          metrics: {},
          judgeResults: summarizeJudgeResults(caseResults, acceptanceCriteria),
          baselineId: null,
          caseResults,
          finishedAt: now(),
          error,
        })
      }
    },
  }
}

/** 内容评审成功返回即视为完成；passed=null 仍属于“已评但无法判断”，但绝不算通过。 */
function isCompletedReview(result: CapabilityEvaluationCaseResult): boolean {
  return result.review?.status === 'succeeded'
}

/** 质量通过必须同时满足运行、格式、评审与真实输入资格，不能信遗留的孤立 passed=true。 */
function isPassedReview(result: CapabilityEvaluationCaseResult): boolean {
  return result.reviewEligible === true
    && result.status === 'succeeded'
    && result.valid
    && result.review?.status === 'succeeded'
    && result.review.passed === true
}

/** 按场景开始时固定的判据聚合“通过数 / 已判断数”。 */
function summarizeJudgeResults(
  caseResults: readonly CapabilityEvaluationCaseResult[],
  criteria: readonly string[],
): CapabilityEvaluation['judgeResults'] {
  return criteria.flatMap((criterion, index) => {
    const decisions = caseResults.flatMap((result) => {
      if (result.reviewEligible !== true || result.review?.status !== 'succeeded') return []
      const decision = result.review.criteria.find((item) => item.criterion === criterion)
      return decision?.passed === null || decision === undefined ? [] : [decision.passed]
    })
    if (decisions.length === 0) return []
    return [{
      criterionId: `criterion-${index + 1}`,
      criterion,
      passed: decisions.filter(Boolean).length,
      total: decisions.length,
    }]
  })
}

export type CapabilityFactoryEvaluator = ReturnType<typeof createCapabilityFactoryEvaluator>
