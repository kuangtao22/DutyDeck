import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityRunModelBinding, CapabilitySceneDefinition, Channel } from '@proma/shared'
import { resolveCapabilityFactoryModels } from './capability-factory-model-call'
import { CapabilityFactoryStore } from './capability-factory-store'
import { CapabilityFactoryService } from './capability-factory-service'
import { createCapabilityFactoryRunner } from './capability-factory-run'
import { createCapabilityFactorySessionRuntime } from './capability-factory-session-runtime'

/** 两个渠道故意提供同名模型，证明模型选择必须绑定渠道身份。 */
const channels: Channel[] = ['first', 'second'].map((id) => ({
  id, name: id, provider: 'openai', baseUrl: 'https://example.invalid', apiKey: '',
  enabled: true, createdAt: 0, updatedAt: 0,
  models: [{ id: 'same-model', name: '同名模型', enabled: true }],
}))

/** 双模型步骤分别引用独立槽位，返回可直接运行的场景定义。 */
function definition(): CapabilitySceneDefinition {
  return {
    name: '模型选择', description: '', inputs: [], capabilities: [],
    outputs: [{ name: 'answer', from: { stepId: 'second-step' }, shape: 'text' }],
    steps: ['first', 'second'].map((id) => ({
      id: `${id}-step`, type: 'llm', title: id, modelSlot: id, prompt: '回答',
    })),
    modelSlots: ['first', 'second'].map((id) => ({ id, model: 'same-model' })),
    acceptance: { criteria: ['正确'], judgePrompt: '', metrics: [] },
  }
}

/** 为给定槽位和渠道生成离线运行绑定，避免测试消耗真实模型额度。 */
function binding(slotId: string, channelId: string): CapabilityRunModelBinding {
  return { slotId, channelId, channelName: channelId, declaredModel: 'same-model', modelId: 'same-model', substituted: false }
}

/** 真实持久化夹具的临时根目录，每例结束后清理。 */
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('工厂明确模型选择', () => {
  test('Given 两个渠道提供同名模型 When 用户指定第二个渠道 Then 精确使用所选渠道', () => {
    /** 已选配置不依赖全局渠道顺序或当前会话模型。 */
    const configured = { ...definition(), modelSelection: { slots: { first: { channelId: 'second', modelId: 'same-model' } } } }
    const result = resolveCapabilityFactoryModels(configured, channels, { channelId: 'first', modelId: 'same-model' })
    expect(result.error).toBeUndefined()
    expect(result.bindings[0]).toMatchObject({ channelId: 'second', modelId: 'same-model', substituted: false })
  })

  test.each(['missing-channel', 'disabled-channel', 'disabled-model', 'missing-model'])('Given 明确选择%s失效 When 解析 Then 拒绝回退到会话模型', (state) => {
    /** 仅破坏明确选择，仍保留可用会话渠道以捕获静默替换。 */
    const available = structuredClone(channels)
    if (state === 'disabled-channel') available[1]!.enabled = false
    if (state === 'disabled-model') available[1]!.models[0]!.enabled = false
    const configured = { ...definition(), modelSelection: { slots: { first: {
      channelId: state === 'missing-channel' ? 'missing' : 'second',
      modelId: state === 'missing-model' ? 'same-model-new' : 'same-model',
    } } } }
    expect(resolveCapabilityFactoryModels(configured, available, { channelId: 'first', modelId: 'same-model' }).error).toBeDefined()
  })

  test('Given 独立评审模型 When 解析 Then 单独冻结评审绑定而不冒充执行槽位', () => {
    /** 评审器不占据用户定义的执行槽位。 */
    const configured = { ...definition(), modelSelection: { slots: {}, review: { channelId: 'second', modelId: 'same-model' } } }
    const result = resolveCapabilityFactoryModels(configured, channels, null)
    expect(result.bindings).toHaveLength(2)
    expect(result.reviewBinding).toMatchObject({ channelId: 'second', modelId: 'same-model', substituted: false })
  })

  test('Given 两个槽位声明相同模型 When 执行和自动评审 Then 各步骤使用自己的渠道且评审可独立指定', async () => {
    /** 服务保存真实场景，模型端口只记录调用目标并返回合成报告。 */
    const root = mkdtempSync(join(tmpdir(), 'factory-model-selection-'))
    roots.push(root)
    const service = new CapabilityFactoryService({ store: new CapabilityFactoryStore(root) })
    const scene = service.createScene('模型选择')
    service.saveDraft(scene.id, definition(), 'human', '配置测试步骤')
    service.adoptDraft(scene.id)
    const calls: Array<{ stepId: string; channelId: string }> = []
    const runner = createCapabilityFactoryRunner({
      service,
      resolveModels: () => ({ bindings: [binding('first', 'first'), binding('second', 'second')], reviewBinding: binding('__factory_review__', 'review-channel') }),
      callModel: async (request) => {
        calls.push({ stepId: request.stepId, channelId: request.channelId })
        return { model: request.modelId, text: request.stepId === '__factory_review__'
          ? JSON.stringify({ passed: true, summary: '通过', criteria: [{ criterion: '正确', passed: true, evidence: '答案正确' }], metrics: [], suggestions: [] })
          : '答案' }
      },
    })
    const run = await runner.run(scene.id, {})
    expect(run.status).toBe('succeeded')
    expect(calls).toEqual([
      { stepId: 'first-step', channelId: 'first' }, { stepId: 'second-step', channelId: 'second' },
      { stepId: '__factory_review__', channelId: 'review-channel' }, { stepId: '__factory_review__', channelId: 'review-channel' },
    ])
    expect(run.stepReviews?.['first-step']?.modelBinding?.channelId).toBe('review-channel')
    expect(run.review?.modelBinding?.channelId).toBe('review-channel')
    /** 单步试跑也遵循相同评审绑定，不被同名模型误匹配到另一渠道。 */
    calls.length = 0
    await runner.runStep(scene.id, 'second-step', {})
    expect(calls).toEqual([{ stepId: 'second-step', channelId: 'second' }, { stepId: '__factory_review__', channelId: 'review-channel' }])
  })

  test('Given 批次中会话默认模型改变 When 执行下一条任务 Then 执行和评审继续使用开始时冻结的渠道', async () => {
    /** 两条真实保存任务通过同一批次执行，解析源在首次调用后变化。 */
    const root = mkdtempSync(join(tmpdir(), 'factory-model-batch-'))
    roots.push(root)
    const service = new CapabilityFactoryService({ store: new CapabilityFactoryStore(root) })
    const scene = service.createScene('模型快照')
    service.saveDraft(scene.id, definition(), 'human', '测试')
    service.adoptDraft(scene.id)
    const dataset = service.createDataset('两条模型快照用例')
    for (const item of [1, 2]) service.addCase(dataset.id, { item })
    /** 模拟用户切换当前会话模型，不改变场景版本。 */
    let sessionChannel = 'first'
    let resolutions = 0
    const calledChannels: string[] = []
    const runtime = createCapabilityFactorySessionRuntime({
      rootDir: root, sessionId: 'session', service, assertCurrent: () => undefined,
      getRunPorts: () => ({
        resolveModels: (value) => {
          resolutions += 1
          return { bindings: value.modelSlots.map((slot) => binding(slot.id, sessionChannel)),
            reviewBinding: binding('__factory_review__', sessionChannel) }
        },
        callModel: async (request) => {
          calledChannels.push(request.channelId)
          sessionChannel = 'second'
          return { model: request.modelId, text: request.stepId === '__factory_review__'
            ? JSON.stringify({ passed: true, summary: '通过', criteria: [{ criterion: '正确', passed: true, evidence: '已核对' }], metrics: [], suggestions: [] })
            : '答案' }
        },
      }),
    })
    const batch = await runtime.runBatch({ sceneId: scene.id, kind: 'evaluation', datasetId: dataset.id })
    expect(batch.status).toBe('succeeded')
    expect(calledChannels).toHaveLength(8)
    expect(new Set(calledChannels)).toEqual(new Set(['first']))
    expect(resolutions).toBe(1)
  })
})
