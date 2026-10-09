/**
 * 编排工厂的 IPC 契约（四层契约的第 1 层）。
 *
 * 与 Agent 操控面的关键区别：**这里的调用者是人**（界面点出来的动作），
 * 所以可以包含采纳、回滚、导出这些"发布"动作；而 Agent facade 刻意不提供它们。
 * 权限差别不是靠同一层里加参数判断，而是靠**两个入口各自暴露不同的方法集**。
 *
 * 沿用 api-workbench 的信封：单通道 + `{ method, input }`，input 里带 sessionId，
 * **拒绝调用方自行声明 workspace**（workspace 由主进程按 session 反查）。
 */
import type {
  CapabilityDataset, CapabilityDelivery, CapabilityDraftAdoptionScope, CapabilityEvaluation, CapabilityPackage, CapabilityRun, CapabilitySavedTask,
  CapabilityScene, CapabilitySceneDefinition, CapabilitySceneVersion, CapabilityStub, CapabilityStubSource,
} from './capability-factory'
import type { CapabilityFactoryBatch, CapabilityFactoryBatchRequest, CapabilityFactoryBatchSummary } from './capability-factory-batch'

/** 单通道常量：命令与响应都走它，避免为每个方法开一条通道。 */
export const CAPABILITY_FACTORY_CHANNELS = {
  INVOKE: 'capability-factory:invoke',
  /** 长运行的请求级进度；只回传给发起该 invoke 的窗口。 */
  PROGRESS: 'capability-factory:run-progress',
  /** 仅携带变更身份，正文按当前会话归属重新读取。 */
  CHANGED: 'capability-factory:changed',
} as const

/** 保存草案时看到的场景状态；用于阻止旧编辑器覆盖并发产生的新草案。 */
export interface CapabilityDraftExpectedState {
  currentVersion: number
  draft: {
    createdAt: number
    definition: CapabilitySceneDefinition
  } | null
}

/** 命令输入映射。 */
export interface CapabilityFactoryCommandInputs {
  listScenes: { sessionId: string }
  getScene: { sessionId: string; sceneId: string }
  createScene: { sessionId: string; name: string }
  renameScene: { sessionId: string; sceneId: string; name: string }
  deleteScene: { sessionId: string; sceneId: string }
  saveDraft: {
    sessionId: string
    sceneId: string
    definition: CapabilitySceneDefinition
    note: string
    /** 弹窗打开时的完整版本/草案快照；缺省兼容 Agent 与旧调用方。 */
    expectedState?: CapabilityDraftExpectedState
  }
  discardDraft: {
    sessionId: string
    sceneId: string
    /** 用户看到的完整版本/草案快照；缺省兼容旧调用方。 */
    expectedState?: CapabilityDraftExpectedState
  }
  adoptDraft: {
    sessionId: string
    sceneId: string
    /** 块内入口必须指定范围；省略只用于兼容既有整份采纳入口。 */
    scope?: CapabilityDraftAdoptionScope
    expectedVersion?: number
    expectedDraftCreatedAt?: number
    expectedDraftDefinition?: CapabilitySceneDefinition
    /** 采纳已测试草案必须复核持久批次，不能仅信前端 passed 标记。 */
    testedBatchId?: string
  }
  listVersions: { sessionId: string; sceneId: string }
  rollback: { sessionId: string; sceneId: string; targetVersion: number }
  exportPackage: { sessionId: string; sceneId: string; packageVersion: string; fileName: string }
  listDeliveries: { sessionId: string }
  /** 虚拟接入：读 / 写 / 清空某个能力的桩。 */
  listStubs: { sessionId: string }
  setStub: {
    sessionId: string
    capabilityId: string
    payload: unknown
    note?: string
    /** 来源由界面盖章：一键占位是 placeholder，手工填是 human。Agent 走 facade，不从这里进。 */
    source: CapabilityStubSource
  }
  deleteStub: { sessionId: string; capabilityId: string }
  /** 运行：提交一次任务，返回**已经跑完**的运行记录（含完整轨迹）。 */
  runScene: {
    sessionId: string
    sceneId: string
    input: Record<string, unknown>
    requestId?: string
    /** 缺省运行当前生效定义；候选对比显式选 draft。 */
    target?: 'current' | 'draft'
    /** 乐观锁：防止两次对比期间基线版本变化。 */
    expectedVersion?: number
    /** 草案乐观锁：覆盖或采纳后旧请求必须失效。 */
    expectedDraftCreatedAt?: number
    /** 草案内容锁：防止同一毫秒内覆盖草案时误跑。 */
    expectedDraftDefinition?: CapabilitySceneDefinition
    comparisonId?: string
    comparisonRole?: 'baseline' | 'candidate'
  }
  /**
   * 单步试跑：只跑一个带提示词的步骤。
   * `definition` 可选 —— 传了就用这份定义（人在弹窗里改到一半的提示词可以先试再存），不落盘。
   */
  runStep: {
    sessionId: string
    sceneId: string
    stepId: string
    input: Record<string, unknown>
    definition?: CapabilitySceneDefinition
    requestId?: string
  }
  listRuns: { sessionId: string; sceneId: string; limit?: number; kind?: 'full' | 'step' }
  /** 读取当前场景可直接复用的历史任务输入。 */
  listTasks: { sessionId: string; sceneId: string }
  /** 在系统文件管理器里显示某个导出产物 —— 用户要把它交给关联项目。 */
  revealDelivery: { sessionId: string; fileName: string }
  /** 评测：数据集读写 + 跑一次评测 + 读评测历史。 */
  listDatasets: { sessionId: string }
  createDataset: { sessionId: string; name: string }
  addCase: {
    sessionId: string
    datasetId: string
    input: Record<string, unknown>
    name?: string
    /** 失败回灌时带上来源运行 id，供追溯。 */
    fromRunId?: string
  }
  deleteCase: { sessionId: string; datasetId: string; caseId: string }
  runEvaluation: { sessionId: string; sceneId: string; datasetId: string }
  listEvaluations: { sessionId: string; sceneId: string; limit?: number }
  runBatch: CapabilityFactoryBatchRequest & { sessionId: string }
  listBatches: { sessionId: string; sceneId: string }
  getBatch: { sessionId: string; sceneId: string; batchId: string }
  cancelBatch: { sessionId: string; sceneId: string; batchId: string }
  getRun: { sessionId: string; sceneId: string; runId: string }
}

/** 命令返回值映射。 */
export interface CapabilityFactoryCommandResults {
  listScenes: CapabilityScene[]
  getScene: CapabilityScene | null
  createScene: CapabilityScene
  renameScene: { scene: CapabilityScene; version: CapabilitySceneVersion | null }
  deleteScene: { deleted: boolean }
  saveDraft: CapabilityScene
  discardDraft: CapabilityScene
  adoptDraft: { scene: CapabilityScene; version: CapabilitySceneVersion }
  listVersions: CapabilitySceneVersion[]
  rollback: { scene: CapabilityScene; version: CapabilitySceneVersion }
  exportPackage: { package: CapabilityPackage; delivery: CapabilityDelivery }
  listDeliveries: CapabilityDelivery[]
  listStubs: CapabilityStub[]
  setStub: CapabilityStub
  deleteStub: { deleted: boolean }
  runScene: CapabilityRun
  runStep: CapabilityRun
  listRuns: CapabilityRun[]
  listTasks: CapabilitySavedTask[]
  revealDelivery: { revealed: boolean }
  listDatasets: CapabilityDataset[]
  createDataset: CapabilityDataset
  addCase: CapabilityDataset
  deleteCase: CapabilityDataset
  runEvaluation: CapabilityEvaluation
  listEvaluations: CapabilityEvaluation[]
  runBatch: CapabilityFactoryBatch
  listBatches: CapabilityFactoryBatchSummary[]
  getBatch: CapabilityFactoryBatch | null
  cancelBatch: { cancelled: boolean }
  getRun: CapabilityRun | null
}

/** 严格分派所支持的方法。 */
export type CapabilityFactoryCommandMethod = keyof CapabilityFactoryCommandInputs

/** 方法与输入保持关联，主进程 switch 可直接收窄。 */
export type CapabilityFactoryCommand = {
  [M in CapabilityFactoryCommandMethod]: { method: M; input: CapabilityFactoryCommandInputs[M] }
}[CapabilityFactoryCommandMethod]

/** 一次长运行的中间记录；requestId 用于渲染层隔离并发请求与场景切换。 */
export interface CapabilityFactoryRunProgress {
  requestId: string
  run: CapabilityRun
}

/** 主进程发布的最小刷新信号；渲染层仅响应当前会话和当前场景。 */
export interface CapabilityFactoryChanged {
  sessionId: string
  sceneId?: string
}

/** preload 暴露给渲染层的接口形状。 */
export interface CapabilityFactoryApi {
  invoke<M extends CapabilityFactoryCommandMethod>(
    method: M,
    input: CapabilityFactoryCommandInputs[M],
  ): Promise<CapabilityFactoryCommandResults[M]>
  /** 旧 preload / 隔离预览可不实现；正式应用实现后返回取消订阅函数。 */
  onRunProgress?(callback: (event: CapabilityFactoryRunProgress) => void): () => void
  onChanged?(callback: (event: CapabilityFactoryChanged) => void): () => void
}

/** 稳定错误：不回显不可信值。 */
function bad(path: string): never {
  throw new Error('CAPABILITY_FACTORY_INVALID: ' + path)
}

/** 解析精确采纳范围，拒绝未知字段和缺失块身份，不能降级成整份采纳。 */
function adoptionScope(value: unknown): CapabilityDraftAdoptionScope {
  const scope = record(value, ['kind', 'stepId'], 'input.scope')
  if (scope.kind === 'all' && scope.stepId === undefined) return { kind: 'all' }
  if (scope.kind === 'step' || scope.kind === 'stepAcceptance') {
    return { kind: scope.kind, stepId: str(scope.stepId, 'input.scope.stepId', 128) }
  }
  return bad('input.scope')
}

/** 有界非空字符串。 */
function str(value: unknown, path: string, max = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return bad(path)
  return value
}

/** 白名单对象：拒绝未知键，避免把新语义悄悄带进主进程。 */
function record(value: unknown, allowed: readonly string[], path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return bad(path)
  const result = value as Record<string, unknown>
  const unknown = Object.keys(result).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) return bad(`${path}.unknown:${unknown.join(',')}`)
  return result
}

/** 场景定义只做浅校验：**深校验由 capability-runner 的解析层在导出时负责**，
 *  这里放行宽松结构是为了让人能在界面上编辑到一半就保存草案。 */
/** 能力 id：与能力包 spec 的 `capabilityId` 同形，避免桩挂到不存在的能力上。 */
function capabilityId(value: unknown): string {
  const id = str(value, 'input.capabilityId', 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id)) return bad('input.capabilityId')
  return id
}

/** 只接受 JSON 能表达的值：桩与运行输入都要能被序列化落盘。 */
function jsonValue(value: unknown, path: string, depth = 0): unknown {
  if (depth > 8) return bad(path)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return bad(path)
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > 512) return bad(path)
    return value.map((item, index) => jsonValue(item, `${path}[${index}]`, depth + 1))
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length > 256) return bad(path)
    const result: Record<string, unknown> = {}
    for (const [key, item] of entries) result[key] = jsonValue(item, `${path}.${key}`, depth + 1)
    return result
  }
  return bad(path)
}

/** 运行输入：字段数有上限，避免整本书之类的超大载荷经 IPC 反复搬运。 */
function workflowInput(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return bad('input.input')
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 64) return bad('input.input')
  const result: Record<string, unknown> = {}
  for (const [key, item] of entries) {
    if (key.length === 0 || key.length > 128) return bad('input.input')
    /** 单个字符串字段上限 100 万字符：一章正文够用，整本书该走文件而不是 IPC。 */
    if (typeof item === 'string' && item.length > 1_000_000) return bad(`input.input.${key}`)
    result[key] = jsonValue(item, `input.input.${key}`)
  }
  return result
}

/** 校验工厂独有的标准结构，防止宽松草案在运行时因缺字段崩溃；空标准仍可保存待完善。 */
function checkAcceptance(value: unknown, path: string): void {
  const acceptance = record(value, ['criteria', 'judgePrompt', 'metrics'], path)
  if (!Array.isArray(acceptance.criteria) || acceptance.criteria.length > 32) bad(`${path}.criteria`)
  for (const criterion of acceptance.criteria as unknown[]) str(criterion, `${path}.criteria`, 500)
  if (typeof acceptance.judgePrompt !== 'string' || acceptance.judgePrompt.length > 4000) bad(`${path}.judgePrompt`)
  if (!Array.isArray(acceptance.metrics) || acceptance.metrics.length > 16) bad(`${path}.metrics`)
  for (const item of acceptance.metrics as unknown[]) {
    const metric = record(item, ['name', 'weight', 'direction'], `${path}.metrics`)
    str(metric.name, `${path}.metrics.name`, 128)
    if (typeof metric.weight !== 'number' || !Number.isFinite(metric.weight) || metric.weight < 0 || metric.weight > 1) bad(`${path}.metrics.weight`)
    if (metric.direction !== 'positive' && metric.direction !== 'negative') bad(`${path}.metrics.direction`)
  }
}

/** 浅校验可编辑定义；path 让嵌套快照返回准确的非法字段位置。 */
function looseDefinition(value: unknown, path = 'definition'): CapabilitySceneDefinition {
  const definition = record(value,
    ['name', 'description', 'inputs', 'outputs', 'steps', 'capabilities', 'modelSlots', 'acceptance', 'stepAcceptances'], path)
  str(definition.name, `${path}.name`, 200)
  if (typeof definition.description !== 'string') return bad(`${path}.description`)
  if (!Array.isArray(definition.steps)) return bad(`${path}.steps`)
  for (const key of ['inputs', 'outputs', 'capabilities', 'modelSlots'] as const) {
    if (!Array.isArray(definition[key])) return bad(`${path}.${key}`)
  }
  checkAcceptance(definition.acceptance, `${path}.acceptance`)
  if (definition.stepAcceptances !== undefined) {
    if (typeof definition.stepAcceptances !== 'object' || definition.stepAcceptances === null || Array.isArray(definition.stepAcceptances)) {
      return bad(`${path}.stepAcceptances`)
    }
    const entries = Object.entries(definition.stepAcceptances as Record<string, unknown>)
    if (entries.length > 256) return bad(`${path}.stepAcceptances`)
    for (const [stepId, acceptance] of entries) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(stepId)) return bad(`${path}.stepAcceptances`)
      checkAcceptance(acceptance, `${path}.stepAcceptances.${stepId}`)
    }
  }
  return value as CapabilitySceneDefinition
}

/** 严格解析保存草案的旧状态，所有嵌套层都拒绝未知字段。 */
function draftExpectedState(value: unknown): CapabilityDraftExpectedState {
  const state = record(value, ['currentVersion', 'draft'], 'input.expectedState')
  if (typeof state.currentVersion !== 'number'
    || !Number.isSafeInteger(state.currentVersion)
    || state.currentVersion < 1) {
    return bad('input.expectedState.currentVersion')
  }
  if (state.draft === null) return { currentVersion: state.currentVersion, draft: null }
  const draft = record(state.draft, ['createdAt', 'definition'], 'input.expectedState.draft')
  if (typeof draft.createdAt !== 'number'
    || !Number.isSafeInteger(draft.createdAt)
    || draft.createdAt < 0) {
    return bad('input.expectedState.draft.createdAt')
  }
  return {
    currentVersion: state.currentVersion,
    draft: {
      createdAt: draft.createdAt,
      definition: looseDefinition(draft.definition, 'input.expectedState.draft.definition'),
    },
  }
}

/** 解析一条 IPC 命令；方法未知或字段非法一律拒绝。 */
export function parseCapabilityFactoryCommand(value: unknown): CapabilityFactoryCommand {
  const root = record(value, ['method', 'input'], 'command')
  const method = root.method
  const allowed = ['listScenes', 'getScene', 'createScene', 'renameScene', 'deleteScene', 'saveDraft',
    'discardDraft', 'adoptDraft', 'listVersions', 'rollback', 'exportPackage', 'listDeliveries',
    'listStubs', 'setStub', 'deleteStub', 'runScene', 'runStep', 'listRuns', 'listTasks', 'revealDelivery',
    'listDatasets', 'createDataset', 'addCase', 'deleteCase', 'runEvaluation', 'listEvaluations',
    'runBatch', 'listBatches', 'getBatch', 'cancelBatch', 'getRun']
  if (typeof method !== 'string' || !allowed.includes(method)) return bad('method')

  switch (method) {
    case 'runBatch': {
      const input = record(root.input, ['sessionId', 'sceneId', 'kind', 'datasetId', 'taskIds', 'caseIds', 'expectedVersion', 'expectedDraftCreatedAt', 'expectedDraftDefinition'], 'input')
      if (input.kind !== 'evaluation' && input.kind !== 'comparison') return bad('input.kind')
      if ((input.datasetId === undefined) === (input.taskIds === undefined)) return bad('input.tasks')
      if (input.kind === 'evaluation' && input.datasetId === undefined) return bad('input.datasetId')
      if (input.taskIds !== undefined && (!Array.isArray(input.taskIds) || input.taskIds.length < 1 || input.taskIds.length > 10
        || new Set(input.taskIds).size !== input.taskIds.length)) return bad('input.taskIds')
      if (input.caseIds !== undefined && (input.datasetId === undefined || !Array.isArray(input.caseIds)
        || input.caseIds.length < 1 || input.caseIds.length > 10 || new Set(input.caseIds).size !== input.caseIds.length)) return bad('input.caseIds')
      if (input.expectedVersion !== undefined && (typeof input.expectedVersion !== 'number' || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)) return bad('input.expectedVersion')
      if (input.expectedDraftCreatedAt !== undefined && (typeof input.expectedDraftCreatedAt !== 'number' || !Number.isSafeInteger(input.expectedDraftCreatedAt) || input.expectedDraftCreatedAt < 0)) return bad('input.expectedDraftCreatedAt')
      return { method, input: {
        sessionId: str(input.sessionId, 'input.sessionId', 128), sceneId: str(input.sceneId, 'input.sceneId', 128), kind: input.kind,
        ...(input.caseIds === undefined ? {} : { caseIds: (input.caseIds as unknown[]).map((id) => str(id, 'input.caseIds', 128)) }),
        ...(input.datasetId === undefined ? {} : { datasetId: str(input.datasetId, 'input.datasetId', 128) }),
        ...(input.taskIds === undefined ? {} : { taskIds: (input.taskIds as unknown[]).map((id) => str(id, 'input.taskIds', 128)) }),
        ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion as number }),
        ...(input.expectedDraftCreatedAt === undefined ? {} : { expectedDraftCreatedAt: input.expectedDraftCreatedAt as number }),
        ...(input.expectedDraftDefinition === undefined ? {} : { expectedDraftDefinition: looseDefinition(input.expectedDraftDefinition) }),
      } }
    }
    case 'getRun':
    case 'getBatch':
    case 'cancelBatch': {
      const key = method === 'getRun' ? 'runId' : 'batchId'
      const input = record(root.input, ['sessionId', 'sceneId', key], 'input')
      const identity = { sessionId: str(input.sessionId, 'input.sessionId', 128), sceneId: str(input.sceneId, 'input.sceneId', 128) }
      return method === 'getRun'
        ? { method, input: { ...identity, runId: str(input.runId, 'input.runId', 128) } }
        : { method, input: { ...identity, batchId: str(input.batchId, 'input.batchId', 128) } }
    }
    case 'listScenes': {
      const input = record(root.input, ['sessionId'], 'input')
      return { method, input: { sessionId: str(input.sessionId, 'input.sessionId', 128) } }
    }
    case 'getScene':
    case 'listBatches':
    case 'deleteScene':
    case 'listVersions': {
      const input = record(root.input, ['sessionId', 'sceneId'], 'input')
      return { method, input: {
        sessionId: str(input.sessionId, 'input.sessionId', 128),
        sceneId: str(input.sceneId, 'input.sceneId', 128),
      } }
    }
    case 'discardDraft': {
      const input = record(root.input, ['sessionId', 'sceneId', 'expectedState'], 'input')
      return { method, input: {
        sessionId: str(input.sessionId, 'input.sessionId', 128),
        sceneId: str(input.sceneId, 'input.sceneId', 128),
        ...(input.expectedState === undefined ? {} : { expectedState: draftExpectedState(input.expectedState) }),
      } }
    }
    case 'adoptDraft': {
      const input = record(root.input, [
        'sessionId', 'sceneId', 'scope', 'expectedVersion', 'expectedDraftCreatedAt', 'expectedDraftDefinition', 'testedBatchId',
      ], 'input')
      /** 整份候选的批次不能认证局部混合版本，必须重新测试实际生效快照。 */
      const scope = input.scope === undefined ? undefined : adoptionScope(input.scope)
      if (scope && scope.kind !== 'all' && input.testedBatchId !== undefined) {
        return bad('局部采纳不能使用整份草案的测试证据')
      }
      const expectedVersion = input.expectedVersion
      if (expectedVersion !== undefined
        && (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
        return bad('input.expectedVersion')
      }
      const expectedDraftCreatedAt = input.expectedDraftCreatedAt
      if (expectedDraftCreatedAt !== undefined
        && (typeof expectedDraftCreatedAt !== 'number'
          || !Number.isSafeInteger(expectedDraftCreatedAt) || expectedDraftCreatedAt < 0)) {
        return bad('input.expectedDraftCreatedAt')
      }
      return { method, input: {
        sessionId: str(input.sessionId, 'input.sessionId', 128),
        sceneId: str(input.sceneId, 'input.sceneId', 128),
        ...(scope === undefined ? {} : { scope }),
        ...(input.testedBatchId === undefined ? {} : { testedBatchId: str(input.testedBatchId, 'input.testedBatchId', 128) }),
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
        ...(expectedDraftCreatedAt === undefined ? {} : { expectedDraftCreatedAt }),
        ...(input.expectedDraftDefinition === undefined
          ? {} : { expectedDraftDefinition: looseDefinition(input.expectedDraftDefinition) }),
      } }
    }
    case 'listTasks': {
      const input = record(root.input, ['sessionId', 'sceneId'], 'input')
      return { method, input: {
        sessionId: str(input.sessionId, 'input.sessionId', 128),
        sceneId: str(input.sceneId, 'input.sceneId', 128),
      } }
    }
    case 'createScene': {
      const input = record(root.input, ['sessionId', 'name'], 'input')
      return { method, input: {
        sessionId: str(input.sessionId, 'input.sessionId', 128),
        name: str(input.name, 'input.name', 200),
      } }
    }
    case 'renameScene': {
      const input = record(root.input, ['sessionId', 'sceneId', 'name'], 'input')
      return { method, input: {
        sessionId: str(input.sessionId, 'input.sessionId', 128),
        sceneId: str(input.sceneId, 'input.sceneId', 128),
        name: str(input.name, 'input.name', 200),
      } }
    }
    case 'saveDraft': {
      const input = record(root.input, ['sessionId', 'sceneId', 'definition', 'note', 'expectedState'], 'input')
      return { method, input: {
        sessionId: str(input.sessionId, 'input.sessionId', 128),
        sceneId: str(input.sceneId, 'input.sceneId', 128),
        definition: looseDefinition(input.definition),
        note: str(input.note, 'input.note', 200),
        ...(input.expectedState === undefined ? {} : { expectedState: draftExpectedState(input.expectedState) }),
      } }
    }
    case 'rollback': {
      const input = record(root.input, ['sessionId', 'sceneId', 'targetVersion'], 'input')
      const targetVersion = input.targetVersion
      if (typeof targetVersion !== 'number' || !Number.isSafeInteger(targetVersion) || targetVersion < 1) {
        return bad('input.targetVersion')
      }
      return { method, input: {
        sessionId: str(input.sessionId, 'input.sessionId', 128),
        sceneId: str(input.sceneId, 'input.sceneId', 128),
        targetVersion,
      } }
    }
    case 'exportPackage': {
      const input = record(root.input, ['sessionId', 'sceneId', 'packageVersion', 'fileName'], 'input')
      return { method, input: {
        sessionId: str(input.sessionId, 'input.sessionId', 128),
        sceneId: str(input.sceneId, 'input.sceneId', 128),
        packageVersion: str(input.packageVersion, 'input.packageVersion', 64),
        fileName: str(input.fileName, 'input.fileName', 256),
      } }
    }
    case 'setStub': {
      const input = record(root.input, ['sessionId', 'capabilityId', 'payload', 'note', 'source'], 'input')
      if (!('payload' in input)) return bad('input.payload')
      /** 来源只认这三档：界面不可能替 Agent 盖章，所以 'agent' 不会从这里进来。 */
      const source = input.source === 'placeholder' ? 'placeholder' : input.source === 'human' ? 'human' : null
      if (source === null) return bad('input.source')
      return { method, input: {
        sessionId: str(input.sessionId, 'input.sessionId', 128),
        capabilityId: capabilityId(input.capabilityId),
        payload: jsonValue(input.payload, 'input.payload'),
        source,
        ...(input.note === undefined ? {} : { note: str(input.note, 'input.note', 200) }),
      } }
    }
    case 'deleteStub': {
      const input = record(root.input, ['sessionId', 'capabilityId'], 'input')
      return { method, input: {
        sessionId: str(input.sessionId, 'input.sessionId', 128),
        capabilityId: capabilityId(input.capabilityId),
      } }
    }
    case 'runScene': {
      const input = record(root.input, [
        'sessionId', 'sceneId', 'input', 'requestId', 'target', 'expectedVersion',
        'expectedDraftCreatedAt', 'expectedDraftDefinition', 'comparisonId', 'comparisonRole',
      ], 'input')
      const target = input.target === undefined || input.target === 'current'
        ? 'current' : input.target === 'draft' ? 'draft' : bad('input.target')
      const expectedVersion = input.expectedVersion
      if (expectedVersion !== undefined
        && (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
        return bad('input.expectedVersion')
      }
      const expectedDraftCreatedAt = input.expectedDraftCreatedAt
      if (expectedDraftCreatedAt !== undefined
        && (typeof expectedDraftCreatedAt !== 'number' || !Number.isSafeInteger(expectedDraftCreatedAt) || expectedDraftCreatedAt < 0)) {
        return bad('input.expectedDraftCreatedAt')
      }
      if (target === 'draft' && expectedDraftCreatedAt === undefined) return bad('input.expectedDraftCreatedAt')
      if (target === 'draft' && expectedVersion === undefined) return bad('input.expectedVersion')
      const expectedDraftDefinition = input.expectedDraftDefinition === undefined
        ? undefined : looseDefinition(input.expectedDraftDefinition)
      if (target === 'draft' && expectedDraftDefinition === undefined) return bad('input.expectedDraftDefinition')
      const comparisonId = input.comparisonId === undefined
        ? undefined : str(input.comparisonId, 'input.comparisonId', 128)
      const comparisonRole = input.comparisonRole === 'baseline' || input.comparisonRole === 'candidate'
        ? input.comparisonRole : input.comparisonRole === undefined ? undefined : bad('input.comparisonRole')
      if ((comparisonId === undefined) !== (comparisonRole === undefined)) return bad('input.comparisonRole')
      if (comparisonId !== undefined && expectedVersion === undefined) return bad('input.expectedVersion')
      if (comparisonRole === 'baseline' && target !== 'current') return bad('input.comparisonRole')
      if (comparisonRole === 'candidate' && target !== 'draft') return bad('input.comparisonRole')
      return { method, input: {
        sessionId: str(input.sessionId, 'input.sessionId', 128),
        sceneId: str(input.sceneId, 'input.sceneId', 128),
        input: workflowInput(input.input),
        ...(target === 'current' && input.target === undefined ? {} : { target }),
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
        ...(expectedDraftCreatedAt === undefined ? {} : { expectedDraftCreatedAt }),
        ...(expectedDraftDefinition === undefined ? {} : { expectedDraftDefinition }),
        ...(comparisonId === undefined ? {} : { comparisonId }),
        ...(comparisonRole === undefined ? {} : { comparisonRole }),
        ...(input.requestId === undefined ? {} : { requestId: str(input.requestId, 'input.requestId', 128) }),
      } }
    }
    case 'runStep': {
      const input = record(root.input, ['sessionId', 'sceneId', 'stepId', 'input', 'definition', 'requestId'], 'input')
      return { method, input: {
        sessionId: str(input.sessionId, 'input.sessionId', 128),
        sceneId: str(input.sceneId, 'input.sceneId', 128),
        stepId: str(input.stepId, 'input.stepId', 128),
        input: workflowInput(input.input),
        /** 未落盘的临时定义：与 saveDraft 用同一套浅校验（深校验交给运行时的严格解析）。 */
        ...(input.definition === undefined ? {} : { definition: looseDefinition(input.definition) }),
        ...(input.requestId === undefined ? {} : { requestId: str(input.requestId, 'input.requestId', 128) }),
      } }
    }
    case 'listRuns': {
      const input = record(root.input, ['sessionId', 'sceneId', 'limit', 'kind'], 'input')
      const limit = input.limit
      if (limit !== undefined && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
        return bad('input.limit')
      }
      const kind = input.kind === 'full' ? 'full' : input.kind === 'step' ? 'step' : null
      if (input.kind !== undefined && kind === null) return bad('input.kind')
      return { method, input: {
        sessionId: str(input.sessionId, 'input.sessionId', 128),
        sceneId: str(input.sceneId, 'input.sceneId', 128),
        ...(limit === undefined ? {} : { limit }),
        ...(kind === null ? {} : { kind }),
      } }
    }
    case 'revealDelivery': {
      const input = record(root.input, ['sessionId', 'fileName'], 'input')
      return { method, input: {
        sessionId: str(input.sessionId, 'input.sessionId', 128),
        /** 只接受普通文件名：主进程据此拼 <root>/deliveries/<name>，不接受任何目录成分。 */
        fileName: (() => {
          const name = str(input.fileName, 'input.fileName', 128)
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(name)) return bad('input.fileName')
          return name
        })(),
      } }
    }
    case 'createDataset': {
      const input = record(root.input, ['sessionId', 'name'], 'input')
      return { method, input: {
        sessionId: str(input.sessionId, 'input.sessionId', 128),
        name: str(input.name, 'input.name', 200),
      } }
    }
    case 'addCase': {
      const input = record(root.input, ['sessionId', 'datasetId', 'input', 'name', 'fromRunId'], 'input')
      return { method, input: {
        sessionId: str(input.sessionId, 'input.sessionId', 128),
        datasetId: str(input.datasetId, 'input.datasetId', 128),
        input: workflowInput(input.input),
        ...(input.name === undefined ? {} : { name: str(input.name, 'input.name', 200) }),
        ...(input.fromRunId === undefined ? {} : { fromRunId: str(input.fromRunId, 'input.fromRunId', 128) }),
      } }
    }
    case 'deleteCase': {
      const input = record(root.input, ['sessionId', 'datasetId', 'caseId'], 'input')
      return { method, input: {
        sessionId: str(input.sessionId, 'input.sessionId', 128),
        datasetId: str(input.datasetId, 'input.datasetId', 128),
        caseId: str(input.caseId, 'input.caseId', 128),
      } }
    }
    case 'runEvaluation': {
      const input = record(root.input, ['sessionId', 'sceneId', 'datasetId'], 'input')
      return { method, input: {
        sessionId: str(input.sessionId, 'input.sessionId', 128),
        sceneId: str(input.sceneId, 'input.sceneId', 128),
        datasetId: str(input.datasetId, 'input.datasetId', 128),
      } }
    }
    case 'listEvaluations': {
      const input = record(root.input, ['sessionId', 'sceneId', 'limit'], 'input')
      const limit = input.limit
      if (limit !== undefined && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
        return bad('input.limit')
      }
      return { method, input: {
        sessionId: str(input.sessionId, 'input.sessionId', 128),
        sceneId: str(input.sceneId, 'input.sceneId', 128),
        ...(limit === undefined ? {} : { limit }),
      } }
    }
    default: {
      const input = record(root.input, ['sessionId'], 'input')
      /** 落到这里的两个只读方法：listDeliveries / listStubs（都只带 sessionId）。 */
      const resolved = method === 'listStubs' ? 'listStubs' : 'listDeliveries'
      return { method: resolved, input: { sessionId: str(input.sessionId, 'input.sessionId', 128) } }
    }
  }
}
