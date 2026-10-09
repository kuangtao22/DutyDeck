/**
 * Agent 操控面。
 *
 * **权限边界全部落在这一层**：读取直接执行；运行受当前回合预算约束；所有修改都采用
 * prepare/apply 两段式，并由宿主在 apply 前展示不可变审批快照。
 *
 * 另外两条纪律：
 * - 草案来源由 Host 盖章为 `agent`，模型无法自报来源；
 * - 写操作必须先拿到宿主的授权快照并获批，授权卡逐条列出"改了什么"。
 */
import { randomUUID } from 'node:crypto'
import type {
  CapabilityDataset,
  CapabilityDelivery,
  CapabilityEvaluation,
  CapabilityFactoryBatch,
  CapabilityFactoryBatchRequest,
  CapabilityFactoryBatchSummary,
  CapabilityRun,
  CapabilitySavedTask,
  CapabilityScene,
  CapabilitySceneDefinition,
  CapabilitySceneDraft,
  CapabilitySceneVersion,
} from '@proma/shared'
import { diffSceneDefinition, stableCapabilityValueKey, type CapabilitySceneChange, type CapabilityStub } from '@proma/shared'
import { validateCapabilitySceneDraft, type CapabilityFactoryService } from './capability-factory-service'
import type { CapabilityFactoryRunOptions } from './capability-factory-run'
import {
  createCapabilityFactoryAgentOperations,
  type CapabilityFactoryAgentOperation,
  type CapabilityFactoryAgentOperationApproval,
} from './capability-factory-agent-operations'

export type { CapabilityFactoryAgentOperation, CapabilityFactoryAgentOperationApproval } from './capability-factory-agent-operations'

/** 授权快照：宿主据此弹审批卡；里面没有"立即生效"这回事。 */
export interface CapabilityFactoryAgentDraftApproval {
  kind: 'draft'
  tool: 'factory_save_draft'
  sceneId: string
  sceneName: string
  /** 当前生效版本，审批卡上要显示"这次改的是 v3"。 */
  currentVersion: number
  /** 逐条列出本次改动。 */
  changes: CapabilitySceneChange[]
  /** 常量：本次草案写入不生效，采纳属于独立操作。 */
  appliesImmediately: false
  /** 草案说明，来自模型，仅作提示。 */
  note: string
}

/**
 * 虚拟接入的授权快照。
 *
 * 桩本身**不影响已发布的场景行为**（不进版本、不进能力包），但它决定"跑出来的结果可不可信"，
 * 所以仍然要让人看到写的是什么：卡片列出能力 id 与返回体的形状预览。
 */
export interface CapabilityFactoryAgentStubApproval {
  kind: 'stub'
  tool: 'factory_set_stub'
  capabilityId: string
  /** 返回体的缩略预览，只用于人眼确认形状。 */
  payloadPreview: string
  /** 该能力被哪些场景声明 —— 写错 id 时人一眼能看出来。 */
  usedByScenes: string[]
  appliesImmediately: false
  note: string
}

export type CapabilityFactoryAgentApproval =
  | CapabilityFactoryAgentDraftApproval
  | CapabilityFactoryAgentStubApproval
  | CapabilityFactoryAgentOperationApproval

/**
 * facade 依赖。
 *
 * **刻意没有 `requireApproval` 回调**：审批由宿主的权限层驱动（与 api-workbench 同构）。
 * 模型只能消费**已签发的精确快照** —— 见 `prepareDraft` / `applyDraft` 的两段式。
 */
export interface CapabilityFactoryAgentFacadeOptions {
  service: CapabilityFactoryService
  /** 同时可用的准备草稿上限；防止模型刷一堆待批准快照。 */
  maxPreparedDrafts?: number
  /**
   * 单步试跑的执行口子。**由宿主注入**：跑一步要用渠道凭据、走代理、还受权限模式约束，
   * 这些只有主进程知道。缺省表示这个宿主不给试跑能力 —— 工具会明确拒绝，而不是假装能跑。
   */
  runStep?: (request: { sceneId: string; stepId: string; input: Record<string, unknown> }) => Promise<CapabilityRun>
  /** 整链运行口子：可用于当前基线 / 草案候选对比，但不推进版本。 */
  runScene?: (request: {
    sceneId: string
    input: Record<string, unknown>
  } & Omit<CapabilityFactoryRunOptions, 'saveTask'>) => Promise<CapabilityRun>
  /** 每个入口都复核当前 Agent 回合仍属于原工作区。 */
  assertCurrent?: () => void
  /** 计划模式等只读宿主返回 false；运行和 apply 都必须拒绝。 */
  canMutate?: () => boolean
  /** 用户停止 Agent 回合后，中止后续写入与模型调用。 */
  signal?: AbortSignal
  runBatch?: (request: CapabilityFactoryBatchRequest) => Promise<CapabilityFactoryBatch>
  listBatches?: (sceneId: string) => CapabilityFactoryBatchSummary[]
  getBatch?: (sceneId: string, batchId: string) => CapabilityFactoryBatch | null
  assertAdoptable?: (sceneId: string, batchId: string) => unknown
  /** 写入或运行产生新证据后，通知宿主刷新同一会话的工厂面板。 */
  onChanged?: () => void
}

/** 模型可见的场景摘要：只给身份与版本，不给全部定义（避免一次把上下文塞满）。 */
export interface CapabilityFactoryAgentSceneSummary {
  id: string
  name: string
  description: string
  currentVersion: number
  hasDraft: boolean
  stepCount: number
  updatedAt: number
}

/** 把场景压成模型可见的摘要。 */
function summarize(scene: CapabilityScene): CapabilityFactoryAgentSceneSummary {
  return {
    id: scene.id,
    name: scene.definition.name,
    description: scene.definition.description,
    currentVersion: scene.currentVersion,
    hasDraft: scene.draft !== null,
    stepCount: scene.definition.steps.length,
    updatedAt: scene.updatedAt,
  }
}

/** 创建 Agent 操控面。 */
export function createCapabilityFactoryAgentFacade(options: CapabilityFactoryAgentFacadeOptions) {
  const { service } = options
  const maxPreparedDrafts = options.maxPreparedDrafts ?? 16
  const assertCurrent = (): void => { options.assertCurrent?.() }
  const canMutate = (): boolean => options.canMutate?.() ?? true
  const assertNotAborted = (): void => {
    if (options.signal?.aborted) throw new Error('当前 Agent 回合已停止')
  }
  const comparisonRuns = new Map<string, Set<'baseline' | 'candidate'>>()
  let comparisonRoundsUsed = 0
  let runUnitsUsed = 0
  /** 一轮 10 条基线/候选对比需要 20 次运行，三轮即 60 次。 */
  const consumeRunUnits = (units: number): boolean => {
    if (runUnitsUsed + units > 60) return false
    runUnitsUsed += units
    return true
  }
  /**
   * 已签发的快照：**批准之前内容不可变**。
   * 键是 preparedId，值是当时算好的改动清单与定义副本 ——
   * 这样"人批准的"和"真正写入的"必然是同一份，模型无法在批准后偷换内容。
   */
  const prepared = new Map<string, {
    sceneId: string
    /** 准备那一刻的生效版本；apply 时用它判断场景有没有被人改过。 */
    currentVersion: number
    definition: CapabilitySceneDefinition
    note: string
    changes: CapabilitySceneChange[]
    expectedDraft: CapabilitySceneDraft | null
  }>()
  /**
   * 已签发的桩快照。与草案同一套纪律：批准前不可变，apply 只认这里登记过的 preparedId。
   * 桩没有"版本"概念，所以这里不需要版本复核 —— 但提交的 payload 必须是快照里的那一份。
   */
  const preparedStubs = new Map<string, {
    capabilityId: string
    payload: unknown
    note: string
    expectedStub: CapabilityStub | null
  }>()
  const operations = createCapabilityFactoryAgentOperations({
    service,
    maxPrepared: maxPreparedDrafts,
    assertCurrent,
    canMutate,
    assertNotAborted,
    ...(options.assertAdoptable === undefined ? {} : { assertAdoptable: options.assertAdoptable }),
    ...(options.listBatches === undefined ? {} : { listBatches: options.listBatches }),
    ...(options.getBatch === undefined ? {} : { getBatch: options.getBatch }),
  })

  return {
    /** 列出本项目的全部场景。 */
    listScenes(): CapabilityFactoryAgentSceneSummary[] {
      assertCurrent()
      return service.listScenes().map(summarize)
    },

    /** 读取一个场景的完整定义（含当前定义与草案状态）。 */
    getScene(sceneId: string): CapabilityScene | null {
      assertCurrent()
      return service.getScene(sceneId)
    },

    /** 读取版本历史。 */
    listVersions(sceneId: string): CapabilitySceneVersion[] {
      assertCurrent()
      return service.listVersions(sceneId)
    },

    /** 读取本工作区的虚拟接入清单 —— Agent 需要知道哪些能力已经绑过桩。 */
    listStubs(): CapabilityStub[] {
      assertCurrent()
      return service.listStubs()
    },

    /**
     * 读取某个场景的运行记录（最新在前，最多 20 条）。
     *
     * 只读，且只给**这一次场景**的记录 —— 训练提示词时最需要的是"我上一版改完跑出了什么"。
     * @param sceneId 场景 id
     * @param kind 只看整链运行或只看单步试跑；缺省两类都返回
     */
    listRuns(sceneId: string, kind?: 'full' | 'step'): CapabilityRun[] {
      assertCurrent()
      return service.listRuns(sceneId, 20, kind)
    },

    /** 按运行 ID 精确读取一条记录，避免历史超过 20 条后 Agent 误读其它运行。 */
    getRun(sceneId: string, runId: string): CapabilityRun | null {
      assertCurrent()
      return service.getRun(sceneId, runId)
    },

    /** 读取用户已保存的整链任务，优化时直接复用原始输入。 */
    listTasks(sceneId: string): CapabilitySavedTask[] {
      assertCurrent()
      return service.listTasks(sceneId)
    },

    /** 读取测试数据集；完整输入仅在明确读取时进入上下文。 */
    listDatasets(): CapabilityDataset[] {
      assertCurrent()
      return service.listDatasets()
    },

    /** 读取场景评测历史。 */
    listEvaluations(sceneId: string): CapabilityEvaluation[] {
      assertCurrent()
      return service.listEvaluations(sceneId)
    },

    /** 读取本地能力包交付记录。 */
    listDeliveries(): CapabilityDelivery[] {
      assertCurrent()
      return service.listDeliveries()
    },

    /** 批次列表只返回摘要，避免把全部输入塞进 Agent 上下文。 */
    listBatches(sceneId: string): CapabilityFactoryBatchSummary[] | { reason: string } {
      assertCurrent()
      if (!options.listBatches) return { reason: '当前会话没有批次读取能力' }
      return options.listBatches(sceneId)
    },

    getBatch(sceneId: string, batchId: string): CapabilityFactoryBatch | { reason: string } | null {
      assertCurrent()
      if (!options.getBatch) return { reason: '当前会话没有批次读取能力' }
      return options.getBatch(sceneId, batchId)
    },

    async runBatch(request: CapabilityFactoryBatchRequest): Promise<CapabilityFactoryBatch | { reason: string }> {
      assertCurrent()
      if (!canMutate()) return { reason: '当前模式不允许运行编排工厂' }
      assertNotAborted()
      if (!options.runBatch) return { reason: '当前会话没有批量运行能力' }
      const scene = service.getScene(request.sceneId)
      if (!scene) return { reason: '场景不存在' }
      const caseIds = request.caseIds
      if (caseIds !== undefined && request.datasetId === undefined) return { reason: 'caseIds 必须与 datasetId 一起使用' }
      if (caseIds !== undefined && request.taskIds !== undefined) return { reason: 'caseIds 不能与 taskIds 同时使用' }
      if (caseIds !== undefined && (caseIds.length < 1 || caseIds.length > 10)) {
        return { reason: 'caseIds 必须选择 1 到 10 条用例' }
      }
      if (caseIds !== undefined && new Set(caseIds).size !== caseIds.length) return { reason: 'caseIds 不能重复' }
      const dataset = request.datasetId === undefined
        ? undefined
        : service.listDatasets().find((item) => item.id === request.datasetId)
      if (request.datasetId !== undefined && dataset === undefined) return { reason: '数据集不存在' }
      if (caseIds !== undefined) {
        const available = new Set(dataset?.cases.map((item) => item.id) ?? [])
        const missing = caseIds.find((caseId) => !available.has(caseId))
        if (missing !== undefined) return { reason: `数据集用例不存在：${missing}` }
      }
      const itemCount = request.datasetId === undefined
        ? request.taskIds?.length ?? 0
        : caseIds?.length ?? dataset?.cases.length ?? 0
      if (itemCount < 1) return { reason: '批次没有可运行的用例' }
      if (itemCount > 10) {
        return { reason: request.datasetId === undefined
          ? '单批最多运行 10 条用例'
          : '单批最多运行 10 条用例；请传 caseIds 分批执行' }
      }
      if (request.kind === 'comparison') {
        if (comparisonRoundsUsed >= 3) return { reason: '当前 Agent 回合最多运行 3 轮优化对比' }
        comparisonRoundsUsed += 1
      }
      const runUnits = itemCount * (request.kind === 'comparison' ? 2 : 1)
      if (!consumeRunUnits(runUnits)) return { reason: '当前 Agent 回合最多发起 60 次场景运行' }
      const batch = await options.runBatch(structuredClone(request))
      options.onChanged?.()
      return batch
    },

    /** 运行整链基线或候选草案；对比记录不会重复写入任务库。 */
    async runScene(
      sceneId: string,
      input: Record<string, unknown>,
      runOptions: Omit<CapabilityFactoryRunOptions, 'saveTask'> = {},
    ): Promise<CapabilityRun | { reason: string }> {
      assertCurrent()
      if (!canMutate()) return { reason: '当前模式不允许运行编排工厂' }
      assertNotAborted()
      if (!options.runScene) return { reason: '当前会话没有整链运行能力（宿主未提供执行口子）' }
      if (!service.getScene(sceneId)) return { reason: '场景不存在' }
      if (runOptions.comparisonId !== undefined) {
        if (runOptions.comparisonRole === undefined) return { reason: '优化对比必须声明 baseline 或 candidate' }
        let roles = comparisonRuns.get(runOptions.comparisonId)
        if (!roles) {
          if (comparisonRoundsUsed >= 3) return { reason: '当前 Agent 回合最多运行 3 轮优化对比' }
          roles = new Set()
          comparisonRuns.set(runOptions.comparisonId, roles)
          comparisonRoundsUsed += 1
        }
        if (roles.has(runOptions.comparisonRole)) return { reason: '同一轮对比不能重复运行相同角色' }
        roles.add(runOptions.comparisonRole)
      }
      if (!consumeRunUnits(1)) return { reason: '当前 Agent 回合最多发起 60 次场景运行' }
      const run = await options.runScene({ sceneId, input, ...runOptions })
      options.onChanged?.()
      return run
    },

    /**
     * 单步试跑：跑一步带提示词的步骤并返回这次运行的记录（含渲染后的提示词与模型返回）。
     *
     * **它只写一条运行记录**：不改场景定义、不推版本、不导出、不碰虚拟接入。
     * 之所以敢给 Agent 用，是因为训练提示词的闭环必须能自己合上 ——
     * 否则每改一句都要人来跑、再把结果贴回去，Agent 就成了打字机。
     *
     * @param sceneId 场景 id
     * @param stepId 目标步骤（顶层 llm / extract）
     * @param input 该步骤输入槽的值
     */
    async runStep(
      sceneId: string,
      stepId: string,
      input: Record<string, unknown>,
    ): Promise<CapabilityRun | { reason: string }> {
      assertCurrent()
      if (!canMutate()) return { reason: '当前模式不允许运行编排工厂' }
      assertNotAborted()
      if (!options.runStep) return { reason: '当前会话没有试跑能力（宿主未提供执行口子）' }
      if (!service.getScene(sceneId)) return { reason: '场景不存在' }
      if (!consumeRunUnits(1)) return { reason: '当前 Agent 回合最多发起 60 次场景运行' }
      const run = await options.runStep({ sceneId, stepId, input })
      options.onChanged?.()
      return run
    },

    /**
     * 第一段（虚拟接入）：签发桩快照。**不写盘**。
     *
     * 桩写错的代价不是"崩"，而是"工厂里全绿、真实接入返工"，所以这一步也要人看一眼：
     * 卡片上会列出能力 id、它被哪些场景用到、以及返回体的形状预览。
     */
    prepareStub(
      capabilityId: string,
      payload: unknown,
      note: string,
    ): { preparedId: string; approval: CapabilityFactoryAgentApproval } | { reason: string } {
      assertCurrent()
      const usedByScenes = service.listScenes()
        .filter((scene) => scene.definition.capabilities.some((item) => item.id === capabilityId))
        .map((scene) => scene.definition.name)
      if (usedByScenes.length === 0) return { reason: `没有场景声明能力 ${capabilityId}` }
      if (preparedStubs.size >= maxPreparedDrafts) return { reason: '待批准的虚拟接入过多，请先处理已有快照' }

      const preparedId = randomUUID()
      preparedStubs.set(preparedId, {
        capabilityId,
        payload: structuredClone(payload),
        note,
        expectedStub: structuredClone(service.listStubs().find((item) => item.capabilityId === capabilityId) ?? null),
      })
      return {
        preparedId,
        approval: {
          kind: 'stub',
          tool: 'factory_set_stub',
          capabilityId,
          payloadPreview: previewPayload(payload),
          usedByScenes,
          appliesImmediately: false,
          note,
        },
      }
    },

    /**
     * 第二段（虚拟接入）：把**已签发**的桩写进本工作区。
     *
     * 来源固定盖章为 `agent` —— 模型不能自报来源。
     */
    applyStub(preparedId: string): { saved: boolean; capabilityId?: string; reason?: string } {
      assertCurrent()
      if (!canMutate()) return { saved: false, reason: '当前模式不允许修改编排工厂' }
      assertNotAborted()
      const entry = preparedStubs.get(preparedId)
      if (!entry) return { saved: false, reason: 'preparedId 无效或已失效' }
      const current = service.listStubs().find((item) => item.capabilityId === entry.capabilityId) ?? null
      if (stableCapabilityValueKey(current) !== stableCapabilityValueKey(entry.expectedStub)) {
        preparedStubs.delete(preparedId)
        return { saved: false, reason: '虚拟接入已变化，请重新准备' }
      }
      service.setStub(entry.capabilityId, entry.payload, entry.note, 'agent')
      preparedStubs.delete(preparedId)
      options.onChanged?.()
      return { saved: true, capabilityId: entry.capabilityId }
    },

    /**
     * 第一段：准备草案。只算差异并签发快照，**不写任何东西**。
     * 返回的 `preparedId` 由宿主权限层在第二段（apply）时核验。
     */
    prepareDraft(
      sceneId: string,
      definition: CapabilitySceneDefinition,
      note: string,
    ): { preparedId: string; approval: CapabilityFactoryAgentApproval } | { reason: string } {
      assertCurrent()
      const scene = service.getScene(sceneId)
      if (!scene) return { reason: '场景不存在' }

      try {
        validateCapabilitySceneDraft(definition)
      } catch (error) {
        return { reason: error instanceof Error ? error.message : String(error) }
      }

      const changes = diffSceneDefinition(scene.definition, definition)
      if (changes.length === 0) return { reason: '没有实际改动' }
      if (prepared.size >= maxPreparedDrafts) return { reason: '待批准的草案过多，请先处理已有快照' }

      const preparedId = randomUUID()
      prepared.set(preparedId, {
        sceneId,
        currentVersion: scene.currentVersion,
        definition: structuredClone(definition),
        note,
        changes: structuredClone(changes),
        expectedDraft: structuredClone(scene.draft),
      })
      return {
        preparedId,
        approval: {
          kind: 'draft',
          tool: 'factory_save_draft',
          sceneId,
          sceneName: scene.definition.name,
          currentVersion: scene.currentVersion,
          changes,
          appliesImmediately: false,
          note,
        },
      }
    },

    /**
     * 第二段：把**已签发**的快照写成草案。
     * 只接受在 `prepareDraft` 登记过的 preparedId —— 模型不能凭一句话直接写入。
     * 写入的永远是当时快照里的那份定义，**绝不推进版本**（推进只在 `service.adoptDraft`）。
     */
    applyDraft(preparedId: string): { saved: boolean; changes: CapabilitySceneChange[]; reason?: string } {
      assertCurrent()
      if (!canMutate()) return { saved: false, changes: [], reason: '当前模式不允许修改编排工厂' }
      assertNotAborted()
      const entry = prepared.get(preparedId)
      if (!entry) return { saved: false, changes: [], reason: 'preparedId 无效或已失效' }
      const scene = service.getScene(entry.sceneId)
      if (!scene) return { saved: false, changes: [], reason: '场景不存在' }
      // 批准期间场景可能被改动，此时旧快照已不适用，宁可拒绝也不覆盖新状态
      if (scene.currentVersion !== entry.currentVersion
        || stableCapabilityValueKey(scene.draft) !== stableCapabilityValueKey(entry.expectedDraft)) {
        prepared.delete(preparedId)
    return { saved: false, changes: entry.changes, reason: '场景已变化，请重新准备' }
      }
      prepared.delete(preparedId)
      // 来源由 Host 盖章：模型不能声明自己是谁写的。
      service.saveDraft(entry.sceneId, entry.definition, 'agent', entry.note, {
        currentVersion: entry.currentVersion,
        draft: structuredClone(entry.expectedDraft),
      })
      options.onChanged?.()
      return { saved: true, changes: entry.changes }
    },

    prepareOperation(operation: CapabilityFactoryAgentOperation) {
      return operations.prepare(operation)
    },

    async applyOperation(preparedId: string) {
      const outcome = await operations.apply(preparedId)
      if (outcome.applied) options.onChanged?.()
      return outcome
    },

    /**
     * 取某个待批准快照的审批视图 —— 供宿主的权限层在弹卡时读取。
     *
     * 与 api facade 的 `approval(toolName, input)` 同形：orchestrator 拿到它之后
     * 把它合并进权限请求的 toolInput，渲染层的纯函数再据此画卡。
     * 查不到时返回 null（例如 preparedId 已失效），宿主必须拒绝 apply，不能降级放行。
     */
    approval(toolName: string, input: unknown): CapabilityFactoryAgentApproval | null {
      assertCurrent()
      const operationApproval = operations.approval(toolName, input)
      if (operationApproval) return operationApproval
      if (typeof input !== 'object' || input === null) return null
      const preparedId = (input as { preparedId?: unknown }).preparedId
      if (typeof preparedId !== 'string') return null

      if (toolName === 'factory_apply_stub') {
        const stub = preparedStubs.get(preparedId)
        if (!stub) return null
        return {
          kind: 'stub',
          tool: 'factory_set_stub',
          capabilityId: stub.capabilityId,
          payloadPreview: previewPayload(stub.payload),
          usedByScenes: service.listScenes()
            .filter((scene) => scene.definition.capabilities.some((item) => item.id === stub.capabilityId))
            .map((scene) => scene.definition.name),
          appliesImmediately: false,
          note: stub.note,
        }
      }

      if (toolName !== 'factory_apply_draft') return null
      const entry = prepared.get(preparedId)
      if (!entry) return null
      const scene = service.getScene(entry.sceneId)
      return {
        kind: 'draft',
        tool: 'factory_save_draft',
        sceneId: entry.sceneId,
        sceneName: scene?.definition.name ?? '(场景已不存在)',
        currentVersion: entry.currentVersion,
        changes: entry.changes,
        appliesImmediately: false,
        note: entry.note,
      }
    },
  }
}

/**
 * 桩返回体的形状预览。
 *
 * 只给人眼确认"字段名与嵌套对不对"，所以**只保留结构**（键名 + 类型占位），
 * 不把可能很长的真实数据塞进审批卡。数组只显示前两项的形状。
 */
function previewPayload(payload: unknown, depth = 0): string {
  if (depth > 3) return '…'
  if (payload === null) return 'null'
  if (Array.isArray(payload)) {
    const head = payload.slice(0, 2).map((item) => previewPayload(item, depth + 1))
    return `[${head.join(', ')}${payload.length > 2 ? `, …共 ${payload.length} 项` : ''}]`
  }
  if (typeof payload === 'object') {
    const entries = Object.entries(payload as Record<string, unknown>)
    const head = entries.slice(0, 8).map(([key, value]) => `${key}: ${previewPayload(value, depth + 1)}`)
    return `{ ${head.join(', ')}${entries.length > 8 ? `, …共 ${entries.length} 个字段` : ''} }`
  }
  if (typeof payload === 'string') return payload.length === 0 ? '""' : `"…${Math.min(payload.length, 24)} 字"`
  return String(payload)
}

/** facade 类型，供工具层引用。 */
export type CapabilityFactoryAgentFacade = ReturnType<typeof createCapabilityFactoryAgentFacade>
