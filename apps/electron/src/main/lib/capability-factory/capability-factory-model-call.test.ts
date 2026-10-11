import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test'
import { createEmptySceneDefinition } from '@proma/shared'
import type { Channel } from '@proma/shared'
import * as piCall from './capability-factory-pi-call'
import { createCapabilityFactoryModelCall, resolveCapabilityFactoryModels } from './capability-factory-model-call'

/** 合成渠道与凭据，仅验证真实适配器和 SSE 读取链路。 */
const channel: Channel = {
  id: 'glm', name: '测试渠道', provider: 'zhipu-coding', baseUrl: 'https://example.invalid',
  apiKey: '', enabled: true, models: [{ id: 'glm-5.3', name: 'GLM', enabled: true }, { id: 'test', name: '测试', enabled: true }], createdAt: 0, updatedAt: 0,
}
/** 只替换网络边界，不模拟模型端口或 SSE 解析。 */
const fetchSpy = spyOn(globalThis, 'fetch')
afterEach(() => fetchSpy.mockReset())
afterAll(() => fetchSpy.mockRestore())

/** 从给定 SSE 事件创建一次工厂调用；返回模型端口的真实结果。 */
function invoke(events: unknown[]) {
  fetchSpy.mockResolvedValue(new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')))
  const call = createCapabilityFactoryModelCall({
    listChannels: () => [channel], resolveApiKey: async () => 'test-key',
    resolveProxyUrl: async () => undefined, sessionModel: () => null,
  })
  return call({ stepId: 'scan', model: 'glm-5.3', channelId: 'glm', modelId: 'glm-5.3',
    prompt: '测试', signal: new AbortController().signal })
}

describe('工厂模型响应', () => {
  test.each(['openai', 'google'] as const)('Given %s 场景声明零温度与输出上限 When 调用模型 Then HTTP 请求保留参数且返回正文', async (provider) => {
    /** 走真实工厂端口、适配器与 SSE 解析，只替换外部网络。 */
    const invocation = createCapabilityFactoryModelCall({
      listChannels: () => [{ ...channel, provider }], resolveApiKey: async () => 'test-key',
      resolveProxyUrl: async () => undefined, sessionModel: () => null,
    })
    /** 两种协议各自的成功事件，避免仅验证中间请求对象。 */
    const event = provider === 'google'
      ? { candidates: [{ content: { parts: [{ text: '结果' }] }, finishReason: 'STOP' }] }
      : { choices: [{ delta: { content: '结果' }, finish_reason: 'stop' }] }
    fetchSpy.mockResolvedValue(new Response(`data: ${JSON.stringify(event)}\n\n`))
    const result = await invocation({ stepId: 'scan', model: 'test', channelId: channel.id, modelId: 'test',
      temperature: 0, maxTokens: 321, prompt: '测试', signal: new AbortController().signal })
    const request = JSON.parse(String((fetchSpy.mock.calls.at(-1)?.[1] as RequestInit).body)) as {
      temperature?: number; max_tokens?: number; generationConfig?: { temperature?: number; maxOutputTokens?: number }
    }
    expect(result.text).toBe('结果')
    expect(provider === 'google' ? request.generationConfig?.temperature : request.temperature).toBe(0)
    expect(provider === 'google' ? request.generationConfig?.maxOutputTokens : request.max_tokens).toBe(321)
  })

  test('Given 场景声明采样参数 When 工厂调用模型 Then 透传到 Provider 请求', async () => {
    const invocation = createCapabilityFactoryModelCall({
      listChannels: () => [channel], resolveApiKey: async () => 'test-key',
      resolveProxyUrl: async () => undefined, sessionModel: () => null,
    })
    fetchSpy.mockResolvedValue(new Response([
      `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '{"ok":true}' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })}\n\n`,
    ].join('')))
    await invocation({ stepId: 'scan', model: 'glm-5.3', channelId: 'glm', modelId: 'glm-5.3',
      temperature: 0.2, maxTokens: 321, prompt: '测试', signal: new AbortController().signal })
    const request = JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1] && (fetchSpy.mock.calls.at(-1)?.[1] as RequestInit).body)) as { temperature?: number; max_tokens?: number }
    expect(request.temperature).toBe(0.2)
    expect(request.max_tokens).toBe(321)
  })

  test('Given 有正文 When SSE 完成 Then 返回正文', async () => {
    const result = await invoke([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '{"ok":true}' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ])
    expect(result.text).toBe('{"ok":true}')
  })

  test('Given 只有思考且额度用尽 When SSE 完成 Then 明确指出没有正文', async () => {
    await expect(invoke([
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '合成思考文本' } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
    ])).rejects.toThrow('未返回正文')
  })

  test('Given 空流 When SSE 完成 Then 不把空响应交给 JSON 校验', async () => {
    await expect(invoke([])).rejects.toThrow('未返回正文')
  })

  test('Given 流内服务错误 When 调用模型 Then 保留错误且不重试', async () => {
    await expect(invoke([{ type: 'error', error: { message: '模型暂时繁忙' } }]))
      .rejects.toThrow('模型暂时繁忙')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})


describe('工厂模型调用边界', () => {
  test.each([false, true])('Given 模型被停用或移除 When 运行 Then 不读取凭据或请求网络 (%s)', async (removed) => {
    /** 凭据读取记录用于证明提前拦截。 */
    let credentialReads = 0
    /** 当前渠道快照中停用或不存在的模型。 */
    const call = createCapabilityFactoryModelCall({
      listChannels: () => [{ ...channel, models: removed ? [] : [{ id: 'glm-5.3', name: 'GLM', enabled: false }] }],
      resolveApiKey: async () => { credentialReads += 1; return 'key' },
      resolveProxyUrl: async () => undefined, sessionModel: () => null,
    })
    await expect(call({ stepId: 'scan', model: 'glm-5.3', channelId: channel.id, modelId: 'glm-5.3',
      prompt: '测试', signal: new AbortController().signal })).rejects.toThrow('模型不存在或已停用')
    expect(credentialReads).toBe(0)
  })

  test.each(['openai-codex', 'github-copilot', 'xai'] as const)('Given %s 订阅模型 When 运行 Then 使用 Pi 并保留请求参数和凭据回调', async (provider) => {
    /** 仅替换 Pi 网络调用边界，真实端口仍负责路由和上下文拼接。 */
    const piSpy = spyOn(piCall, 'callCapabilityFactoryPiModel').mockResolvedValue('正文')
    /** 调用方取消信号与订阅刷新回调。 */
    const signal = new AbortController().signal
    /** 模拟宿主提供的凭据刷新持久化函数。 */
    const refreshed = async () => undefined
    try {
      /** 订阅渠道不得走普通 API key 解密分支。 */
      const call = createCapabilityFactoryModelCall({
        listChannels: () => [{ ...channel, provider }],
        resolveApiKey: async () => { throw new Error('不应读取普通 API key') },
        resolveSubscriptionCredentials: async () => ({ onCodexOAuthCredentialsRefreshed: refreshed }),
        resolveProxyUrl: async () => 'http://localhost:1234', sessionModel: () => null,
      })
      await expect(call({ stepId: 'scan', model: 'test', channelId: channel.id, modelId: 'test',
        prompt: '问题', formatInstruction: '输出JSON', temperature: 0, maxTokens: 2048, signal }))
        .resolves.toEqual({ text: '正文', model: 'test' })
      expect(piSpy.mock.calls[0]?.[0]).toMatchObject({ provider, modelId: 'test', prompt: '问题\n\n输出JSON',
        proxyUrl: 'http://localhost:1234', temperature: 0, maxTokens: 2048, signal,
        onCodexOAuthCredentialsRefreshed: refreshed })
    } finally { piSpy.mockRestore() }
  })
})

test.each(['minimax-m3', 'qwen3.8-flash', 'gpt-6-luna', 'grok-4.7'])('Given OpenCode Go 的 %s 模型 When 工厂调用 Then 使用 Pi 目录协议与普通 API key', async (modelId) => {
  /** 仅拦截 Pi 传输边界；旧普通适配器响应确保错误路由会立即失败断言。 */
  const piSpy = spyOn(piCall, 'callCapabilityFactoryPiModel').mockResolvedValue('Pi 正文')
  fetchSpy.mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"错误协议"},"finish_reason":"stop"}]}\n\n'))
  try {
    /** 没有 OAuth 解析器的 API key 渠道也必须能调用混合协议模型。 */
    const call = createCapabilityFactoryModelCall({
      listChannels: () => [{ ...channel, provider: 'opencode-go-openai', models: [{ id: modelId, name: modelId, enabled: true }] }],
      resolveApiKey: async () => 'opencode-key', resolveProxyUrl: async () => undefined, sessionModel: () => null,
    })
    await expect(call({ stepId: 'scan', model: modelId, channelId: channel.id, modelId,
      prompt: '问题', signal: new AbortController().signal })).resolves.toEqual({ text: 'Pi 正文', model: modelId })
    expect(piSpy.mock.calls[0]?.[0]).toMatchObject({ provider: 'opencode-go-openai', modelId, apiKey: 'opencode-key' })
    expect(fetchSpy).not.toHaveBeenCalled()
  } finally { piSpy.mockRestore() }
})

import { createCapabilityFactoryCallLedger } from './capability-factory-budget'

test('Given SSE 首次 500 When 自动重试成功 Then 同一逻辑调用记录两次实际发送', async () => {
  /** 真实 SSE 解析只模拟网络响应。 */
  fetchSpy.mockResolvedValueOnce(new Response('', { status: 500 }))
    .mockResolvedValueOnce(new Response('data: {"choices":[{"delta":{"content":"结果"},"finish_reason":"stop"}]}\n\n'))
  const ledger = createCapabilityFactoryCallLedger({ maxCalls: 1, maxTransportAttempts: 2 })
  const call = createCapabilityFactoryModelCall({ listChannels: () => [{ ...channel, provider: 'openai' }],
    resolveApiKey: async () => 'key', resolveProxyUrl: async () => undefined, sessionModel: () => null })
  await call({ stepId: 'scan', model: 'test', channelId: channel.id, modelId: 'test',
    prompt: '问题', signal: new AbortController().signal, callLedger: ledger, purpose: 'review' })
  expect(fetchSpy).toHaveBeenCalledTimes(2)
  expect(ledger.snapshot()).toMatchObject([{ purpose: 'review', transportAttempts: 2, status: 'completed', amount: null, usage: null }])
})

test('Given 传输额度为零 When 调用 Then 不发送且不做 SSE 重试', async () => {
  const ledger = createCapabilityFactoryCallLedger({ maxCalls: 1, maxTransportAttempts: 0 })
  const call = createCapabilityFactoryModelCall({ listChannels: () => [{ ...channel, provider: 'openai' }],
    resolveApiKey: async () => 'key', resolveProxyUrl: async () => undefined, sessionModel: () => null })
  await expect(call({ stepId: 'scan', model: 'test', channelId: channel.id, modelId: 'test',
    prompt: '问题', signal: new AbortController().signal, callLedger: ledger })).rejects.toThrow('传输额度')
  expect(fetchSpy).not.toHaveBeenCalled()
  expect(ledger.snapshot()[0]).toMatchObject({ status: 'failed', sent: false, billing: 'not-sent' })
})

test('Given 异步凭据期间取消 When 返回凭据 Then 不发送且预留记取消', async () => {
  const controller = new AbortController()
  const ledger = createCapabilityFactoryCallLedger({ maxCalls: 1 })
  const call = createCapabilityFactoryModelCall({ listChannels: () => [{ ...channel, provider: 'openai' }],
    resolveApiKey: async () => { controller.abort(); return 'key' }, resolveProxyUrl: async () => undefined, sessionModel: () => null })
  await expect(call({ stepId: 'scan', model: 'test', channelId: channel.id, modelId: 'test',
    prompt: '问题', signal: controller.signal, callLedger: ledger })).rejects.toThrow()
  expect(fetchSpy).not.toHaveBeenCalled()
  expect(ledger.snapshot()[0]).toMatchObject({ status: 'cancelled', sent: false, billing: 'not-sent' })
})


test('Given 渠道模型身份未改 When 地址或评审配置变化 Then 冻结配置指纹变化且不含凭据值', () => {
  const definition = createEmptySceneDefinition('配置身份')
  definition.modelSelection = { slots: { main: { channelId: channel.id, modelId: 'test' } }, review: { channelId: 'review', modelId: 'test' } }
  const reviewChannel: Channel = { ...channel, id: 'review' }
  const resolve = (channels: Channel[]) => resolveCapabilityFactoryModels(definition, channels, null)
  const original = resolve([channel, reviewChannel])
  expect(original.configurationFingerprint).toMatch(/^[a-f0-9]{64}$/)
  expect(resolve([{ ...channel, baseUrl: 'https://other.invalid' }, reviewChannel]).configurationFingerprint).not.toBe(original.configurationFingerprint)
  expect(resolve([channel, { ...reviewChannel, provider: 'openai' }]).configurationFingerprint).not.toBe(original.configurationFingerprint)
  expect(resolve([{ ...channel, updatedAt: 1 }, reviewChannel]).configurationFingerprint).not.toBe(original.configurationFingerprint)
  expect(resolve([{ ...channel, apiKey: 'secret-must-not-enter-identity' }, reviewChannel]).configurationFingerprint).toBe(original.configurationFingerprint)
  expect(resolve([reviewChannel, channel]).configurationFingerprint).toBe(original.configurationFingerprint)
})

test('Given 首次传输后取消 When SSE 收到可重试错误 Then 不再发送且保留已发送的不确定费用', async () => {
  /** 取消发生在真实 fetch 边界之后，不得返还可能计费的尝试。 */
  const controller = new AbortController()
  const ledger = createCapabilityFactoryCallLedger({ maxCalls: 2, maxTransportAttempts: 3 })
  /** Bun 的 fetch 类型还包含 preconnect；保留该静态属性而不使用类型强转。 */
  fetchSpy.mockImplementation(Object.assign(async () => { controller.abort(); return new Response('', { status: 500 }) },
    { preconnect: globalThis.fetch.preconnect }))
  const call = createCapabilityFactoryModelCall({ listChannels: () => [{ ...channel, provider: 'openai' }],
    resolveApiKey: async () => 'key', resolveProxyUrl: async () => undefined, sessionModel: () => null })
  await expect(call({ stepId: 'scan', model: 'test', channelId: channel.id, modelId: 'test',
    prompt: '问题', signal: controller.signal, callLedger: ledger })).rejects.toThrow()
  expect(fetchSpy).toHaveBeenCalledTimes(1)
  expect(ledger.snapshot()[0]).toMatchObject({ status: 'cancelled', transportAttempts: 1, sent: true, billing: 'unknown', amount: null })
})

test('Given 发送前持久化失败 When 调用者捕获后再次调用 Then 所有后续请求都不发网络', async () => {
  /** 第一次预留成功，发送标记的持久化失败；其后恢复磁盘仍不得恢复发送权限。 */
  let writes = 0
  const ledger = createCapabilityFactoryCallLedger({ maxCalls: 3, onChange: () => {
    writes += 1
    if (writes === 2) throw new Error('账本磁盘失败')
  } })
  const call = createCapabilityFactoryModelCall({ listChannels: () => [{ ...channel, provider: 'openai' }],
    resolveApiKey: async () => 'key', resolveProxyUrl: async () => undefined, sessionModel: () => null })
  const invocation = { stepId: 'scan', model: 'test', channelId: channel.id, modelId: 'test',
    prompt: '问题', signal: new AbortController().signal, callLedger: ledger }
  await expect(call(invocation)).rejects.toThrow('账本磁盘失败')
  await expect(call(invocation)).rejects.toThrow('持久化失败')
  expect(fetchSpy).not.toHaveBeenCalled()
  expect(ledger.snapshot()).toHaveLength(1)
  expect(ledger.snapshot()[0]).toMatchObject({ status: 'failed', amount: null, transportAttempts: 1, billing: 'unknown' })
})
