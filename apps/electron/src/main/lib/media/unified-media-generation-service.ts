import { randomUUID } from 'node:crypto'
import type { MediaAssetRef, MediaGenerationRequest, MediaGenerationSnapshot, MediaInputValue, MediaKind } from '@proma/shared'
import { parseMediaGenerationRequest } from '@proma/shared'
import type { UnifiedMediaModelRoute } from './unified-media-model-catalog'

/** 适配器生成的原始媒体结果；字节只在主进程内流转。 */
export interface UnifiedMediaGenerationAdapterOutput {
  bytes: Uint8Array
  contentType: string
  outputKey?: string
}

/** 各供应商适配器只负责请求与响应，任务归属和资产登记由 Facade 统一处理。 */
export interface UnifiedMediaGenerationAdapter {
  id: string
  generate(input: { request: MediaGenerationRequest; route: UnifiedMediaModelRoute; signal: AbortSignal }): Promise<UnifiedMediaGenerationAdapterOutput[]>
}

/** 主进程统一媒体运行入口，Agent 与 Canvas 可共享同一实例。 */
export interface UnifiedMediaGenerationServiceOptions {
  resolveModel(modelRef: string): UnifiedMediaModelRoute
  adapters: readonly UnifiedMediaGenerationAdapter[]
  registerOutput(projectId: string, operationId: string, bytes: Uint8Array, contentType: string, origin: { mediaRunId: string; sourceSessionId: string }, expectedMediaKind: MediaKind): Promise<MediaAssetRef>
  now?: () => number
}

interface GenerationRecord {
  ownerSessionId: string
  request: MediaGenerationRequest
  route: UnifiedMediaModelRoute
  snapshot: MediaGenerationSnapshot
  controller?: AbortController
  task?: Promise<void>
  waiters: Set<() => void>
}

/** 统一媒体运行 Facade；每个 Agent 会话只能访问自己准备的任务。 */
export class UnifiedMediaGenerationService {
  private readonly records = new Map<string, GenerationRecord>()
  private readonly adapters = new Map<string, UnifiedMediaGenerationAdapter>()
  private readonly now: () => number

  constructor(private readonly options: UnifiedMediaGenerationServiceOptions) {
    this.now = options.now ?? Date.now
    for (const adapter of options.adapters) this.adapters.set(adapter.id, adapter)
  }

  /** 校验模型并冻结一次生成意图，不触发远端请求。 */
  prepare(ownerSessionId: string, raw: MediaGenerationRequest): MediaGenerationSnapshot {
    const request = parseMediaGenerationRequest(raw)
    const route = this.options.resolveModel(request.modelRef)
    validateMediaInputCompatibility(request, route)
    const adapterId = route.option.adapterId
    if (!adapterId || !this.adapters.has(adapterId)) throw new Error('MEDIA_MODEL_UNAVAILABLE')
    const now = this.now()
    const snapshot: MediaGenerationSnapshot = {
      id: randomUUID(), projectId: request.projectId, revision: 0, phase: 'prepared', modelRef: request.modelRef,
      mediaKind: route.option.kind, createdAt: now, updatedAt: now, outputs: [], error: null,
    }
    this.records.set(snapshot.id, { ownerSessionId, request, route, snapshot, waiters: new Set() })
    return this.copy(snapshot)
  }

  /** 启动已准备任务；完成由内部任务推进，返回 running 快照。 */
  async execute(ownerSessionId: string, runId: string, expectedRevision: number): Promise<MediaGenerationSnapshot> {
    const record = this.requireOwned(ownerSessionId, runId)
    if (record.snapshot.revision !== expectedRevision) throw new Error('MEDIA_GENERATION_REVISION_CONFLICT')
    if (record.snapshot.phase === 'succeeded' || record.snapshot.phase === 'failed' || record.snapshot.phase === 'cancelled') return this.copy(record.snapshot)
    if (record.task) return this.copy(record.snapshot)
    const adapterId = record.route.option.adapterId
    const adapter = adapterId ? this.adapters.get(adapterId) : undefined
    if (!adapter) throw new Error('MEDIA_MODEL_UNAVAILABLE')
    record.controller = new AbortController()
    this.update(record, { phase: 'running', error: null })
    record.task = this.runAdapter(record, adapter)
    return this.copy(record.snapshot)
  }

  /** 获取指定会话持有的任务快照。 */
  get(ownerSessionId: string, runId: string): MediaGenerationSnapshot {
    return this.copy(this.requireOwned(ownerSessionId, runId).snapshot)
  }

  /** 等待 revision 变化或终态；超时只返回当前快照，不取消远端任务。 */
  async wait(ownerSessionId: string, runId: string, timeoutMs = 30_000, afterRevision?: number, signal?: AbortSignal): Promise<MediaGenerationSnapshot> {
    const record = this.requireOwned(ownerSessionId, runId)
    const baseline = afterRevision ?? -1
    if (record.snapshot.revision > baseline || ['succeeded', 'failed', 'cancelled'].includes(record.snapshot.phase)) return this.copy(record.snapshot)
    if (signal?.aborted) throw new Error('MEDIA_GENERATION_WAIT_ABORTED')
    const waiter = new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = (): void => { if (timer) clearTimeout(timer); reject(new Error('MEDIA_GENERATION_WAIT_ABORTED')) }
      signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, Math.max(0, Math.min(timeoutMs, 30_000)))
      record.waiters.add(() => {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve()
      })
    })
    await waiter
    return this.copy(record.snapshot)
  }

  /** 明确取消任务；迟到的供应商响应不会复活已取消任务。 */
  cancel(ownerSessionId: string, runId: string): MediaGenerationSnapshot {
    const record = this.requireOwned(ownerSessionId, runId)
    if (['succeeded', 'failed', 'cancelled'].includes(record.snapshot.phase)) return this.copy(record.snapshot)
    record.controller?.abort()
    this.update(record, { phase: 'cancelled', error: null })
    return this.copy(record.snapshot)
  }

  /** 执行适配器并把结果登记为项目媒体资产。 */
  private async runAdapter(record: GenerationRecord, adapter: UnifiedMediaGenerationAdapter): Promise<void> {
    try {
      const outputs = await adapter.generate({ request: record.request, route: record.route, signal: record.controller!.signal })
      if (this.isCancelled(record)) return
      const assets: MediaGenerationSnapshot['outputs'] = []
      for (const [index, output] of outputs.entries()) {
        if (this.isCancelled(record)) return
        const outputKey = output.outputKey ?? `output-${index + 1}`
        const asset = await this.options.registerOutput(record.request.projectId, `${record.snapshot.id}:${outputKey}`, output.bytes, output.contentType, {
          mediaRunId: record.snapshot.id, sourceSessionId: record.ownerSessionId,
        }, record.snapshot.mediaKind)
        assets.push({ outputKey, asset })
      }
      /** 登记产物期间也可能收到取消；取消状态拥有终态优先级，不能被迟到结果覆盖。 */
      if (this.isCancelled(record)) return
      if (assets.length === 0) throw new Error('MEDIA_GENERATION_OUTPUT_MISSING')
      this.update(record, { phase: 'succeeded', outputs: assets, error: null })
    } catch (error) {
      if (this.isCancelled(record)) return
      const message = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'MEDIA_GENERATION_FAILED'
      this.update(record, { phase: 'failed', error: message })
    }
  }

  /** 按会话校验任务归属，避免模型通过猜测 ID 读取其它会话产物。 */
  private requireOwned(ownerSessionId: string, runId: string): GenerationRecord {
    const record = this.records.get(runId)
    if (!record || record.ownerSessionId !== ownerSessionId) throw new Error('MEDIA_GENERATION_NOT_OWNED')
    return record
  }

  /** 原子推进 revision 并唤醒等待者。 */
  private update(record: GenerationRecord, patch: Partial<MediaGenerationSnapshot>): void {
    record.snapshot = { ...record.snapshot, ...patch, revision: record.snapshot.revision + 1, updatedAt: this.now() }
    const waiters = [...record.waiters]
    record.waiters.clear()
    for (const wake of waiters) wake()
  }

  /** 返回脱离内部可变对象的任务快照。 */
  private copy(snapshot: MediaGenerationSnapshot): MediaGenerationSnapshot {
    return { ...snapshot, outputs: snapshot.outputs.map((output) => ({ ...output, asset: { ...output.asset } })) }
  }

  /** 通过方法读取可变任务状态，避免 TypeScript 把跨 await 的快照错误收窄。 */
  private isCancelled(record: GenerationRecord): boolean {
    return record.snapshot.phase === 'cancelled'
  }
}

/** 仅取出标量输入供供应商请求体使用，媒体资产由未来图生视频适配器按引用读取。 */
export function scalarInput(inputs: Record<string, MediaInputValue>, key: string): string | number | boolean | undefined {
  const value = inputs[key]
  return value?.kind === 'scalar' ? value.value : undefined
}

/** 根据模型能力校验素材输入，阻止把错误媒体类型或未支持的输入静默交给供应商。 */
function validateMediaInputCompatibility(request: MediaGenerationRequest, route: UnifiedMediaModelRoute): void {
  const assets = Object.values(request.inputs).filter((value): value is Extract<MediaInputValue, { kind: 'asset' }> => value.kind === 'asset')
  const capabilities = new Set(route.option.capabilities)
  const hasAssets = assets.length > 0
  if (route.option.kind === 'audio') {
    if (hasAssets && !capabilities.has('voice-cloning')) throw new Error('MEDIA_GENERATION_INPUT_INVALID')
    if (!hasAssets && !capabilities.has('text-to-speech') && !capabilities.has('text-to-music')) throw new Error('MEDIA_GENERATION_INPUT_INVALID')
    return
  }
  if (assets.some((value) => value.asset.mediaKind !== 'image')) throw new Error('MEDIA_GENERATION_INPUT_INVALID')
  if (route.option.kind === 'image') {
    if (hasAssets && !capabilities.has('image-to-image')) throw new Error('MEDIA_GENERATION_INPUT_INVALID')
    if (!hasAssets && !capabilities.has('text-to-image')) throw new Error('MEDIA_GENERATION_INPUT_INVALID')
    return
  }
  if (assets.length > 1) throw new Error('MEDIA_GENERATION_INPUT_INVALID')
  if (hasAssets && !capabilities.has('image-to-video')) throw new Error('MEDIA_GENERATION_INPUT_INVALID')
  if (!hasAssets && !capabilities.has('text-to-video')) throw new Error('MEDIA_GENERATION_INPUT_INVALID')
}
