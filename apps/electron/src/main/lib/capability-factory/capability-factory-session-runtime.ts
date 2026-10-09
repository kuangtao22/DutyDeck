import { stableCapabilityValueKey } from '@proma/shared'
import type { CapabilityFactoryBatch, CapabilityFactoryBatchRequest } from '@proma/shared'
import { createCapabilityFactoryRunner } from './capability-factory-run'
import type { CapabilityFactoryRunDeps } from './capability-factory-run'
import { createCapabilityFactoryBatchRunner } from './capability-factory-batch'
import { withCapabilityFactoryBatchControl } from './capability-factory-batch-control'
import { publishCapabilityFactoryChanged } from './capability-factory-events'

/** 当前会话的模型端口与归属来自宿主，不接受工具输入覆盖。 */
interface CapabilityFactorySessionRuntimeOptions {
  rootDir: string
  sessionId: string
  scopeId?: string
  service: CapabilityFactoryRunDeps['service']
  getRunPorts(): Pick<CapabilityFactoryRunDeps, 'resolveModels' | 'callModel'>
  assertCurrent(): void
  signal?: AbortSignal
}

/** UI 与 Agent 共用同一运行接线；批次固定实际模型，并共用停止和进度入口。 */
export function createCapabilityFactorySessionRuntime(options: CapabilityFactorySessionRuntimeOptions) {
  /** 运行写入真实记录后，只发送当前会话的轻量刷新信号。 */
  const changed = (sceneId: string): void => publishCapabilityFactoryChanged({ sessionId: options.sessionId, sceneId })
  /** 单次运行共享归属校验，批次额外缓存本批解析出的模型绑定。 */
  const runner = (signal = options.signal, freezeModels = false) => {
    options.assertCurrent()
    const ports = options.getRunPorts()
    const models = new Map<string, ReturnType<CapabilityFactoryRunDeps['resolveModels']>>()
    return createCapabilityFactoryRunner({ service: options.service, ...ports, signal, assertCurrent: options.assertCurrent,
      resolveModels: (definition) => {
        const key = stableCapabilityValueKey(definition.modelSlots)
        const cached = models.get(key)
        if (freezeModels && cached) return structuredClone(cached)
        const resolution = ports.resolveModels(definition)
        if (freezeModels) models.set(key, structuredClone(resolution))
        return resolution
      },
      onProgress: (run) => { options.assertCurrent(); changed(run.sceneId) },
    })
  }
  /** 只读批次服务不初始化模型渠道；执行时才构建 runner。 */
  const batches = (signal = options.signal, onProgress?: (batch: CapabilityFactoryBatch) => void) => {
    let execution: ReturnType<typeof runner> | undefined
    return createCapabilityFactoryBatchRunner({ service: options.service, rootDir: options.rootDir,
      /** Agent 的三轮预算属于一个回合；界面每次显式点击单独授权，不累加成会话永久上限。 */
      ...(options.scopeId ? { scopeId: options.scopeId } : {}), signal, assertCurrent: options.assertCurrent,
      run: (sceneId, input, runOptions) => { execution ??= runner(signal, true); return execution.run(sceneId, input, runOptions) },
      onProgress: (batch) => { options.assertCurrent(); onProgress?.(batch); changed(batch.sceneId) },
    })
  }
  return {
    runner,
    batches,
    /** 场景锁覆盖界面与 Agent 发起的批次，重复点击不能启动第二份执行。 */
    runBatch: (request: CapabilityFactoryBatchRequest) => withCapabilityFactoryBatchControl({
      rootDir: options.rootDir, sessionId: options.sessionId, sceneId: request.sceneId, signal: options.signal,
      execute: (signal, bind) => batches(signal, (batch) => bind(batch.id)).run(request),
    }),
  }
}
