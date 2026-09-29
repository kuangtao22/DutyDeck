import { describe, expect, test } from 'bun:test'
import { createEmptySceneDefinition, parseCapabilityFactoryCommand } from '@proma/shared'
import type { CapabilityFactoryApi, CapabilityRun, CapabilityScene } from '@proma/shared'
import { compareOptimizationPair, groupOptimizationRuns, canAdoptOptimization, runOptimizationBatch } from './capability-factory-optimization'

/** 已采纳定义与候选只在提示词上不同，评审标准固定。 */
const definition = { ...createEmptySceneDefinition('角色'), acceptance: { criteria: ['有证据'], judgePrompt: '逐字核对', metrics: [] } }
const candidateDefinition = { ...definition, description: '改进证据提取' }
const scene: CapabilityScene = { id: 'scene', definition, currentVersion: 2, createdAt: 1, updatedAt: 3,
  draft: { definition: candidateDefinition, source: 'agent', note: '修复证据', createdAt: 3 } }
/** 完整运行夹具，模型与评审身份足够用于比较。 */
function run(candidate = false): CapabilityRun {
  return { id: candidate ? 'candidate' : 'baseline', sceneId: 'scene', sceneVersion: 2, kind: 'full', status: 'succeeded', valid: true,
    input: { text: '正文' }, outputs: {}, steps: [], startedAt: 1, finishedAt: 10,
    definitionTarget: candidate ? 'draft' : 'current', definitionSnapshot: candidate ? candidateDefinition : definition,
    ...(candidate ? { draftCreatedAt: 3 } : {}), comparisonId: 'pair', comparisonRole: candidate ? 'candidate' : 'baseline',
    modelBindings: [{ slotId: 'main', declaredModel: 'test', channelId: 'channel', channelName: '模型', modelId: 'test', substituted: false }],
    review: { status: 'succeeded', passed: candidate, summary: '已核对', acceptance: definition.acceptance,
      criteria: [{ criterion: '有证据', passed: candidate, evidence: candidate ? '证据存在' : '缺少证据' }], metrics: [], suggestions: [], startedAt: 10, finishedAt: 15 },
  }
}

describe('优化对比边界', () => {
  test('Given 两步同名判据 When 比较 Then 分别报告修复退化且步骤评审提示词变化不可横比', () => {
    const baseline = run()
    const candidate = run(true)
    baseline.stepReviews = { scan: baseline.review!, profiles: candidate.review! }
    candidate.stepReviews = { scan: candidate.review!, profiles: baseline.review! }
    expect(compareOptimizationPair(baseline, candidate)).toMatchObject({ comparable: true, fixed: ['scan：有证据'], regressed: ['profiles：有证据'] })
    candidate.stepReviews.scan = { ...candidate.review!, acceptance: { ...definition.acceptance, judgePrompt: '放宽' } }
    expect(compareOptimizationPair(baseline, candidate).comparable).toBe(false)
  })
  test('Given 同任务同标准 When 对比 Then 显示修复与退化而非虚构分数', () => {
    expect(compareOptimizationPair(run(), run(true))).toMatchObject({ comparable: true, fixed: ['有证据'], regressed: [] })
    expect(compareOptimizationPair(run(true), run())).toMatchObject({ comparable: true, fixed: [], regressed: ['有证据'] })
  })
  test('Given 评审异常、标准、输入或模型变化 When 对比 Then 不宣称改善', () => {
    for (const candidate of [
      { ...run(true), review: { ...run(true).review!, status: 'failed' as const } },
      { ...run(true), review: { ...run(true).review!, acceptance: { ...definition.acceptance, criteria: ['放宽'] } } },
      { ...run(true), input: { text: '其他正文' } },
      { ...run(true), modelBindings: [] },
      { ...run(true), placeholderCapabilities: ['stub'] },
    ]) expect(compareOptimizationPair(run(), candidate).comparable).toBe(false)
  })
  test('Given 对象键换序 When 输入相同 Then 不误报变化', () => {
    expect(compareOptimizationPair({ ...run(), input: { a: 1, b: 2 } }, { ...run(true), input: { b: 2, a: 1 } }).comparable).toBe(true)
  })
  test('Given 持久历史缺少候选或包含普通记录 When 配对 Then 保留未完成对比且不混入普通记录', () => {
    expect(groupOptimizationRuns([run(), { ...run(), comparisonId: undefined }])).toHaveLength(1)
    expect(groupOptimizationRuns([run(), run(true)])[0]?.candidate?.id).toBe('candidate')
  })
  test('Given 草案被改写或基线变化 When 采纳 Then 旧对比不能背书新草案', () => {
    expect(canAdoptOptimization(run(true), scene)).toBe(true)
    expect(canAdoptOptimization(run(true), { ...scene, currentVersion: 3 })).toBe(false)
    expect(canAdoptOptimization(run(true), { ...scene, draft: { ...scene.draft!, definition } })).toBe(false)
  })
})

test('Given 已保存任务 When 对比 Then 两版共用输入和版本，回调保留基线与候选', async () => {
  /** 仅替换 IPC 端口，检查真实编排函数的发送参数与结果配对。 */
  const calls: Array<Record<string, unknown>> = []
  const api = { invoke: async (_method: string, input: Record<string, unknown>) => {
    parseCapabilityFactoryCommand({ method: _method, input })
    calls.push(input)
    return { ...run(input.target === 'draft'), comparisonId: input.comparisonId }
  } } as CapabilityFactoryApi
  const seen: string[] = []
  await runOptimizationBatch({ api, sessionId: 'session', scene, tasks: [{ id: 'task', sceneId: scene.id, input: { text: '正文' }, createdAt: 1, updatedAt: 1 }],
    onPair: (pair) => { seen.push(pair.candidate ? 'both' : 'baseline') }, isActive: () => true })
  expect(calls).toHaveLength(2)
  expect(calls[0]?.input).toEqual(calls[1]?.input)
  expect(calls[0]?.expectedVersion).toBe(2)
  expect(calls[1]?.expectedDraftCreatedAt).toBe(3)
  expect(calls[1]?.expectedDraftDefinition).toEqual(candidateDefinition)
  expect(calls[0]?.comparisonId).toBe(calls[1]?.comparisonId)
  expect(seen).toEqual(['baseline', 'both'])
})

test('Given 基线评审失败 When 对比 Then 保存失败结果并停止候选模型调用', async () => {
  let calls = 0
  const api = { invoke: async () => { calls += 1; return { ...run(), review: { ...run().review!, status: 'failed' as const } } } } as CapabilityFactoryApi
  const seen: string[] = []
  await expect(runOptimizationBatch({ api, sessionId: 'session', scene,
    tasks: [{ id: 'task', sceneId: scene.id, input: {}, createdAt: 1, updatedAt: 1 }],
    onPair: (pair) => { seen.push(pair.baseline.id) }, isActive: () => true,
  })).rejects.toThrow('评审')
  expect(calls).toBe(1)
  expect(seen).toEqual(['baseline'])
})

test('Given 草案改变模型配置 When 开始对比 Then 调用基线前就拒绝以避免无效开销', async () => {
  /** 只记录调用次数，模型配置不同不应触达执行端口。 */
  let calls = 0
  const api = { invoke: async () => { calls += 1; return run() } } as CapabilityFactoryApi
  await expect(runOptimizationBatch({ api, sessionId: 'session',
    scene: { ...scene, draft: { ...scene.draft!, definition: { ...candidateDefinition,
      modelSlots: [{ id: 'other', model: 'other' }] } } },
    tasks: [{ id: 'task', sceneId: scene.id, input: {}, createdAt: 1, updatedAt: 1 }],
    onPair: () => {}, isActive: () => true,
  })).rejects.toThrow('模型')
  expect(calls).toBe(0)
})
