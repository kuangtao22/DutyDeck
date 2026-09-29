import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test'
import type { Channel } from '@proma/shared'
import { createCapabilityFactoryModelCall } from './capability-factory-model-call'

/** 合成渠道与凭据，仅验证真实适配器和 SSE 读取链路。 */
const channel: Channel = {
  id: 'glm', name: '测试渠道', provider: 'zhipu-coding', baseUrl: 'https://example.invalid',
  apiKey: '', enabled: true, models: [], createdAt: 0, updatedAt: 0,
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
