import { describe, expect, test } from 'bun:test'
import { resolveReasoningProfile } from './reasoning-profile'

describe('模型目录思考档位约束', () => {
  test.each([
    { provider: 'qwen', modelId: 'gpt-6-astra', transport: 'openai-completions' },
    { provider: 'openai', modelId: 'glm-5.3', transport: 'openai-completions' },
    { provider: 'doubao-api', modelId: 'kimi-k3', transport: 'openai-completions' },
  ] as const)('Given $provider 的未知 $modelId When 编译请求 Then 不借用其他供应商专属协议', (input) => {
    expect(resolveReasoningProfile(input)).toBeUndefined()
  })

  test('Given Kimi API 和 Coding 同族模型 When 查能力 Then 保留各自关闭权限', () => {
    expect(resolveReasoningProfile({ provider: 'kimi-api', modelId: 'kimi-k3', transport: 'anthropic-messages' })?.levels).not.toContain('off')
    expect(resolveReasoningProfile({ provider: 'kimi-coding', modelId: 'k3', transport: 'anthropic-messages' })?.levels).toContain('off')
  })

  test.each(['gpt-5', 'gpt-5-mini', 'gpt-5-nano'])('Given %s When 解析 API 思考能力 Then 保留 minimal 且不提供关闭和 xhigh', (modelId) => {
    /** 待核对的精确模型 profile。 */
    const profile = resolveReasoningProfile({ modelId, transport: 'openai-responses' })
    expect(profile?.levels).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(profile?.normalize('xhigh')).toBe('high')
    expect(profile?.normalize('minimal')).toBe('minimal')
  })

  test('Given GPT-5 Pro When 读取旧档位 Then 始终归一为唯一合法 high', () => {
    /** Pro 只有一个合法强度，不能继承整个 GPT 家族。 */
    const profile = resolveReasoningProfile({ modelId: 'gpt-5-pro', transport: 'openai-responses' })
    expect(profile?.levels).toEqual(['high'])
    expect(profile?.normalize('off')).toBe('high')
    expect(profile?.normalize('xhigh')).toBe('high')
  })

  test.each(['o1', 'o3', 'o3-mini', 'o4-mini'])('Given %s When 解析档位 Then 只有 low medium high', (modelId) => {
    expect(resolveReasoningProfile({ modelId, transport: 'openai-responses' })?.levels).toEqual(['low', 'medium', 'high'])
  })

  test('Given 未知未来 GPT 型号 When 解析 Then 不猜测支持的档位', () => {
    expect(resolveReasoningProfile({ modelId: 'gpt-5.99-future', transport: 'openai-responses' })).toBeUndefined()
  })

  test('Given DeepSeek V4 Pro When 选择低档 Then 实际编码为 low 且旧 xhigh 归一为 max', () => {
    /** 已有会话的 xhigh 保留兼容，新选择器不再暴露重复档位。 */
    const profile = resolveReasoningProfile({ modelId: 'deepseek-v4-pro', transport: 'anthropic-messages' })
    expect(profile?.levels).toEqual(['off', 'low', 'high', 'max'])
    expect(profile?.encodings['anthropic-messages']?.effortMap.low).toBe('low')
    expect(profile?.normalize('xhigh')).toBe('max')
  })

  test.each(['kimi-k3', 'glm-5.2'])('Given %s When 读取旧关闭配置 Then 不再发送关闭思考', (modelId) => {
    /** 只有 effort 的模型不应产生 disabled 请求。 */
    const profile = resolveReasoningProfile({ modelId, transport: 'anthropic-messages' })
    expect(profile?.levels).not.toContain('off')
    expect(profile?.normalize('off')).not.toBe('off')
  })
})
