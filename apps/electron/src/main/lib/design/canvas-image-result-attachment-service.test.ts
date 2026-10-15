import { describe, expect, test } from 'bun:test'
import type { CanvasDocument, CanvasImageModuleConfig, DesignAsset, DesignJobRecord, MediaAssetRecord, MediaGenerationRequest, MediaGenerationSnapshot } from '@proma/shared'
import { createCanvasImageResultAttachmentService } from './canvas-image-result-attachment-service'
import type { CanvasImageAttachmentReceipt, PrepareCanvasImageAttachmentInput } from './canvas-image-result-attachment-service'
import type { CanvasImageCandidateJobTerminalEvent, CreateCanvasImageCandidateBatchInput } from './canvas-image-candidate-batch-service'

/** 内存夹具隔离外部生成，精确记录原候选系统收到的事实。 */
function fixture() {
  const input: PrepareCanvasImageAttachmentInput = { projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1', imageModuleId: 'module-1', sessionId: 'session-1', source: { kind: 'generation', runId: 'run-1', outputKey: 'image' } }
  const config: CanvasImageModuleConfig = { schemaVersion: 2, kind: 'image', contentId: 'module-1', revision: 2, createdAt: 1, updatedAt: 2, prompt: '旧画布提示词', selectedModelProfileId: null, aspectRatio: '1:1', imageSize: 'auto', contextMode: 'none', adoptedAssetId: null }
  const canvas: CanvasDocument = { schemaVersion: 4, projectId: input.projectId, canvasId: input.canvasId, revision: 3, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ kind: 'image', id: input.nodeId, imageModuleId: input.imageModuleId, title: '原卡', position: { x: 0, y: 0 } }], edges: [], createdAt: 1, updatedAt: 1 }
  const asset: MediaAssetRecord = { id: 'asset-media', revision: 1, hash: 'a'.repeat(64), filename: 'result.png', byteSize: 10, mediaType: 'image/png', createdAt: 3, mediaKind: 'image', metadata: { width: 10, height: 10 }, sourceSessionId: input.sessionId }
  const snapshot: MediaGenerationSnapshot = { id: 'run-1', projectId: input.projectId, revision: 0, phase: 'prepared', modelRef: 'media:image:openai-images:p:m', mediaKind: 'image', createdAt: 2, updatedAt: 3, outputs: [{ outputKey: 'image', asset: { assetId: asset.id, revision: 1, hash: asset.hash, mediaKind: 'image' } }], error: null }
  const request: MediaGenerationRequest = { projectId: input.projectId, operationId: 'op-1', modelRef: snapshot.modelRef, prompt: '真正发给模型的提示词', inputs: { image: { kind: 'asset', asset: { assetId: 'reference-1', hash: 'b'.repeat(64), revision: 1, mediaKind: 'image' } } } }
  const receipts = new Map<string, CanvasImageAttachmentReceipt>()
  const jobs = new Map<string, DesignJobRecord>()
  const batches: CreateCanvasImageCandidateBatchInput[] = []
  const terminals: CanvasImageCandidateJobTerminalEvent[] = []
  let imports = 0
  let locked = false
  let failTerminal = false
  const service = createCanvasImageResultAttachmentService({
    runExclusive: async (_target, effect) => { if (locked) throw new Error('重入锁'); locked = true; try { return await effect() } finally { locked = false } },
    loadCanvas: () => structuredClone(canvas), loadConfig: async () => structuredClone(config),
    resolveGeneration: (session) => { if (session !== input.sessionId) throw new Error('MEDIA_GENERATION_NOT_OWNED'); return structuredClone({ snapshot, request }) },
    resolveAsset: async () => structuredClone(asset),
    loadReceipt: async (_target, id) => structuredClone(receipts.get(id) ?? null),
    saveReceipt: async (receipt) => { receipts.set(receipt.attachmentId, structuredClone(receipt)) },
    importAsset: async (_receipt, _asset, jobId) => { imports++; return { id: 'asset-design', sourceJobId: jobId } as DesignAsset },
    registerJob: async (job, importer) => { const previous = jobs.get(job.id); if (previous) return previous; const imported = await importer(job.id); const saved = { ...job, outputAssetId: imported.id }; jobs.set(job.id, saved); return saved },
    candidates: {
      createBatchLocked: async (batch) => { batches.push(batch); return {} as never },
      recordJobTerminal: async (event) => { if (locked) throw new Error('候选终态不应重入'); if (failTerminal) throw new Error('磁盘暂不可用'); terminals.push(event) },
    }, now: () => 10,
  })
  return { service, input, config, canvas, asset, snapshot, request, receipts, jobs, batches, terminals, imports: () => imports, failTerminal: (value: boolean) => { failTerminal = value } }
}

describe('原图片卡外部结果回填', () => {
  test('Given 原卡已绑定运行 When 成功回填两次 Then 只有一份Job/素材且保留冻结输入，不创建节点或自动采用', async () => {
    const f = fixture()
    const prepared = await f.service.prepare(f.input)
    f.snapshot.phase = 'succeeded'
    const first = await f.service.attach({ ...f.input, attachmentId: prepared.attachmentId })
    expect(await f.service.attach({ ...f.input, attachmentId: prepared.attachmentId })).toEqual(first)
    expect(f.imports()).toBe(1)
    expect(f.jobs.size).toBe(1)
    expect(f.canvas.nodes).toHaveLength(1)
    expect(f.config.adoptedAssetId).toBeNull()
    expect(f.terminals.every((event) => event.skipInitialAdoption)).toBe(true)
    expect([...f.jobs.values()][0]?.prompt).toBe(f.request.prompt)
    expect(prepared.request?.inputs).toEqual(f.request.inputs)
    expect(prepared.configSnapshot.prompt).toBe('旧画布提示词')
  })

  test('Given 生成期间配置和采用版改变 When 迟到成功 Then 保留旧基线候选并标记stale', async () => {
    const f = fixture()
    const prepared = await f.service.prepare(f.input)
    f.config.revision++
    f.config.adoptedAssetId = 'user-choice'
    if (f.canvas.nodes[0]?.kind === 'image') f.canvas.nodes[0].adoptedAssetId = 'user-choice'
    f.snapshot.phase = 'succeeded'
    expect((await f.service.attach({ ...f.input, attachmentId: prepared.attachmentId })).stale).toBe(true)
    expect(f.batches[0]?.entries[0]?.initialConfigRevision).toBe(2)
    expect(f.batches[0]?.entries[0]?.initialAdoptedAssetId).toBeNull()
    expect(f.config.adoptedAssetId).toBe('user-choice')
  })

  test('Given 非终态、失败、跨项目、篡改输入或哈希不符 When 回填 Then 全部在导入前拒绝', async () => {
    for (const failure of ['running', 'failed', 'project', 'request', 'hash']) {
      const f = fixture()
      const prepared = await f.service.prepare(f.input)
      f.snapshot.phase = 'succeeded'
      if (failure === 'running') f.snapshot.phase = 'running'
      if (failure === 'failed') f.snapshot.phase = 'failed'
      if (failure === 'project') f.snapshot.projectId = 'other'
      if (failure === 'request') f.request.prompt = '替换输入'
      if (failure === 'hash') f.asset.hash = 'c'.repeat(64)
      await expect(f.service.attach({ ...f.input, attachmentId: prepared.attachmentId })).rejects.toThrow()
      expect(f.imports()).toBe(0)
    }
  })

  test('Given 原卡删除或其他会话领取 When 回填 Then 拒绝改派', async () => {
    const f = fixture()
    const prepared = await f.service.prepare(f.input)
    await expect(f.service.attach({ ...f.input, attachmentId: prepared.attachmentId, sessionId: 'other' })).rejects.toThrow('NOT_OWNED')
    f.canvas.nodes = []
    await expect(f.service.attach({ ...f.input, attachmentId: prepared.attachmentId })).rejects.toThrow('TARGET_INVALID')
    expect(f.imports()).toBe(0)
  })

  test('Given Job成功但候选登记中断 When 重试 Then 复用同Job和素材并补齐候选', async () => {
    const f = fixture()
    const prepared = await f.service.prepare(f.input)
    f.snapshot.phase = 'succeeded'
    f.failTerminal(true)
    await expect(f.service.attach({ ...f.input, attachmentId: prepared.attachmentId })).rejects.toThrow('磁盘暂不可用')
    f.failTerminal(false)
    await f.service.attach({ ...f.input, attachmentId: prepared.attachmentId })
    expect(f.imports()).toBe(1)
    expect(f.terminals).toHaveLength(1)
  })

  test('Given 已登记后期图 When 准备回填 Then 只接受同会话精确图片资产', async () => {
    const f = fixture()
    f.input.source = { kind: 'asset', asset: f.snapshot.outputs[0]!.asset }
    const prepared = await f.service.prepare(f.input)
    expect(prepared.preparedBeforeCompletion).toBe(false)
    await f.service.attach({ ...f.input, attachmentId: prepared.attachmentId })
    expect(f.imports()).toBe(1)
    f.input.source = { kind: 'asset', asset: { ...f.snapshot.outputs[0]!.asset, assetId: 'other' } }
    await expect(f.service.prepare(f.input)).rejects.toThrow('ASSET_INVALID')
  })

  test('Given 后期素材准备后归属变化 When 回填 Then 在导入前再次拒绝越权', async () => {
    const f = fixture()
    f.input.source = { kind: 'asset', asset: f.snapshot.outputs[0]!.asset }
    const prepared = await f.service.prepare(f.input)
    f.asset.sourceSessionId = 'other-session'
    await expect(f.service.attach({ ...f.input, attachmentId: prepared.attachmentId })).rejects.toThrow('NOT_OWNED')
    expect(f.imports()).toBe(0)
  })
})
