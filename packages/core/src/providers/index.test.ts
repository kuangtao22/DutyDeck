import { describe, expect, test } from 'bun:test'
import type { ProviderType } from '@proma/shared'
import { getAdapter } from './index.ts'

describe('Provider 适配器注册表', () => {
  test.each([
    'zhipu',
    'doubao',
    'doubao-api',
    'qwen',
  ] satisfies ProviderType[])('Given OpenAI 兼容渠道 %s When 获取适配器 Then 保留真实渠道身份', (provider) => {
    expect(getAdapter(provider).providerType).toBe(provider)
  })
})
