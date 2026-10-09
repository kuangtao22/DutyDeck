import { randomUUID } from 'node:crypto'
import type {
  CapabilityDataset,
  CapabilityFactoryBatch,
  CapabilityFactoryBatchSummary,
  CapabilityDraftAdoptionScope,
  CapabilityScene,
  CapabilitySceneDraft,
  CapabilityStub,
  SceneAcceptance,
} from '@proma/shared'
import { getReviewSteps, getStepAcceptance, stableCapabilityValueKey } from '@proma/shared'
import type { CapabilityFactoryService } from './capability-factory-service'
import {
  createCapabilityFactoryAdoptionSummary,
  type CapabilityFactoryAdoptionProposal,
  type CapabilityFactoryAdoptionSummary,
} from './capability-factory-adoption-summary'
import { resolveCapabilityDraftAdoption } from './capability-factory-draft-adoption'

/** Agent 可准备的写操作白名单；不接受任意 service 方法名。 */
export type CapabilityFactoryAgentOperation =
  | { kind: 'createScene'; name: string }
  | { kind: 'renameScene'; sceneId: string; name: string }
  | { kind: 'deleteScene'; sceneId: string }
  | { kind: 'discardDraft'; sceneId: string }
  | {
    kind: 'adoptDraft'
    sceneId: string
    scope?: CapabilityDraftAdoptionScope
    testedBatchId?: string
    proposal?: CapabilityFactoryAdoptionProposal
  }
  | { kind: 'rollback'; sceneId: string; targetVersion: number }
  | { kind: 'exportPackage'; sceneId: string; packageVersion: string; fileName: string; projectId?: string }
  | { kind: 'createDataset'; name: string }
  | { kind: 'addDatasetCases'; datasetId: string; cases: CapabilityFactoryAgentDatasetCase[] }
  | { kind: 'deleteDatasetCase'; datasetId: string; caseId: string }
  | { kind: 'deleteStub'; capabilityId: string }

/** Agent 添加的数据集用例；来源由 Host 固定为 agent。 */
export interface CapabilityFactoryAgentDatasetCase {
  name?: string
  input: Record<string, unknown>
  expected?: unknown
  fromRunId?: string
}

/** 宿主审批卡只渲染这些稳定字段，不渲染模型可伪造的 approved 标记。 */
export interface CapabilityFactoryAgentOperationApproval {
  kind: 'operation'
  tool: 'factory_apply_operation'
  operation: CapabilityFactoryAgentOperation['kind']
  title: string
  lines: string[]
  destructive: boolean
  appliesImmediately: boolean
  /** 仅采纳草案时提供；内容由宿主基于冻结测试证据生成。 */
  adoption?: CapabilityFactoryAdoptionSummary
}

interface PreparedOperation {
  operation: CapabilityFactoryAgentOperation
  approval: CapabilityFactoryAgentOperationApproval
  /** 目标对象准备时的完整稳定指纹；应用前必须精确匹配。 */
  expectedKey: string | null
  /** 测试批次与运行记录的完整指纹；审核后变化时旧批准失效。 */
  evidenceKey: string | null
}

export interface CapabilityFactoryAgentOperationOptions {
  service: CapabilityFactoryService
  maxPrepared: number
  assertAdoptable?: (sceneId: string, batchId: string) => unknown
  listBatches?: (sceneId: string) => CapabilityFactoryBatchSummary[]
  getBatch?: (sceneId: string, batchId: string) => CapabilityFactoryBatch | null
  assertCurrent: () => void
  canMutate: () => boolean
  assertNotAborted: () => void
}

/** 创建两段式操作仓库；preparedId 只在当前 facade 生命周期内有效。 */
export function createCapabilityFactoryAgentOperations(options: CapabilityFactoryAgentOperationOptions) {
  const prepared = new Map<string, PreparedOperation>()

  return {
    prepare(operation: CapabilityFactoryAgentOperation) {
      options.assertCurrent()
      if (prepared.size >= options.maxPrepared) return { reason: '待批准的工厂操作过多，请先处理已有快照' }
      const frozen = structuredClone(operation)
      let inspected: ReturnType<typeof inspect>
      try {
        inspected = inspect(options, frozen)
      } catch (error) {
        return { reason: error instanceof Error ? error.message : String(error) }
      }
      const preparedId = randomUUID()
      const entry: PreparedOperation = {
        operation: frozen,
        approval: structuredClone(inspected.approval),
        expectedKey: inspected.expectedKey,
        evidenceKey: inspected.evidenceKey,
      }
      prepared.set(preparedId, entry)
      return { preparedId, approval: structuredClone(entry.approval) }
    },

    async apply(preparedId: string) {
      options.assertCurrent()
      if (!options.canMutate()) return { applied: false, reason: '当前模式不允许修改编排工厂' }
      options.assertNotAborted()
      const entry = prepared.get(preparedId)
      if (!entry) return { applied: false, reason: 'preparedId 无效或已失效' }
      let current: ReturnType<typeof inspect>
      try {
        current = inspect(options, entry.operation)
      } catch {
        prepared.delete(preparedId)
        return { applied: false, reason: '目标状态已变化，请重新准备操作' }
      }
      if (current.expectedKey !== entry.expectedKey) {
        prepared.delete(preparedId)
        return { applied: false, reason: '目标状态已变化，请重新准备操作' }
      }
      if (current.evidenceKey !== entry.evidenceKey) {
        prepared.delete(preparedId)
        return { applied: false, reason: '测试证据已变化，请重新准备操作' }
      }
      prepared.delete(preparedId)
      const operation = entry.operation
      switch (operation.kind) {
        case 'createScene':
          return { applied: true, result: options.service.createScene(operation.name, 'agent') }
        case 'renameScene':
          return { applied: true, result: options.service.renameScene(operation.sceneId, operation.name, 'agent') }
        case 'deleteScene':
          return { applied: true, result: options.service.deleteScene(operation.sceneId) }
        case 'discardDraft': {
          const scene = requireScene(options.service, operation.sceneId)
          return { applied: true, result: options.service.discardDraft(operation.sceneId, expectedDraftState(scene)) }
        }
        case 'adoptDraft': {
          const scene = requireScene(options.service, operation.sceneId)
          if (!scene.draft) return { applied: false, reason: '当前没有待采纳的草案' }
          if (operation.testedBatchId !== undefined) {
            if (!options.assertAdoptable) return { applied: false, reason: '当前会话不能校验批次采纳证据' }
            await options.assertAdoptable(operation.sceneId, operation.testedBatchId)
            /** 证据校验可能跨异步边界；返回后必须重做全部守卫与完整场景 CAS。 */
            options.assertCurrent()
            if (!options.canMutate()) return { applied: false, reason: '当前模式不允许修改编排工厂' }
            options.assertNotAborted()
            if (key(requireScene(options.service, operation.sceneId)) !== entry.expectedKey) {
              return { applied: false, reason: '目标状态已变化，请重新准备操作' }
            }
            if (inspect(options, operation).evidenceKey !== entry.evidenceKey) {
              return { applied: false, reason: '测试证据已变化，请重新准备操作' }
            }
          }
          return {
            applied: true,
            result: options.service.adoptDraft(operation.sceneId, {
              ...(operation.scope === undefined ? {} : { scope: structuredClone(operation.scope) }),
              expectedVersion: scene.currentVersion,
              expectedDraftCreatedAt: scene.draft.createdAt,
              expectedDraftDefinition: structuredClone(scene.draft.definition),
            }),
          }
        }
        case 'rollback':
          return { applied: true, result: options.service.rollback(operation.sceneId, operation.targetVersion, 'agent') }
        case 'exportPackage':
          return { applied: true, result: options.service.exportPackage(operation.sceneId, {
            packageVersion: operation.packageVersion,
            fileName: operation.fileName,
            ...(operation.projectId === undefined ? {} : { projectId: operation.projectId }),
          }) }
        case 'createDataset':
          return { applied: true, result: options.service.createDataset(operation.name) }
        case 'addDatasetCases': {
          let dataset: CapabilityDataset | null = null
          for (const item of operation.cases) {
            dataset = options.service.addCase(operation.datasetId, structuredClone(item.input), {
              ...(item.name === undefined ? {} : { name: item.name }),
              ...(item.expected === undefined ? {} : { expected: structuredClone(item.expected) }),
              ...(item.fromRunId === undefined ? {} : { fromRunId: item.fromRunId }),
              source: 'agent',
            })
          }
          return { applied: true, result: dataset }
        }
        case 'deleteDatasetCase':
          return { applied: true, result: options.service.deleteCase(operation.datasetId, operation.caseId) }
        case 'deleteStub':
          return { applied: true, result: options.service.deleteStub(operation.capabilityId) }
      }
    },

    approval(toolName: string, input: unknown): CapabilityFactoryAgentOperationApproval | null {
      options.assertCurrent()
      if (toolName !== 'factory_apply_operation' || typeof input !== 'object' || input === null) return null
      const preparedId = (input as { preparedId?: unknown }).preparedId
      if (typeof preparedId !== 'string') return null
      const entry = prepared.get(preparedId)
      return entry ? structuredClone(entry.approval) : null
    },
  }
}

/** 准备审批文案并冻结当前目标对象。 */
function inspect(options: CapabilityFactoryAgentOperationOptions, operation: CapabilityFactoryAgentOperation): {
  approval: CapabilityFactoryAgentOperationApproval
  expectedKey: string | null
  evidenceKey: string | null
} {
  const { service } = options
  switch (operation.kind) {
    case 'createScene':
      if (operation.name.trim().length === 0) throw new Error('场景名称不能为空')
      return approval(operation.kind, `新建场景「${operation.name.trim()}」`, ['创建空白场景 v1'], false, true, null)
    case 'renameScene': {
      if (operation.name.trim().length === 0) throw new Error('场景名称不能为空')
      const scene = requireScene(service, operation.sceneId)
      return approval(operation.kind, `重命名场景「${scene.definition.name}」`, [`${scene.definition.name} -> ${operation.name.trim()}`, `当前版本：v${scene.currentVersion}`], false, true, key(scene))
    }
    case 'deleteScene': {
      const scene = requireScene(service, operation.sceneId)
      return approval(operation.kind, `删除场景「${scene.definition.name}」`, [`场景：${scene.id}`, `当前版本：v${scene.currentVersion}`, '版本审计记录会保留'], true, true, key(scene))
    }
    case 'discardDraft': {
      const scene = requireScene(service, operation.sceneId)
      if (!scene.draft) throw new Error('当前没有可放弃的草案')
      return approval(operation.kind, `放弃「${scene.definition.name}」草案`, [`草案时间：${scene.draft.createdAt}`, `当前版本：v${scene.currentVersion}`], true, true, key(scene))
    }
    case 'adoptDraft': {
      const scene = requireScene(service, operation.sceneId)
      if (!scene.draft) throw new Error('当前没有待采纳的草案')
      if (operation.proposal !== undefined) assertProposal(operation.proposal)
      /** 缺省继续代表整份草案，保证旧调用行为不变。 */
      const scope = operation.scope === undefined ? { kind: 'all' as const } : operation.scope
      const adoption = resolveCapabilityDraftAdoption(scene, scope)
      const partial = scope.kind !== 'all'
      if (partial && operation.testedBatchId !== undefined) {
        throw new Error('局部采纳不能使用整份草案的验证批次')
      }
      /** 摘要只比较本次会生效的快照，不能泄露或暗中批准其余草案内容。 */
      const previewScene: CapabilityScene = {
        ...scene,
        ...(scope.kind === 'stepAcceptance' ? { definition: expandLegacyAcceptances(scene.definition) } : {}),
        draft: { ...scene.draft, definition: adoption.definition },
      }
      const lines = [
        `采纳范围：${describeAdoptionScope(scene, scope)}`,
        `版本：v${scene.currentVersion} → v${scene.currentVersion + 1}`,
        `草案来源：${scene.draft.source === 'agent' ? 'Agent' : '用户'}`,
      ]
      if (partial) lines.push('其余草案改动继续待审')
      if (operation.testedBatchId !== undefined) lines.push(`验证批次：${operation.testedBatchId}`)
      const summary = createCapabilityFactoryAdoptionSummary({
        scene: previewScene,
        ...(operation.proposal === undefined ? {} : { proposal: operation.proposal }),
        ...(operation.testedBatchId === undefined ? {} : { testedBatchId: operation.testedBatchId }),
        ...(!partial && options.listBatches !== undefined ? { listBatches: options.listBatches } : {}),
        ...(!partial && options.getBatch !== undefined ? { getBatch: options.getBatch } : {}),
        getRunsByIds: (sceneId, runIds) => service.getRunsByIds(sceneId, runIds),
      })
      if (partial) summary.adoption.validation = '局部采纳未复用整份草案测试证据'
      return {
        approval: {
          kind: 'operation', tool: 'factory_apply_operation', operation: operation.kind,
          title: `采纳「${scene.definition.name}」${partial ? '部分' : '整份'}草案`, lines,
          destructive: false, appliesImmediately: true,
          adoption: summary.adoption,
        },
        expectedKey: key(scene),
        evidenceKey: summary.evidenceKey,
      }
    }
    case 'rollback': {
      const scene = requireScene(service, operation.sceneId)
      const target = service.listVersions(operation.sceneId).find((item) => item.version === operation.targetVersion)
      if (!target) throw new Error(`版本不存在：v${operation.targetVersion}`)
      return approval(operation.kind, `回滚「${scene.definition.name}」`, [`目标快照：v${operation.targetVersion}`, `将追加为：v${scene.currentVersion + 1}`, '当前草案会被清空'], true, true, key(scene))
    }
    case 'exportPackage': {
      const scene = requireScene(service, operation.sceneId)
      return approval(operation.kind, `导出「${scene.definition.name}」能力包`, [`场景版本：v${scene.currentVersion}`, `包版本：${operation.packageVersion}`, `文件：${operation.fileName}`], false, true, key(scene))
    }
    case 'createDataset':
      if (operation.name.trim().length === 0) throw new Error('数据集名称不能为空')
      return approval(operation.kind, `新建数据集「${operation.name.trim()}」`, ['创建空数据集 v1'], false, false, null)
    case 'addDatasetCases': {
      const dataset = requireDataset(service, operation.datasetId)
      if (operation.cases.length === 0) throw new Error('至少需要一条用例')
      if (operation.cases.length > 10) throw new Error('单次最多添加 10 条用例')
      return approval(operation.kind, `向「${dataset.name}」添加用例`, [`新增 ${operation.cases.length} 条`, `数据集 v${dataset.version} -> v${dataset.version + operation.cases.length}`], false, false, key(dataset))
    }
    case 'deleteDatasetCase': {
      const dataset = requireDataset(service, operation.datasetId)
      const item = dataset.cases.find((candidate) => candidate.id === operation.caseId)
      if (!item) throw new Error(`用例不存在：${operation.caseId}`)
      return approval(operation.kind, `删除数据集用例「${item.name}」`, [`数据集：${dataset.name}`, `用例：${item.id}`], true, false, key(dataset))
    }
    case 'deleteStub': {
      const stub = service.listStubs().find((item) => item.capabilityId === operation.capabilityId)
      if (!stub) throw new Error(`虚拟接入不存在：${operation.capabilityId}`)
      return approval(operation.kind, `删除虚拟接入「${operation.capabilityId}」`, [stub.note ?? '无备注'], true, false, key(stub))
    }
  }
}

/**
 * 将旧全局标准等价展开为逐步标准，仅供局部审批 diff 使用。
 * 这样表示迁移不会把未选步骤误报为新增，真实场景与 CAS 指纹保持不变。
 */
function expandLegacyAcceptances(definition: CapabilityScene['definition']): CapabilityScene['definition'] {
  if (definition.stepAcceptances !== undefined) return definition
  /** 每个可评审步骤都冻结其当前实际继承的标准。 */
  const stepAcceptances: Record<string, SceneAcceptance> = {}
  for (const step of getReviewSteps(definition.steps)) {
    const acceptance = getStepAcceptance(definition, step.id)
    if (acceptance) stepAcceptances[step.id] = structuredClone(acceptance)
  }
  return { ...definition, stepAcceptances }
}

/** 将冻结范围转换为审批卡可读文案，标题取当前草案中的真实步骤名称。 */
function describeAdoptionScope(scene: CapabilityScene, scope: CapabilityDraftAdoptionScope): string {
  if (scope.kind === 'all') return '整份草案'
  /** helper 已验证步骤存在且位置稳定，这里只负责展示。 */
  const step = findStep(scene.draft?.definition.steps ?? [], scope.stepId)
  const identity = `步骤「${step?.title ?? scope.stepId}」（${scope.stepId}）`
  return scope.kind === 'stepAcceptance' ? `${identity}的评审标准` : identity
}

/** 在嵌套流程中按 ID 查找步骤，仅用于生成已经过范围校验的审批文案。 */
function findStep(steps: CapabilityScene['definition']['steps'], stepId: string): CapabilityScene['definition']['steps'][number] | undefined {
  for (const step of steps) {
    if (step.id === stepId) return step
    if (step.type === 'map') {
      const nested = findStep(step.body, stepId)
      if (nested) return nested
    }
  }
  return undefined
}

/** facade 也可能被非工具入口调用，因此运行时重复执行 proposal 长度校验。 */
function assertProposal(proposal: CapabilityFactoryAdoptionProposal): void {
  const fields: Array<[string, string]> = [
    ['具体问题', proposal.problem],
    ['预期收益', proposal.expectedBenefit],
  ]
  if (proposal.risk !== undefined) fields.push(['潜在取舍', proposal.risk])
  for (const [label, value] of fields) {
    if (value.trim().length === 0 || value.length > 240) throw new Error(`${label}必须为 1–240 字`)
  }
}

function approval(
  operation: CapabilityFactoryAgentOperation['kind'], title: string, lines: string[], destructive: boolean,
  appliesImmediately: boolean, expectedKey: string | null,
) {
  return {
    approval: { kind: 'operation' as const, tool: 'factory_apply_operation' as const, operation, title, lines, destructive, appliesImmediately },
    expectedKey,
    evidenceKey: null,
  }
}

function requireScene(service: CapabilityFactoryService, sceneId: string): CapabilityScene {
  const scene = service.getScene(sceneId)
  if (!scene) throw new Error(`场景不存在：${sceneId}`)
  return scene
}

function requireDataset(service: CapabilityFactoryService, datasetId: string): CapabilityDataset {
  const dataset = service.listDatasets().find((item) => item.id === datasetId)
  if (!dataset) throw new Error(`数据集不存在：${datasetId}`)
  return dataset
}

function expectedDraftState(scene: CapabilityScene): { currentVersion: number; draft: CapabilitySceneDraft | null } {
  return { currentVersion: scene.currentVersion, draft: structuredClone(scene.draft) }
}

function key(value: CapabilityScene | CapabilityDataset | CapabilityStub): string {
  return stableCapabilityValueKey(value)
}
