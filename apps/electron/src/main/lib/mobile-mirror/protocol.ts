import sharp from 'sharp'
import type { MobileMirrorDevice } from '@proma/shared'
/** 面板必须具备的有限工具集合。 */
export const MOBILE_MIRROR_TOOLS = ['mobile_list_available_devices', 'mobile_get_screen_size', 'mobile_take_screenshot', 'mobile_click_on_screen_at_coordinates', 'mobile_swipe_on_screen', 'mobile_type_keys', 'mobile_press_button'] as const
/** 从不可信 MCP 返回值中验证内容数组与错误标记。 */
export function toolContent(result: unknown): Record<string, unknown>[] {
  if (!result || typeof result !== 'object') throw new Error('手机服务响应无效')
  const value = result as Record<string, unknown>
  if (value.isError) throw new Error('手机工具执行失败，请检查设备连接')
  if (!Array.isArray(value.content) || value.content.length > 20) throw new Error('手机服务内容无效')
  return value.content.map(item => {
    if (!item || typeof item !== 'object') throw new Error('手机服务内容无效')
    return item as Record<string, unknown>
  })
}
/** 提取有限长度文本；不回显服务可能返回的敏感内容。 */
function toolText(result: unknown): string {
  const text = toolContent(result).filter(item => item.type === 'text').map(item => item.text).filter((item): item is string => typeof item === 'string').join('\n')
  if (text.length > 128 * 1024) throw new Error('手机服务文本超过限制')
  return text
}
/** 解析官方设备 JSON 包装，只接受本地在线设备列表。 */
export function parseDevices(result: unknown): MobileMirrorDevice[] {
  const text = toolText(result)
  const start = text.indexOf('{')
  const value: unknown = JSON.parse(start >= 0 ? text.slice(start) : text)
  const devices: unknown = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).devices : value
  if (!Array.isArray(devices) || devices.length > 100) throw new Error('手机设备列表无效')
  const ids = new Set<string>()
  return devices.map(item => {
    if (!item || typeof item !== 'object') throw new Error('手机设备信息无效')
    const device = item as Record<string, unknown>
    if (typeof device.id !== 'string' || !device.id || device.id.length > 256 || typeof device.name !== 'string' || device.name.length > 256 || !['ios', 'android'].includes(String(device.platform)) || ids.has(device.id)) throw new Error('手机设备信息无效')
    ids.add(device.id)
    return { id: device.id, name: device.name, platform: device.platform as 'ios' | 'android', ...(typeof device.type === 'string' && device.type.length < 64 ? { type: device.type } : {}) }
  })
}
/** 解析官方触点尺寸文本，尺寸不等同截图像素。 */
export function parseScreenSize(result: unknown): { width: number; height: number } {
  const match = /^Screen size is (\d+)x(\d+) pixels$/.exec(toolText(result).trim())
  const width = Number(match?.[1]); const height = Number(match?.[2])
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384) throw new Error('手机屏幕尺寸无效')
  return { width, height }
}
/** 限制编码长度和解码像素，重新编码为最大 1024 边 JPEG，不写文件。 */
export async function decodeScreenshot(result: unknown): Promise<{ imageDataUrl: string; imageWidth: number; imageHeight: number }> {
  const images = toolContent(result).filter(item => item.type === 'image')
  const image = images[0]
  if (images.length !== 1 || !image || !['image/png', 'image/jpeg'].includes(String(image.mimeType)) || typeof image.data !== 'string' || image.data.length > 12 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new Error('手机截图格式或大小无效')
  const buffer = Buffer.from(image.data, 'base64')
  const pipeline = sharp(buffer, { limitInputPixels: 32 * 1024 * 1024, failOn: 'warning' })
  const metadata = await pipeline.metadata()
  if (!metadata.width || !metadata.height || metadata.width > 16384 || metadata.height > 16384 || (metadata.pages ?? 1) !== 1 || !['png', 'jpeg'].includes(metadata.format ?? '')) throw new Error('手机截图尺寸或格式无效')
  const output = await pipeline.resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer({ resolveWithObject: true })
  return { imageDataUrl: `data:image/jpeg;base64,${output.data.toString('base64')}`, imageWidth: output.info.width, imageHeight: output.info.height }
}
