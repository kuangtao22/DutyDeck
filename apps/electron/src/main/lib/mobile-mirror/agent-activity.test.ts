import { describe, expect, it } from 'bun:test'
import { createMobileDeviceActivity } from './agent-activity'
/** 已经获批的真实 MCP 执行身份。 */
const execution = { serverName: 'mobile-mcp', toolName: 'mobile_click_on_screen_at_coordinates', toolUseId: 'tool-1', args: { device: 'phone-1', text: '不得广播的内容' } }
describe('手机工具活动事件', () => {
  it('只广播设备和运行身份，不广播工具输入', () => {
    expect(createMobileDeviceActivity(execution, 123, 4)).toEqual({ type: 'mobile_device_activity', deviceId: 'phone-1', toolUseId: 'tool-1', runStartedAt: 123, runGeneration: 4 })
  })
  it('拒绝同名归一化碰撞、非设备操作和非法设备参数', () => {
    expect(createMobileDeviceActivity({ ...execution, serverName: 'mobile_mcp' }, 123, 4)).toBeNull()
    for (const toolName of ['mobile_list_available_devices', 'mobile_login_to_cloud_provider', 'mobile_allocate_remote_device', 'unknown']) expect(createMobileDeviceActivity({ ...execution, toolName }, 123, 4)).toBeNull()
    expect(createMobileDeviceActivity({ ...execution, args: {} }, 123, 4)).toBeNull()
  })
})
