import { describe, expect, test } from 'bun:test'
import type { AgentEvent, AgentStreamPayload, SDKResultMessage } from '@proma/shared'

interface ListenerModule {
  payloadToLegacyEvents?: (payload: AgentStreamPayload) => AgentEvent[]
}

describe('全局 Agent listener 上下文窗口', () => {
  test('Given result 携带真实 128K 窗口 When 转换 complete 事件 Then 不被 200K 推断值抬高', async () => {
    /** 动态读取模块，先让测试以行为断言表达需要公开的纯转换入口。 */
    const listenerModule = await import('./useGlobalAgentListeners') as unknown as ListenerModule
    expect(typeof listenerModule.payloadToLegacyEvents).toBe('function')
    if (!listenerModule.payloadToLegacyEvents) return
    /** 模型名称不在静态规则内，因此旧实现会推断为默认 200K。 */
    const message: SDKResultMessage = {
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 64_000, output_tokens: 1 },
      modelUsage: { 'unknown-128k-model': { contextWindow: 128_000 } },
    }

    const events = listenerModule.payloadToLegacyEvents({ kind: 'sdk_message', message })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'complete',
      usage: { contextWindow: 128_000, contextWindowSource: 'runtime' },
    })
  })

  test('Given assistant 只有模型推断窗口 When 转换 usage_update Then 标记为 inferred', async () => {
    const listenerModule = await import('./useGlobalAgentListeners') as unknown as ListenerModule
    expect(typeof listenerModule.payloadToLegacyEvents).toBe('function')
    if (!listenerModule.payloadToLegacyEvents) return

    const events = listenerModule.payloadToLegacyEvents({
      kind: 'sdk_message',
      message: {
        type: 'assistant',
        parent_tool_use_id: null,
        _channelModelId: 'unknown-model',
        message: {
          content: [],
          usage: { input_tokens: 64_000, output_tokens: 1 },
        },
      },
    })

    expect(events).toContainEqual(expect.objectContaining({
      type: 'usage_update',
      usage: expect.objectContaining({ contextWindow: 200_000, contextWindowSource: 'inferred' }),
    }))
  })

  test('Given 主进程 context_window When 转换 usage_update Then 标记为 runtime', async () => {
    const listenerModule = await import('./useGlobalAgentListeners') as unknown as ListenerModule
    expect(typeof listenerModule.payloadToLegacyEvents).toBe('function')
    if (!listenerModule.payloadToLegacyEvents) return

    const events = listenerModule.payloadToLegacyEvents({
      kind: 'proma_event',
      event: { type: 'context_window', contextWindow: 128_000 },
    })

    expect(events).toEqual([{
      type: 'usage_update',
      usage: { contextWindow: 128_000, contextWindowSource: 'runtime' },
    }])
  })
})
