import type { LocalModelAsset, LocalModelSnapshot } from '@proma/shared'

/** 生命周期的用户文案；输入资产状态，返回不会混淆下载与加载的标签。 */
export function localModelStatus(status: LocalModelAsset['status']): string {
  return { 'not-installed': '未下载', downloading: '下载中', verifying: '校验中', installed: '已安装，未加载', starting: '加载中', running: '运行中', stopping: '停止中', error: '异常，可重试' }[status]
}

/** 从权威快照计算行操作权限；启用不等于加载，停止后仍保留能力证据。 */
export function localModelControls(asset: LocalModelAsset, snapshot: LocalModelSnapshot) {
  /** 当前资产是否已健康加载。 */
  const loaded = snapshot.runtime.assetId === asset.assetId && snapshot.runtime.endpointReady
  /** 模型文件下载、加载和启用都必须建立在已校验的引擎环境之上。 */
  const engineReady = snapshot.engine === undefined || (snapshot.engine.available === true && (snapshot.engine.state === undefined || snapshot.engine.state === 'installed'))
  /** 可取消生命周期由主进程决定，页面重开也仍然有效。 */
  const downloading = asset.status === 'downloading' || asset.status === 'verifying'
  return {
    loaded,
    downloading,
    canEnable: engineReady && asset.capability.state === 'available',
    canDownload: engineReady && (asset.status === 'not-installed' || (asset.status === 'error' && !asset.installedAt)),
    canRedownload: engineReady && asset.status === 'error' && Boolean(asset.installedAt) && !snapshot.runtime.busy,
    canStart: engineReady && Boolean(asset.installedAt) && !loaded && !downloading && !['starting', 'stopping', 'running', 'busy'].includes(snapshot.runtime.state),
    canStop: snapshot.runtime.assetId === asset.assetId && (snapshot.runtime.state === 'starting' || (snapshot.runtime.state === 'running' && !snapshot.runtime.busy)),
  }
}

/** 字节转为紧凑的 GiB 文案，供模型资源和下载进度复用。 */
export function localModelSize(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}
