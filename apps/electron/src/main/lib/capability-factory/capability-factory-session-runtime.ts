import { stableCapabilityValueKey } from '@proma/shared'
import type { CapabilityFactoryBatch, CapabilityFactoryBatchRequest, CapabilityExperimentAdvanceRequest } from '@proma/shared'
import { createCapabilityFactoryRunner } from './capability-factory-run'
import type { CapabilityFactoryRunDeps } from './capability-factory-run'
import { createCapabilityFactoryBatchRunner } from './capability-factory-batch'
import { withCapabilityFactoryBatchControl } from './capability-factory-batch-control'
import { publishCapabilityFactoryChanged } from './capability-factory-events'
import { createCapabilityFactoryExperimentService, capabilityExperimentFingerprint } from './capability-factory-experiment'

/** 当前会话的模型端口与归属来自宿主，不接受工具输入覆盖。 */
interface CapabilityFactorySessionRuntimeOptions {
  rootDir: string
  sessionId: string
  scopeId?: string
  service: CapabilityFactoryRunDeps['service']
  getRunPorts(): Pick<CapabilityFactoryRunDeps, 'resolveModels' | 'callModel'>
  assertCurrent(): void
  /** 只读模式仍可查历史；启动模型和业务写入另行校验。 */
  canMutate?(): boolean
  signal?: AbortSignal
}

/** UI 与 Agent 共用同一运行接线；批次固定实际模型，并共用停止和进度入口。 */
export function createCapabilityFactorySessionRuntime(options: CapabilityFactorySessionRuntimeOptions) {
  /** 与所有权分开，避免用户停止或切换模式后丢弃已完成证据。 */
  const assertExecution = (): void => {
    options.assertCurrent()
    if (options.canMutate?.() === false) throw new Error('计划模式下不能执行编排工厂')
  }
  /** 运行写入真实记录后，只发送当前会话的轻量刷新信号。 */
  const changed = (sceneId: string): void => publishCapabilityFactoryChanged({ sessionId: options.sessionId, sceneId })
  /** 单次运行共享归属校验，批次额外缓存本批解析出的模型绑定。 */
  const runner = (signal = options.signal, freezeModels = false) => {
    assertExecution()
    const ports = options.getRunPorts()
    const models = new Map<string, ReturnType<CapabilityFactoryRunDeps['resolveModels']>>()
    return createCapabilityFactoryRunner({ service: options.service, ...ports, signal, assertCurrent: options.assertCurrent,
      callModel: async (invocation) => { assertExecution(); return ports.callModel(invocation) },
      resolveModels: (definition) => {
        const key = stableCapabilityValueKey({ slots: definition.modelSlots, selection: definition.modelSelection })
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
  /** 实验复用现有批次和 runner；仅本地服务视图替换草案，不写用户的待审草案。 */
  const experiments = (signal = options.signal) => createCapabilityFactoryExperimentService({
    rootDir: options.rootDir, service: options.service, signal, assertCurrent: options.assertCurrent,
    assertCanExecute: assertExecution,
    resolveModels: (definition) => { options.assertCurrent(); return options.getRunPorts().resolveModels(definition) },
    onChanged: changed,
    environmentFingerprint: () => capabilityExperimentFingerprint(options.service.listStubs()),
    runBatch: async (context) => {
      context.assertCurrent()
      /** 从真实服务继承持久化方法；唯一被替换的是冻结场景的只读查询。 */
      const snapshotService = Object.create(options.service) as CapabilityFactoryRunDeps['service']
      snapshotService.getScene = (sceneId) => {
        options.assertCurrent()
        if (sceneId !== context.request.sceneId) throw new Error('实验不能执行其他场景')
        const current = options.service.getScene(sceneId)
        return current ? { ...current, definition: structuredClone(context.baselineDefinition),
          draft: { definition: structuredClone(context.candidate.definition), source: 'agent', note: '实验冻结候选', createdAt: context.candidate.createdAt } } : null
      }
      const ports = options.getRunPorts()
      const execution = createCapabilityFactoryRunner({ service: snapshotService,
        /** 请求边界校验停止与冻结身份；持久化只检查所有权，以保留取消后的真实轨迹。 */
        callModel: async (invocation) => {
          assertExecution()
          context.assertCurrent()
          const response = await ports.callModel(invocation)
          context.assertCurrent()
          return response
        },
        resolveModels: () => structuredClone(context.resolution), callLedger: context.callLedger,
        signal: context.signal, assertCurrent: options.assertCurrent, onProgress: (run) => changed(run.sceneId) })
      return createCapabilityFactoryBatchRunner({ rootDir: options.rootDir, service: snapshotService,
        ...(options.scopeId ? { scopeId: options.scopeId } : {}), signal: context.signal, assertCurrent: options.assertCurrent,
        onProgress: context.onProgress, run: (sceneId, input, runOptions) => {
          context.assertCurrent()
          return execution.run(sceneId, input, runOptions)
        },
      }).run(context.request)
    },
  })
  return {
    runner,
    batches,
    experiments,
    /** 与普通批次共享场景锁，避免 UI 与 Agent 同时运行两份实验。 */
    runExperiment: (request: CapabilityExperimentAdvanceRequest) => withCapabilityFactoryBatchControl({
      rootDir: options.rootDir, sessionId: options.sessionId, sceneId: request.sceneId, signal: options.signal,
      execute: (signal, bind) => { assertExecution(); bind(request.experimentId); return experiments(signal).advance(request) },
    }),
    /** 场景锁覆盖界面与 Agent 发起的批次，重复点击不能启动第二份执行。 */
    runBatch: (request: CapabilityFactoryBatchRequest) => withCapabilityFactoryBatchControl({
      rootDir: options.rootDir, sessionId: options.sessionId, sceneId: request.sceneId, signal: options.signal,
      execute: (signal, bind) => { assertExecution(); return batches(signal, (batch) => bind(batch.id)).run(request) },
    }),
  }
}
