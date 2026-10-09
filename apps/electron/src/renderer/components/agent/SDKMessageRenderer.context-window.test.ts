import { describe, expect, test } from 'bun:test'
import type { AgentEventUsage, SDKMessage, SDKResultMessage } from '@proma/shared'

interface RendererModule {
  extractTurnUsage?: (messages: SDKMessage[]) => { durationMs?: number; usage?: AgentEventUsage }
}

describe('Agent 历史消息上下文窗口', () => {
  test('Given 历史 result 携带真实 128K 窗口 When 提取 turn 用量 Then 不被 200K 推断值抬高', async () => {
    /** 动态读取模块，先让测试以行为断言表达需要公开的纯提取入口。 */
    const rendererModule = await import('./SDKMessageRenderer') as unknown as RendererModule
    expect(typeof rendererModule.extractTurnUsage).toBe('function')
    if (!rendererModule.extractTurnUsage) return
    /** 未知模型会命中 200K fallback，用于复现真实值被 Math.max 覆盖的问题。 */
    const message: SDKResultMessage = {
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 64_000, output_tokens: 1 },
      modelUsage: { 'unknown-128k-model': { contextWindow: 128_000 } },
    }

    const extracted = rendererModule.extractTurnUsage([message])

    expect(extracted.usage?.contextWindow).toBe(128_000)
  })
})
