import { describe, expect, test } from 'bun:test'
import type { MediaGenerationRequest, UnifiedMediaModelOption } from '@proma/shared'
import { UnifiedMediaGenerationService, type UnifiedMediaGenerationAdapter } from './unified-media-generation-service'

const model: UnifiedMediaModelOption = {
  ref: 'media:audio:minimax:profile:speech-2.8-hd', name: 'Speech', kind: 'audio', provider: 'minimax', profileId: 'profile', modelId: 'speech-2.8-hd', capabilities: ['text-to-speech'], available: true, adapterId: 'fake',
}

const request: MediaGenerationRequest = {
  projectId: 'project-1', operationId: 'operation-1', modelRef: model.ref, prompt: '你好', inputs: {},
}

describe('UnifiedMediaGenerationService', () => {
  test('Given 已配置模型 When Agent 准备、执行并等待 Then 输出登记为媒体资产', async () => {
    const adapter: UnifiedMediaGenerationAdapter = { id: 'fake', generate: async () => [{ bytes: new Uint8Array([1, 2, 3]), contentType: 'audio/mpeg' }] }
    let registeredKind: string | undefined
    const service = new UnifiedMediaGenerationService({
      resolveModel: () => ({ option: model, ref: { kind: 'audio', provider: 'minimax', profileId: 'profile', modelId: 'speech-2.8-hd' }, baseUrl: 'https://example.test', apiKey: 'secret' }),
      adapters: [adapter],
      registerOutput: async (_projectId, _operationId, _bytes, _contentType, origin, expectedMediaKind) => {
        registeredKind = expectedMediaKind
        return { assetId: 'asset-1', revision: 1, hash: 'a'.repeat(64), mediaKind: 'audio', sourceSessionId: origin.sourceSessionId }
      },
      now: () => 100,
    })
    const prepared = service.prepare('session-1', request)
    expect(prepared.phase).toBe('prepared')
    const running = await service.execute('session-1', prepared.id, prepared.revision)
    expect(running.phase).toBe('running')
    const done = await service.wait('session-1', prepared.id, 1_000, running.revision)
    expect(done.phase).toBe('succeeded')
    expect(done.outputs[0]?.asset.assetId).toBe('asset-1')
    expect(registeredKind).toBe('audio')
  })

  test('Given 其它会话持有运行 When 查询或取消 Then 拒绝越权', () => {
    const service = new UnifiedMediaGenerationService({
      resolveModel: () => ({ option: model, ref: { kind: 'audio', provider: 'minimax', profileId: 'profile', modelId: 'speech-2.8-hd' }, baseUrl: 'https://example.test', apiKey: 'secret' }),
      adapters: [{ id: 'fake', generate: async () => [{ bytes: new Uint8Array([1]), contentType: 'audio/mpeg' }] }],
      registerOutput: async () => ({ assetId: 'asset-1', revision: 1, hash: 'a'.repeat(64), mediaKind: 'audio' }),
    })
    const prepared = service.prepare('session-1', request)
    expect(() => service.get('session-2', prepared.id)).toThrow('MEDIA_GENERATION_NOT_OWNED')
    expect(() => service.cancel('session-2', prepared.id)).toThrow('MEDIA_GENERATION_NOT_OWNED')
    expect(() => service.getAttachmentSource('session-2', prepared.id)).toThrow('MEDIA_GENERATION_NOT_OWNED')
    /** 回填只读取冻结输入，不泄漏供应商密钥，也不能改写原运行。 */
    const source = service.getAttachmentSource('session-1', prepared.id)
    expect(source.request.prompt).toBe('你好')
    expect(JSON.stringify(source)).not.toContain('secret')
    source.request.prompt = '已修改'
    expect(service.getAttachmentSource('session-1', prepared.id).request.prompt).toBe('你好')
  })

  test('Given 模型能力与素材类型不匹配 When Agent 准备生成 Then 在供应商请求前拒绝', () => {
    const imageModel: UnifiedMediaModelOption = {
      ref: 'media:image:openai-images:image:gpt-image-1', name: 'Image', kind: 'image', provider: 'openai-images', profileId: 'image', modelId: 'gpt-image-1', capabilities: ['text-to-image'], available: true, adapterId: 'openai-images',
    }
    const service = new UnifiedMediaGenerationService({
      resolveModel: () => ({ option: imageModel, ref: { kind: 'image', provider: 'openai-images', profileId: 'image', modelId: 'gpt-image-1' }, baseUrl: 'https://example.test', apiKey: 'secret' }),
      adapters: [{ id: 'openai-images', generate: async () => [] }],
      registerOutput: async () => ({ assetId: 'asset-1', revision: 1, hash: 'a'.repeat(64), mediaKind: 'image' }),
    })
    expect(() => service.prepare('session-1', {
      projectId: 'project-1', operationId: 'operation-1', modelRef: imageModel.ref, prompt: '生成',
      inputs: { reference: { kind: 'asset', asset: { assetId: 'audio-1', revision: 1, hash: 'a'.repeat(64), mediaKind: 'audio' } } },
    })).toThrow('MEDIA_GENERATION_INPUT_INVALID')
  })

  test('Given 产物登记期间收到取消 When 供应商结果迟到 Then 取消终态不能被成功结果覆盖', async () => {
    let resolveRegistration: ((asset: { assetId: string; revision: number; hash: string; mediaKind: 'audio' }) => void) | undefined
    let registrationStarted: (() => void) | undefined
    const registrationReady = new Promise<void>((resolve) => { registrationStarted = resolve })
    const service = new UnifiedMediaGenerationService({
      resolveModel: () => ({ option: model, ref: { kind: 'audio', provider: 'minimax', profileId: 'profile', modelId: 'speech-2.8-hd' }, baseUrl: 'https://example.test', apiKey: 'secret' }),
      adapters: [{ id: 'fake', generate: async () => [{ bytes: new Uint8Array([1]), contentType: 'audio/mpeg' }] }],
      registerOutput: async () => {
        registrationStarted?.()
        return await new Promise((resolve) => { resolveRegistration = resolve })
      },
    })
    const prepared = service.prepare('session-1', request)
    await service.execute('session-1', prepared.id, prepared.revision)
    await registrationReady
    expect(service.cancel('session-1', prepared.id).phase).toBe('cancelled')
    resolveRegistration?.({ assetId: 'asset-late', revision: 1, hash: 'a'.repeat(64), mediaKind: 'audio' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(service.get('session-1', prepared.id).phase).toBe('cancelled')
  })
})
