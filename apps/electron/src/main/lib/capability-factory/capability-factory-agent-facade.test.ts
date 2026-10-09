import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Value } from 'typebox/value'
import type { CapabilityFactoryBatch, CapabilitySceneDefinition } from '@proma/shared'
import { CapabilityFactoryStore } from './capability-factory-store'
import { CapabilityFactoryService } from './capability-factory-service'
import { createCapabilityFactoryAgentFacade, type CapabilityFactoryAgentApproval } from './capability-factory-agent-facade'
import type { CapabilityFactoryAgentOperation } from './capability-factory-agent-operations'
import {
  CAPABILITY_FACTORY_AGENT_APPLY_TOOL_NAMES,
  CAPABILITY_FACTORY_AGENT_READ_TOOL_NAMES,
  CAPABILITY_FACTORY_AGENT_RUN_TOOL_NAMES,
  CAPABILITY_FACTORY_AGENT_TOOL_NAMES,
  buildCapabilityFactoryAgentTools,
} from './capability-factory-agent-tools'

/** 独立临时目录 + 确定性时钟。 */
function fixture() {
  const service = new CapabilityFactoryService({
    store: new CapabilityFactoryStore(mkdtempSync(join(tmpdir(), 'cap-factory-agent-'))),
    now: () => 2000,
    createId: () => 'id-1',
  })
  const facade = createCapabilityFactoryAgentFacade({ service })
  return { service, facade }
}

/** 在定义上加一条步骤，模拟 Agent 的改动。 */
function withStep(definition: CapabilitySceneDefinition, prompt: string): CapabilitySceneDefinition {
  return {
    ...definition,
    steps: [{ type: 'llm', id: 'answer', title: '生成回答', modelSlot: 'main', prompt }],
    outputs: [{ name: 'answer', from: { stepId: 'answer' }, shape: 'text' }],
  }
}

/** 构造两个可独立审核的模型步骤，覆盖步骤内容与逐步评审标准的局部采纳。 */
function withTwoSteps(definition: CapabilitySceneDefinition): CapabilitySceneDefinition {
  return {
    ...definition,
    steps: [
      { type: 'llm', id: 'first', title: '第一步', modelSlot: 'main', prompt: '第一步旧提示词' },
      { type: 'llm', id: 'second', title: '第二步', modelSlot: 'main', prompt: '第二步旧提示词' },
    ],
    outputs: [{ name: 'answer', from: { stepId: 'second' }, shape: 'text' }],
    stepAcceptances: {
      first: { criteria: ['第一步旧标准'], judgePrompt: '核对第一步', metrics: [] },
      second: { criteria: ['第二步旧标准'], judgePrompt: '核对第二步', metrics: [] },
    },
  }
}

describe('Agent 操控面（权限边界）', () => {
  test('只读方法不产生任何快照', () => {
    const { service, facade } = fixture()
    const scene = service.createScene('账号查询')
    expect(facade.listScenes()).toHaveLength(1)
    expect(facade.getScene(scene.id)?.id).toBe(scene.id)
    expect(facade.listVersions(scene.id)).toHaveLength(1)
  })

  test('两段式：prepare 只签发快照不写入，apply 才写草案且不推进版本', () => {
    const { service, facade } = fixture()
    const scene = service.createScene('账号查询')
    const first = facade.prepareDraft(scene.id, withStep(scene.definition, '新提示词'), '补充回答步骤')
    if ('reason' in first) throw new Error(`prepare 不应失败：${first.reason}`)

    // 关键：prepare 之后什么都没写
    expect(service.getScene(scene.id)?.draft).toBeNull()
    expect(first.approval.appliesImmediately).toBe(false)
    /** 快照是联合类型：草案卡与虚拟接入卡字段不同，这里先收窄到草案。 */
    if (first.approval.kind !== 'draft') throw new Error('prepareDraft 应签发草案快照')
    expect(first.approval.currentVersion).toBe(1)
    expect(first.approval.changes.map((item) => item.kind)).toContain('steps')

    const outcome = facade.applyDraft(first.preparedId)
    expect(outcome.saved).toBe(true)
    const after = service.getScene(scene.id)
    expect(after?.currentVersion).toBe(1)          // 版本没动
    expect(after?.definition.steps).toHaveLength(0) // 生效定义没动
    expect(after?.draft?.source).toBe('agent')      // 来源由 Host 盖章
  })

  test('preparedId 只能用一次；重复 apply 即拒绝', () => {
    const { service, facade } = fixture()
    const scene = service.createScene('账号查询')
    const first = facade.prepareDraft(scene.id, withStep(scene.definition, '新提示词'), '尝试')
    if ('reason' in first) throw new Error('prepare 失败')
    expect(facade.applyDraft(first.preparedId).saved).toBe(true)
    expect(facade.applyDraft(first.preparedId).reason).toBe('preparedId 无效或已失效')
  })

  test('与当前定义无差异时直接拒绝，不签发快照', () => {
    const { service, facade } = fixture()
    const scene = service.createScene('账号查询')
    const outcome = facade.prepareDraft(scene.id, scene.definition, '什么都没改')
    expect('reason' in outcome && outcome.reason).toBe('没有实际改动')
  })

  test('准备后场景被人改动，旧快照失效并拒绝写入', () => {
    const { service, facade } = fixture()
    const scene = service.createScene('账号查询')
    const first = facade.prepareDraft(scene.id, withStep(scene.definition, 'Agent 的方案'), 'Agent 改')
    if ('reason' in first) throw new Error('prepare 失败')
    // 人在此期间采纳了另一份草案，版本推进到 2
    service.saveDraft(scene.id, withStep(scene.definition, '人的方案'), 'human', '人工修改')
    service.adoptDraft(scene.id)

    const outcome = facade.applyDraft(first.preparedId)
    expect(outcome.saved).toBe(false)
    expect(outcome.reason).toBe('场景已变化，请重新准备')
    // 生效定义仍是人的方案，没被 Agent 的旧快照覆盖
    expect(service.getScene(scene.id)?.definition.steps).toHaveLength(1)
    expect(service.getScene(scene.id)?.draft).toBeNull()
  })

  test('准备草案后同版本草案被替换，完整 CAS 拒绝覆盖', () => {
    const { service, facade } = fixture()
    const scene = service.createScene('账号查询')
    service.saveDraft(scene.id, withStep(scene.definition, '旧草案'), 'human', '旧草案')
    const prepared = facade.prepareDraft(scene.id, withStep(scene.definition, 'Agent 草案'), 'Agent 修改')
    if ('reason' in prepared) throw new Error(prepared.reason)

    service.saveDraft(scene.id, withStep(scene.definition, '并发新草案'), 'human', '并发修改')
    expect(facade.applyDraft(prepared.preparedId)).toMatchObject({
      saved: false, reason: '场景已变化，请重新准备',
    })
    expect(service.getScene(scene.id)?.draft?.definition.steps[0]).toMatchObject({ prompt: '并发新草案' })
  })

  test('场景不存在时给出可读原因', () => {
    const { facade } = fixture()
    const outcome = facade.prepareDraft('missing', {} as CapabilitySceneDefinition, 'x')
    expect('reason' in outcome && outcome.reason).toBe('场景不存在')
  })

  test('权限层能按 preparedId 取回待批准快照 —— 卡片据此逐条展示改动', () => {
    const { service, facade } = fixture()
    const scene = service.createScene('账号查询')
    const first = facade.prepareDraft(scene.id, withStep(scene.definition, '新提示词'), '补充回答步骤')
    if ('reason' in first) throw new Error('prepare 失败')

    const snapshot = facade.approval('factory_apply_draft', { preparedId: first.preparedId })
    if (snapshot?.kind !== 'draft') throw new Error('应取到草案快照')
    expect(snapshot?.sceneName).toBe('账号查询')
    expect(snapshot?.currentVersion).toBe(1)
    expect(snapshot?.appliesImmediately).toBe(false)
    expect(snapshot?.changes.map((item) => item.kind)).toContain('steps')
    // 只读工具与未知 preparedId 都取不到快照，宿主会降级展示
    expect(facade.approval('factory_list_scenes', {})).toBeNull()
    expect(facade.approval('factory_apply_draft', { preparedId: 'nope' })).toBeNull()
    // apply 之后快照即失效
    facade.applyDraft(first.preparedId)
    expect(facade.approval('factory_apply_draft', { preparedId: first.preparedId })).toBeNull()
  })

  test('工具清单按只读 / 运行 / 修改分类，宿主可据此执行权限策略', () => {
    expect(CAPABILITY_FACTORY_AGENT_READ_TOOL_NAMES).toContain('factory_list_batches')
    expect(CAPABILITY_FACTORY_AGENT_RUN_TOOL_NAMES).toEqual([
      'factory_run_scene', 'factory_run_step', 'factory_run_batch',
    ])
    expect(CAPABILITY_FACTORY_AGENT_APPLY_TOOL_NAMES).toContain('factory_apply_operation')
    expect(new Set(CAPABILITY_FACTORY_AGENT_TOOL_NAMES).size).toBe(CAPABILITY_FACTORY_AGENT_TOOL_NAMES.length)
  })

  test('操作工具 schema 接受三种采纳范围并拒绝不完整或越界字段', () => {
    /** 测试只读取工具 schema，不执行 facade。 */
    const sdk = { defineTool: (definition: unknown) => definition } as Parameters<typeof buildCapabilityFactoryAgentTools>[0]
    const tools = buildCapabilityFactoryAgentTools(sdk, fixture().facade)
    const prepare = tools.find((tool) => tool.name === 'factory_prepare_operation')
    if (!prepare) throw new Error('缺少 factory_prepare_operation')
    const base = {
      kind: 'adoptDraft', sceneId: 'scene-1',
      proposal: { problem: '旧提示词不稳定', expectedBenefit: '稳定输出' },
    }
    expect(Value.Check(prepare.parameters, { operation: { ...base, scope: { kind: 'all' } } })).toBe(true)
    expect(Value.Check(prepare.parameters, { operation: { ...base, scope: { kind: 'step', stepId: 'answer' } } })).toBe(true)
    expect(Value.Check(prepare.parameters, { operation: { ...base, scope: { kind: 'stepAcceptance', stepId: 'answer' } } })).toBe(true)
    expect(Value.Check(prepare.parameters, { operation: { ...base, scope: { kind: 'step' } } })).toBe(false)
    expect(Value.Check(prepare.parameters, { operation: { ...base, scope: { kind: 'all', stepId: 'answer' } } })).toBe(false)
  })

  test('试跑与运行记录：宿主注入口子后 Agent 能自己跑并读回结果', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'cap-factory-facade-'))
    const service = new CapabilityFactoryService({ store: new CapabilityFactoryStore(rootDir) })
    const scene = service.createScene('小说角色提取')
    /** 替身执行口子：真实实现要用渠道凭据，不在 facade 的测试范围里。 */
    const calls: { sceneId: string; stepId: string; input: Record<string, unknown> }[] = []
    const facade = createCapabilityFactoryAgentFacade({
      service,
      runStep: async ({ sceneId, stepId, input }) => {
        calls.push({ sceneId, stepId, input })
        return service.recordRun({
          id: 'run-1', sceneId, sceneVersion: 1, kind: 'step', stepId,
          status: 'succeeded', valid: true, input, outputs: null, steps: [],
          startedAt: 0, finishedAt: 10,
        })
      },
    })

    const outcome = await facade.runStep(scene.id, 'scan', { corpus: '第 1 段' })

    expect(calls).toEqual([{ sceneId: scene.id, stepId: 'scan', input: { corpus: '第 1 段' } }])
    expect('kind' in outcome && outcome.kind).toBe('step')
    /** 只读侧：跑完就能读回这次记录（kind 过滤按运行范围）。 */
    expect(facade.listRuns(scene.id, 'step')).toHaveLength(1)
    expect(facade.listRuns(scene.id, 'full')).toEqual([])
  })

  test('按 runId 精确读取运行记录，不受最近 20 条限制', () => {
    const { service, facade } = fixture()
    const scene = service.createScene('精确读取')
    for (let index = 0; index < 21; index += 1) {
      service.recordRun({
        id: `run-${index}`, sceneId: scene.id, sceneVersion: 1, kind: 'full', status: 'succeeded', valid: true,
        input: { text: `第 ${index} 条` }, outputs: {}, steps: [], startedAt: index, finishedAt: index + 1,
      })
    }
    expect(facade.listRuns(scene.id, 'full')).toHaveLength(20)
    expect(facade.getRun(scene.id, 'run-0')?.id).toBe('run-0')
    expect(facade.getRun(scene.id, 'missing')).toBeNull()
  })

  test('宿主没给试跑口子、或场景不存在时，试跑明确拒绝而不是假装跑过', async () => {
    const withoutPort = fixture().facade
    const first = await withoutPort.runStep('scene-1', 'scan', {})
    expect('reason' in first && first.reason).toContain('没有试跑能力')

    const { service: service0 } = fixture()
    /** 有口子但场景不存在：也不能假装跑过。 */
    const withPort = createCapabilityFactoryAgentFacade({
      service: service0,
      runStep: async () => { throw new Error('不该被调用') },
    })
    const missing = await withPort.runStep('nope', 'scan', {})
    expect('reason' in missing && missing.reason).toBe('场景不存在')
  })

  test('Agent 可以运行整链当前版本或草案，但只能把候选当对比记录，不能采纳', async () => {
    const { service } = fixture()
    const scene = service.createScene('小说角色提取')
    const calls: unknown[] = []
    const facade = createCapabilityFactoryAgentFacade({
      service,
      runScene: async (request) => {
        calls.push(request)
        return {
          id: 'run-candidate', sceneId: request.sceneId, sceneVersion: 1, kind: 'full',
          definitionTarget: request.target, comparisonId: request.comparisonId,
          comparisonRole: request.comparisonRole, taskSaved: false,
          status: 'succeeded', valid: true, input: request.input, outputs: {}, steps: [],
          startedAt: 0, finishedAt: 1,
        }
      },
    })

    const result = await facade.runScene(scene.id, { text: '正文' }, {
      target: 'draft', expectedVersion: 1, expectedDraftCreatedAt: 2000,
      expectedDraftDefinition: scene.definition,
      comparisonId: 'compare-1', comparisonRole: 'candidate',
    })

    expect(calls).toEqual([{
      sceneId: scene.id, input: { text: '正文' }, target: 'draft', expectedVersion: 1,
      expectedDraftCreatedAt: 2000, comparisonId: 'compare-1', comparisonRole: 'candidate',
      expectedDraftDefinition: scene.definition,
    }])
    expect('definitionTarget' in result && result.definitionTarget).toBe('draft')
    expect(service.getScene(scene.id)?.currentVersion).toBe(1)
  })

  test('场景生命周期操作必须先准备审批快照，apply 后来源固定为 agent', async () => {
    const { service, facade } = fixture()
    const created = facade.prepareOperation({ kind: 'createScene', name: '账号查询' })
    if ('reason' in created) throw new Error(created.reason)
    expect(service.listScenes()).toEqual([])
    expect(created.approval).toMatchObject({
      kind: 'operation', operation: 'createScene', destructive: false, appliesImmediately: true,
    })
    expect(facade.approval('factory_apply_operation', { preparedId: created.preparedId })).toEqual(created.approval)

    const applied = await facade.applyOperation(created.preparedId)
    expect(applied.applied).toBe(true)
    expect(service.listVersions('id-1')[0]?.source).toBe('agent')
    expect(await facade.applyOperation(created.preparedId)).toMatchObject({ applied: false })
  })

  test('破坏性操作冻结完整目标；批准后目标变化则拒绝执行', async () => {
    const { service, facade } = fixture()
    const scene = service.createScene('账号查询')
    const prepared = facade.prepareOperation({ kind: 'deleteScene', sceneId: scene.id })
    if ('reason' in prepared) throw new Error(prepared.reason)
    expect(prepared.approval).toMatchObject({ destructive: true, operation: 'deleteScene' })

    service.saveDraft(scene.id, scene.definition, 'human', '并发草案')
    expect(await facade.applyOperation(prepared.preparedId)).toEqual({
      applied: false, reason: '目标状态已变化，请重新准备操作',
    })
    expect(service.getScene(scene.id)).not.toBeNull()
  })

  test('带 testedBatchId 的采纳必须由 Host 复核证据，且采纳精确草案', async () => {
    const { service } = fixture()
    const scene = service.createScene('账号查询')
    service.saveDraft(scene.id, withStep(scene.definition, '新提示词'), 'agent', '优化')
    const checked: string[] = []
    const facade = createCapabilityFactoryAgentFacade({
      service,
      assertAdoptable(sceneId, batchId) { checked.push(`${sceneId}:${batchId}`) },
    })
    const prepared = facade.prepareOperation({ kind: 'adoptDraft', sceneId: scene.id, testedBatchId: 'batch-1' })
    if ('reason' in prepared) throw new Error(prepared.reason)

    expect(await facade.applyOperation(prepared.preparedId)).toMatchObject({ applied: true })
    expect(checked).toEqual([`${scene.id}:batch-1`])
    expect(service.getScene(scene.id)?.currentVersion).toBe(2)
    expect(service.listVersions(scene.id)[1]?.source).toBe('agent')
  })

  test('采纳证据异步校验期间草案变化，返回后再次 CAS 并拒绝旧批准', async () => {
    const { service } = fixture()
    const scene = service.createScene('账号查询')
    service.saveDraft(scene.id, withStep(scene.definition, '候选一'), 'agent', '第一份')
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const facade = createCapabilityFactoryAgentFacade({
      service,
      assertAdoptable: async () => gate,
    })
    const prepared = facade.prepareOperation({ kind: 'adoptDraft', sceneId: scene.id, testedBatchId: 'batch-1' })
    if ('reason' in prepared) throw new Error(prepared.reason)

    const applying = facade.applyOperation(prepared.preparedId)
    service.saveDraft(scene.id, withStep(scene.definition, '候选二'), 'human', '并发替换')
    release?.()
    expect(await applying).toEqual({ applied: false, reason: '目标状态已变化，请重新准备操作' })
    expect(service.getScene(scene.id)?.currentVersion).toBe(1)
  })

  test('采纳审核冻结批次摘要；批准后证据变化则旧审核失效', async () => {
    const { service } = fixture()
    const scene = service.createScene('账号查询')
    service.saveDraft(scene.id, withStep(scene.definition, '候选提示词'), 'agent', '优化')
    let updatedAt = 10
    const batch = (): CapabilityFactoryBatch => ({
      id: 'batch-1', sceneId: scene.id, kind: 'comparison', status: 'succeeded', adoptable: false,
      snapshot: {
        sceneVersion: scene.currentVersion, draftCreatedAt: service.getScene(scene.id)!.draft!.createdAt,
        draftDefinition: structuredClone(service.getScene(scene.id)!.draft!.definition), itemIds: [],
      },
      items: [], comparison: { comparable: 0, candidatePassed: 0, fixed: [], regressed: [], unknown: [], reasons: [] },
      startedAt: 1, updatedAt, finishedAt: updatedAt,
    })
    const facade = createCapabilityFactoryAgentFacade({
      service,
      listBatches: () => [{ ...batch(), itemCount: 0, completedCount: 0 }],
      getBatch: () => batch(),
    })
    const prepared = facade.prepareOperation({ kind: 'adoptDraft', sceneId: scene.id })
    if ('reason' in prepared) throw new Error(prepared.reason)
    expect(prepared.approval).toMatchObject({ adoption: { benefits: [], rationale: '优化' } })

    updatedAt = 11
    expect(await facade.applyOperation(prepared.preparedId)).toEqual({
      applied: false, reason: '测试证据已变化，请重新准备操作',
    })
    expect(service.getScene(scene.id)?.currentVersion).toBe(1)
  })

  test('采纳提案原样冻结为待验证判断，旧调用不传提案仍可读真实差异', () => {
    const { service } = fixture()
    const scene = service.createScene('账号查询')
    service.saveDraft(scene.id, withStep(scene.definition, '先核对账号，再回答'), 'agent', '减少答非所问')
    const facade = createCapabilityFactoryAgentFacade({ service })
    const proposed = facade.prepareOperation({
      kind: 'adoptDraft', sceneId: scene.id,
      proposal: { problem: '回答可能偏离账号', expectedBenefit: '提高相关性', risk: '回答步骤增加' },
    })
    if ('reason' in proposed) throw new Error(proposed.reason)
    expect(proposed.approval).toMatchObject({
      title: '采纳「账号查询」整份草案',
      lines: ['采纳范围：整份草案', '版本：v1 → v2', '草案来源：Agent'],
      adoption: {
        rationale: '减少答非所问',
        proposal: { problem: '回答可能偏离账号', expectedBenefit: '提高相关性', risk: '回答步骤增加' },
        benefits: [], currentProblems: [], remainingRisks: [],
      },
    })
    expect(proposed.approval.adoption?.changes).toContain('提示词（生成回答（answer））：「无」→「先核对账号，再回答」')

    const legacy = facade.prepareOperation({ kind: 'adoptDraft', sceneId: scene.id })
    if ('reason' in legacy) throw new Error(legacy.reason)
    expect(legacy.approval.adoption?.changes).toContain('提示词（生成回答（answer））：「无」→「先核对账号，再回答」')
    expect(legacy.approval.adoption?.proposal).toBeUndefined()

    const explicitAll = facade.prepareOperation({ kind: 'adoptDraft', sceneId: scene.id, scope: { kind: 'all' } })
    if ('reason' in explicitAll) throw new Error(explicitAll.reason)
    expect(explicitAll.approval.title).toBe('采纳「账号查询」整份草案')
    expect(explicitAll.approval.adoption?.changes).toEqual(legacy.approval.adoption?.changes)

    expect(facade.prepareOperation({
      kind: 'adoptDraft', sceneId: scene.id,
      proposal: { problem: 'x'.repeat(241), expectedBenefit: '提高相关性' },
    })).toEqual({ reason: '具体问题必须为 1–240 字' })
  })

  test('步骤局部采纳只合入所选步骤，审批摘要不包含其他草案改动', async () => {
    const { service, facade } = fixture()
    const empty = service.createScene('局部采纳')
    service.saveDraft(empty.id, withTwoSteps(empty.definition), 'human', '初始化')
    service.adoptDraft(empty.id)
    const current = service.getScene(empty.id)!
    const draft = structuredClone(current.definition)
    if (draft.steps[0]?.type !== 'llm' || draft.steps[1]?.type !== 'llm') throw new Error('测试步骤类型错误')
    draft.steps[0].prompt = '第一步新提示词'
    draft.steps[1].prompt = '第二步新提示词'
    draft.stepAcceptances!.second!.criteria = ['第二步新标准']
    service.saveDraft(current.id, draft, 'agent', '分别优化两个步骤')

    const operation: CapabilityFactoryAgentOperation = {
      kind: 'adoptDraft', sceneId: current.id, scope: { kind: 'step', stepId: 'first' },
      proposal: { problem: '第一步回答不稳定', expectedBenefit: '稳定第一步输出' },
    }
    const prepared = facade.prepareOperation(operation)
    if ('reason' in prepared) throw new Error(prepared.reason)
    /** prepare 后修改调用方对象，不能扩大或切换已经批准的范围。 */
    if (operation.scope?.kind === 'step') operation.scope.stepId = 'second'
    expect(prepared.approval.title).toBe('采纳「局部采纳」部分草案')
    expect(prepared.approval.lines).toContain('采纳范围：步骤「第一步」（first）')
    expect(prepared.approval.lines).toContain('其余草案改动继续待审')
    expect(prepared.approval.adoption?.changes.join('\n')).toContain('第一步新提示词')
    expect(prepared.approval.adoption?.changes.join('\n')).not.toContain('第二步新提示词')
    expect(prepared.approval.adoption?.changes.join('\n')).not.toContain('第二步新标准')

    expect(await facade.applyOperation(prepared.preparedId)).toMatchObject({ applied: true })
    const after = service.getScene(current.id)!
    expect(after.definition.steps[0]).toMatchObject({ prompt: '第一步新提示词' })
    expect(after.definition.steps[1]).toMatchObject({ prompt: '第二步旧提示词' })
    expect(after.draft?.definition.steps[1]).toMatchObject({ prompt: '第二步新提示词' })
    expect(after.draft?.definition.stepAcceptances?.second?.criteria).toEqual(['第二步新标准'])
  })

  test('评审标准局部采纳只合入所选步骤标准，并保留步骤及其他标准草案', async () => {
    const { service, facade } = fixture()
    const empty = service.createScene('标准局部采纳')
    service.saveDraft(empty.id, withTwoSteps(empty.definition), 'human', '初始化')
    service.adoptDraft(empty.id)
    const current = service.getScene(empty.id)!
    const draft = structuredClone(current.definition)
    if (draft.steps[0]?.type !== 'llm') throw new Error('测试步骤类型错误')
    draft.steps[0].prompt = '第一步仍待审的新提示词'
    draft.stepAcceptances!.first!.criteria = ['第一步新标准']
    draft.stepAcceptances!.second!.criteria = ['第二步新标准']
    service.saveDraft(current.id, draft, 'agent', '更新标准')

    const prepared = facade.prepareOperation({
      kind: 'adoptDraft', sceneId: current.id, scope: { kind: 'stepAcceptance', stepId: 'first' },
    })
    if ('reason' in prepared) throw new Error(prepared.reason)
    expect(prepared.approval.lines).toContain('采纳范围：步骤「第一步」（first）的评审标准')
    expect(prepared.approval.adoption?.changes.join('\n')).toContain('第一步新标准')
    expect(prepared.approval.adoption?.changes.join('\n')).not.toContain('第一步仍待审的新提示词')
    expect(prepared.approval.adoption?.changes.join('\n')).not.toContain('第二步新标准')

    expect(await facade.applyOperation(prepared.preparedId)).toMatchObject({ applied: true })
    const after = service.getScene(current.id)!
    expect(after.definition.stepAcceptances?.first?.criteria).toEqual(['第一步新标准'])
    expect(after.definition.stepAcceptances?.second?.criteria).toEqual(['第二步旧标准'])
    expect(after.definition.steps[0]).toMatchObject({ prompt: '第一步旧提示词' })
    expect(after.draft?.definition.steps[0]).toMatchObject({ prompt: '第一步仍待审的新提示词' })
  })

  test('旧全局标准局部采纳时，审批只显示所选步骤而不把其他继承标准误报为新增', async () => {
    const { service, facade } = fixture()
    const empty = service.createScene('旧标准局部采纳')
    const legacy = withTwoSteps(empty.definition)
    delete legacy.stepAcceptances
    legacy.acceptance = { criteria: ['旧全局标准'], judgePrompt: '旧评审提示', metrics: [] }
    service.saveDraft(empty.id, legacy, 'human', '初始化旧格式')
    service.adoptDraft(empty.id)
    const current = service.getScene(empty.id)!
    const draft = structuredClone(current.definition)
    draft.acceptance = { criteria: ['新全局标准'], judgePrompt: '新评审提示', metrics: [] }
    service.saveDraft(current.id, draft, 'agent', '更新旧格式标准')

    const prepared = facade.prepareOperation({
      kind: 'adoptDraft', sceneId: current.id, scope: { kind: 'stepAcceptance', stepId: 'first' },
    })
    if ('reason' in prepared) throw new Error(prepared.reason)
    const changes = prepared.approval.adoption?.changes.join('\n') ?? ''
    expect(changes).toContain('评审判据（first）')
    expect(changes).toContain('新全局标准')
    expect(changes).not.toContain('评审判据（second）')
    expect(changes).not.toContain('评审提示词（second）')

    expect(await facade.applyOperation(prepared.preparedId)).toMatchObject({ applied: true })
    expect(service.getScene(current.id)?.definition.stepAcceptances?.first?.criteria).toEqual(['新全局标准'])
    expect(service.getScene(current.id)?.definition.stepAcceptances?.second?.criteria).toEqual(['旧全局标准'])
  })

  test('局部采纳拒绝整份 testedBatchId，且准备摘要不读取整份批次证据', () => {
    const { service } = fixture()
    const empty = service.createScene('证据隔离')
    service.saveDraft(empty.id, withTwoSteps(empty.definition), 'human', '初始化')
    service.adoptDraft(empty.id)
    const current = service.getScene(empty.id)!
    const draft = structuredClone(current.definition)
    if (draft.steps[0]?.type !== 'llm') throw new Error('测试步骤类型错误')
    draft.steps[0].prompt = '第一步新提示词'
    service.saveDraft(current.id, draft, 'agent', '局部优化')
    let listCalls = 0
    let getCalls = 0
    const facade = createCapabilityFactoryAgentFacade({
      service,
      listBatches: () => { listCalls += 1; return [] },
      getBatch: () => { getCalls += 1; return null },
    })

    expect(facade.prepareOperation({
      kind: 'adoptDraft', sceneId: current.id, scope: { kind: 'step', stepId: 'first' }, testedBatchId: 'batch-1',
    })).toEqual({ reason: '局部采纳不能使用整份草案的验证批次' })
    /** 非 schema 调用也不能把 null 当成缺省的整份批准。 */
    const invalidScope = facade.prepareOperation({
      kind: 'adoptDraft', sceneId: current.id, scope: null,
    } as unknown as CapabilityFactoryAgentOperation)
    expect('reason' in invalidScope).toBe(true)
    const prepared = facade.prepareOperation({
      kind: 'adoptDraft', sceneId: current.id, scope: { kind: 'step', stepId: 'first' },
    })
    if ('reason' in prepared) throw new Error(prepared.reason)
    expect(listCalls).toBe(0)
    expect(getCalls).toBe(0)
    expect(prepared.approval.adoption?.validation).toContain('局部采纳未复用整份草案测试证据')
  })

  test('局部采纳准备后任意草案改动都会使旧批准失效', async () => {
    const { service, facade } = fixture()
    const empty = service.createScene('局部 CAS')
    service.saveDraft(empty.id, withTwoSteps(empty.definition), 'human', '初始化')
    service.adoptDraft(empty.id)
    const current = service.getScene(empty.id)!
    const firstDraft = structuredClone(current.definition)
    if (firstDraft.steps[0]?.type !== 'llm') throw new Error('测试步骤类型错误')
    firstDraft.steps[0].prompt = '第一步新提示词'
    service.saveDraft(current.id, firstDraft, 'agent', '第一份')
    const prepared = facade.prepareOperation({
      kind: 'adoptDraft', sceneId: current.id, scope: { kind: 'step', stepId: 'first' },
    })
    if ('reason' in prepared) throw new Error(prepared.reason)

    const changedDraft = structuredClone(firstDraft)
    if (changedDraft.steps[1]?.type !== 'llm') throw new Error('测试步骤类型错误')
    changedDraft.steps[1].prompt = '并发修改第二步'
    service.saveDraft(current.id, changedDraft, 'human', '并发修改')
    expect(await facade.applyOperation(prepared.preparedId)).toEqual({
      applied: false, reason: '目标状态已变化，请重新准备操作',
    })
  })

  test('数据集操作批量添加用例并由 Host 固定来源为 agent', async () => {
    const { service, facade } = fixture()
    const dataset = service.createDataset('回归集')
    const prepared = facade.prepareOperation({
      kind: 'addDatasetCases', datasetId: dataset.id,
      cases: [{ name: '第一条', input: { text: '正文' } }, { input: { text: '边界' }, expected: { ok: true } }],
    })
    if ('reason' in prepared) throw new Error(prepared.reason)
    expect(service.listDatasets()[0]?.cases).toEqual([])

    expect(await facade.applyOperation(prepared.preparedId)).toMatchObject({ applied: true })
    expect(service.listDatasets()[0]?.cases.map((item) => item.source)).toEqual(['agent', 'agent'])
    expect(service.listDatasets()[0]?.version).toBe(3)
  })

  test('计划模式可读取和准备，但运行与 apply 均拒绝', async () => {
    const { service } = fixture()
    const scene = service.createScene('账号查询')
    const facade = createCapabilityFactoryAgentFacade({
      service,
      canMutate: () => false,
      runScene: async () => { throw new Error('不应运行') },
    })
    expect(facade.listScenes()).toHaveLength(1)
    const prepared = facade.prepareOperation({ kind: 'renameScene', sceneId: scene.id, name: '新名称' })
    if ('reason' in prepared) throw new Error(prepared.reason)
    expect(await facade.applyOperation(prepared.preparedId)).toMatchObject({ applied: false })
    expect(await facade.runScene(scene.id, {})).toEqual({ reason: '当前模式不允许运行编排工厂' })
  })

  test('每个入口复核当前工作区，失效 facade 不再读取或写入', () => {
    const { service } = fixture()
    service.createScene('账号查询')
    let current = true
    const facade = createCapabilityFactoryAgentFacade({
      service,
      assertCurrent() { if (!current) throw new Error('工作区已失效') },
    })
    expect(facade.listScenes()).toHaveLength(1)
    current = false
    expect(() => facade.listScenes()).toThrow('工作区已失效')
    expect(() => facade.prepareOperation({ kind: 'createDataset', name: '测试集' })).toThrow('工作区已失效')
  })

  test('批次限制单批 10 条、每回合最多 3 轮 comparison，普通整链不强制对比参数', async () => {
    const { service } = fixture()
    const scene = service.createScene('账号查询')
    const taskIds = Array.from({ length: 9 }, (_, index) => `task-${index}`)
    const batch = (id: string): CapabilityFactoryBatch => ({
      id, sceneId: scene.id, kind: 'comparison', status: 'succeeded',
      snapshot: { sceneVersion: 1, itemIds: taskIds }, items: [], adoptable: false,
      startedAt: 1, updatedAt: 2, finishedAt: 2,
    })
    const sceneCalls: unknown[] = []
    const facade = createCapabilityFactoryAgentFacade({
      service,
      runBatch: async (request) => batch(request.taskIds?.[0] ?? 'dataset'),
      runScene: async (request) => {
        sceneCalls.push(request)
        return {
          id: 'run-normal', sceneId: request.sceneId, sceneVersion: 1, kind: 'full', status: 'succeeded',
          valid: true, input: request.input, outputs: {}, steps: [], startedAt: 1, finishedAt: 2,
        }
      },
    })
    await facade.runScene(scene.id, { text: '普通运行' })
    expect(sceneCalls).toEqual([{ sceneId: scene.id, input: { text: '普通运行' } }])
    for (let index = 0; index < 3; index += 1) {
      expect('id' in await facade.runBatch({ sceneId: scene.id, kind: 'comparison', taskIds })).toBe(true)
    }
    expect(await facade.runBatch({ sceneId: scene.id, kind: 'comparison', taskIds })).toEqual({
      reason: '当前 Agent 回合最多运行 3 轮优化对比',
    })
    expect(await facade.runBatch({
      sceneId: scene.id,
      kind: 'evaluation',
      taskIds: [...taskIds, 'task-9', 'task-10'],
    })).toEqual({
      reason: '单批最多运行 10 条用例',
    })
  })

  test('超过十条的数据集可用 caseIds 分批，且子集身份严格校验', async () => {
    let id = 0
    const service = new CapabilityFactoryService({
      store: new CapabilityFactoryStore(mkdtempSync(join(tmpdir(), 'cap-factory-subset-'))),
      createId: () => `id-${++id}`,
    })
    const scene = service.createScene('账号查询')
    const dataset = service.createDataset('大回归集')
    for (let index = 0; index < 11; index += 1) service.addCase(dataset.id, { index })
    const selected = service.listDatasets()[0]?.cases.slice(0, 10).map((item) => item.id) ?? []
    const calls: unknown[] = []
    const facade = createCapabilityFactoryAgentFacade({
      service,
      runBatch: async (request) => {
        calls.push(request)
        return {
          id: 'batch', sceneId: scene.id, kind: request.kind, status: 'succeeded',
          snapshot: { sceneVersion: 1, datasetId: dataset.id, itemIds: request.caseIds ?? [] },
          items: [], adoptable: false, startedAt: 1, updatedAt: 2, finishedAt: 2,
        }
      },
    })

    expect(await facade.runBatch({ sceneId: scene.id, kind: 'evaluation', datasetId: dataset.id })).toEqual({
      reason: '单批最多运行 10 条用例；请传 caseIds 分批执行',
    })
    expect('id' in await facade.runBatch({
      sceneId: scene.id, kind: 'evaluation', datasetId: dataset.id, caseIds: selected,
    })).toBe(true)
    expect(calls).toHaveLength(1)
    expect(await facade.runBatch({
      sceneId: scene.id, kind: 'evaluation', datasetId: dataset.id, caseIds: [selected[0] as string, selected[0] as string],
    })).toEqual({ reason: 'caseIds 不能重复' })
    expect(await facade.runBatch({
      sceneId: scene.id, kind: 'evaluation', datasetId: dataset.id, caseIds: ['missing'],
    })).toEqual({ reason: '数据集用例不存在：missing' })
    expect(await facade.runBatch({ sceneId: scene.id, kind: 'evaluation', caseIds: ['case-1'] })).toEqual({
      reason: 'caseIds 必须与 datasetId 一起使用',
    })
  })

  test('旧单次对比入口每轮只允许 baseline/candidate 各一次', async () => {
    const { service } = fixture()
    const scene = service.createScene('账号查询')
    const facade = createCapabilityFactoryAgentFacade({
      service,
      runScene: async (request) => ({
        id: `${request.comparisonRole}`, sceneId: scene.id, sceneVersion: 1, kind: 'full',
        status: 'succeeded', valid: true, input: request.input, outputs: {}, steps: [], startedAt: 1, finishedAt: 2,
      }),
    })
    const options = { target: 'current' as const, expectedVersion: 1, comparisonId: 'round-1', comparisonRole: 'baseline' as const }
    expect('id' in await facade.runScene(scene.id, {}, options)).toBe(true)
    expect(await facade.runScene(scene.id, {}, options)).toEqual({ reason: '同一轮对比不能重复运行相同角色' })
  })

  test('批次与单次对比共用三轮预算，不能从另一入口绕过', async () => {
    const { service } = fixture()
    const scene = service.createScene('账号查询')
    const taskIds = ['task-1']
    const facade = createCapabilityFactoryAgentFacade({
      service,
      runBatch: async () => ({
        id: 'batch', sceneId: scene.id, kind: 'comparison', status: 'succeeded',
        snapshot: { sceneVersion: 1, itemIds: taskIds }, items: [], adoptable: false,
        startedAt: 1, updatedAt: 2, finishedAt: 2,
      }),
      runScene: async (request) => ({
        id: 'run', sceneId: scene.id, sceneVersion: 1, kind: 'full', status: 'succeeded', valid: true,
        input: request.input, outputs: {}, steps: [], startedAt: 1, finishedAt: 2,
      }),
    })
    await facade.runBatch({ sceneId: scene.id, kind: 'comparison', taskIds })
    await facade.runBatch({ sceneId: scene.id, kind: 'comparison', taskIds })
    await facade.runScene(scene.id, {}, {
      target: 'current', expectedVersion: 1, comparisonId: 'round-3', comparisonRole: 'baseline',
    })
    expect(await facade.runScene(scene.id, {}, {
      target: 'current', expectedVersion: 1, comparisonId: 'round-4', comparisonRole: 'baseline',
    })).toEqual({ reason: '当前 Agent 回合最多运行 3 轮优化对比' })
  })

  test('普通单次运行也受当前回合 60 次硬上限约束', async () => {
    const { service } = fixture()
    const scene = service.createScene('账号查询')
    let calls = 0
    const facade = createCapabilityFactoryAgentFacade({
      service,
      runStep: async ({ input }) => {
        calls += 1
        return {
          id: `run-${calls}`, sceneId: scene.id, sceneVersion: 1, kind: 'step', stepId: 'answer',
          status: 'succeeded', valid: true, input, outputs: {}, steps: [], startedAt: 1, finishedAt: 2,
        }
      },
    })
    for (let index = 0; index < 60; index += 1) {
      expect('id' in await facade.runStep(scene.id, 'answer', { index })).toBe(true)
    }
    expect(await facade.runStep(scene.id, 'answer', {})).toEqual({ reason: '当前 Agent 回合最多发起 60 次场景运行' })
    expect(calls).toBe(60)
  })

  test('成功写入或运行后通知宿主刷新，拒绝操作不通知', async () => {
    const { service } = fixture()
    const scene = service.createScene('账号查询')
    let changed = 0
    const facade = createCapabilityFactoryAgentFacade({
      service,
      onChanged: () => { changed += 1 },
      runScene: async (request) => ({
        id: 'run-1', sceneId: scene.id, sceneVersion: 1, kind: 'full', status: 'succeeded', valid: true,
        input: request.input, outputs: {}, steps: [], startedAt: 1, finishedAt: 2,
      }),
    })
    await facade.runScene(scene.id, {})
    const prepared = facade.prepareOperation({ kind: 'renameScene', sceneId: scene.id, name: '新名称' })
    if ('reason' in prepared) throw new Error(prepared.reason)
    await facade.applyOperation(prepared.preparedId)
    await facade.applyOperation('missing')
    expect(changed).toBe(2)
  })

  test('虚拟接入也是两段式：prepare 不写盘、apply 才写，来源盖章 agent', () => {
    const { service, facade } = fixture()
    const scene = service.createScene('小说角色提取')
    service.saveDraft(scene.id, {
      ...scene.definition,
      capabilities: [{
        id: 'corpus.build', description: '构建批次正文',
        inputSchema: [{ name: 'text', type: 'string' }],
        outputSchema: [{ name: 'corpusText', type: 'string' }, { name: 'paragraphCount', type: 'number' }],
        sideEffect: 'read',
      }],
    }, 'human', '先声明能力')
    /** 能力要先在**生效定义**里声明：只有草案声明过的能力还不算（桩不该挂到没上线的契约上）。 */
    service.adoptDraft(scene.id)

    const prepared = facade.prepareStub('corpus.build', { corpusText: '第 1 段', paragraphCount: 1 }, '取自真实响应')
    if ('reason' in prepared) throw new Error(`prepareStub 不应失败：${prepared.reason}`)

    /** 关键：prepare 之后本地还没有任何桩。 */
    expect(service.listStubs()).toEqual([])
    expect(prepared.approval.kind).toBe('stub')
    if (prepared.approval.kind !== 'stub') throw new Error('应为桩快照')
    expect(prepared.approval.capabilityId).toBe('corpus.build')
    /** 卡片只给形状预览，不把整份真实数据塞进审批卡。 */
    expect(prepared.approval.payloadPreview).toContain('corpusText')
    expect(prepared.approval.usedByScenes).toEqual(['小说角色提取'])

    expect(facade.applyStub(prepared.preparedId)).toEqual({ saved: true, capabilityId: 'corpus.build' })
    expect(service.listStubs()[0]?.source).toBe('agent')
    expect(service.listStubs()[0]?.payload).toEqual({ corpusText: '第 1 段', paragraphCount: 1 })
    /** preparedId 只能用一次。 */
    expect(facade.applyStub(prepared.preparedId).saved).toBe(false)
  })

  test('桩在批准期间被替换时拒绝旧快照', () => {
    const { service, facade } = fixture()
    const scene = service.createScene('小说角色提取')
    service.saveDraft(scene.id, {
      ...scene.definition,
      capabilities: [{ id: 'corpus.build', description: '构建正文', inputSchema: [], outputSchema: [], sideEffect: 'read' }],
    }, 'human', '声明能力')
    service.adoptDraft(scene.id)
    service.setStub('corpus.build', { value: 1 }, '旧值')
    const prepared = facade.prepareStub('corpus.build', { value: 2 }, 'Agent 值')
    if ('reason' in prepared) throw new Error(prepared.reason)

    service.setStub('corpus.build', { value: 3 }, '并发值')
    expect(facade.applyStub(prepared.preparedId)).toEqual({ saved: false, reason: '虚拟接入已变化，请重新准备' })
    expect(service.listStubs()[0]?.payload).toEqual({ value: 3 })
  })

  test('没有场景声明过的能力：prepareStub 直接拒绝，避免桩挂到不存在的能力上', () => {
    const { facade } = fixture()

    const prepared = facade.prepareStub('nobody.uses.this', { a: 1 }, '试试')

    expect('reason' in prepared && prepared.reason).toContain('没有场景声明')
  })

  test('桩的审批快照取不到时返回 null，宿主据此拒绝 apply', () => {
    const { facade } = fixture()

    expect(facade.approval('factory_apply_stub', { preparedId: 'nope' })).toBeNull()
    expect(facade.approval('factory_apply_stub', {})).toBeNull()
  })
})
