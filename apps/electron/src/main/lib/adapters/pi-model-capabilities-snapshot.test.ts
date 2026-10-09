import { describe, expect, test } from 'bun:test'
import type { Api, Model } from '@earendil-works/pi-ai/compat'
import { buildModel, getCodexCatalogModels } from './pi-model-registry'
import type { ProviderType } from '@proma/shared'
import { normalizeContext } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions'

/** 只注册内存模型，返回生产解析出的能力；不创建会话、写凭据或访问网络。 */
async function registeredModel(provider: ProviderType, modelId: string): Promise<Model<Api>> {
  /** 保存宿主注册到 Pi 的模型。 */
  let registered: Model<Api> | undefined
  /** 只实现本测试使用的模型注册接口。 */
  const runtime = {
    registerProvider: (_name: string, value: { models: Model<Api>[] }) => { registered = value.models[0] },
    getModel: () => registered,
  }
  /** 替代实际 SDK 生命周期，生产能力解析仍完整执行。 */
  const sdk = { ModelRuntime: { create: async () => runtime } } as unknown as Parameters<typeof buildModel>[0]
  return (await buildModel(sdk, { sessionId: 'capability-audit', provider, model: modelId, apiKey: 'test-placeholder', baseUrl: 'https://example.invalid/v1' })).model
}

/** 走真实 Pi 请求编码并在联网前截获 body；不发送模型请求。 */
async function captureReasoningPayload(provider: ProviderType, modelId: string, level: 'off' | 'low' | 'high'): Promise<Record<string, unknown>> {
  /** 注册流程产出的实际能力与协议配置。 */
  const model = await registeredModel(provider, modelId)
  /** 捕获参数供测试断言，onPayload 抛出后 SDK 直接结束。 */
  let payload: Record<string, unknown> | undefined
  await streamSimple({ ...model, api: 'openai-completions', provider: 'proma-offline-test' }, normalizeContext({
    messages: [{ role: 'user', content: '测试参数', timestamp: 1 }],
  }), {
    apiKey: 'offline-test-key', reasoning: level === 'off' ? undefined : level, maxRetries: 0,
    onPayload: (body) => {
      payload = body as Record<string, unknown>
      throw new Error('offline-payload-captured')
    },
    fetch: (async () => { throw new Error('此测试禁止联网') }) as unknown as typeof fetch,
  }).result()
  expect(payload).toBeDefined()
  return payload!
}

describe('供应商模型快照运行时接入', () => {
  test('Given Qwen 预算模型 When 关闭或调整强度 Then Pi 发送真实开关和不同预算而非 effort', async () => {
    /** 相同模型的三种用户设置必须影响实际协议字段。 */
    const off = await captureReasoningPayload('qwen', 'qwen3.7-plus', 'off')
    const low = await captureReasoningPayload('qwen', 'qwen3.7-plus', 'low')
    const high = await captureReasoningPayload('qwen', 'qwen3.7-plus', 'high')
    expect(off.enable_thinking).toBe(false)
    expect(off.reasoning_effort).toBeUndefined()
    expect(low.enable_thinking).toBe(true)
    expect(low.reasoning_effort).toBeUndefined()
    expect(low.thinking_budget).toBeGreaterThan(0)
    expect(high.thinking_budget).toBeGreaterThan(low.thinking_budget as number)
  })

  test('Given Zhipu 仅开关模型 When 关闭 Then Pi 发送 disabled 而非不支持的 effort', async () => {
    /** 注册为临时 provider 后也必须保留智谱协议。 */
    const off = await captureReasoningPayload('zhipu', 'glm-4.7', 'off')
    expect(off.thinking).toEqual({ type: 'disabled' })
    expect(off.reasoning_effort).toBeUndefined()
  })

  test('Given OpenAI API 与 Codex 同名模型 When 注册 Then 分别使用各自窗口', async () => {
    expect((await registeredModel('openai-responses', 'gpt-6-astra')).contextWindow).toBe(1_050_000)
    expect((await registeredModel('openai-responses', 'gpt-6.1-sol')).contextWindow).toBe(1_050_000)
    expect((await getCodexCatalogModels()).find((model) => model.id === 'gpt-6-astra')?.contextWindow).toBe(372_000)
  })

  test('Given GPT-4o 的 128K 目录 When 注册 Then 不用 200K 默认值抬高上限', async () => {
    expect((await registeredModel('openai', 'gpt-4o')).contextWindow).toBe(128_000)
  })

  test('Given DeepSeek Flash When 注册 Then 使用当前最大输出和价格', async () => {
    /** 模型完整结果同时验证输出预算和计费字段。 */
    const model = await registeredModel('deepseek', 'deepseek-flash')
    expect(model.maxTokens).toBe(393_216)
    expect(model.cost).toMatchObject({ input: 0.15, output: 0.6, cacheRead: 0.003 })
  })

  test('Given Gemini 最新别名 When 注册 Then 不暴露目录未支持的 minimal', async () => {
    expect((await registeredModel('google', 'gemini-flash-latest')).thinkingLevelMap?.minimal).toBeNull()
  })

  test('Given Claude 5.5 When 注册 Then 保留禁温度能力与最新缓存价格', async () => {
    /** 不能在临时 provider 重注册时丢失采样约束。 */
    const model = await registeredModel('anthropic', 'claude-sonnet-5-5')
    expect(model.compat).toMatchObject({ supportsTemperature: false })
    expect(model.cost.cacheRead).toBe(0.1)
  })

  test('Given 阶梯目录省略某种费率 When 注册 Then 从基础费率补齐而不会产生 NaN 费用', async () => {
    /** Google 阶梯价没有缓存写入项，Pi 要求四项费率均为数字。 */
    const model = await registeredModel('google', 'gemini-2.5-pro')
    expect(model.cost.tiers?.[0]?.cacheWrite).toBe(0)
  })
})
