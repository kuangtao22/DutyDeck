/**
 * 编排工厂的 preload 桥（四层契约的第 2 层）。
 *
 * 只做两件事：把方法名 + 输入打包成信封发出去；把响应按类型交给渲染层。
 * 命令的合法性由**主进程**用 `parseCapabilityFactoryCommand` 把关（渲染层是不可信输入源）。
 *
 * 已知缺口（刻意标注，不假装完成）：本桥**尚未做响应的严格解析**。
 * api-workbench 有对应的 `parseApiResponse`，本模块还没有 ——
 * 在补上之前，主进程返回的结构异常会以原始形态到达渲染层。
 */
import { CAPABILITY_FACTORY_CHANNELS } from '@proma/shared'
import type {
  CapabilityFactoryApi, CapabilityFactoryCommandInputs, CapabilityFactoryCommandMethod,
  CapabilityFactoryCommandResults, CapabilityFactoryRunProgress,
} from '@proma/shared'

/** invoke 只依赖这一个能力，便于测试替身。 */
export type CapabilityFactoryInvoke = (channel: string, input: unknown) => Promise<unknown>

/** 订阅主进程单向事件；返回函数必须移除同一个 listener。 */
export type CapabilityFactorySubscribe = (
  channel: string,
  listener: (value: unknown) => void,
) => () => void

/** 进度事件的最小边界校验：损坏消息不进入 React 状态。 */
function parseRunProgress(value: unknown): CapabilityFactoryRunProgress | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const candidate = value as { requestId?: unknown; run?: unknown }
  if (typeof candidate.requestId !== 'string' || candidate.requestId.length === 0 || candidate.requestId.length > 128) return null
  if (typeof candidate.run !== 'object' || candidate.run === null || Array.isArray(candidate.run)) return null
  const run = candidate.run as { id?: unknown }
  if (typeof run.id !== 'string' || run.id.length === 0) return null
  return value as CapabilityFactoryRunProgress
}

/** 创建渲染层可用的编排工厂接口。 */
export function createCapabilityFactoryPreload(
  invoke: CapabilityFactoryInvoke,
  subscribe?: CapabilityFactorySubscribe,
): CapabilityFactoryApi {
  return {
    async invoke<M extends CapabilityFactoryCommandMethod>(
      method: M,
      input: CapabilityFactoryCommandInputs[M],
    ): Promise<CapabilityFactoryCommandResults[M]> {
      const response = await invoke(CAPABILITY_FACTORY_CHANNELS.INVOKE, { method, input })
      return response as CapabilityFactoryCommandResults[M]
    },
    ...(subscribe ? {
      onRunProgress(callback: (event: CapabilityFactoryRunProgress) => void): () => void {
        return subscribe(CAPABILITY_FACTORY_CHANNELS.PROGRESS, (value) => {
          const event = parseRunProgress(value)
          if (event) callback(event)
        })
      },
    } : {}),
  }
}
