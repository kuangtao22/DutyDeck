import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { CapabilityFactoryReviewRetryRequest, CapabilitySceneDefinition } from '@proma/shared'
import { CapabilityFactoryService } from './capability-factory-service'
import { CapabilityFactoryStore } from './capability-factory-store'
import { createCapabilityFactoryRunner } from './capability-factory-run'
import { createCapabilityFactoryReviewRetryService } from './capability-factory-review-retry'
import type { CapabilityFactoryReviewRetryOptions } from './capability-factory-review-retry'
import { writeJsonFileAtomicSecure } from '../safe-file'

/** 离线用例各自保存真实历史与补评记录，结束后清理临时目录。 */
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
/** 由原 runner 生成评审超时记录，避免手写历史绕过真实运行合同。 */
async function fixture(stepCount = 1, successfulReviews: number[] = [], singleStep = false) {
  const rootDir = mkdtempSync(join(tmpdir(), 'factory-review-retry-'))
  roots.push(rootDir)
  const service = new CapabilityFactoryService({ store: new CapabilityFactoryStore(rootDir) })
  const created = service.createScene('小说角色')
  const definition: CapabilitySceneDefinition = { ...created.definition,
    inputs: [{ name: 'text', type: 'string' }],
    acceptance: { criteria: ['角色有原文依据'], judgePrompt: '核对原文', metrics: [] },
    stepAcceptances: Object.fromEntries(Array.from({ length: stepCount }, (_, index) =>
      [`extract-${index}`, { criteria: ['角色有原文依据'], judgePrompt: '核对原文', metrics: [] }])),
    steps: Array.from({ length: stepCount }, (_, index) => ({ id: `extract-${index}`, title: '角色', type: 'llm' as const, modelSlot: 'main', prompt: '{{text}}' })),
    outputs: [{ name: 'answer', from: { stepId: 'extract-0' }, shape: 'text' }],
  }
  service.saveDraft(created.id, definition, 'human', '离线场景')
  const scene = service.adoptDraft(created.id).scene
  const bindings = [{ slotId: 'main', declaredModel: 'test', channelId: 'channel', channelName: '测试', modelId: 'test', substituted: false }]
  let configuration = 'config-v1'
  let executionCalls = 0
  /** 指定原轮已成功评审的步骤，其余用可识别超时模拟故障。 */
  let originalReviewIndex = 0
  const reviewText = JSON.stringify({ passed: true, summary: '角色正确', criteria: [{ criterion: '角色有原文依据', passed: true, evidence: '原文明确出现小林' }], metrics: [], suggestions: [] })
  const runner = createCapabilityFactoryRunner({ service, reviewTimeoutMs: 1,
    resolveModels: () => ({ bindings }),
    callModel: async (request) => {
      if (request.stepId === '__factory_review__') {
        if (successfulReviews.includes(originalReviewIndex++)) return { text: reviewText, model: 'test' }
        return new Promise<never>(() => {})
      }
      executionCalls += 1
      return { text: '小林', model: 'test' }
    },
  })
  const run = singleStep
    ? await runner.runStep(scene.id, 'extract-0', { text: '小林推开门。' })
    : await runner.run(scene.id, { text: '小林推开门。' })
  expect(run.error).toBeUndefined()
  expect(run.status).toBe('succeeded')
  let reviewCalls = 0
  const options: CapabilityFactoryReviewRetryOptions = { rootDir, service,
    resolveModels: () => ({ bindings: structuredClone(bindings), configurationFingerprint: configuration }),
    callModel: async (request) => {
      expect(request.stepId).toBe('__factory_review__')
      expect(request.prompt).toContain('小林推开门。')
      expect(request.callLedger).toBeDefined()
      /** 替身模拟真实端口的预留、传输与结算，不发网络请求。 */
      const id = request.callLedger!.reserve({ purpose: 'review', stepId: request.stepId, channelId: request.channelId, modelId: request.modelId, signal: request.signal })
      request.callLedger!.markSent(id, request.signal)
      reviewCalls += 1
      request.callLedger!.settle(id, { status: 'completed' })
      return { text: reviewText, model: 'test' }
    },
  }
  const api = createCapabilityFactoryReviewRetryService(options)
  const request: CapabilityFactoryReviewRetryRequest = { sceneId: scene.id, runId: run.id,
    expectedSourceFingerprint: api.diagnose(scene.id, run.id).sourceFingerprint,
    limits: { maxCalls: stepCount, maxTransportAttempts: stepCount * 2, durationMs: 1000 } }
  return { rootDir, service, scene, run, api, request, options, bindings,
    executionCalls: () => executionCalls, reviewCalls: () => reviewCalls,
    changeModel: () => { configuration = 'config-v2' } }
}

test('Given 执行成功但评审超时 When 定点补评 Then 只调用评审并独立保存，原运行字节不变', async () => {
  const f = await fixture()
  const original = readFileSync(join(f.rootDir, 'runs', `${f.scene.id}.jsonl`), 'utf8')
  expect(f.api.diagnose(f.scene.id, f.run.id).retryableStepIds).toEqual(['extract-0'])
  const result = await f.api.retry(f.request)
  expect(result.status).toBe('completed')
  expect(result.reviews['extract-0']?.passed).toBe(true)
  expect(result.calls).toHaveLength(1)
  expect(f.executionCalls()).toBe(1)
  expect(f.reviewCalls()).toBe(1)
  expect(readFileSync(join(f.rootDir, 'runs', `${f.scene.id}.jsonl`), 'utf8')).toBe(original)
  expect(f.service.getRun(f.scene.id, f.run.id)?.review?.status).toBe('failed')
  const reopened = createCapabilityFactoryReviewRetryService(f.options)
  expect(reopened.diagnose(f.scene.id, f.run.id).retry?.id).toBe(result.id)
  await expect(reopened.retry(f.request)).rejects.toThrow('一次')
})

test('Given 预算或诊断身份不足 When 补评 Then 零追加调用且不占用补评机会', async () => {
  const f = await fixture(2)
  await expect(f.api.retry({ ...f.request, limits: { ...f.request.limits, maxCalls: 1 } })).rejects.toThrow('预算')
  await expect(f.api.retry({ ...f.request, expectedSourceFingerprint: 'old' })).rejects.toThrow('变化')
  expect(f.reviewCalls()).toBe(0)
  expect(f.api.diagnose(f.scene.id, f.run.id).retry).toBeNull()
})

test('Given 已属于冻结实验的运行 When 诊断或补评 Then 不从新入口绕开实验预算', async () => {
  const f = await fixture()
  const api = createCapabilityFactoryReviewRetryService({ ...f.options, isExperimentRun: () => true })
  expect(api.diagnose(f.scene.id, f.run.id).retryableStepIds).toEqual([])
  await expect(api.retry(f.request)).rejects.toThrow('实验')
  expect(f.reviewCalls()).toBe(0)
})

test('Given 计划模式 When 读取与补评 Then 可诊断但不能发送模型请求', async () => {
  const f = await fixture()
  const api = createCapabilityFactoryReviewRetryService({ ...f.options, assertCanExecute: () => { throw new Error('计划模式') } })
  expect(api.diagnose(f.scene.id, f.run.id).category).toBe('review-retryable')
  await expect(api.retry(f.request)).rejects.toThrow('计划模式')
  expect(f.reviewCalls()).toBe(0)
})

test('Given 补评在途 When 第二个实例重试或用户取消 Then 不重发且保留尝试', async () => {
  const f = await fixture()
  const controller = new AbortController()
  let entered: (() => void) | undefined
  const started = new Promise<void>((resolve) => { entered = resolve })
  const options = { ...f.options, signal: controller.signal, callModel: async () => { entered?.(); return new Promise<never>(() => {}) } }
  const api = createCapabilityFactoryReviewRetryService(options)
  const pending = api.retry(f.request)
  await started
  await expect(createCapabilityFactoryReviewRetryService(options).retry(f.request)).rejects.toThrow('一次')
  controller.abort()
  expect((await pending).status).toBe('cancelled')
  expect(api.diagnose(f.scene.id, f.run.id).retry?.status).toBe('cancelled')
})

test('Given 已发送一项后模型配置变化 When 下一步补评 Then 停止并保留已完成报告', async () => {
  const f = await fixture(2)
  const api = createCapabilityFactoryReviewRetryService({ ...f.options, callModel: async (request) => {
    const response = await f.options.callModel(request)
    f.changeModel()
    return response
  } })
  const result = await api.retry(f.request)
  expect(result.status).toBe('failed')
  expect(result.summary).toContain('模型')
  expect(f.reviewCalls()).toBe(1)
  expect(result.calls).toHaveLength(1)
})

test('Given 补评总时限耗尽且端口忽略signal When 等待 Then 按时结束且不能再次消费', async () => {
  const f = await fixture()
  const api = createCapabilityFactoryReviewRetryService({ ...f.options, callModel: async () => new Promise<never>(() => {}) })
  const result = await api.retry({ ...f.request, limits: { ...f.request.limits, durationMs: 5 } })
  expect(result.status).toBe('failed')
  await expect(api.retry(f.request)).rejects.toThrow('一次')
})

test('Given 上次进程遗留在途补评 When 重读 Then 中断而不恢复或重发', async () => {
  const f = await fixture()
  const result = await f.api.retry(f.request)
  const directory = join(f.rootDir, 'review-retries')
  const file = join(directory, readdirSync(directory)[0]!)
  writeJsonFileAtomicSecure(file, { schemaVersion: 1, retry: { ...result, status: 'running', finishedAt: null, processId: 'previous-process' } })
  expect(createCapabilityFactoryReviewRetryService(f.options).diagnose(f.scene.id, f.run.id).retry?.status).toBe('interrupted')
  expect(f.reviewCalls()).toBe(1)
})

test('Given 首次持久化失败 When 请求补评 Then 不发送请求且原运行保留', async () => {
  const f = await fixture()
  writeFileSync(join(f.rootDir, 'review-retries'), 'blocked')
  await expect(f.api.retry(f.request)).rejects.toThrow()
  expect(f.reviewCalls()).toBe(0)
  expect(f.service.getRun(f.scene.id, f.run.id)).toEqual(f.run)
})

test('Given 源运行变化或归属丢失 When 模型结束 Then 不把结果当作可信补评', async () => {
  const f = await fixture()
  let revoked = false
  const api = createCapabilityFactoryReviewRetryService({ ...f.options,
    assertCurrent: () => { if (revoked) throw new Error('工作区归属变化') },
    callModel: async (request) => { const response = await f.options.callModel(request); revoked = true; return response },
  })
  await expect(api.retry(f.request)).rejects.toThrow('归属')
  expect(f.service.getRun(f.scene.id, f.run.id)).toEqual(f.run)
})

test('Given 一步评审成功另一步超时 When 补评 Then 只补失败步骤且原成功结论不变', async () => {
  const f = await fixture(2, [0])
  const original = readFileSync(join(f.rootDir, 'runs', `${f.scene.id}.jsonl`), 'utf8')
  const result = await f.api.retry({ ...f.request, limits: { ...f.request.limits, maxCalls: 1 } })
  expect(result.status).toBe('completed')
  expect(result.stepIds).toEqual(['extract-1'])
  expect(Object.keys(result.reviews)).toEqual(['extract-1'])
  expect(f.reviewCalls()).toBe(1)
  expect(f.executionCalls()).toBe(2)
  expect(readFileSync(join(f.rootDir, 'runs', `${f.scene.id}.jsonl`), 'utf8')).toBe(original)
})

for (const drift of ['model', 'source', 'mode'] as const) {
  test(`Given 异步凭据等待期间${drift}变化 When 底层尝试发送 Then 零传输且保留预留额度`, async () => {
    const f = await fixture()
    /** 在端口进入与真实发送间注入身份或模式漂移。 */
    let changed = false
    let sends = 0
    const api = createCapabilityFactoryReviewRetryService({ ...f.options,
      service: { getScene: (id) => f.service.getScene(id), getRun: (sceneId, runId) => {
        const run = f.service.getRun(sceneId, runId)
        return run && changed && drift === 'source' ? { ...run, input: { text: '被更改的原文' } } : run
      } },
      assertCanExecute: () => { if (changed && drift === 'mode') throw new Error('计划模式') },
      callModel: async (request) => {
        const id = request.callLedger!.reserve({ ...request, purpose: 'review' })
        await Promise.resolve()
        changed = true
        if (drift === 'model') f.changeModel()
        request.callLedger!.markSent(id, request.signal)
        sends += 1
        request.callLedger!.settle(id, { status: 'completed' })
        return { text: '{}', model: 'test' }
      },
    })
    const result = await api.retry(f.request)
    expect(sends).toBe(0)
    expect(result.status).toBe('failed')
    expect(result.calls).toHaveLength(1)
    expect(result.calls[0]?.sent).toBe(false)
  })
}

test('Given 持久记录缺失调用账本 When 再诊断 Then 显式拒绝而非视为零消费', async () => {
  const f = await fixture()
  const result = await f.api.retry(f.request)
  const directory = join(f.rootDir, 'review-retries')
  const file = join(directory, readdirSync(directory)[0]!)
  writeJsonFileAtomicSecure(file, { schemaVersion: 1, retry: { ...result, calls: undefined } })
  expect(() => f.api.diagnose(f.scene.id, f.run.id)).toThrow('结构')
  expect(f.reviewCalls()).toBe(1)
})

test('Given 用户取消后才收到评审响应 When 端口结算 Then 保留迟到材料和费用但不翻转终态', async () => {
  const f = await fixture()
  const controller = new AbortController()
  /** 可控端口先记真实发送，再在取消终态之后交还响应。 */
  let release: (() => void) | undefined
  let entered: (() => void) | undefined
  let savedLate: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  const saved = new Promise<void>((resolve) => { savedLate = resolve })
  const options: CapabilityFactoryReviewRetryOptions = { ...f.options, signal: controller.signal,
    onChanged: () => {
      const directory = join(f.rootDir, 'review-retries')
      const file = join(directory, readdirSync(directory)[0]!)
      if (readFileSync(file, 'utf8').includes('excludedResponses')) savedLate?.()
    },
    callModel: async (request) => {
      const id = request.callLedger!.reserve({ ...request, purpose: 'review' })
      request.callLedger!.markSent(id, request.signal)
      entered?.()
      await gate
      request.callLedger!.settle(id, { status: 'completed', usage: { inputTokens: 10, outputTokens: 20 } })
      return { text: '{"passed":true,"summary":"迟到报告"}', model: 'test' }
    },
  }
  const api = createCapabilityFactoryReviewRetryService(options)
  const pending = api.retry(f.request)
  await started
  controller.abort()
  expect((await pending).status).toBe('cancelled')
  release?.()
  await Promise.race([saved, new Promise<void>((resolve) => setTimeout(resolve, 100))])
  const record = api.diagnose(f.scene.id, f.run.id).retry!
  expect(record.status).toBe('cancelled')
  expect(record.calls[0]?.usage?.outputTokens).toBe(20)
  expect(record.excludedResponses?.['extract-0']?.text).toContain('迟到报告')
  expect(record.excludedResponses?.['extract-0']?.reason).toContain('不纳入质量结论')
  expect(record.reviews['extract-0']?.passed).toBeNull()
  expect(f.service.getRun(f.scene.id, f.run.id)).toEqual(f.run)
})

test('Given 单步试跑没有整链输出 When 补评 Then 复用该步成功轨迹而不重新执行', async () => {
  const f = await fixture(1, [], true)
  expect(f.run.outputs).toBeNull()
  expect(f.run.kind).toBe('step')
  const result = await f.api.retry(f.request)
  expect(result.status).toBe('completed')
  expect(f.executionCalls()).toBe(1)
  expect(f.reviewCalls()).toBe(1)
})

test('Given 底层尝试多次传输 When 超过显式传输预算 Then 第二次发送前停止且不退回额度', async () => {
  const f = await fixture()
  let sends = 0
  const api = createCapabilityFactoryReviewRetryService({ ...f.options, callModel: async (request) => {
    const id = request.callLedger!.reserve({ ...request, purpose: 'review' })
    try {
      for (let index = 0; index < 2; index += 1) {
        request.callLedger!.markSent(id, request.signal)
        sends += 1
      }
      return { text: '{}', model: 'test' }
    } finally { request.callLedger!.settle(id, { status: 'failed' }) }
  } })
  const record = await api.retry({ ...f.request, limits: { ...f.request.limits, maxTransportAttempts: 1 } })
  expect(record.status).toBe('failed')
  expect(sends).toBe(1)
  expect(record.calls[0]?.transportAttempts).toBe(1)
  expect(record.calls[0]?.billing).toBe('unknown')
  await expect(api.retry(f.request)).rejects.toThrow('一次')
})

test('Given 预留已保存但发送记账失败 When 继续补评 Then 不发送且保留可恢复的原额度证据', async () => {
  const f = await fixture()
  let sends = 0
  const directory = join(f.rootDir, 'review-retries')
  const backup = join(f.rootDir, 'retry-backup')
  const api = createCapabilityFactoryReviewRetryService({ ...f.options, callModel: async (request) => {
    const id = request.callLedger!.reserve({ ...request, purpose: 'review' })
    /** 只在临时夹具中制造不可写路径，保留先前有效文件用于检查。 */
    renameSync(directory, backup)
    writeFileSync(directory, 'blocked')
    request.callLedger!.markSent(id, request.signal)
    sends += 1
    return { text: '{}', model: 'test' }
  } })
  await expect(api.retry(f.request)).rejects.toThrow('目录')
  expect(sends).toBe(0)
  rmSync(directory)
  renameSync(backup, directory)
  const record = f.api.diagnose(f.scene.id, f.run.id).retry!
  expect(record.status).toBe('interrupted')
  expect(record.calls).toHaveLength(1)
  await expect(f.api.retry(f.request)).rejects.toThrow('一次')
})

test('Given 补评文件被截断或超过大小上限 When 再读 Then 拒绝并保持一次性限制', async () => {
  const f = await fixture()
  await f.api.retry(f.request)
  const directory = join(f.rootDir, 'review-retries')
  const file = join(directory, readdirSync(directory)[0]!)
  writeFileSync(file, '{')
  expect(() => f.api.diagnose(f.scene.id, f.run.id)).toThrow()
  await expect(f.api.retry(f.request)).rejects.toThrow()
  writeFileSync(file, ' '.repeat(2 * 1024 * 1024 + 1))
  expect(() => f.api.diagnose(f.scene.id, f.run.id)).toThrow('上限')
  expect(f.reviewCalls()).toBe(1)
})
