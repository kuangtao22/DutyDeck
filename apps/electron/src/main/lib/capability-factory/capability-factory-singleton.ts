/**
 * 编排工厂的生命周期单例。
 *
 * 与 api-workbench 的做法一致：**服务按需创建、退出时统一销毁**，未打开工厂前不创建任何文件。
 *
 * 差别在于本模块是**工作区级**的：存储根目录随工作区不同，
 * 所以按 rootDir 缓存服务实例，而不是全局一个。
 * 根目录由主进程统一解析后传入 —— 本模块不猜路径约定（那是 workspace 自己的事）。
 */
import { CapabilityFactoryService } from './capability-factory-service'
import { CapabilityFactoryStore } from './capability-factory-store'

/** 按存储根目录缓存的服务实例。 */
const services = new Map<string, CapabilityFactoryService>()

/** 取得（必要时创建）某个存储根目录对应的服务。 */
export function getCapabilityFactoryService(rootDir: string): CapabilityFactoryService {
  const existing = services.get(rootDir)
  if (existing) return existing
  const service = new CapabilityFactoryService({ store: new CapabilityFactoryStore(rootDir) })
  service.recoverInterruptedReviews()
  services.set(rootDir, service)
  return service
}

/**
 * 运行适配器**刻意不缓存**：它的模型解析要读"当前会话正在用哪个模型"，
 * 而同一工作区里不同会话可能用不同模型 —— 缓存等于把第一个会话的模型焊死。
 * runner 本身只是闭包，每次运行现建即可（见 `capability-factory-run.ts`）。
 */

/** 退出清理：丢弃全部实例（下次调用会重建）。 */
export function shutdownCapabilityFactory(): void {
  services.clear()
}

/** 是否存在已创建的服务 —— 退出流程用它决定要不要等清理。 */
export function hasActiveCapabilityFactoryServices(): boolean {
  return services.size > 0
}
