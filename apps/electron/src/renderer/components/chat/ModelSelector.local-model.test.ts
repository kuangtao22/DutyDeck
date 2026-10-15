import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { Channel } from '@proma/shared'
import { buildModelOptions } from './ModelSelector'

/** 创建资产清单投影后的本地供应商，不包含端点凭据。 */
const channel: Channel = { id: 'local', name: '本地', provider: 'dutydeck-local', baseUrl: '', apiKey: '', enabled: true, models: [{ id: 'qwen', name: 'Qwen', enabled: true }], createdAt: 1, updatedAt: 1 }

test('Given 已通过能力测试且启用 When Agent 选择模型 Then 本地模型可选', () => {
  expect(buildModelOptions([channel])).toHaveLength(1)
})
test('Given 本地供应商 When 普通 Chat 排除 Agent 专用供应商 Then 不显示本地模型', () => {
  expect(buildModelOptions([channel], undefined, undefined, ['dutydeck-local'])).toEqual([])
  const chat = readFileSync(new URL('./ChatInput.tsx', import.meta.url), 'utf8')
  const vision = readFileSync(new URL('../settings/VisionRelaySettings.tsx', import.meta.url), 'utf8')
  for (const source of [chat, vision]) expect(source).toContain("excludedProviders={['openai-codex', 'github-copilot', 'xai', 'dutydeck-local']}")
})
test('Given 资产已停用的渠道投影 When 重建选项 Then 删除旧启用项', () => {
  expect(buildModelOptions([{ ...channel, models: [{ ...channel.models[0]!, enabled: false }] }])).toEqual([])
})
