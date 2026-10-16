import { randomUUID } from 'node:crypto'
import type { McpServerEntry, MobileMirrorSessionInput, MobileMirrorCaptureInput, MobileMirrorActionInput, MobileMirrorDevice, MobileMirrorFrame, MobileMirrorOpenResult } from '@proma/shared'
import { parseMobileMirrorSessionInput, parseMobileMirrorCaptureInput, parseMobileMirrorActionInput } from '@proma/shared'
import { decodeScreenshot, parseDevices, parseScreenSize, toolContent } from './protocol'
/** 服务仅调用白名单适配器构造的工具参数。 */
export interface MobileMirrorConnection { callTool(input: { name: string; arguments: Record<string, unknown> }): Promise<unknown>; close(): Promise<void> }
/** 主线程按可见会话解析配置；连接工厂只接收可信配置。 */
export interface MobileMirrorDependencies {
  resolveScope(sessionId: string): { workspaceSlug: string; entry: McpServerEntry } | Promise<{ workspaceSlug: string; entry: McpServerEntry }>
  connect(entry: McpServerEntry, workspaceSlug: string, signal: AbortSignal): Promise<MobileMirrorConnection>
  timeoutMs?: number
  now?: () => number
}
/** 每个面板独立连接、设备和最新帧，不共享 Agent 生命周期。 */
interface MirrorState {
  ownerId: number; input: MobileMirrorSessionInput; controller: AbortController; busy: boolean
  binding?: string; initializing?: boolean; releasePromise?: Promise<void>; connection?: MobileMirrorConnection; devices: MobileMirrorDevice[]; frame?: MobileMirrorFrame; previousFrame?: MobileMirrorFrame
}
/** 对配置语义做稳定序列化，避免仅对象属性顺序改变触发失效。 */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([key]) => key !== 'lastTestResult').sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
/** 手机镜像的授权、取消、单飞和帧有效性边界。 */
export class MobileMirrorService {
  /** 活动面板按窗口和 UUID 隔离。 */
  private readonly states = new Map<string, MirrorState>()
  /** 依赖由主线程提供，测试使用不访问真实设备的替身。 */
  constructor(private readonly deps: MobileMirrorDependencies) {}
  /** 生成内部面板键；输入另经过运行时校验。 */
  private key(ownerId: number, input: MobileMirrorSessionInput): string { return `${ownerId}:${input.mirrorId}` }
  /** 确保迟到的操作不能返回帧或触发后续工具。 */
  private live(state: MirrorState): void { if (state.controller.signal.aborted) throw new Error('手机面板已关闭') }
  /** 重读当前授权与配置，禁用或替换立即关闭旧连接。 */
  private async scope(state: MirrorState): Promise<{ workspaceSlug: string; entry: McpServerEntry }> {
    this.live(state)
    try {
      const scope = await this.deps.resolveScope(state.input.sessionId)
      this.live(state)
      const binding = stable(scope)
      if (!scope.entry.enabled || (state.binding && state.binding !== binding)) throw new Error('Mobile MCP 已停用或配置已改变，请重新打开面板')
      state.binding = binding
      return scope
    } catch (error) { await this.release(state); throw error }
  }
  /** 幂等释放连接并使所有在途返回失效。 */
  private async release(state: MirrorState): Promise<void> {
    if (state.releasePromise) return state.releasePromise
    state.releasePromise = (async () => {
      state.controller.abort()
      const connection = state.connection; state.connection = undefined; state.frame = undefined; state.previousFrame = undefined
      try { await connection?.close() } catch { /* 关闭失败不保留可调用连接。 */ }
      finally {
        // 直到清理结束才归还预算，避免反复 OPEN/CLOSE 绕过进程上限。
        if (!state.initializing && this.states.get(this.key(state.ownerId, state.input)) === state) this.states.delete(this.key(state.ownerId, state.input))
      }
    })()
    return state.releasePromise
  }
  /** 为完整操作设置上限；超时关闭连接，禁止重叠请求。 */
  private async run<T>(state: MirrorState, operation: () => Promise<T>): Promise<T> {
    if (state.busy) throw new Error('手机面板忙碌，请等待当前操作完成')
    state.busy = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    try {
      return await Promise.race([
        operation().then(result => { this.live(state); return result }),
        new Promise<never>((_, reject) => {
          abort = () => reject(new Error('手机面板已关闭'))
          state.controller.signal.addEventListener('abort', abort, { once: true })
          if (state.controller.signal.aborted) abort()
          timer = setTimeout(() => { reject(new Error('手机操作超时，请重新打开面板')); void this.release(state) }, this.deps.timeoutMs ?? 120_000)
        }),
      ])
    } catch (error) {
      state.frame = undefined; state.previousFrame = undefined
      throw error
    } finally {
      clearTimeout(timer)
      if (abort) state.controller.signal.removeEventListener('abort', abort)
      state.busy = false
    }
  }
  /** 获取当前面板，阻止跨会话访问。 */
  private state(ownerId: number, input: MobileMirrorSessionInput): MirrorState {
    const state = this.states.get(this.key(ownerId, input))
    if (!state || state.input.sessionId !== input.sessionId) throw new Error('手机面板身份无效或已关闭')
    return state
  }
  /** 每次远程调用前重查配置与取消状态。 */
  private async call(state: MirrorState, name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.scope(state)
    if (!state.connection) throw new Error('手机连接尚未就绪')
    let result: unknown
    try { result = await state.connection.callTool({ name, arguments: args }) }
    catch (error) { await this.release(state); throw error }
    await this.scope(state)
    await this.response(state, () => toolContent(result))
    return result
  }
  /** 不可信响应解析失败即回收连接，避免 renderer 缺席时遗留子进程。 */
  private async response<T>(state: MirrorState, parse: () => T | Promise<T>): Promise<T> {
    try { return await parse() }
    catch (error) { await this.release(state); throw error }
  }
  /** 打开面板；状态先登记，使初始化期间 close 也能取消。 */
  async open(ownerId: number, raw: MobileMirrorSessionInput): Promise<MobileMirrorOpenResult> {
    const input = parseMobileMirrorSessionInput(raw)
    const key = this.key(ownerId, input)
    if (this.states.has(key)) throw new Error('手机面板已经打开')
    // 初始化中的面板也占用名额，左右分屏最多两个，全部窗口合计最多四个。
    if (this.states.size >= 4 || [...this.states.values()].filter(state => state.ownerId === ownerId).length >= 2) throw new Error('手机面板数量已达上限，请先关闭其他面板')
    const state: MirrorState = { ownerId, input, controller: new AbortController(), busy: false, devices: [] }
    this.states.set(key, state)
    try {
      return await this.run(state, async () => {
        const scope = await this.scope(state)
        state.initializing = true
        try {
          const connection = await this.deps.connect(scope.entry, scope.workspaceSlug, state.controller.signal)
          if (state.controller.signal.aborted) { await connection.close(); this.live(state) }
          state.connection = connection
        } finally {
          state.initializing = false
          // 取消可以即时返回，但迟到的初始化仍占预算，直到其资源确实收回。
          if (state.controller.signal.aborted && this.states.get(key) === state) this.states.delete(key)
        }
        state.devices = await this.response(state, async () => parseDevices(await this.call(state, 'mobile_list_available_devices', {})))
        return { devices: state.devices }
      })
    } catch (error) { await this.release(state); throw error }
  }
  /** 刷新本地设备列表，清除旧帧。 */
  async listDevices(ownerId: number, raw: MobileMirrorSessionInput): Promise<MobileMirrorDevice[]> {
    const state = this.state(ownerId, parseMobileMirrorSessionInput(raw))
    return this.run(state, async () => { state.frame = undefined; state.previousFrame = undefined; state.devices = await this.response(state, async () => parseDevices(await this.call(state, 'mobile_list_available_devices', {}))); return state.devices })
  }
  /** 设备必须来自此连接最近一次发现，不能直接指定远程云设备。 */
  private device(state: MirrorState, deviceId: string): MobileMirrorDevice {
    const device = state.devices.find(item => item.id === deviceId)
    if (!device) throw new Error('设备未连接，请刷新设备列表')
    return device
  }
  /** 读取尺寸、截图、再读尺寸，旋转中的帧不允许用作触点依据。 */
  async capture(ownerId: number, raw: MobileMirrorCaptureInput): Promise<MobileMirrorFrame> {
    const input = parseMobileMirrorCaptureInput(raw); const state = this.state(ownerId, input)
    return this.run(state, async () => {
      this.device(state, input.deviceId)
      // 仅保留一帧用于 UI 截图在途期间已提交的操作，不积累历史图像。
      const previous = state.frame?.deviceId === input.deviceId ? state.frame : undefined
      state.frame = undefined; state.previousFrame = undefined
      const args = { device: input.deviceId }
      const size = await this.response(state, async () => parseScreenSize(await this.call(state, 'mobile_get_screen_size', args)))
      const image = await this.response(state, async () => decodeScreenshot(await this.call(state, 'mobile_take_screenshot', { ...args, maxSize: 1024 })))
      const after = await this.response(state, async () => parseScreenSize(await this.call(state, 'mobile_get_screen_size', args)))
      if (size.width !== after.width || size.height !== after.height) throw new Error('屏幕方向已改变，请刷新画面')
      /** 缩放取整最多容忍两像素误差；截图方向与触点方向不一致时拒绝误控。 */
      if (Math.abs(image.imageWidth * size.height - image.imageHeight * size.width) > Math.max(size.width, size.height) * 2) throw new Error('截图方向与屏幕尺寸不一致，请刷新画面')
      this.live(state)
      const frame: MobileMirrorFrame = { ...image, frameId: randomUUID(), deviceId: input.deviceId, coordinateWidth: size.width, coordinateHeight: size.height, capturedAt: (this.deps.now ?? Date.now)() }
      state.previousFrame = previous && previous.coordinateWidth === size.width && previous.coordinateHeight === size.height && frame.capturedAt - previous.capturedAt <= 5_000 ? previous : undefined
      state.frame = frame
      return frame
    })
  }
  /** 执行有限手动操作；点击与滑动以所见帧尺寸映射，所有操作均使帧失效。 */
  async performAction(ownerId: number, raw: MobileMirrorActionInput): Promise<void> {
    const input = parseMobileMirrorActionInput(raw); const state = this.state(ownerId, input)
    return this.run(state, async () => {
      const device = this.device(state, input.deviceId); const action = input.action
      const args: Record<string, unknown> = { device: device.id }
      let name: string
      if (action.type === 'tap' || action.type === 'swipe') {
        const frame = state.frame?.frameId === action.frameId ? state.frame : state.previousFrame?.frameId === action.frameId ? state.previousFrame : undefined
        if (!frame || frame.frameId !== action.frameId || frame.deviceId !== device.id || (this.deps.now ?? Date.now)() - frame.capturedAt > (frame === state.previousFrame ? 5_000 : 15_000)) throw new Error('画面已过期，请刷新后操作')
        state.frame = undefined; state.previousFrame = undefined
        const size = await this.response(state, async () => parseScreenSize(await this.call(state, 'mobile_get_screen_size', args)))
        if (size.width !== frame.coordinateWidth || size.height !== frame.coordinateHeight) throw new Error('屏幕方向已改变，请刷新后操作')
        if (action.type === 'tap') {
          name = 'mobile_click_on_screen_at_coordinates'
          args.x = Math.min(size.width - 1, Math.round(action.x * size.width)); args.y = Math.min(size.height - 1, Math.round(action.y * size.height))
        } else { name = 'mobile_swipe_on_screen'; args.direction = action.direction }
      } else if (action.type === 'type') { name = 'mobile_type_keys'; args.text = action.text; args.submit = false }
      else {
        if (device.platform === 'ios' && action.button === 'BACK') throw new Error('iOS 不支持返回按钮')
        name = 'mobile_press_button'; args.button = action.button
      }
      state.frame = undefined; state.previousFrame = undefined
      await this.call(state, name, args)
    })
  }
  /** 关闭指定面板，不影响其他窗口或 Agent MCP。 */
  async close(ownerId: number, raw: MobileMirrorSessionInput): Promise<void> {
    const input = parseMobileMirrorSessionInput(raw); const state = this.states.get(this.key(ownerId, input))
    if (state && state.input.sessionId !== input.sessionId) throw new Error('手机面板身份无效')
    if (state) await this.release(state)
  }
  /** 窗口导航或销毁时取消全部所属面板。 */
  async closeOwner(ownerId: number): Promise<void> { await Promise.all([...this.states.values()].filter(state => state.ownerId === ownerId).map(state => this.release(state))) }
  /** 应用退出时清理所有独立连接。 */
  async dispose(): Promise<void> { await Promise.all([...this.states.values()].map(state => this.release(state))) }
}
