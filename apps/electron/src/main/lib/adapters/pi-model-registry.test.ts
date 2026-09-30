import { describe, expect, test } from 'bun:test'
import { createAgentRuntimeGuard } from '../agent-runtime-guards'
import type { Api, Model, Usage } from '@earendil-works/pi-ai/compat'
import {
  buildGithubCopilotModel,
  buildCodexModel,
  listCodexModels,
  getCodexCatalogModels,
  buildModel,
  filterSupportedCodexModels,
  getGithubCopilotCatalogModels,
  listGithubCopilotModels,
  resolvePiApi,
} from './pi-model-registry'

/** 构造最小可用的 Codex 目录条目，字段值本身不影响过滤判定。 */
function codexModel(id: string): Model<Api> {
  return {
    id,
    name: id,
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: 'https://chatgpt.com/backend-api',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 372_000,
    maxTokens: 128_000,
  }
}

describe('Codex 目录下线模型过滤', () => {
  test('Given 目录含已下线的 Codex Spark When 过滤 Then 该条目不再进入候选', () => {
    const filtered = filterSupportedCodexModels([
      codexModel('gpt-5.6-sol'),
      codexModel('gpt-5.3-codex-spark'),
    ])

    expect(filtered.map((model) => model.id)).toEqual(['gpt-5.6-sol'])
  })

  test('Given 大小写或首尾空格不同的下线 ID When 过滤 Then 仍被识别并剔除', () => {
    const filtered = filterSupportedCodexModels([
      codexModel('GPT-5.3-Codex-Spark'),
      codexModel(' gpt-5.3-codex-spark '),
    ])

    expect(filtered).toEqual([])
  })

  test('Given 目录只含可用模型 When 过滤 Then 顺序与内容保持不变', () => {
    const filtered = filterSupportedCodexModels([
      codexModel('gpt-5.6-sol'),
      codexModel('gpt-5.6-luna'),
    ])

    expect(filtered.map((model) => model.id)).toEqual(['gpt-5.6-sol', 'gpt-5.6-luna'])
  })
})

describe('GLM-5.3-FlashX 离线模型注册', () => {
  test('Given Pi catalog 尚无 FlashX When 离线构建智谱模型 Then 沿用 GLM-5.3 推理能力与上下文参数', async () => {
    let registeredModel: Model<Api> | undefined
    const modelRuntime = {
      registerProvider: (_providerName: string, provider: { models: Model<Api>[] }) => {
        registeredModel = provider.models[0]
      },
      getModel: () => registeredModel,
    }
    const sdk = {
      ModelRuntime: {
        create: async (options: { allowModelNetwork: boolean }) => {
          expect(options).toEqual({ allowModelNetwork: false })
          return modelRuntime
        },
      },
    } as unknown as Parameters<typeof buildModel>[0]

    const { model } = await buildModel(sdk, {
      sessionId: 'session-flashx',
      apiKey: 'test-key',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      provider: 'zhipu',
      model: 'glm-5.3-flashx',
    })

    expect(model).toMatchObject({
      id: 'glm-5.3-flashx',
      api: 'openai-completions',
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      thinkingLevelMap: { low: 'low', high: 'high', max: 'max' },
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        thinkingFormat: 'zai',
        zaiToolStream: true,
      },
    })
  })
})

describe('MiMo V2.6 离线模型注册', () => {
  test('Given Pi 0.87.1 catalog 已包含 MiMo V2.6 When 构建模型 Then 优先使用目录中的上下文和输出上限', async () => {
    let registeredModel: Model<Api> | undefined
    const modelRuntime = {
      registerProvider: (_providerName: string, provider: { models: Model<Api>[] }) => {
        registeredModel = provider.models[0]
      },
      getModel: () => registeredModel,
    }
    const sdk = {
      ModelRuntime: {
        create: async () => modelRuntime,
      },
    } as unknown as Parameters<typeof buildModel>[0]

    const { model } = await buildModel(sdk, {
      sessionId: 'session-mimo-v26',
      apiKey: 'test-key',
      baseUrl: 'https://api.xiaomimimo.com/anthropic',
      provider: 'xiaomi',
      model: 'mimo-v2.6-pro',
    })

    expect(model).toMatchObject({
      id: 'mimo-v2.6-pro',
      contextWindow: 1_048_576,
      maxTokens: 131_072,
    })
  })

  test('Given 类似但未知的未来 MiMo ID When 构建模型 Then 不套用 V2.6 输出上限', async () => {
    let registeredModel: Model<Api> | undefined
    const modelRuntime = {
      registerProvider: (_providerName: string, provider: { models: Model<Api>[] }) => {
        registeredModel = provider.models[0]
      },
      getModel: () => registeredModel,
    }
    const sdk = {
      ModelRuntime: {
        create: async () => modelRuntime,
      },
    } as unknown as Parameters<typeof buildModel>[0]

    const { model } = await buildModel(sdk, {
      sessionId: 'session-mimo-future',
      apiKey: 'test-key',
      baseUrl: 'https://api.xiaomimimo.com/anthropic',
      provider: 'xiaomi',
      model: 'mimo-v2.60-preview',
    })

    expect(model.maxTokens).toBe(64_000)
    expect(model.contextWindow).toBe(200_000)
  })
})

describe('GitHub Copilot 模型目录', () => {
  /** 测试账号的最小内存凭据，不读取真实账号或 ~/.pi。 */
  const credentials = {
    access: 'access',
    refresh: 'refresh',
    expires: Date.now() + 3_600_000,
    availableModelIds: ['gpt-5.3-codex'],
  }

  test('Given 当前账号目录为空 When 列出模型 Then 返回空列表而不误报模型缺失', async () => {
    const sdk = {
      ModelRuntime: {
        create: async () => ({ getAvailable: async () => [] }),
      },
    } as unknown as Parameters<typeof buildGithubCopilotModel>[0]

    await expect(listGithubCopilotModels(credentials, sdk)).resolves.toEqual([])
  })

  test('Given 用户指定账号未授权模型 When 构建 Agent 模型 Then 返回明确错误', async () => {
    const sdk = {
      ModelRuntime: {
        create: async () => ({ getAvailable: async () => [] }),
      },
    } as unknown as Parameters<typeof buildGithubCopilotModel>[0]

    await expect(buildGithubCopilotModel(sdk, {
      model: 'gpt-5.3-codex',
      githubCopilotOAuthCredentials: credentials,
    })).rejects.toThrow('当前订阅不支持模型')
  })

  test('Given Pi 0.87.1 真实 runtime 与内存假凭据 When 限定目录 Then 单模型和空目录都离线生效', async () => {
    /** 真实 runtime 应按凭据中的授权 ID 只返回一个模型。 */
    const singleModel = await listGithubCopilotModels(credentials)
    /** 空目录代表有效账号当前无授权模型，不应回退到静态全目录。 */
    const emptyModels = await listGithubCopilotModels({ ...credentials, availableModelIds: [] })

    expect(singleModel).toEqual([{ id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' }])
    expect(emptyModels).toEqual([])
  })

  test('Given Pi 0.87.1 Copilot 真实目录含多协议模型 When 解析 API Then 分别保留 GPT 与 Claude 协议', async () => {
    /** 从真实 Pi 目录读取 GPT 与 Claude 的协议声明。 */
    const catalog = await getGithubCopilotCatalogModels()
    const gptModel = catalog.find((model) => model.id === 'gpt-5.3-codex')
    const claudeModel = catalog.find((model) => model.id === 'claude-sonnet-5')

    expect(gptModel?.api).toBe('openai-responses')
    expect(claudeModel?.api).toBe('anthropic-messages')
    expect(resolvePiApi('github-copilot', gptModel?.api)).toBe('openai-responses')
    expect(resolvePiApi('github-copilot', claudeModel?.api)).toBe('anthropic-messages')
  })
})


describe('Pi 0.87 Codex 目录与运行时', () => {
  /** 完全离线的内存凭据，不使用真实账号。 */
  const credentials = { access: 'fixture', refresh: 'fixture', expires: Date.now() + 3_600_000 }

  test('Given 官方退役家族 When 过滤 Then 排除所有 SKU 且保留相近独立名称', () => {
    expect(filterSupportedCodexModels(['gpt-5.4', 'gpt-5.4-mini', ' GPT-5.5 ', 'gpt-5.5-pro', 'gpt-5.50', 'gpt-6-sol'].map(codexModel)).map((model) => model.id))
      .toEqual(['gpt-5.50', 'gpt-6-sol'])
  })

  test.each(['gpt-6-sol', 'gpt-6-luna'])('Given %s When 真实 runtime 构建 Then 保留本地已验证能力', async (modelId) => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const { model } = await buildCodexModel(sdk, { model: modelId, codexOAuthCredentials: credentials })
    expect(model.contextWindow).toBe(372_000)
    expect(model.thinkingLevelMap?.off).toBe('none')
    expect(model.thinkingLevelMap?.max).toBe('max')
    expect((await getCodexCatalogModels()).some((entry) => entry.id === modelId)).toBe(true)
  })

  test('Given 空的可用目录 When 拉模型 Then 不回退到静态全集', async () => {
    const sdk = { ModelRuntime: { create: async () => ({ getAvailable: async () => [] }) } } as unknown as Parameters<typeof buildCodexModel>[0]
    expect(await listCodexModels(credentials, sdk)).toEqual([])
  })

  test('Given 真实 runtime When 离线拉取 Then 新模型可见且退役家族不可见', async () => {
    const models = await listCodexModels(credentials)
    expect(models.some((model) => model.id === 'gpt-6-sol')).toBe(true)
    expect(models.some((model) => /^gpt-5\.[45](?:-|$)/.test(model.id))).toBe(false)
  })

  test('Given 用户显式请求退役模型 When 构建 Then 明确失败而不替换模型', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    await expect(buildCodexModel(sdk, { model: 'gpt-5.5', codexOAuthCredentials: credentials })).rejects.toThrow('未找到指定')
  })
})


describe('Codex 官方费用与预算边界', () => {
  test.each(['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])(
    'Given %s 官方目录含阶梯价格 When 构建并累计用量 Then 保留全部价格且触发预算停止',
    async (modelId) => {
      /** 使用真实目录与真实计费函数，避免零价格补丁悄悄绕过预算。 */
      const { getModels, calculateCost } = await import('@earendil-works/pi-ai/compat')
      /** 当前安装版本的官方费率是唯一比较基准。 */
      const official = getModels('openai-codex').find((model) => model.id === modelId)!
      /** 实际 SDK 使用内存假凭据离线构建模型。 */
      const sdk = await import('@earendil-works/pi-coding-agent')
      /** 经过本地能力补丁后的最终模型。 */
      const { model } = await buildCodexModel(sdk, {
        model: modelId,
        codexOAuthCredentials: { access: 'fixture', refresh: 'fixture', expires: Date.now() + 3_600_000 },
      })
      expect(model.cost).toEqual(official.cost)
      expect(model.cost.input).toBeGreaterThan(0)
      /** 超过 272K 后应使用官方长上下文阶梯费率。 */
      const usage: Usage = {
        input: 300_000, output: 1_000, cacheRead: 0, cacheWrite: 0, totalTokens: 301_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      }
      calculateCost(model, usage)
      expect(usage.cost.input).toBeCloseTo(0.3 * official.cost.tiers![0]!.input)
      /** 较小的预算用于证明估算费用能触发下一轮停止。 */
      const guard = createAgentRuntimeGuard({ maxBudgetUsd: 0.01 })
      guard.recordMessage({
        role: 'assistant', content: [{ type: 'text', text: 'fixture' }],
        api: model.api, provider: model.provider, model: model.id,
        usage, stopReason: 'stop', timestamp: Date.now(),
      })
      expect(guard.shouldStopBeforeNextTurn()).toBe(true)
      expect(guard.getLimitResultOverride()?.terminalReason).toBe('max_budget_usd')
    },
  )
})
