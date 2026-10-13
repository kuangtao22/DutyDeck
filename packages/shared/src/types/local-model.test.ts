import { describe, expect, test } from 'bun:test'
import {
  DUTYDECK_LOCAL_PROVIDER,
  LOCAL_MODEL_IPC_CHANNELS,
  type LocalModelSnapshot,
  type LocalModelTestResult,
} from './local-model'
import { PROVIDER_DEFAULT_URLS, PROVIDER_LABELS, type ProviderType } from './channel'

describe('DutyDeck 内置本地模型共享契约', () => {
  test('显式 provider 身份不依赖 localhost 或空凭据推断', () => {
    const provider: ProviderType = DUTYDECK_LOCAL_PROVIDER
    expect(provider).toBe('dutydeck-local')
    expect(PROVIDER_LABELS[provider]).toBe('DutyDeck 本地运行时')
    expect(PROVIDER_DEFAULT_URLS[provider]).toBe('')
  })

  test('快照能区分未加载、运行中和能力三态', () => {
    const snapshot: LocalModelSnapshot = {
      catalog: [],
      assets: [{
        assetId: 'qwen3-8b-q4km-r1', modelId: 'qwen3-8b', name: 'Qwen3 8B', family: 'qwen',
        revision: 'r1', fileName: 'qwen3-8b.gguf', sha256: 'a'.repeat(64), sizeBytes: 1,
        status: 'installed', enabled: false, capability: { state: 'unknown' }, updatedAt: 1,
      }],
      runtime: { state: 'idle', endpointReady: false },
      updatedAt: 1,
    }
    expect(snapshot.assets[0]?.status).toBe('installed')
    expect(snapshot.assets[0]?.capability.state).toBe('unknown')
    expect(snapshot.runtime.endpointReady).toBe(false)
  })

  test('renderer-facing test result does not need executable details', () => {
    const result: LocalModelTestResult = {
      success: true,
      assetId: 'qwen3-8b-q4km-r1',
      reply: 'ok',
      toolCallSupported: true,
      jsonSupported: true,
      capability: { state: 'available', assetSha256: 'a'.repeat(64), engineVersion: 'b1', probeVersion: 1 },
      message: '能力检查通过',
    }
    expect(JSON.stringify(result)).not.toContain('127.0.0.1:')
    expect(JSON.stringify(result)).not.toContain('Authorization')
  })

  test('所有 IPC 通道唯一且有本地模型命名空间', () => {
    const channels = Object.values(LOCAL_MODEL_IPC_CHANNELS)
    expect(new Set(channels).size).toBe(channels.length)
    expect(channels.every((channel) => channel.startsWith('local-model:'))).toBe(true)
  })
})
