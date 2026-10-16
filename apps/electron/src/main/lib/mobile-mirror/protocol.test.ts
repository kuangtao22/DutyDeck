import { describe, expect, it } from 'bun:test'
import sharp from 'sharp'
import { decodeScreenshot, parseDevices, parseScreenSize } from './protocol'
/** 构造官方文本 content 包装。 */
const text = (value: string): unknown => ({ content: [{ type: 'text', text: value }] })
describe('手机 MCP 不可信响应', () => {
  it('读取官方设备和触点尺寸，拒绝重复设备及错误响应', () => {
    expect(parseDevices(text('Found 0 devices:\n{"devices":[]}'))).toEqual([])
    expect(parseScreenSize(text('Screen size is 393x852 pixels'))).toEqual({ width: 393, height: 852 })
    expect(() => parseScreenSize(text('Screen size is 0x852 pixels'))).toThrow()
    expect(() => parseDevices({ isError: true, content: [] })).toThrow()
    expect(() => parseDevices(text(JSON.stringify({ devices: [{ id: 'x', name: 'x', platform: 'ios' }, { id: 'x', name: 'x', platform: 'ios' }] })))).toThrow()
  })
  it('拒绝超长编码、伪图、SVG 和像素炸弹，不信任 MIME 声明', async () => {
    for (const data of ['a'.repeat(12 * 1024 * 1024 + 1), Buffer.from('<svg/>').toString('base64'), '!!']) {
      await expect(decodeScreenshot({ content: [{ type: 'image', mimeType: 'image/png', data }] })).rejects.toThrow()
    }
    const large = await sharp({ create: { width: 6000, height: 6000, channels: 3, background: '#fff' } }).png().toBuffer()
    await expect(decodeScreenshot({ content: [{ type: 'image', mimeType: 'image/png', data: large.toString('base64') }] })).rejects.toThrow()
  })
})
