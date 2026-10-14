import { describe, expect, spyOn, test } from 'bun:test'
import type { Api, Model, ModelsSimpleStreamOptions } from '@earendil-works/pi-ai'
import type { PiTitleRuntime, PiTitleRequestEnvironment } from '../adapters/pi-title-generator'
import * as registry from '../adapters/pi-model-registry'
import { callCapabilityFactoryPiModel, completeCapabilityFactoryPiRequest } from './capability-factory-pi-call'

/** 创建观察代理释放行为的隔离环境。 */
function environment(): PiTitleRequestEnvironment & { closed: boolean } {
  return { closed: false, installRequestProxyFetch() {}, runWithRequestProxy(_dispatcher, operation) { return operation() },
    async closeRequestProxyDispatcher() { this.closed = true } }
}

describe('工厂 Pi 文本请求', () => {
  test.each(['openai-codex-responses', 'openai-responses'] as const)('Given %s 模型 When 完成 Then 保留生成参数且无工具和标题预算限制', async (api) => {
    /** 捕获实际模型请求，验证上下文与参数。 */
    let options: ModelsSimpleStreamOptions | undefined
    /** 记录协议分支，防止 Codex 走不支持的普通适配器。 */
    let route = ''
    /** 同一响应实现只记录参数，不访问网络。 */
    const complete: PiTitleRuntime['completeSimple'] = async (_model, context, received) => {
      options = received
      expect(context.messages).toHaveLength(1)
      expect(context).not.toHaveProperty('tools')
      return { content: [{ type: 'thinking', thinking: '隐藏' }, { type: 'text', text: '结果' }], stopReason: 'stop' }
    }
    /** 只实现文本补全 API 的运行时。 */
    const runtime: PiTitleRuntime = {
      complete: (...args) => { route = 'complete'; return complete(...args) },
      completeSimple: (...args) => { route = 'simple'; return complete(...args) },
    }
    /** 当前调用的取消信号。 */
    const signal = new AbortController().signal
    /** 必须在成功时释放的请求代理。 */
    const proxy = environment()
    await expect(completeCapabilityFactoryPiRequest(runtime, { id: 'test', api } as Model<Api>,
      { prompt: '问题', signal, maxTokens: 4096, temperature: 0 }, proxy, 'sse')).resolves.toBe('结果')
    expect(options).toMatchObject({ maxTokens: 4096, temperature: 0, signal, transport: 'sse', maxRetries: 0 })
    expect(options).not.toHaveProperty('timeoutMs')
    expect(route).toBe(api === 'openai-codex-responses' ? 'complete' : 'simple')
    expect(proxy.closed).toBe(true)
  })

  test.each(['error', 'aborted', 'length', 'stop'] as const)('Given %s 无正文响应 When 补全 Then 明确报错并释放代理', async (stopReason) => {
    /** 模拟 provider 终态，分别覆盖错误、取消、额度耗尽和空响应。 */
    const complete: PiTitleRuntime['completeSimple'] = async () => ({ content: [], stopReason, errorMessage: '服务错误' })
    /** 请求代理记录。 */
    const proxy = environment()
    await expect(completeCapabilityFactoryPiRequest({ complete, completeSimple: complete }, { id: 'test' } as Model<Api>,
      { prompt: '问题', signal: new AbortController().signal }, proxy))
      .rejects.toThrow(stopReason === 'error' || stopReason === 'aborted' ? '服务错误' : '未返回正文')
    expect(proxy.closed).toBe(true)
  })
})


test('Given Pi 将指定模型回退为其他模型 When 工厂调用 Then 拒绝静默替换', async () => {
  /** 模拟目录过期时 xAI runtime 的默认模型回退。 */
  const build = spyOn(registry, 'buildModel').mockResolvedValue({
    model: { id: 'other' } as Model<Api>,
    modelRuntime: {} as Awaited<ReturnType<typeof registry.buildModel>>['modelRuntime'],
  })
  try {
    await expect(callCapabilityFactoryPiModel({ channelId: 'xai', channelName: 'xAI', provider: 'xai',
      apiKey: '', modelId: 'selected', prompt: '问题' })).rejects.toThrow('未能使用指定模型')
  } finally { build.mockRestore() }
})

test.each([false, true])('Given 请求抛错或提前取消 When 工厂请求 Then 保留失败并释放资源 (%s)', async (cancelled) => {
  /** 分别模拟用户取消与网络中断。 */
  const controller = new AbortController()
  if (cancelled) controller.abort(new Error('用户取消'))
  /** 观察提前取消是否阻止进入运行时。 */
  let calls = 0
  /** 模拟抛出网络错误的模型接口。 */
  const complete: PiTitleRuntime['completeSimple'] = async (_model, _context, options) => {
    calls += 1
    expect(options).not.toHaveProperty('maxTokens')
    expect(options).not.toHaveProperty('temperature')
    throw new Error('网络中断')
  }
  /** 可追踪释放动作的代理环境。 */
  const proxy = environment()
  await expect(completeCapabilityFactoryPiRequest({ complete, completeSimple: complete }, { id: 'test' } as Model<Api>,
    { prompt: '问题', signal: controller.signal }, proxy)).rejects.toThrow(cancelled ? '用户取消' : '网络中断')
  expect(calls).toBe(cancelled ? 0 : 1)
  expect(proxy.closed).toBe(true)
})

test.each([
  ['minimax-m3', 'anthropic-messages'], ['qwen3.8-flash', 'anthropic-messages'],
  ['gpt-6-luna', 'openai-responses'], ['grok-4.7', 'openai-responses'],
] as const)('Given OpenCode Go %s When 构建工厂 Pi 请求 Then 使用目录声明的 %s 协议', async (modelId, expectedApi) => {
  /** 加载真实 SDK 与目录，仅替换运行时的网络执行边界。 */
  const sdk = await import('@earendil-works/pi-coding-agent')
  /** 记录由真实 buildModel 注册的模型。 */
  let registered: Model<Api> | undefined
  /** 使用最小运行时观察 provider 注册和文本请求；不发送网络请求。 */
  const runtime = {
    registerProvider(_name: string, provider: { apiKey: string; api: Api; models: Model<Api>[] }) {
      expect(provider.apiKey).toBe('opencode-key')
      expect(provider.api).toBe(expectedApi)
      registered = provider.models[0]
    },
    getModel() { return registered },
    async completeSimple(model: Model<Api>) {
      expect(model.api).toBe(expectedApi)
      expect(model.id).toBe(modelId)
      return { content: [{ type: 'text', text: '正文' }], stopReason: 'stop' }
    },
  }
  /** 保留真实协议解析，仅注入可观察的运行时。 */
  const create = spyOn(sdk.ModelRuntime, 'create').mockResolvedValue(runtime as unknown as Awaited<ReturnType<typeof sdk.ModelRuntime.create>>)
  try {
    await expect(callCapabilityFactoryPiModel({ channelId: 'go', channelName: 'Go', provider: 'opencode-go-openai',
      apiKey: 'opencode-key', baseUrl: 'https://opencode.ai/zen/go/v1', modelId, prompt: '问题' })).resolves.toBe('正文')
  } finally { create.mockRestore() }
})

import { extractCapabilityFactoryPiUsage } from './capability-factory-pi-call'

test('Given Pi 实际 usage When 响应 Then 透传 token 且不把 SDK 零成本当免费', async () => {
  /** 完整供应商响应结构用于验证 usage 观察端，不访问网络。 */
  const complete = async () => ({ content: [{ type: 'text' as const, text: '结果' }], stopReason: 'stop' as const,
    usage: { input: 12, output: 5, cacheRead: 3, cacheWrite: 0, cost: { total: 0 } } })
  /** 记录发送边界及供应商用量回调。 */
  const calls: unknown[] = []
  await completeCapabilityFactoryPiRequest({ complete, completeSimple: complete }, { id: 'test' } as Model<Api>,
    { prompt: '问题', onBeforeSend: () => calls.push('sent'), onUsage: (usage) => calls.push(usage) }, environment())
  expect(calls).toEqual(['sent', { inputTokens: 12, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 0 }])
  expect(extractCapabilityFactoryPiUsage(undefined)).toBeUndefined()
  expect(extractCapabilityFactoryPiUsage({ input: 12 })).toBeUndefined()
  expect(extractCapabilityFactoryPiUsage({ input: -1, output: 5 })).toBeUndefined()
})

test('Given 工厂预算拒绝或已发送失败 When 统计 Then 仅实际请求进入全局账本', async () => {
  /** 失败端口不联网，模拟真实发送边界之后的异常。 */
  const complete: PiTitleRuntime['completeSimple'] = async () => { throw new Error('network') }
  const events: unknown[] = []
  const runtime = { complete, completeSimple: complete }
  const onUsageAttempt: import('../token-usage-observer').TokenUsageObserver = (usage, status) => { events.push({ usage, status }) }
  await completeCapabilityFactoryPiRequest(runtime, { id: 'test' } as Model<Api>, { prompt: '问题', onBeforeSend: () => { throw new Error('budget') }, onUsageAttempt }, environment()).catch(() => undefined)
  expect(events).toHaveLength(0)
  await completeCapabilityFactoryPiRequest(runtime, { id: 'test' } as Model<Api>, { prompt: '问题', onUsageAttempt }, environment()).catch(() => undefined)
  expect(events).toEqual([{ usage: null, status: 'failed' }])
})

test('Given 工厂收到正常空正文 When 业务校验失败 Then 调用仅统计一次完成终态', async () => {
  /** 空正文是业务失败，但传输有正常完成且不能被重复累计。 */
  const complete: PiTitleRuntime['completeSimple'] = async () => ({ content: [], stopReason: 'stop' })
  const events: unknown[] = []
  await completeCapabilityFactoryPiRequest({ complete, completeSimple: complete }, { id: 'test' } as Model<Api>, { prompt: '问题', onUsageAttempt: (usage, status) => events.push({ usage, status }) }, environment()).catch(() => undefined)
  expect(events).toEqual([{ usage: null, status: 'completed' }])
})
