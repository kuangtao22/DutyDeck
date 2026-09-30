import { describe, expect, test } from 'bun:test'
import type { ChannelModel } from '@proma/shared'
import { mergeFetchedChannelModels } from './channel-model-catalog'

/** 旧账号手工添加的模型，用于验证 Copilot 授权目录不会继承越权候选。 */
const previousModels: ChannelModel[] = [{ id: 'old-model', name: '旧账号模型', enabled: true, source: 'manual' }]

describe('渠道模型目录刷新', () => {
  test('Given Copilot 新账号目录为空 When 刷新 Then 清除旧账号手工模型', () => {
    expect(mergeFetchedChannelModels('github-copilot', previousModels, [])).toEqual([])
  })
  test('Given Copilot 新账号目录 When 刷新 Then 只启用该目录内的模型', () => {
    expect(mergeFetchedChannelModels('github-copilot', previousModels, [{ id: 'allowed', name: '可用模型', enabled: false }]))
      .toEqual([{ id: 'allowed', name: '可用模型', enabled: true }])
  })
  test('Given 普通 API 渠道有手工模型 When 刷新 Then 保留手工项且新增模型默认关闭', () => {
    expect(mergeFetchedChannelModels('custom', previousModels, [{ id: 'new', name: '新模型', enabled: true }]))
      .toEqual([...previousModels, { id: 'new', name: '新模型', enabled: false }])
  })
  test('Given Codex 渠道有旧模型 When 刷新 Then 保持订阅模型默认启用的原行为', () => {
    expect(mergeFetchedChannelModels('openai-codex', [], [{ id: 'gpt', name: 'GPT', enabled: false }]))
      .toEqual([{ id: 'gpt', name: 'GPT', enabled: true }])
  })
})
