import type { AppSettings } from '../../../types'

export type SleepBlockerType = 'prevent-app-suspension'

export interface SleepBlockerAdapter {
  start(type: SleepBlockerType): number
  stop(id: number): void
  isStarted(id: number): boolean
}

/** 判断是否应保留系统防睡眠电源锁。
 * @param settings 通用防睡眠与飞书实时同步设置。
 * @returns 任一来源要求保持唤醒时返回 true。
 */
export function shouldPreventSystemSleep(
  settings: Pick<AppSettings, 'feishuSessionMirror' | 'preventSystemSleep'>,
): boolean {
  return settings.preventSystemSleep === true || settings.feishuSessionMirror?.mode === 'stream'
}

/** 合并管理通用设置与飞书实时同步的系统防睡眠电源锁。 */
export class SystemSleepBlocker {
  private activeBlockerId: number | null = null

  /** 创建电源锁管理器。
   * @param adapter Electron 电源锁适配器。
   * @returns 防睡眠状态管理实例。
   */
  constructor(private readonly adapter: SleepBlockerAdapter) {}

  /** 根据当前应用设置同步电源锁状态。
   * @param settings 通用防睡眠与飞书实时同步设置。
   * @returns 无返回值。
   */
  sync(settings: Pick<AppSettings, 'feishuSessionMirror' | 'preventSystemSleep'>): void {
    if (shouldPreventSystemSleep(settings)) {
      this.start()
      return
    }

    this.stop()
  }

  /** 释放本服务创建的电源锁。 */
  stop(): void {
    if (this.activeBlockerId === null) return

    const blockerId = this.activeBlockerId
    this.activeBlockerId = null

    if (this.adapter.isStarted(blockerId)) {
      this.adapter.stop(blockerId)
      console.log('[电源管理] 已释放防睡眠电源锁')
    }
  }

  /** 创建或恢复防睡眠电源锁，重复调用保持幂等。 */
  private start(): void {
    if (this.activeBlockerId !== null) {
      if (this.adapter.isStarted(this.activeBlockerId)) return
      this.activeBlockerId = null
    }

    this.activeBlockerId = this.adapter.start('prevent-app-suspension')
    console.log('[电源管理] 已启用系统防睡眠（允许息屏锁屏）')
  }
}
