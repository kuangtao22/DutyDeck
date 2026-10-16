import { describe, expect, it } from 'bun:test'
import sharp from 'sharp'
import { MobileMirrorService } from './service'
import type { McpServerEntry } from '@proma/shared'
/** 测试面板身份与可切换配置。 */
const input = { sessionId: 's1', mirrorId: 'bb4b7738-8ded-4af4-8309-377f741f66db' }
/** 创建隔离服务及工具桩，记录真实参数，不访问设备。 */
async function fixture(platform: 'ios' | 'android' = 'ios') {
  let entry: McpServerEntry = { type: 'stdio', command: 'npx', enabled: true }
  const calls: { name: string; arguments: Record<string, unknown> }[] = []
  let closed = 0
  let now = 1000
  let width = 400
  const png = await sharp({ create: { width: 800, height: 1600, channels: 3, background: '#fff' } }).png().toBuffer()
  const service = new MobileMirrorService({ now: () => now, resolveScope: () => ({ workspaceSlug: 'w', entry }), connect: async () => ({
    close: async () => { closed++ },
    callTool: async (request) => {
      calls.push(request)
      if (request.name === 'mobile_list_available_devices') return { content: [{ type: 'text', text: JSON.stringify({ devices: [{ id: 'd', name: 'Phone', platform }] }) }] }
      if (request.name === 'mobile_get_screen_size') return { content: [{ type: 'text', text: `Screen size is ${width}x800 pixels` }] }
      if (request.name === 'mobile_take_screenshot') return { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] }
      return { content: [{ type: 'text', text: 'ok' }] }
    },
  }) })
  return { service, calls, advance: () => { now += 5001 }, disable: () => { entry = { ...entry, enabled: false } }, rotate: () => { width = 800 }, closed: () => closed }
}
describe('手机镜像服务隔离与触点映射', () => {
  it('截图缩放不改变触点尺寸，点击使用屏幕合同且操作后旧帧失效', async () => {
    const f = await fixture(); await f.service.open(1, input)
    const frame = await f.service.capture(1, { ...input, deviceId: 'd' })
    expect(frame.imageHeight).toBe(1024); expect(frame.coordinateWidth).toBe(400)
    const request = { ...input, deviceId: 'd', action: { type: 'tap' as const, x: .5, y: .5, frameId: frame.frameId } }
    await f.service.performAction(1, request)
    expect(f.calls.at(-1)).toEqual({ name: 'mobile_click_on_screen_at_coordinates', arguments: { device: 'd', x: 200, y: 400 } })
    await expect(f.service.performAction(1, request)).rejects.toThrow()
    await f.service.dispose()
  })
  it('拒绝跨窗口、会话、未发现设备及已禁用配置', async () => {
    const f = await fixture(); await f.service.open(1, input)
    await expect(f.service.capture(2, { ...input, deviceId: 'd' })).rejects.toThrow()
    await expect(f.service.capture(1, { ...input, sessionId: 'other', deviceId: 'd' })).rejects.toThrow()
    await expect(f.service.capture(1, { ...input, deviceId: 'unknown' })).rejects.toThrow()
    f.disable(); await expect(f.service.capture(1, { ...input, deviceId: 'd' })).rejects.toThrow()
    expect(f.closed()).toBe(1)
  })
  it('旋转后拒绝旧图点击，iOS 不支持 BACK', async () => {
    const f = await fixture(); await f.service.open(1, input)
    const frame = await f.service.capture(1, { ...input, deviceId: 'd' }); f.rotate()
    await expect(f.service.performAction(1, { ...input, deviceId: 'd', action: { type: 'tap', x: .5, y: .5, frameId: frame.frameId } })).rejects.toThrow()
    await expect(f.service.performAction(1, { ...input, deviceId: 'd', action: { type: 'button', button: 'BACK' } })).rejects.toThrow()
    await f.service.dispose()
  })
  it('截图方向和触点尺寸比例不一致时拒绝生成可操作帧', async () => {
    const f = await fixture(); await f.service.open(1, input)
    f.rotate()
    await expect(f.service.capture(1, { ...input, deviceId: 'd' })).rejects.toThrow('截图方向')
    expect(f.calls.some(call => call.name === 'mobile_click_on_screen_at_coordinates')).toBe(false)
    await f.service.dispose()
  })
  it('Android 滑动、文字和系统按钮遵守官方参数且文字不自动提交', async () => {
    const f = await fixture('android'); await f.service.open(1, input)
    const frame = await f.service.capture(1, { ...input, deviceId: 'd' })
    await f.service.performAction(1, { ...input, deviceId: 'd', action: { type: 'swipe', direction: 'up', frameId: frame.frameId } })
    expect(f.calls.at(-1)).toEqual({ name: 'mobile_swipe_on_screen', arguments: { device: 'd', direction: 'up' } })
    await f.service.performAction(1, { ...input, deviceId: 'd', action: { type: 'type', text: '输入草稿' } })
    expect(f.calls.at(-1)).toEqual({ name: 'mobile_type_keys', arguments: { device: 'd', text: '输入草稿', submit: false } })
    for (const button of ['HOME', 'BACK'] as const) {
      await f.service.performAction(1, { ...input, deviceId: 'd', action: { type: 'button', button } })
      expect(f.calls.at(-1)).toEqual({ name: 'mobile_press_button', arguments: { device: 'd', button } })
    }
    await f.service.dispose()
  })
})

describe('手机镜像异步生命周期', () => {
  it('初始化中关闭立即拒绝，迟到连接被关闭且不能发现设备', async () => {
    let finish: ((value: import('./service').MobileMirrorConnection) => void) | undefined
    let closed = 0; let called = 0
    const service = new MobileMirrorService({ resolveScope: () => ({ workspaceSlug: 'w', entry: { type: 'stdio', enabled: true } }), connect: () => new Promise(resolve => { finish = resolve }) })
    const opening = service.open(1, input)
    const rejected = opening.catch((error: unknown) => error)
    await new Promise(resolve => setTimeout(resolve, 0))
    await service.close(1, input); expect(await rejected).toBeInstanceOf(Error)
    finish?.({ close: async () => { closed++ }, callTool: async () => { called++; return {} } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(closed).toBe(1); expect(called).toBe(0)
  })
  it('并发请求立即拒绝，超时后旧连接不能再用', async () => {
    let closed = 0; let block = false
    const service = new MobileMirrorService({ timeoutMs: 15, resolveScope: () => ({ workspaceSlug: 'w', entry: { type: 'stdio', enabled: true } }), connect: async () => ({ close: async () => { closed++ }, callTool: async () => {
      if (block) return new Promise(() => {})
      return { content: [{ type: 'text', text: '{"devices":[]}' }] }
    } }) })
    await service.open(1, input); block = true
    const refresh = service.listDevices(1, input)
    await expect(service.listDevices(1, input)).rejects.toThrow('忙碌')
    await expect(refresh).rejects.toThrow('超时')
    await expect(service.listDevices(1, input)).rejects.toThrow('已关闭')
    expect(closed).toBe(1)
  })
  it('配置替换后关闭旧连接，未启用时不创建连接', async () => {
    let command = 'one'; let enabled = false; let connects = 0; let closed = 0
    const service = new MobileMirrorService({ resolveScope: () => ({ workspaceSlug: 'w', entry: { type: 'stdio', enabled, command } }), connect: async () => { connects++; return { close: async () => { closed++ }, callTool: async () => ({ content: [{ type: 'text', text: '{"devices":[]}' }] }) } } })
    await expect(service.open(1, input)).rejects.toThrow(); expect(connects).toBe(0)
    enabled = true; await service.open(1, input); command = 'two'
    await expect(service.listDevices(1, input)).rejects.toThrow()
    expect(closed).toBe(1)
  })
})

describe('手机镜像所见帧队列兼容', () => {
  it('刷新后允许前一帧点击但不保留更早帧，动作使两帧都失效', async () => {
    const f = await fixture(); await f.service.open(1, input)
    const first = await f.service.capture(1, { ...input, deviceId: 'd' })
    const second = await f.service.capture(1, { ...input, deviceId: 'd' })
    const third = await f.service.capture(1, { ...input, deviceId: 'd' })
    const tap = (frameId: string) => f.service.performAction(1, { ...input, deviceId: 'd', action: { type: 'tap', x: .5, y: .5, frameId } })
    await tap(second.frameId)
    await expect(tap(third.frameId)).rejects.toThrow('过期')
    await expect(tap(first.frameId)).rejects.toThrow('过期')
    await f.service.dispose()
  })
})

  it('前一帧超过五秒拒绝，错误后当前帧也失效', async () => {
    const f = await fixture(); await f.service.open(1, input)
    const first = await f.service.capture(1, { ...input, deviceId: 'd' })
    const second = await f.service.capture(1, { ...input, deviceId: 'd' })
    f.advance()
    const tap = (frameId: string) => f.service.performAction(1, { ...input, deviceId: 'd', action: { type: 'tap', x: .5, y: .5, frameId } })
    await expect(tap(first.frameId)).rejects.toThrow('过期')
    await expect(tap(second.frameId)).rejects.toThrow('过期')
    await f.service.dispose()
  })

describe('手机镜像资源预算与失败回收', () => {
  it('每窗口最多两个、全局最多四个面板，关闭后释放名额', async () => {
    let connects = 0
    const service = new MobileMirrorService({ resolveScope: () => ({ workspaceSlug: 'w', entry: { type: 'stdio', enabled: true } }), connect: async () => {
      connects++
      return { close: async () => {}, callTool: async () => ({ content: [{ type: 'text', text: '{"devices":[]}' }] }) }
    } })
    const second = { ...input, mirrorId: 'bb4b7738-8ded-4af4-8309-377f741f66dc' }
    const third = { ...input, mirrorId: 'bb4b7738-8ded-4af4-8309-377f741f66dd' }
    await service.open(1, input); await service.open(1, second)
    await expect(service.open(1, third)).rejects.toThrow('上限')
    await service.open(2, input); await service.open(2, second)
    await expect(service.open(3, input)).rejects.toThrow('上限')
    expect(connects).toBe(4)
    await service.close(1, second); await service.open(3, input)
    expect(connects).toBe(5)
    await service.dispose()
  })
  it('工具错误和图片解码失败都主动关闭连接，不依赖 renderer 兜底', async () => {
    for (const invalid of [ { isError: true, content: [] }, { content: [{ type: 'image', mimeType: 'image/png', data: 'eA==' }] } ]) {
      let closed = 0
      const service = new MobileMirrorService({ resolveScope: () => ({ workspaceSlug: 'w', entry: { type: 'stdio', enabled: true } }), connect: async () => ({
        close: async () => { closed++ }, callTool: async ({ name }) => {
          if (name === 'mobile_list_available_devices') return { content: [{ type: 'text', text: '{"devices":[{"id":"d","name":"Phone","platform":"ios"}]}' }] }
          if (name === 'mobile_get_screen_size') return { content: [{ type: 'text', text: 'Screen size is 400x800 pixels' }] }
          return invalid
        },
      }) })
      await service.open(1, input)
      await expect(service.capture(1, { ...input, deviceId: 'd' })).rejects.toThrow()
      expect(closed).toBe(1)
      await expect(service.listDevices(1, input)).rejects.toThrow('已关闭')
    }
  })
})

it('初始化取消后仍占预算，迟到连接清理后才允许新增面板', async () => {
  const resolvers: ((connection: import('./service').MobileMirrorConnection) => void)[] = []
  const service = new MobileMirrorService({ resolveScope: () => ({ workspaceSlug: 'w', entry: { type: 'stdio', enabled: true } }), connect: () => new Promise(resolve => { resolvers.push(resolve) }) })
  const second = { ...input, mirrorId: 'bb4b7738-8ded-4af4-8309-377f741f66dc' }
  const third = { ...input, mirrorId: 'bb4b7738-8ded-4af4-8309-377f741f66dd' }
  const pending = [service.open(1, input).catch(() => undefined), service.open(1, second).catch(() => undefined)]
  await new Promise(resolve => setTimeout(resolve, 0))
  await service.closeOwner(1)
  await expect(service.open(1, third)).rejects.toThrow('上限')
  for (const resolve of resolvers) resolve({ close: async () => {}, callTool: async () => ({ content: [] }) })
  await Promise.all(pending)
  await new Promise(resolve => setTimeout(resolve, 0))
  const reopened = service.open(1, third)
  await new Promise(resolve => setTimeout(resolve, 0))
  resolvers.at(-1)?.({ close: async () => {}, callTool: async () => ({ content: [{ type: 'text', text: '{"devices":[]}' }] }) })
  expect(await reopened).toEqual({ devices: [] })
  await service.dispose()
})
