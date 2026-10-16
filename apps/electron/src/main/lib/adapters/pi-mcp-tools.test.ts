import { expect, test } from 'bun:test'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import { createPiMcpToolDefinition } from './pi-mcp-tools'
import { createMobileDeviceActivity } from '../mobile-mirror/agent-activity'

test('Given 两个服务器归一化名称碰撞 When 真实执行 Then 只有原始 mobile-mcp 身份触发展示', async () => {
  /** 记录执行顺序和事件，不连接真实设备。 */
  const order: string[] = []
  const events: unknown[] = []
  const names: string[] = []
  for (const serverName of ['mobile_mcp', 'mobile-mcp']) {
    const tool = createPiMcpToolDefinition({
      serverName, originalToolName: 'mobile_take_screenshot',
      tool: { name: 'mobile_take_screenshot', inputSchema: { type: 'object' } }, managerConfig: { type: 'stdio' },
      manager: { callTool: async () => { order.push('call'); return { content: [] } } },
      onToolExecuting: execution => {
        order.push('observed')
        const event = createMobileDeviceActivity(execution, 100, 2)
        if (event) events.push(event)
      },
    })
    names.push(tool.name)
    await tool.execute('use-id', { device: 'phone' }, new AbortController().signal, undefined, {} as ExtensionToolContext)
  }
  expect(names[0]).toBe(names[1])
  expect(order).toEqual(['observed', 'call', 'observed', 'call'])
  expect(events).toEqual([{ type: 'mobile_device_activity', deviceId: 'phone', toolUseId: 'use-id', runStartedAt: 100, runGeneration: 2 }])
})

test('Given 展示观察器抛错 When 调用手机工具 Then 业务继续且取消信号仍有效', async () => {
  let calls = 0
  for (const cancel of [false, true]) {
    const controller = new AbortController()
    const tool = createPiMcpToolDefinition({
      serverName: 'mobile-mcp', originalToolName: 'mobile_take_screenshot',
      tool: { name: 'mobile_take_screenshot', inputSchema: { type: 'object' } }, managerConfig: { type: 'stdio' },
      manager: { callTool: async () => { calls++; return { content: [] } } },
      onToolExecuting: () => { if (cancel) controller.abort(); throw new Error('展示监听器失败') },
    })
    const result = tool.execute('use-id', { device: 'phone' }, controller.signal, undefined, {} as ExtensionToolContext)
    if (cancel) await expect(result).rejects.toThrow('取消')
    else await result
  }
  expect(calls).toBe(1)
})
