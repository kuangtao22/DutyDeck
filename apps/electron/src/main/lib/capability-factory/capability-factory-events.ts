import type { CapabilityFactoryChanged } from '@proma/shared'

/** 生命周期由 IPC 注册层管理，只发送身份、不广播运行正文。 */
let changeSink: ((event: CapabilityFactoryChanged) => void) | undefined

/** 宿主注册内部窗口的工厂变化通知出口。 */
export function setCapabilityFactoryChangeSink(sink: (event: CapabilityFactoryChanged) => void): void {
  changeSink = sink
}

/** 已落盘后发送刷新信号；窗口销毁不改变真实写入结论。 */
export function publishCapabilityFactoryChanged(event: CapabilityFactoryChanged): void {
  try { changeSink?.(event) } catch { /* 已保存证据仍可在重新打开面板后读取。 */ }
}
