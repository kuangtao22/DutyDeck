import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getStepAcceptance, type CapabilitySceneDefinition, type Step } from '@proma/shared'
import { CapabilityFactoryStore } from './capability-factory-store'
import { CapabilityFactoryService } from './capability-factory-service'

/** 建立两个已生效步骤，返回临时存储与独立服务；不读取用户工厂数据。 */
function fixture() {
  /** 固定时钟覆盖同毫秒采纳后剩余草案身份仍须变化的边界。 */
  const rootDir = mkdtempSync(join(tmpdir(), 'factory-partial-'))
  const store = new CapabilityFactoryStore(rootDir)
  const service = new CapabilityFactoryService({ store, now: () => 1000 })
  const created = service.createScene('分块审核')
  const definition: CapabilitySceneDefinition = {
    ...created.definition,
    steps: ['a', 'b'].map((id) => ({ type: 'llm', id, title: id, modelSlot: 'main', prompt: `${id}-old` })),
    stepAcceptances: Object.fromEntries(['a', 'b'].map((id) => [id, { criteria: [`${id}-old`], judgePrompt: '核对证据', metrics: [] }])),
  }
  service.saveDraft(created.id, definition, 'human', '初始流程')
  const scene = service.adoptDraft(created.id).scene
  return { rootDir, store, service, scene }
}

/** 同时修改两个步骤和两份标准，返回彼此独立的四块候选内容。 */
function changedDefinition(definition: CapabilitySceneDefinition): CapabilitySceneDefinition {
  return {
    ...definition,
    steps: definition.steps.map((step) => 'prompt' in step ? { ...step, prompt: `${step.id}-new` } : step),
    stepAcceptances: Object.fromEntries(['a', 'b'].map((id) => [id, { criteria: [`${id}-new`], judgePrompt: '核对证据', metrics: [] }])),
  }
}

describe('编排工厂逐块采纳', () => {
  test('Given 四块同时变化 When 逐块采纳 Then 每次只生效当前块且最后一次才清空草案', () => {
    const { service, scene, store, rootDir } = fixture()
    const candidate = changedDefinition(scene.definition)
    const saved = service.saveDraft(scene.id, candidate, 'agent', '改进四块')
    const first = service.adoptDraft(scene.id, { scope: { kind: 'step', stepId: 'a' } })
    expect(first.scene.definition.steps).toEqual([candidate.steps[0]!, scene.definition.steps[1]!])
    expect(first.scene.definition.stepAcceptances).toEqual(scene.definition.stepAcceptances)
    expect(first.scene.draft?.definition).toEqual(candidate)
    expect(first.scene.draft?.createdAt).toBeGreaterThan(saved.draft!.createdAt)
    expect(first.version.note).toContain('a')
    expect(first.version.definition).toEqual(first.scene.definition)
    expect(new CapabilityFactoryStore(rootDir).listScenes()[0]).toEqual(first.scene)

    const second = service.adoptDraft(scene.id, { scope: { kind: 'stepAcceptance', stepId: 'a' } }).scene
    expect(second.definition.stepAcceptances).toEqual({ a: candidate.stepAcceptances!.a!, b: scene.definition.stepAcceptances!.b! })
    expect(second.definition.steps[1]).toEqual(scene.definition.steps[1])
    service.adoptDraft(scene.id, { scope: { kind: 'step', stepId: 'b' } })
    const last = service.adoptDraft(scene.id, { scope: { kind: 'stepAcceptance', stepId: 'b' } }).scene
    expect(last.definition).toEqual(candidate)
    expect(last.draft).toBeNull()
    expect(last.currentVersion).toBe(scene.currentVersion + 4)
    expect(store.listVersions(scene.id)).toHaveLength(last.currentVersion)
  })

  test('Given 场景元信息也变化 When 采纳步骤 Then 其余字段仍待审核且整体入口兼容', () => {
    const { service, scene } = fixture()
    const candidate = { ...scene.definition, description: '尚未审核的说明', steps: changedDefinition(scene.definition).steps }
    service.saveDraft(scene.id, candidate, 'agent', '两个步骤与说明')
    service.adoptDraft(scene.id, { scope: { kind: 'step', stepId: 'a' } })
    const partial = service.adoptDraft(scene.id, { scope: { kind: 'step', stepId: 'b' } }).scene
    expect(partial.definition.description).toBe(scene.definition.description)
    expect(partial.draft?.definition.description).toBe(candidate.description)
    expect(service.adoptDraft(scene.id, { scope: { kind: 'all' } }).scene.definition).toEqual(candidate)
  })

  test('Given 旧场景全局评审变更 When 分别采纳 Then 保留其他步骤旧标准并最终清空等价草案', () => {
    const { service, scene } = fixture()
    const legacy = { ...scene.definition, acceptance: { criteria: ['old'], judgePrompt: 'old', metrics: [] } }
    delete legacy.stepAcceptances
    service.saveDraft(scene.id, legacy, 'human', '旧格式')
    service.adoptDraft(scene.id)
    const candidate = { ...legacy, acceptance: { criteria: ['new'], judgePrompt: 'new', metrics: [] } }
    service.saveDraft(scene.id, candidate, 'agent', '更新旧评审')
    const first = service.adoptDraft(scene.id, { scope: { kind: 'stepAcceptance', stepId: 'a' } }).scene
    expect(getStepAcceptance(first.definition, 'a')).toEqual(candidate.acceptance)
    expect(getStepAcceptance(first.definition, 'b')).toEqual(legacy.acceptance)
    expect(first.draft).not.toBeNull()
    const last = service.adoptDraft(scene.id, { scope: { kind: 'stepAcceptance', stepId: 'b' } }).scene
    expect(getStepAcceptance(last.definition, 'b')).toEqual(candidate.acceptance)
    expect(last.draft).toBeNull()
  })

  test('Given 草案清除单步标准 When 采纳标准 Then 不清除其他标准或提示词', () => {
    const { service, scene } = fixture()
    const candidate = changedDefinition(scene.definition)
    candidate.stepAcceptances!.a = { criteria: [], judgePrompt: '', metrics: [] }
    service.saveDraft(scene.id, candidate, 'agent', '清除 a 标准')
    const result = service.adoptDraft(scene.id, { scope: { kind: 'stepAcceptance', stepId: 'a' } }).scene
    expect(getStepAcceptance(result.definition, 'a')).toBeNull()
    expect(getStepAcceptance(result.definition, 'b')).toEqual(getStepAcceptance(scene.definition, 'b'))
    expect(result.definition.steps).toEqual(scene.definition.steps)
  })

  test('Given 同一草案的旧批准 When 其他块已采纳 Then 三重锁拒绝过期请求且无变化的块不能生成新版本', () => {
    const { service, scene } = fixture()
    const saved = service.saveDraft(scene.id, changedDefinition(scene.definition), 'agent', '并发审核')
    const locks = { expectedVersion: saved.currentVersion, expectedDraftCreatedAt: saved.draft!.createdAt, expectedDraftDefinition: saved.draft!.definition }
    const current = service.adoptDraft(scene.id, { ...locks, scope: { kind: 'step', stepId: 'a' } }).scene
    expect(() => service.adoptDraft(scene.id, { ...locks, scope: { kind: 'step', stepId: 'b' } })).toThrow('场景版本已变化')
    expect(() => service.adoptDraft(scene.id, { scope: { kind: 'step', stepId: 'a' } })).toThrow('没有待采纳的改动')
    expect(service.getScene(scene.id)).toEqual(current)
  })

  test('Given 未配置标准的空值与缺省表示混用 When 最后一个可见改动采纳 Then 不遗留无法审核的空草案', () => {
    const { service, scene } = fixture()
    const initial = structuredClone(scene.definition)
    initial.stepAcceptances!.b = { criteria: [], judgePrompt: '', metrics: [] }
    service.saveDraft(scene.id, initial, 'human', '清空 b')
    service.adoptDraft(scene.id)
    const candidate = structuredClone(initial)
    candidate.stepAcceptances!.a = { criteria: ['a-new'], judgePrompt: '核对证据', metrics: [] }
    delete candidate.stepAcceptances!.b
    service.saveDraft(scene.id, candidate, 'agent', '修改 a，省略空配置')
    const result = service.adoptDraft(scene.id, { scope: { kind: 'stepAcceptance', stepId: 'a' } }).scene
    expect(result.draft).toBeNull()
    expect(getStepAcceptance(result.definition, 'b')).toBeNull()
  })

  test('Given 新增删除移动或依赖变化 When 只采纳一个步骤 Then 拒绝扩大范围且不写入版本', () => {
    const { service, scene } = fixture()
    const changed = changedDefinition(scene.definition)
    const alternatives: Step[][] = [
      changed.steps.slice(1),
      [...changed.steps].reverse(),
      [{ type: 'tool', id: 'a', title: 'a', capabilityId: 'api', bindings: {} }, changed.steps[1]!],
      changed.steps.map((step) => step.id === 'a' ? { ...step, inputs: { value: { from: 'step-output', stepId: 'new' } } } : step),
      [...changed.steps, changed.steps[0]!],
    ]
    for (const steps of alternatives) {
      const saved = service.saveDraft(scene.id, { ...changed, steps }, 'agent', '结构变化')
      expect(() => service.adoptDraft(scene.id, { scope: { kind: 'step', stepId: 'a' } })).toThrow('整份草案')
      expect(service.getScene(scene.id)).toEqual(saved)
    }
    expect(service.listVersions(scene.id)).toHaveLength(scene.currentVersion)
  })

  test('Given 并行组中两步变化 When 采纳子步骤 Then 只更新该节点且容器不能顺带采纳子块', () => {
    const { service, scene } = fixture()
    const nested: CapabilitySceneDefinition = { ...scene.definition, steps: [{ type: 'map', id: 'group', title: '组', over: { from: 'literal', value: [] }, body: scene.definition.steps }] }
    service.saveDraft(scene.id, nested, 'human', '嵌套步骤')
    service.adoptDraft(scene.id)
    const candidate: CapabilitySceneDefinition = { ...nested, steps: [{ ...nested.steps[0] as Extract<Step, { type: 'map' }>, body: changedDefinition(scene.definition).steps }] }
    service.saveDraft(scene.id, candidate, 'agent', '两个子步骤')
    expect(() => service.adoptDraft(scene.id, { scope: { kind: 'step', stepId: 'group' } })).toThrow('整份草案')
    const result = service.adoptDraft(scene.id, { scope: { kind: 'step', stepId: 'a' } }).scene
    expect(result.definition.steps[0]).toMatchObject({ body: [{ prompt: 'a-new' }, { prompt: 'b-old' }] })
    expect(result.draft).not.toBeNull()
  })
})
