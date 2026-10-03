import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilitySceneDefinition } from '@proma/shared'
import { CapabilityFactoryStore } from './capability-factory-store'
import { CapabilityFactoryService } from './capability-factory-service'
import { createCapabilityFactoryAgentFacade, type CapabilityFactoryAgentApproval } from './capability-factory-agent-facade'
import { CAPABILITY_FACTORY_AGENT_TOOL_NAMES } from './capability-factory-agent-tools'

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

  test('工具清单里没有采纳 / 回滚 / 导出 / 删除 —— 权限清单即工具清单', () => {
    const names = CAPABILITY_FACTORY_AGENT_TOOL_NAMES.join(' ')
    for (const forbidden of ['adopt', 'rollback', 'export', 'delete', 'publish']) {
      expect(names).not.toContain(forbidden)
    }
    /** 读 6 + 写 4 + 单步试跑 1 + 整链候选对比 1。 */
    expect(CAPABILITY_FACTORY_AGENT_TOOL_NAMES).toHaveLength(13)
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

  test('facade 上不存在任何能推进版本的方法', () => {
    const { facade } = fixture()
    // 这是刻意的结构性断言：即使将来有人加工具，也没有对应方法可接
    for (const forbidden of ['adoptDraft', 'rollback', 'exportPackage', 'deleteScene']) {
      expect(Object.prototype.hasOwnProperty.call(facade, forbidden)).toBe(false)
    }
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

  test('没有场景声明过的能力：prepareStub 直接拒绝，避免桩挂到不存在的能力上', () => {
    const { facade } = fixture()

    const prepared = facade.prepareStub('nobody.uses.this', { a: 1 }, '试试')

    expect('reason' in prepared && prepared.reason).toContain('没有场景声明')
  })

  test('桩的审批快照同样取不到时就返回 null（宿主降级展示，而不是画空卡）', () => {
    const { facade } = fixture()

    expect(facade.approval('factory_apply_stub', { preparedId: 'nope' })).toBeNull()
    expect(facade.approval('factory_apply_stub', {})).toBeNull()
  })
})
