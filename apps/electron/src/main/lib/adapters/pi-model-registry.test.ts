import { describe, expect, test } from 'bun:test'
import type { Api, Model } from '@earendil-works/pi-ai/compat'
import {
  buildGithubCopilotModel,
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
  test('Given Pi catalog 没有 MiMo V2.6 When 构建模型 Then 使用官方 1M 上下文和 128K 输出上限', async () => {
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
      contextWindow: 1_000_000,
      maxTokens: 128_000,
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

  test('Given Pi 0.85.1 真实 runtime 与内存假凭据 When 限定目录 Then 单模型和空目录都离线生效', async () => {
    /** 真实 runtime 应按凭据中的授权 ID 只返回一个模型。 */
    const singleModel = await listGithubCopilotModels(credentials)
    /** 空目录代表有效账号当前无授权模型，不应回退到静态全目录。 */
    const emptyModels = await listGithubCopilotModels({ ...credentials, availableModelIds: [] })

    expect(singleModel).toEqual([{ id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' }])
    expect(emptyModels).toEqual([])
  })

  test('Given Pi 0.85.1 Copilot 真实目录含多协议模型 When 解析 API Then 分别保留 GPT 与 Claude 协议', async () => {
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
