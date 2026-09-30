import { describe, expect, test } from 'bun:test'
import type { Channel, ProviderType } from '@proma/shared'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ChannelPlanQuotaBadge } from './ChannelPlanQuotaBadge'

/** 构造最小渠道数据，覆盖额度徽标首帧展示。 */
function channel(provider: ProviderType): Channel {
  return {
    id: `channel-${provider}`,
    name: provider,
    provider,
    baseUrl: '',
    apiKey: '',
    models: [],
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  }
}

/** 使用真实 Tooltip provider 服务端渲染徽标。 */
function renderBadge(provider: ProviderType): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <ChannelPlanQuotaBadge channel={channel(provider)} />
    </TooltipProvider>,
  )
}

describe('渠道额度徽标', () => {
  test('Given Copilot 渠道 When 首帧渲染 Then 显示可聚焦加载占位', () => {
    const html = renderBadge('github-copilot')

    expect(html).toContain('额度加载中')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('正在读取 GitHub Copilot 订阅额度')
  })

  test('Given Codex 渠道 When 额度尚未返回 Then 保持原有隐藏行为', () => {
    expect(renderBadge('openai-codex')).toBe('')
  })
})
