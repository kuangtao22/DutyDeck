import { describe, expect, test } from 'bun:test'
import type { Channel, LocalModelAsset, LocalModelSnapshot } from '@proma/shared'
import { projectLocalModelChannel } from './local-model-channel'
import { LOCAL_MODEL_CATALOG } from './local-model-catalog'

/** 渠道持久化中的伪造模型不能当成本地资产能力来源。 */
const channel: Channel = { id: 'local', provider: 'dutydeck-local', name: 'Local', baseUrl: 'https://old-cloud', apiKey: 'old-key', models: [{ id: 'fake', name: 'Fake', enabled: true }], enabled: true, createdAt: 1, updatedAt: 1 }
/** 候选资产来自固定目录；测试仅控制能力与启用状态。 */
function snapshot(state: LocalModelAsset['capability']['state'], enabled: boolean): LocalModelSnapshot {
  const entry = LOCAL_MODEL_CATALOG[0]!
  return { catalog: [entry], engine: { available: true }, assets: [{ ...entry, fileName: 'model.gguf', status: 'installed', enabled, capability: { state }, updatedAt: 1 }], runtime: { state: 'idle', endpointReady: false }, updatedAt: 1 }
}

describe('本地渠道权威投影', () => {
  test('Given 未验证或未启用资产 When 读取渠道 Then 忽略手工启用且清除地址凭据', () => {
    for (const state of ['unknown', 'unavailable', 'available'] as const) {
      const projected = projectLocalModelChannel(channel, snapshot(state, false))
      expect(projected.apiKey).toBe('')
      expect(projected.baseUrl).toBe('')
      expect(projected.models[0]?.enabled).toBe(false)
      expect(projected.models.some((model) => model.id === 'fake')).toBe(false)
    }
    expect(projectLocalModelChannel(channel, snapshot('unknown', true)).models[0]?.enabled).toBe(false)
  })
  test('Given 已验证且启用资产 When 读取 Then 使用精确revision身份且停止不丢失选择', () => {
    const projected = projectLocalModelChannel(channel, snapshot('available', true))
    expect(projected.models[0]).toMatchObject({ id: LOCAL_MODEL_CATALOG[0]!.assetId, enabled: true })
  })
  test('Given 引擎不可用 When 读取 Then 即使旧能力可用也不可选择', () => {
    const view = snapshot('available', true)
    view.engine = { available: false }
    expect(projectLocalModelChannel(channel, view).models[0]?.enabled).toBe(false)
  })
  test('Given 云端渠道 When 投影 Then 不修改原对象', () => {
    const cloud = { ...channel, provider: 'openai' as const }
    expect(projectLocalModelChannel(cloud, snapshot('available', true))).toBe(cloud)
  })
})
