import type { PromaEvent } from '@proma/shared'
import type { PiMcpToolExecution } from '../adapters/pi-mcp-tools'
/** 只观察已指定设备的实际操作；发现设备、云授权与云资源分配不触发面板。 */
const DEVICE_TOOLS = new Set([
  'mobile_get_screen_size', 'mobile_take_screenshot', 'mobile_save_screenshot',
  'mobile_list_elements_on_screen', 'mobile_click_on_screen_at_coordinates',
  'mobile_double_tap_on_screen', 'mobile_long_press_on_screen_at_coordinates',
  'mobile_swipe_on_screen', 'mobile_type_keys', 'mobile_press_button',
  'mobile_launch_app', 'mobile_terminate_app', 'mobile_list_apps', 'mobile_open_url',
  'mobile_install_app', 'mobile_uninstall_app', 'mobile_set_orientation',
  'mobile_get_orientation', 'mobile_batch_commands', 'mobile_get_foreground_app',
  'mobile_fold_device', 'mobile_set_location', 'mobile_clipboard',
  'mobile_get_device_logs', 'mobile_start_screen_recording', 'mobile_stop_screen_recording',
  'mobile_list_crashes', 'mobile_get_crash',
])
/** 从主进程真实绑定构造最小展示事件，禁止将文本、图片或完整参数广播到 renderer。 */
export function createMobileDeviceActivity(execution: PiMcpToolExecution, runStartedAt: number, runGeneration: number): Extract<PromaEvent, { type: 'mobile_device_activity' }> | null {
  const deviceId = execution.args.device
  if (execution.serverName !== 'mobile-mcp' || !DEVICE_TOOLS.has(execution.toolName)
    || typeof deviceId !== 'string' || !deviceId.trim() || deviceId.length > 256 || /[\x00-\x1f]/.test(deviceId)) return null
  return { type: 'mobile_device_activity', deviceId, toolUseId: execution.toolUseId, runStartedAt, runGeneration }
}
