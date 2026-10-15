import { createHash } from 'node:crypto'
import type {
  CanvasDocument, CanvasImageModuleConfig, CanvasImageTarget, CanvasTarget, DesignAsset,
  DesignJobRecord, MediaAssetRecord, MediaAssetRef, MediaGenerationRequest, MediaGenerationSnapshot,
} from '@proma/shared'
import { parseCanvasImageModuleConfig, parseMediaGenerationRequest } from '@proma/shared'
import type { CanvasImageCandidateBatchService } from './canvas-image-candidate-batch-service'

/** 只接受同会话统一生成或已登记的本地图片；路径不进入回填协议。 */
export type CanvasImageAttachmentSource =
  | { kind: 'generation'; runId: string; outputKey: string }
  | { kind: 'asset'; asset: MediaAssetRef }

/** 准备时固定的图片目标与来源；调用方提供的会话身份须来自 Host。 */
export interface PrepareCanvasImageAttachmentInput extends CanvasImageTarget {
  sessionId: string
  source: CanvasImageAttachmentSource
}

/** 持久回填记录；它是原候选系统的来源证据，不是另一套候选状态。 */
export interface CanvasImageAttachmentReceipt extends PrepareCanvasImageAttachmentInput {
  schemaVersion: 1
  attachmentId: string
  configSnapshot: CanvasImageModuleConfig
  request: MediaGenerationRequest | null
  preparedAt: number
  /** 成功运行才被关联时，不能把当前配置冒充生成开始配置。 */
  preparedBeforeCompletion: boolean
  output: MediaAssetRef | null
}

/** 产物仅登记为既有图片候选，采用仍由原来的采用事务决定。 */
export interface CanvasImageAttachmentResult {
  attachmentId: string
  jobId: string
  batchId: string
  assetId: string
  stale: boolean
}

/** 主进程注入权威读取、原子记录、稳定资产导入和原候选服务。 */
export interface CanvasImageResultAttachmentDependencies {
  runExclusive: <T>(target: CanvasTarget, effect: () => Promise<T>) => Promise<T>
  loadCanvas: (target: CanvasTarget) => CanvasDocument | Promise<CanvasDocument>
  loadConfig: (target: CanvasImageTarget) => Promise<CanvasImageModuleConfig>
  resolveGeneration: (sessionId: string, runId: string) => { request: MediaGenerationRequest; snapshot: MediaGenerationSnapshot }
  resolveAsset: (projectId: string, asset: MediaAssetRef) => Promise<MediaAssetRecord>
  loadReceipt: (target: CanvasTarget, attachmentId: string) => Promise<CanvasImageAttachmentReceipt | null>
  saveReceipt: (receipt: CanvasImageAttachmentReceipt) => Promise<void>
  /** 导入器应按 sourceJobId 复用已提交元数据，避免中断后重复复制文件。 */
  importAsset: (receipt: CanvasImageAttachmentReceipt, asset: MediaAssetRef, jobId: string) => Promise<DesignAsset>
  registerJob: (job: DesignJobRecord, importAsset: (jobId: string) => Promise<DesignAsset>) => Promise<DesignJobRecord>
  candidates: Pick<CanvasImageCandidateBatchService, 'createBatchLocked' | 'recordJobTerminal'>
  now?: () => number
}

/** 校验磁盘回执的最小公开结构，损坏回执按不存在处理并重新走准备合同。 */
export function isCanvasImageAttachmentReceipt(value: unknown): value is CanvasImageAttachmentReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1 || typeof record.attachmentId !== 'string'
    || typeof record.projectId !== 'string' || typeof record.canvasId !== 'string'
    || typeof record.nodeId !== 'string' || typeof record.imageModuleId !== 'string'
    || typeof record.sessionId !== 'string' || typeof record.preparedAt !== 'number'
    || !Number.isSafeInteger(record.preparedAt) || typeof record.preparedBeforeCompletion !== 'boolean'
    || !record.configSnapshot || typeof record.configSnapshot !== 'object') return false
  try {
    parseCanvasImageModuleConfig(record.configSnapshot)
    if (record.request !== null) parseMediaGenerationRequest(record.request)
    const source = record.source as Record<string, unknown>
    if (!source || typeof source !== 'object' || Array.isArray(source)) return false
    if (source.kind === 'generation') {
      if (typeof source.runId !== 'string' || typeof source.outputKey !== 'string') return false
    } else if (source.kind === 'asset') {
      const asset = source.asset as Record<string, unknown>
      if (!asset || typeof asset !== 'object' || Array.isArray(asset)
        || typeof asset.assetId !== 'string' || typeof asset.revision !== 'number'
        || !Number.isSafeInteger(asset.revision) || typeof asset.hash !== 'string'
        || !/^[a-f0-9]{64}$/.test(asset.hash)
        || !['image', 'audio', 'video'].includes(String(asset.mediaKind))) return false
    } else return false
    if (record.output !== null && (!record.output || typeof record.output !== 'object')) return false
    return true
  } catch {
    return false
  }
}

/** 四重目标与来源共同决定稳定身份；相同运行输出不能在同卡制造多份候选。 */
function attachmentIdentity(input: PrepareCanvasImageAttachmentInput): string {
  return createHash('sha256').update(JSON.stringify([
    input.projectId, input.canvasId, input.nodeId, input.imageModuleId, input.sessionId,
    input.source.kind === 'generation'
      ? ['generation', input.source.runId, input.source.outputKey]
      : ['asset', input.source.asset.assetId, input.source.asset.revision, input.source.asset.hash],
  ])).digest('hex')
}

/** 验证精确资产，不使用文件名或标题推断产物归属。 */
function assertAsset(record: MediaAssetRecord, ref: MediaAssetRef): void {
  if (ref.mediaKind !== 'image' || record.mediaKind !== 'image' || record.id !== ref.assetId
    || record.revision !== ref.revision || record.hash !== ref.hash) {
    throw new Error('CANVAS_IMAGE_ATTACHMENT_ASSET_INVALID')
  }
}

/** 创建只回填原节点的服务，所有写入复用 Canvas 串行边界与既有任务/候选合同。 */
export function createCanvasImageResultAttachmentService(dependencies: CanvasImageResultAttachmentDependencies) {
  /** 注入时钟便于失败恢复与测试保持稳定。 */
  const now = dependencies.now ?? Date.now
  /** 每次写入前核对节点仍属于原图片模块，删除后重建不能继承旧回填。 */
  const loadTarget = async (target: CanvasImageTarget): Promise<CanvasImageModuleConfig> => {
    /** 图节点和模块配置共同构成目标身份。 */
    const document = await dependencies.loadCanvas(target)
    const node = document.nodes.find((entry) => entry.id === target.nodeId)
    if (document.projectId !== target.projectId || document.canvasId !== target.canvasId
      || node?.kind !== 'image' || node.imageModuleId !== target.imageModuleId) {
      throw new Error('CANVAS_IMAGE_TARGET_INVALID')
    }
    const config = await dependencies.loadConfig(target)
    if (config.contentId !== target.imageModuleId || config.adoptedAssetId !== (node.adoptedAssetId ?? null)) {
      throw new Error('CANVAS_IMAGE_TARGET_INVALID')
    }
    return config
  }

  return {
    /** 在生成完成前绑定原图片卡与冻结配置；重试保持原基线，不重新签发新版本。 */
    prepare: async (input: PrepareCanvasImageAttachmentInput): Promise<CanvasImageAttachmentReceipt> => {
      return dependencies.runExclusive(input, async () => {
        const configSnapshot = await loadTarget(input)
        const attachmentId = attachmentIdentity(input)
        const existing = await dependencies.loadReceipt(input, attachmentId)
        if (existing) return structuredClone(existing)
        let request: MediaGenerationRequest | null = null
        let preparedBeforeCompletion = false
        if (input.source.kind === 'generation') {
          const source = dependencies.resolveGeneration(input.sessionId, input.source.runId)
          if (source.snapshot.projectId !== input.projectId || source.request.projectId !== input.projectId
            || source.snapshot.mediaKind !== 'image' || source.snapshot.id !== input.source.runId
            || ['failed', 'cancelled'].includes(source.snapshot.phase)) {
            throw new Error('CANVAS_IMAGE_ATTACHMENT_SOURCE_INVALID')
          }
          request = structuredClone(source.request)
          preparedBeforeCompletion = source.snapshot.phase !== 'succeeded'
        } else {
          const record = await dependencies.resolveAsset(input.projectId, input.source.asset)
          assertAsset(record, input.source.asset)
          if (record.sourceSessionId !== input.sessionId) throw new Error('CANVAS_IMAGE_ATTACHMENT_NOT_OWNED')
        }
        const receipt: CanvasImageAttachmentReceipt = {
          ...structuredClone(input), schemaVersion: 1, attachmentId, configSnapshot: structuredClone(configSnapshot),
          request, preparedAt: now(), preparedBeforeCompletion, output: null,
        }
        await dependencies.saveReceipt(receipt)
        return structuredClone(receipt)
      })
    },

    /** 成功产物进入原 Job/候选链；配置已变化仍保留候选，但绝不自动采用或覆盖。 */
    attach: async (input: CanvasTarget & { attachmentId: string; sessionId: string }): Promise<CanvasImageAttachmentResult> => {
      const result = await dependencies.runExclusive(input, async () => {
        const receipt = await dependencies.loadReceipt(input, input.attachmentId)
        if (!receipt || receipt.attachmentId !== input.attachmentId || receipt.projectId !== input.projectId
          || receipt.canvasId !== input.canvasId || receipt.sessionId !== input.sessionId
          || attachmentIdentity(receipt) !== input.attachmentId) throw new Error('CANVAS_IMAGE_ATTACHMENT_NOT_OWNED')
        const config = await loadTarget(receipt)
        let output: MediaAssetRef
        if (receipt.source.kind === 'generation') {
          const source = dependencies.resolveGeneration(input.sessionId, receipt.source.runId)
          if (source.snapshot.projectId !== input.projectId || source.snapshot.id !== receipt.source.runId
            || source.snapshot.phase !== 'succeeded' || source.snapshot.mediaKind !== 'image'
            || JSON.stringify(source.request) !== JSON.stringify(receipt.request)) {
            throw new Error('CANVAS_IMAGE_ATTACHMENT_SOURCE_INVALID')
          }
          /** 固定已收窄的来源字段，避免异步回调重新读取可变联合类型。 */
          const outputKey = receipt.source.outputKey
          const outputs = source.snapshot.outputs.filter((entry) => entry.outputKey === outputKey)
          if (outputs.length !== 1) throw new Error('CANVAS_IMAGE_ATTACHMENT_OUTPUT_INVALID')
          output = outputs[0]!.asset
        } else output = receipt.source.asset
        /** 元数据可能在准备后变化，写入前重新核对精确资产与本地来源归属。 */
        const outputRecord = await dependencies.resolveAsset(input.projectId, output)
        assertAsset(outputRecord, output)
        if (receipt.source.kind === 'asset' && outputRecord.sourceSessionId !== input.sessionId) {
          throw new Error('CANVAS_IMAGE_ATTACHMENT_NOT_OWNED')
        }
        if (receipt.output && JSON.stringify(receipt.output) !== JSON.stringify(output)) {
          throw new Error('CANVAS_IMAGE_ATTACHMENT_OUTPUT_INVALID')
        }
        /** 在文件复制前写下精确输出；发生中断后只能继续同一资产。 */
        receipt.output = structuredClone(output)
        await dependencies.saveReceipt(receipt)
        const jobId = `attached-${receipt.attachmentId}`
        const batchId = `attachment-${receipt.attachmentId}`
        const timestamp = now()
        const prompt = receipt.request?.prompt || receipt.configSnapshot.prompt || '已登记的本地后期图片'
        const job = await dependencies.registerJob({
          id: jobId, creativeTaskId: `attachment-task-${receipt.attachmentId}`, attemptNumber: 1,
          projectId: input.projectId, target: { kind: 'canvas-image', canvasId: input.canvasId,
            nodeId: receipt.nodeId, imageModuleId: receipt.imageModuleId },
          action: 'generate', status: 'succeeded', prompt, originalRequest: prompt, contextMode: 'none',
          sourceSessionId: input.sessionId, canvasImageConfigRevision: receipt.configSnapshot.revision,
          canvasImageInitialAdoptedAssetId: receipt.configSnapshot.adoptedAssetId,
          candidateBatchId: batchId, traceState: 'unavailable', executionSessionCleanupState: 'completed',
          createdAt: receipt.preparedAt, updatedAt: timestamp, completedAt: timestamp,
        }, (id) => dependencies.importAsset(receipt, output, id))
        if (!job.outputAssetId) throw new Error('CANVAS_IMAGE_ATTACHMENT_OUTPUT_INVALID')
        await dependencies.candidates.createBatchLocked({
          projectId: input.projectId, canvasId: input.canvasId, batchId, source: 'single',
          sourceSessionId: null, sourceToolCallId: null,
          entries: [{ nodeId: receipt.nodeId, imageModuleId: receipt.imageModuleId, jobId,
            initialConfigRevision: receipt.configSnapshot.revision, initialAdoptedAssetId: receipt.configSnapshot.adoptedAssetId }],
        })
        return { attachmentId: receipt.attachmentId, jobId, batchId, assetId: job.outputAssetId,
          stale: config.revision !== receipt.configSnapshot.revision || config.adoptedAssetId !== receipt.configSnapshot.adoptedAssetId }
      })
      /** 候选服务自身取得同一锁，必须在上面的锁释放后调用，防止重入死锁。 */
      await dependencies.candidates.recordJobTerminal({
        projectId: input.projectId, canvasId: input.canvasId, jobId: result.jobId, candidateBatchId: result.batchId,
        status: 'succeeded', outputAssetId: result.assetId, error: null, skipInitialAdoption: true,
      })
      return result
    },
  }
}

/** 工具和 IPC 只需要公开的准备/回填方法，不依赖具体存储实现。 */
export type CanvasImageResultAttachmentService = ReturnType<typeof createCanvasImageResultAttachmentService>
