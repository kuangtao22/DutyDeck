import type { Channel, ChannelPlanQuotaResult, ChannelPlanQuotaWindow, ProviderType } from '@proma/shared'

export interface LoadedPlanQuota {
  channelKey: string
  result: ChannelPlanQuotaResult
}

/** 构造 Agent 工具栏所需的账号版本键。 */
export function planQuotaAccountKey(channelId?: string | null, updatedAt?: number): string | null {
  return channelId ? JSON.stringify([channelId, updatedAt]) : null
}

/** 仅返回与当前完整身份键一致的结果，确保首帧不闪现旧账号额度。 */
export function currentPlanQuota(loaded: LoadedPlanQuota | null, channelKey: string | null): ChannelPlanQuotaResult | null {
  return channelKey !== null && loaded?.channelKey === channelKey ? loaded.result : null
}

interface PlanQuotaDisplay {
  summary: string
  title: string
  muted: boolean
}

/** 构造模型选择器所需的完整渠道身份键。 */
export function planQuotaChannelKey(channel: Pick<Channel, 'id' | 'updatedAt' | 'provider' | 'baseUrl'>): string {
  return JSON.stringify([channel.id, channel.updatedAt, channel.provider, channel.baseUrl])
}

/** 将单个额度窗口格式化为紧凑摘要。 */
function formatWindow(window: ChannelPlanQuotaWindow): string {
  const label = window.type === '5h' ? '5H' : window.type === 'weekly' ? '周' : window.label.replace(/\s+/g, '')
  return `${label} ${window.remainingLabel ?? `${window.remainingPercent}%`}`
}

/** 将单个额度窗口格式化为详情行。 */
export function formatPlanQuotaWindowValue(window: ChannelPlanQuotaWindow, provider: ProviderType): string {
  const date = window.resetAt === undefined ? undefined : new Date(window.resetAt)
  const reset = date && Number.isFinite(date.getTime())
    ? `，重置 ${new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    }).format(date)}`
    : provider === 'github-copilot' ? '，未提供重置时间' : ''
  const value = window.remainingLabel ?? `${window.remainingPercent}%`
  return `${window.showProgress === false ? value : `剩余 ${value}`}${reset}`
}

/** 生成渠道额度徽标的摘要、提示与弱化状态。 */
export function getPlanQuotaDisplay(quota: ChannelPlanQuotaResult | null, provider: ProviderType): PlanQuotaDisplay | null {
  const copilot = provider === 'github-copilot'
  if (!quota) return copilot ? { summary: '额度加载中', title: '正在读取 GitHub Copilot 订阅额度', muted: true } : null
  if (!quota.supported || quota.windows.length === 0) {
    return copilot ? {
      summary: quota.supported ? '额度未知' : '额度不可用',
      title: quota.message ?? 'GitHub Copilot 未提供可用额度数据',
      muted: true,
    } : null
  }

  const primary = [quota.windows.find((window) => window.type === '5h'), quota.windows.find((window) => window.type === 'weekly')]
    .filter((window): window is ChannelPlanQuotaWindow => Boolean(window))
  const summary = (primary.length > 0 ? primary : quota.windows.slice(0, 2)).map(formatWindow).join(' · ')
  const details = quota.windows.map((window) => `${window.label}: ${formatPlanQuotaWindowValue(window, provider)}`).join('\n')
  return { summary, title: `${quota.planName ?? '订阅额度'}\n${details}`, muted: false }
}
