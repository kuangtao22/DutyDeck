import { powerSaveBlocker } from 'electron'
import type { AppSettings } from '../../types'
import { SystemSleepBlocker } from './feishu/sleep-blocker'
import type { SleepBlockerAdapter, SleepBlockerType } from './feishu/sleep-blocker'

const electronSleepBlocker: SleepBlockerAdapter = {
  start: (type: SleepBlockerType): number => powerSaveBlocker.start(type),
  stop: (id: number): void => {
    powerSaveBlocker.stop(id)
  },
  isStarted: (id: number): boolean => powerSaveBlocker.isStarted(id),
}

/** 全局电源锁实例，同时承接通用设置和飞书实时同步。 */
const blocker = new SystemSleepBlocker(electronSleepBlocker)

/** 同步应用设置对应的系统防睡眠状态。
 * @param settings 当前通用防睡眠与飞书实时同步配置。
 * @returns 无返回值。
 */
export function syncSystemSleepBlocker(
  settings: Pick<AppSettings, 'feishuSessionMirror' | 'preventSystemSleep'>,
): void {
  try {
    blocker.sync(settings)
  } catch (error) {
    console.error('[电源管理] 同步防睡眠状态失败:', error)
  }
}

/** 应用退出时释放系统防睡眠电源锁。 */
export function stopSystemSleepBlocker(): void {
  try {
    blocker.stop()
  } catch (error) {
    console.error('[电源管理] 关闭防睡眠电源锁失败:', error)
  }
}
