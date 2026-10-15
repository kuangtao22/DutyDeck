/** DutyDeck 本地模型运行时的主进程单例；utility 进程只接收临时租约快照。 */
import { join } from 'node:path'
import { LocalModelRuntime } from './local-model-runtime'
import { LocalModelEngineManager } from './local-model-engine-manager'
import { LOCAL_MODEL_CATALOG } from './local-model-catalog'
import { getConfigDir } from './config-paths'
import { createLocalModelDownloadTransport } from './local-model-download-network'

/** 单个应用进程只持有一份模型调度器。 */
let runtime: LocalModelRuntime | undefined

/** 按需创建本地引擎管理器；运行时不读取 PATH 或用户设置的可执行文件。 */
export function getLocalModelRuntime(): LocalModelRuntime {
  if (!runtime) {
    const { app } = require('electron') as { app: { isPackaged: boolean } }
    const root = app.isPackaged ? process.resourcesPath : join(__dirname, 'resources')
    const engineManager = new LocalModelEngineManager({ configDir: getConfigDir(), bundledRoot: join(root, 'local-model-engine'), createDownloadTransport: createLocalModelDownloadTransport })
    runtime = new LocalModelRuntime({ catalog: LOCAL_MODEL_CATALOG, engineManager, createDownloadTransport: createLocalModelDownloadTransport })
  }
  return runtime
}

/** 退出同步回收进程和下载；before-quit 不依赖未被等待的异步任务。 */
export function shutdownLocalModelRuntime(): void {
  runtime?.shutdown()
  runtime = undefined
}
