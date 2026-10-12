import { describe, expect, test } from 'bun:test'
import { formatMediaModelRef, parseMediaGenerationRequest, parseMediaModelRef } from './media-generation'

describe('统一媒体模型引用', () => {
  test('Given 合法音频模型 When 编解码 Then 保持稳定引用', () => {
    const ref = { kind: 'audio' as const, provider: 'minimax', profileId: 'speech-main', modelId: 'speech-2.8-hd' }
    expect(parseMediaModelRef(formatMediaModelRef(ref))).toEqual(ref)
  })

  test('Given 越权或不完整模型引用 When 解析 Then 拒绝', () => {
    expect(() => parseMediaModelRef('media:audio:minimax:__proto__:speech')).toThrow('MEDIA_MODEL_REF_INVALID')
    expect(() => parseMediaModelRef('media:audio:minimax:profile:')).toThrow('MEDIA_MODEL_REF_INVALID')
  })

  test('Given 统一生成输入 When 包含密钥字段或空提示词 Then 拒绝', () => {
    expect(() => parseMediaGenerationRequest({ projectId: 'p', operationId: 'o', modelRef: 'media:audio:minimax:profile:speech', prompt: ' ', inputs: {}, apiKey: 'secret' })).toThrow('MEDIA_GENERATION_INPUT_INVALID')
  })
})
