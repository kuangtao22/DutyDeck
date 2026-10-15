/** 默认根迁移窗口专用 preload，只暴露一次性确认 bridge。 */
import { contextBridge, ipcRenderer } from 'electron'
import { createDefaultRootMigrationPreloadApi } from './default-root-migration-preload'

/** 启动迁移窗口的最小安全 bridge，不暴露完整 electronAPI。 */
contextBridge.exposeInMainWorld(
  'defaultRootMigrationAPI',
  createDefaultRootMigrationPreloadApi(ipcRenderer),
)
