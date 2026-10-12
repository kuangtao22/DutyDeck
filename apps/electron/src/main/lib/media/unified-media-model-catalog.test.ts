import { describe, expect, test } from 'bun:test'
import type { AudioGenerationPublicCatalog } from '@proma/shared'
import type { ImageGenerationPublicCatalog } from '@proma/shared'
import { formatMediaModelRef } from '@proma/shared'
import { UnifiedMediaModelCatalog } from './unified-media-model-catalog'

const imageCatalog: ImageGenerationPublicCatalog = {
  schemaVersion: 1,
  revision: 2,
  profiles: [{ id: 'image-main', name: '图片主配置', provider: 'minimax', baseUrl: 'https://api.example.test/v1', models: [
    { id: 'image-01', name: 'Image 01', capabilities: ['text-to-image', 'image-to-image'] },
    { id: 'video-01', name: 'Video 01', capabilities: ['text-to-video'] },
  ], enabled: true, credentialConfigured: true, endpointOrigin: 'https://api.example.test', createdAt: 1, updatedAt: 2 }],
}

const audioCatalog: AudioGenerationPublicCatalog = {
  schemaVersion: 3,
  revision: 4,
  profiles: [{ id: 'audio-main', name: '语音主配置', provider: 'minimax', baseUrl: 'https://api.example.test/v1', models: [{ id: 'speech-2.8-hd', voices: [{ id: '青舟', source: 'remote' }] }], enabled: true, credentialConfigured: true, endpointOrigin: 'https://api.example.test', createdAt: 1, updatedAt: 2 }],
}

describe('UnifiedMediaModelCatalog', () => {
  test('Given 图片、视频和音频独立目录 When 列出模型 Then 统一引用且按能力报告执行器', () => {
    const catalog = new UnifiedMediaModelCatalog({
      readImageCatalog: () => imageCatalog,
      readAudioCatalog: () => audioCatalog,
      resolveImageApiKey: () => 'image-secret',
      resolveAudioApiKey: () => 'audio-secret',
    })
    const models = catalog.list('project-1')
    expect(models.map((model) => model.ref)).toEqual([
      formatMediaModelRef({ kind: 'image', provider: 'minimax', profileId: 'image-main', modelId: 'image-01' }),
      formatMediaModelRef({ kind: 'video', provider: 'minimax', profileId: 'image-main', modelId: 'video-01' }),
      formatMediaModelRef({ kind: 'audio', provider: 'minimax', profileId: 'audio-main', modelId: 'speech-2.8-hd' }),
    ])
    expect(models.find((model) => model.kind === 'video')?.adapterId).toBe('minimax-video')
  })

  test('Given 已停用模型 When 解析 Then 标记不可用且不能解析秘密路由', () => {
    const disabled = { ...imageCatalog, profiles: [{ ...imageCatalog.profiles[0]!, enabled: false }] }
    const catalog = new UnifiedMediaModelCatalog({
      readImageCatalog: () => disabled,
      readAudioCatalog: () => ({ ...audioCatalog, profiles: [] }),
      resolveImageApiKey: () => 'secret',
      resolveAudioApiKey: () => 'secret',
    })
    const model = catalog.list('project-1')[0]!
    expect(model.available).toBe(false)
    expect(() => catalog.resolve(model.ref)).toThrow('MEDIA_MODEL_UNAVAILABLE')
  })

  test('Given 只有尚未接入执行器的放大能力 When 列出模型 Then 明确标记不可用', () => {
    const catalog = new UnifiedMediaModelCatalog({
      readImageCatalog: () => ({ ...imageCatalog, profiles: [{ ...imageCatalog.profiles[0]!, models: [{ id: 'upscale-1', name: 'Upscale', capabilities: ['upscale'] }] }] }),
      readAudioCatalog: () => ({ ...audioCatalog, profiles: [] }),
      resolveImageApiKey: () => 'secret',
      resolveAudioApiKey: () => 'secret',
    })
    const model = catalog.list('project-1')[0]!
    expect(model.available).toBe(false)
    expect(model.unavailableReason).toBe('执行器尚未接入')
  })
})
