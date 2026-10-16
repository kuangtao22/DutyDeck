/** 手机面板身份；主进程另以 WebContents 身份隔离调用者。 */
export interface MobileMirrorSessionInput { sessionId: string; mirrorId: string }
/** 已发现的本地设备。 */
export interface MobileMirrorDevice { id: string; name: string; platform: 'ios' | 'android'; type?: string }
/** 指定当前面板内设备的请求。 */
export interface MobileMirrorCaptureInput extends MobileMirrorSessionInput { deviceId: string }
/** 只允许有限的手动设备操作；点击与滑动必须绑定当前显示帧。 */
export type MobileMirrorAction =
  | { type: 'tap'; x: number; y: number; frameId: string }
  | { type: 'swipe'; direction: 'up' | 'down' | 'left' | 'right'; frameId: string }
  | { type: 'type'; text: string }
  | { type: 'button'; button: 'HOME' | 'BACK' }
/** 操作请求不接受任意 MCP 工具名或配置。 */
export interface MobileMirrorActionInput extends MobileMirrorCaptureInput { action: MobileMirrorAction }
/** 只在内存传递的缩略截图及真实触点坐标尺寸。 */
export interface MobileMirrorFrame {
  frameId: string; deviceId: string; imageDataUrl: string; imageWidth: number; imageHeight: number
  coordinateWidth: number; coordinateHeight: number; capturedAt: number
}
/** 打开面板后的设备发现结果。 */
export interface MobileMirrorOpenResult { devices: MobileMirrorDevice[] }
/** 验证普通对象和字段白名单，返回已缩窄对象。 */
function object(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('手机面板请求格式无效')
  const value = input as Record<string, unknown>
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('手机面板请求包含不支持的字段')
  return value
}
/** 验证有限长度标识符，返回原字符串。 */
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f]/.test(value)) throw new Error('手机面板标识符无效')
  return value
}
/** 验证面板身份；额外字段仅由设备/操作解析器显式允许。 */
function identity(value: Record<string, unknown>): MobileMirrorSessionInput {
  const sessionId = identifier(value.sessionId)
  const mirrorId = identifier(value.mirrorId)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(mirrorId)) throw new Error('手机面板 UUID 无效')
  return { sessionId, mirrorId }
}
/** 解析打开、刷新设备或关闭请求，拒绝任意扩展配置。 */
export function parseMobileMirrorSessionInput(input: unknown): MobileMirrorSessionInput {
  return identity(object(input, ['sessionId', 'mirrorId']))
}
/** 解析截图请求并验证设备标识。 */
export function parseMobileMirrorCaptureInput(input: unknown): MobileMirrorCaptureInput {
  const value = object(input, ['sessionId', 'mirrorId', 'deviceId'])
  return { ...identity(value), deviceId: identifier(value.deviceId) }
}
/** 解析白名单操作；坐标归一化，文本最多 4096 个字符。 */
export function parseMobileMirrorActionInput(input: unknown): MobileMirrorActionInput {
  const value = object(input, ['sessionId', 'mirrorId', 'deviceId', 'action'])
  const action = object(value.action, ['type', 'x', 'y', 'frameId', 'direction', 'text', 'button'])
  let parsed: MobileMirrorAction
  switch (action.type) {
    case 'tap':
      object(action, ['type', 'x', 'y', 'frameId'])
      if (typeof action.x !== 'number' || typeof action.y !== 'number' || !Number.isFinite(action.x) || !Number.isFinite(action.y) || action.x < 0 || action.x > 1 || action.y < 0 || action.y > 1) throw new Error('点击坐标须在 0 到 1 之间')
      parsed = { type: 'tap', x: action.x, y: action.y, frameId: identifier(action.frameId) }; break
    case 'swipe':
      object(action, ['type', 'direction', 'frameId'])
      if (!['up', 'down', 'left', 'right'].includes(String(action.direction))) throw new Error('滑动方向无效')
      parsed = { type: 'swipe', direction: action.direction as 'up' | 'down' | 'left' | 'right', frameId: identifier(action.frameId) }; break
    case 'type':
      object(action, ['type', 'text'])
      if (typeof action.text !== 'string' || !action.text.length || action.text.length > 4096) throw new Error('输入文本长度须为 1 到 4096')
      parsed = { type: 'type', text: action.text }; break
    case 'button':
      object(action, ['type', 'button'])
      if (action.button !== 'HOME' && action.button !== 'BACK') throw new Error('不支持此手机按钮')
      parsed = { type: 'button', button: action.button }; break
    default: throw new Error('不支持此手机操作')
  }
  return { ...identity(value), deviceId: identifier(value.deviceId), action: parsed }
}
/** 手机面板专用窄域 IPC 通道，主进程与 preload 共享。 */
export const MOBILE_MIRROR_CHANNELS = {
  OPEN: 'mobile-mirror:open', LIST_DEVICES: 'mobile-mirror:list-devices', CAPTURE: 'mobile-mirror:capture', ACTION: 'mobile-mirror:action', CLOSE: 'mobile-mirror:close',
} as const
