import { describe, expect, test } from 'bun:test'
import type { ChannelPlanQuotaResult } from '@proma/shared'
import {
  currentPlanQuota,
  formatPlanQuotaWindowValue,
  getPlanQuotaDisplay,
  planQuotaAccountKey,
  planQuotaChannelKey,
} from './channel-plan-quota-display'

const copilotQuota: ChannelPlanQuotaResult = {
  supported: true,
  provider: 'github-copilot',
  planName: 'GitHub Copilot Pro',
  windows: [{ type: 'custom', label: 'Premium', remainingPercent: 80, usedPercent: 20 }],
  updatedAt: 1,
}

describe('额度显示身份门禁', () => {
  test('Given 已加载旧账号额度 When 新账号首帧渲染 Then 立即隐藏旧结果', () => {
    const oldKey = planQuotaAccountKey('copilot', 1)
    const newKey = planQuotaAccountKey('copilot', 2)

    expect(currentPlanQuota({ channelKey: oldKey!, result: copilotQuota }, newKey)).toBeNull()
  })

  test('Given 渠道协议或地址改变 When 首帧渲染 Then 完整身份键不同', () => {
    const oldKey = planQuotaChannelKey({ id: 'copilot', updatedAt: 1, provider: 'github-copilot', baseUrl: '' })
    const newKey = planQuotaChannelKey({ id: 'copilot', updatedAt: 1, provider: 'openai-codex', baseUrl: 'https://example.com' })

    expect(oldKey).not.toBe(newKey)
    expect(currentPlanQuota({ channelKey: oldKey, result: copilotQuota }, newKey)).toBeNull()
  })
})

describe('Copilot 额度文案', () => {
  test('Given 首次加载 When 展示 Then Copilot 显示加载态而其他渠道保持原行为', () => {
    expect(getPlanQuotaDisplay(null, 'github-copilot')).toMatchObject({ summary: '额度加载中', muted: true })
    expect(getPlanQuotaDisplay(null, 'openai-codex')).toBeNull()
  })

  test('Given 不限额窗口 When 格式化 Then 不伪装成百分比剩余', () => {
    const value = formatPlanQuotaWindowValue({
      type: 'custom', label: 'Chat', remainingPercent: 0, usedPercent: 0, remainingLabel: '不限额', showProgress: false,
    }, 'github-copilot')

    expect(value).toContain('不限额')
    expect(value).not.toContain('剩余')
    expect(value).toContain('未提供重置时间')
  })

  test('Given Copilot 查询失败 When 展示 Then 保留失败原因和可见占位', () => {
    const display = getPlanQuotaDisplay({
      supported: false,
      provider: 'github-copilot',
      windows: [],
      updatedAt: 1,
      message: '登录已失效',
    }, 'github-copilot')

    expect(display).toEqual({ summary: '额度不可用', title: '登录已失效', muted: true })
  })
})
