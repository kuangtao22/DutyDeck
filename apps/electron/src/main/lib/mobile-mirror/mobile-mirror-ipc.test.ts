import { describe, expect, test } from 'bun:test'
import { MOBILE_MIRROR_CHANNELS } from '@proma/shared'
import { registerMobileMirrorIpc, type MobileMirrorIpcEvent } from './mobile-mirror-ipc'

/** 构造不接触 Electron 或真实设备的 IPC 夹具。 */
function fixture() {
  const handlers = new Map<string, (event: MobileMirrorIpcEvent, input: unknown) => Promise<unknown>>()
  const calls: string[] = []
  let authorized = true
  let invalidate: (() => void) | undefined
  let open = async () => ({ devices: [] })
  const registration = registerMobileMirrorIpc({
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: channel => { handlers.delete(channel) } },
    isAuthorizedSender: () => authorized,
    watchOwner: (_event, callback) => { invalidate = callback; return () => { calls.push('unwatch') } },
    service: {
      open: async () => { calls.push('open'); return open() },
      listDevices: async () => [], capture: async () => { throw new Error('unused') },
      performAction: async () => { calls.push('action') }, close: async () => { calls.push('close') },
      closeOwner: async () => { calls.push('closeOwner') }, dispose: async () => { calls.push('dispose') },
    },
  })
  const input = { sessionId: 'session-a', mirrorId: '229aa313-186a-4912-a39d-1f16469dcdda' }
  return { calls, input, handlers, registration,
    invoke: (channel: string, value: unknown = input) => handlers.get(channel)!({ sender: { id: 1 } }, value),
    deny: () => { authorized = false }, invalidate: () => invalidate?.(),
    setOpen: (next: typeof open) => { open = next },
  }
}

describe('手机面板 IPC 的授权和生命周期', () => {
  test('Given 合法主窗口，When 打开并关闭，Then 只调用绑定服务', async () => {
    const f = fixture()
    expect(await f.invoke(MOBILE_MIRROR_CHANNELS.OPEN)).toEqual({ devices: [] })
    await f.invoke(MOBILE_MIRROR_CHANNELS.CLOSE)
    expect(f.calls).toEqual(['open', 'close'])
  })
  test('Given 非授权窗口或 iframe，When 调用，Then 不访问设备', async () => {
    const f = fixture(); f.deny()
    await expect(f.invoke(MOBILE_MIRROR_CHANNELS.OPEN)).rejects.toThrow('MOBILE_MIRROR_ACCESS_DENIED')
    expect(f.calls).toEqual([])
  })
  test('Given 任意命令或工具名，When 请求，Then 在服务前拒绝', async () => {
    const f = fixture()
    await expect(f.invoke(MOBILE_MIRROR_CHANNELS.OPEN, { ...f.input, command: 'shell' })).rejects.toThrow()
    await expect(f.invoke(MOBILE_MIRROR_CHANNELS.ACTION, { ...f.input, deviceId: 'phone', action: { type: 'tool', name: 'exec' } })).rejects.toThrow()
    expect(f.calls).toEqual([])
  })
  test('Given 初始化在途，When 主窗口导航，Then 关闭连接并丢弃迟到结果', async () => {
    const f = fixture()
    let resolve!: (value: { devices: never[] }) => void
    f.setOpen(() => new Promise(done => { resolve = done }))
    const pending = f.invoke(MOBILE_MIRROR_CHANNELS.OPEN)
    f.invalidate(); resolve({ devices: [] })
    await expect(pending).rejects.toThrow('MOBILE_MIRROR_ACCESS_DENIED')
    expect(f.calls).toContain('closeOwner')
  })
  test('Given 异步期间权限失效，When 完成，Then 清理而不返回画面', async () => {
    const f = fixture()
    f.setOpen(async () => { f.deny(); return { devices: [] } })
    await expect(f.invoke(MOBILE_MIRROR_CHANNELS.OPEN)).rejects.toThrow('MOBILE_MIRROR_ACCESS_DENIED')
    expect(f.calls).toContain('closeOwner')
  })
  test('Given 导航后新面板已打开，When 旧请求迟到，Then 不关闭新上下文的连接', async () => {
    const f = fixture()
    let resolve!: (value: { devices: never[] }) => void
    f.setOpen(() => new Promise(done => { resolve = done }))
    const previous = f.invoke(MOBILE_MIRROR_CHANNELS.OPEN)
    f.invalidate()
    f.setOpen(async () => ({ devices: [] }))
    await f.invoke(MOBILE_MIRROR_CHANNELS.OPEN, { ...f.input, mirrorId: '229aa313-186a-4912-a39d-1f16469dcddb' })
    resolve({ devices: [] })
    await expect(previous).rejects.toThrow('MOBILE_MIRROR_ACCESS_DENIED')
    expect(f.calls.filter(call => call === 'closeOwner')).toHaveLength(1)
  })
  test('Given 已注册监听，When 应用退出，Then 释放连接和所有 handler', async () => {
    const f = fixture(); await f.invoke(MOBILE_MIRROR_CHANNELS.OPEN)
    await f.registration.dispose()
    expect(f.handlers.size).toBe(0)
    expect(f.calls).toContain('unwatch')
    expect(f.calls).toContain('dispose')
  })
})
