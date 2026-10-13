import { expect, test } from 'bun:test'
import { Value } from 'typebox/value'
import { buildCapabilityFactoryAgentTools } from './capability-factory-agent-tools'
import type { CapabilityFactoryAgentFacade } from './capability-factory-agent-facade'

test('Given 整链工具限额 When SDK 或直接调用 Then 严格校验并透传合法限额', async () => {
  /** 仅替换 facade 的终点，验证真实工具 schema 与执行入口。 */
  const received: unknown[] = []
  const facade = { runScene: async (...args: unknown[]) => { received.push(args); return {} } } as unknown as CapabilityFactoryAgentFacade
  const sdk = { defineTool: (definition: unknown) => definition } as Parameters<typeof buildCapabilityFactoryAgentTools>[0]
  const tool = buildCapabilityFactoryAgentTools(sdk, facade).find((entry) => entry.name === 'factory_run_scene')!
  const limits = { maxCalls: 3, maxTransportAttempts: 3, deadlineAt: 123 }
  const input = { sceneId: 'scene', input: {}, limits }
  expect(Value.Check(tool.parameters, input)).toBe(true)
  await tool.execute('call', input, undefined, undefined, {} as never)
  expect(received).toEqual([['scene', {}, { limits }]])
  for (const invalid of [{ ...input, limits: { ...limits, maxCalls: 1001 } },
    { ...input, limits: { ...limits, deadlineAt: 0 } }, { ...input, limits: { ...limits, durationMs: 1 } },
    { ...input, sessionId: 'forged' }, { ...input, requestId: 'not-an-agent-field' }]) {
    expect(Value.Check(tool.parameters, invalid)).toBe(false)
    await expect(tool.execute('call', invalid, undefined, undefined, {} as never)).rejects.toThrow('CAPABILITY_FACTORY_INVALID')
  }
  expect(received).toHaveLength(1)
  await tool.execute('legacy', { sceneId: 'scene', input: {} }, undefined, undefined, {} as never)
  expect(received[1]).toEqual(['scene', {}, {}])
})
