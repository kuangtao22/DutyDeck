import { describe, expect, it } from 'bun:test'
import { parseMobileMirrorActionInput, parseMobileMirrorSessionInput } from './mobile-mirror'
/** 合法面板身份。 */
const identity = { sessionId: 'session-1', mirrorId: 'bb4b7738-8ded-4af4-8309-377f741f66db' }
describe('手机镜像 IPC 输入边界', () => {
  it('接受面板身份，拒绝伪造命令和非法 UUID', () => {
    expect(parseMobileMirrorSessionInput(identity)).toEqual(identity)
    expect(() => parseMobileMirrorSessionInput({ ...identity, command: 'sh' })).toThrow()
    expect(() => parseMobileMirrorSessionInput({ ...identity, mirrorId: '../x' })).toThrow()
  })
  it('接受归一化点击，拒绝越界、非有限坐标和超长文本', () => {
    const input = { ...identity, deviceId: 'device', action: { type: 'tap' as const, x: 0.5, y: 1, frameId: 'frame' } }
    expect(parseMobileMirrorActionInput(input)).toEqual(input)
    for (const x of [-1, 1.01, Infinity, NaN]) expect(() => parseMobileMirrorActionInput({ ...input, action: { ...input.action, x } })).toThrow()
    expect(() => parseMobileMirrorActionInput({ ...input, action: { type: 'type', text: 'x'.repeat(4097) } })).toThrow()
  })
})
