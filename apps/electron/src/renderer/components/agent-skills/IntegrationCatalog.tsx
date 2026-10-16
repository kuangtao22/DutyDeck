import * as React from 'react'
import { BookOpen, ChartCandlestick, Check, Chrome, CircleDashed, Cloud, FileText, Mail, Orbit, Plane, Search, Smartphone, Terminal, TrendingUp, Unplug } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import tavilyIcon from '@/assets/integrations/tavily.png'
import braveIcon from '@/assets/integrations/brave.svg'
import exaIcon from '@/assets/integrations/exa.png'
import tongdaxinIcon from '@/assets/integrations/tongdaxin.png'
import qichachaIcon from '@/assets/integrations/qichacha.png'
import tencentDocsIcon from '@/assets/integrations/tencent-docs.png'
import wecomIcon from '@/assets/integrations/wecom.png'
import dingtalkIcon from '@/assets/integrations/dingtalk.png'
import ctripIcon from '@/assets/integrations/ctrip.png'
import baiduNetdiskIcon from '@/assets/integrations/baidu-netdisk.png'
import feishuIcon from '@/assets/bots/feishu.png'
/** 小红书官网品牌图标（https://www.xiaohongshu.com/favicon.ico），本地打包确保离线可用。 */
import xiaohongshuIcon from '@/assets/integrations/xiaohongshu.png'
/** 上游公开产品图标本地打包；来源保留在导入旁，避免运行时请求第三方图标服务。 */
import context7Icon from '@/assets/integrations/context7.svg' // https://context7.com/context7-icon-green.svg
import playwrightIcon from '@/assets/integrations/playwright.svg' // https://playwright.dev/img/playwright-logo.svg
import figmaIcon from '@/assets/integrations/figma.png' // https://www.figma.com/favicon.ico
import apifyIcon from '@/assets/integrations/apify.png' // https://docs.apify.com/ 官方站点 favicon
import n8nIcon from '@/assets/integrations/n8n.png' // https://n8n.io/ 官方站点 favicon
import concatIcon from '@/assets/integrations/concat.png' // https://github.com/jub0t/concat/blob/v0.2.7/assets/icons/concat_logo_128.png
import codebaseMemoryIcon from '@/assets/integrations/codebase-memory.svg' // https://deusdata.github.io/codebase-memory-mcp/
import { cn } from '@/lib/utils'
import { compareCatalogConnectionCards, getCatalogCliConnectionStatus, getCatalogCliStatusRank, getCatalogGuidedConnectionStatus, getCatalogMcpConnectionStatus, getCatalogMcpStatusRank, type CatalogCliIntegration, type CatalogCliProbeState, type CatalogCredentialIntegration, type CatalogGuidedIntegration, type CatalogMcpIntegration } from './integration-catalog'

interface IntegrationCatalogProps {
  mcps: CatalogMcpIntegration[]
  clis: CatalogCliIntegration[]
  guided: CatalogGuidedIntegration[]
  credentials: CatalogCredentialIntegration[]
  embedded: boolean
  installedMcpNames: Set<string>
  enabledMcpNames: Set<string>
  verifiedMcpNames: Set<string>
  activeSkillSlugs: Set<string>
  connectedCliIds: Set<string>
  cliIntegrationProbeState: CatalogCliProbeState
  installingMcpId: string | null
  onInstallMcp: (integration: CatalogMcpIntegration) => void
  onGuideCli: (integration: CatalogCliIntegration) => void
  onDisconnectCli: (integration: CatalogCliIntegration) => void
  onGuide: (integration: CatalogGuidedIntegration) => void
  onRequestCredential: (integration: CatalogCredentialIntegration) => void
  onToggleMcp: (serverName: string, enabled: boolean) => void
  /** 仅已验证的 Mobile MCP 可进入专用设备面板。 */
  onOpenMobileMirror?: () => void
}

// The normal capability center keeps its viewport breakpoint. The embedded view
// is inside a resizable SidePanel, so it switches columns from its own container.
export const EMBEDDED_CATALOG_TWO_COLUMN_MIN_WIDTH = '40rem'
const embeddedCatalogContainerQuery = `
  @container (min-width: ${EMBEDDED_CATALOG_TWO_COLUMN_MIN_WIDTH}) {
    .integration-catalog-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
`

type CatalogCard =
  | { integration: CatalogMcpIntegration; status: string; statusTone: 'success' | 'muted'; statusRank: number; actionLabel: string; commandLine: false; enabled: boolean; onAction: () => void; onToggle?: (enabled: boolean) => void; onDisconnect?: () => void }
  | { integration: CatalogCliIntegration; status: string; statusTone: 'success' | 'muted'; statusRank: number; actionLabel: string; commandLine: true; enabled?: boolean; onAction: () => void; onToggle?: (enabled: boolean) => void; onDisconnect?: () => void }
  | { integration: CatalogGuidedIntegration; status: string; statusTone: 'success' | 'muted'; statusRank: number; actionLabel: string; commandLine: false; enabled?: boolean; onAction: () => void; onToggle?: (enabled: boolean) => void; onDisconnect?: () => void }
  | { integration: CatalogCredentialIntegration; status: string; statusTone: 'success' | 'muted'; statusRank: number; actionLabel: string; primaryActionLabel: string; commandLine: false; enabled: boolean; onAction: () => void; onToggle?: (enabled: boolean) => void; onDisconnect?: () => void }

export function IntegrationCatalog({ mcps, clis, guided, credentials, embedded, installedMcpNames, enabledMcpNames, verifiedMcpNames, activeSkillSlugs, connectedCliIds, cliIntegrationProbeState, installingMcpId, onInstallMcp, onGuideCli, onDisconnectCli, onGuide, onRequestCredential, onToggleMcp, onOpenMobileMirror }: IntegrationCatalogProps): React.ReactElement {
  const cards: CatalogCard[] = [
    ...mcps.map((integration) => {
      const status = getCatalogMcpConnectionStatus(integration.serverName, installedMcpNames, enabledMcpNames, verifiedMcpNames)
      return {
        integration,
        status: status === 'connected' ? '已连接' : status === 'pending' ? (integration.authentication === 'none' ? '待验证' : '待授权') : '未配置',
        statusTone: status === 'connected' ? 'success' as const : 'muted' as const,
        statusRank: getCatalogMcpStatusRank(status),
        actionLabel: status === 'connected' ? `查看 ${integration.name}` : status === 'pending' ? `继续配置 ${integration.name}` : `连接 ${integration.name}`,
        commandLine: false as const,
        enabled: enabledMcpNames.has(integration.serverName),
        onAction: () => onInstallMcp(integration),
        onToggle: status !== 'unconfigured' ? (enabled: boolean) => onToggleMcp(integration.serverName, enabled) : undefined,
      }
    }),
    ...guided.map((integration) => {
      const serverName = integration.serverName
      const status = getCatalogGuidedConnectionStatus(integration, activeSkillSlugs, installedMcpNames, enabledMcpNames, verifiedMcpNames)
      const skillAvailable = status === 'skill-available'
      const connected = status === 'connected'
      return {
        integration,
        status: skillAvailable ? 'Skill 已安装' : connected ? '已连接' : status === 'pending' ? (integration.authType === 'local-setup' ? '待配置' : '待授权') : '未配置',
        statusTone: skillAvailable || connected ? 'success' as const : 'muted' as const,
        statusRank: skillAvailable || connected
          ? getCatalogMcpStatusRank('connected')
          : getCatalogMcpStatusRank(status === 'pending' ? 'pending' : 'unconfigured'),
        actionLabel: skillAvailable ? `查看/使用 ${integration.name}` : connected ? `查看 ${integration.name}` : status === 'pending' ? `继续配置 ${integration.name}` : `开始配置 ${integration.name}`,
        commandLine: false as const,
        enabled: Boolean(serverName && enabledMcpNames.has(serverName)),
        onAction: () => onGuide(integration),
        // 引导写入关闭状态的配置后，目录仍须提供真实验证入口；Skill 本身不生成 MCP 开关。
        onToggle: serverName && installedMcpNames.has(serverName) ? (enabled: boolean) => onToggleMcp(serverName, enabled) : undefined,
      }
    }),
    ...credentials.map((integration) => {
      const status = getCatalogMcpConnectionStatus(integration.serverName, installedMcpNames, enabledMcpNames, verifiedMcpNames)
      return {
        integration,
        status: status === 'connected' ? '已连接' : status === 'pending' ? '待授权' : '未配置',
        statusTone: status === 'connected' ? 'success' as const : 'muted' as const,
        statusRank: getCatalogMcpStatusRank(status),
        actionLabel: `配置 ${integration.name}`,
        primaryActionLabel: '配置',
        commandLine: false as const,
        enabled: enabledMcpNames.has(integration.serverName),
        onAction: () => onRequestCredential(integration),
        onToggle: status !== 'unconfigured' ? (enabled: boolean) => onToggleMcp(integration.serverName, enabled) : undefined,
      }
    }),
    ...clis.map((integration) => {
      const status = getCatalogCliConnectionStatus(integration.id, connectedCliIds, cliIntegrationProbeState)
      const connected = status === 'connected'
      return {
        integration,
        status: status === 'connected' ? '已连接' : status === 'checking' ? '检测中' : status === 'unavailable' ? '暂无法检测' : '未配置',
        statusTone: connected ? 'success' as const : 'muted' as const,
        statusRank: getCatalogCliStatusRank(status),
        actionLabel: connected ? `查看 ${integration.name} 配置` : `配置 ${integration.name}`,
        commandLine: true as const,
        onAction: () => onGuideCli(integration),
        onDisconnect: connected ? () => onDisconnectCli(integration) : undefined,
      }
    }),
  ].sort((left, right) => compareCatalogConnectionCards(
    { placement: left.integration.placement, featured: left.integration.featured, priority: left.integration.priority, statusRank: left.statusRank },
    { placement: right.integration.placement, featured: right.integration.featured, priority: right.integration.priority, statusRank: right.statusRank },
  ))

  if (cards.length === 0) return <></>

  return (
    <section className="flex flex-col gap-4">
      {embedded && <style>{embeddedCatalogContainerQuery}</style>}
      <div className="px-1">
        <div className="flex items-center gap-2.5">
          <h2 className="text-[15px] font-semibold text-foreground">连接</h2>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium tabular-nums text-foreground/45">{cards.length}</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">选择服务后按提示完成授权、安装或配置。</p>
      </div>
      <div className={cn('grid grid-cols-1 gap-4', embedded ? 'integration-catalog-grid' : 'md:grid-cols-2')}>
        {cards.map((card) => (
          <IntegrationCard
            key={card.integration.id}
            name={card.integration.name}
            description={card.integration.description}
            capabilities={card.integration.capabilities}
            iconSlug={card.integration.iconSlug}
            status={card.integration.unavailableReason ? '待上游支持' : card.status}
            statusTone={card.integration.unavailableReason ? 'muted' : card.statusTone}
            experimental={card.integration.experimental}
            unavailableReason={card.integration.unavailableReason}
            actionLabel={card.actionLabel}
            primaryActionLabel={'primaryActionLabel' in card ? card.primaryActionLabel : undefined}
            installing={'serverName' in card.integration && installingMcpId === card.integration.id}
            commandLine={card.commandLine}
            onAction={card.onAction}
            onToggle={card.integration.unavailableReason ? undefined : card.onToggle}
            enabled={card.enabled}
            onDisconnect={card.integration.unavailableReason ? undefined : card.onDisconnect}
            onOpenDevice={card.integration.id === 'mobile-mcp' && card.status === '已连接' && !card.integration.unavailableReason ? onOpenMobileMirror : undefined}
          />
        ))}
      </div>
    </section>
  )
}

interface IntegrationCardProps {
  name: string
  description: string
  capabilities: string[]
  iconSlug: string
  status: string
  statusTone: 'success' | 'muted'
  actionLabel: string
  primaryActionLabel?: string
  installing: boolean
  commandLine: boolean
  onAction: () => void
  enabled?: boolean
  onToggle?: (enabled: boolean) => void
  onDisconnect?: () => void
  /** 在名称旁提示实验状态，不影响正常服务的连接流程。 */
  experimental?: boolean
  /** 完整展示不可连接原因，同时禁用主操作。 */
  unavailableReason?: string
  /** 用户主动打开镜像，不改变 MCP 的启用状态。 */
  onOpenDevice?: () => void
}

function IntegrationCard({ name, description, capabilities, iconSlug, status, statusTone, actionLabel, primaryActionLabel, installing, commandLine, onAction, enabled, onToggle, onDisconnect, experimental, unavailableReason, onOpenDevice }: IntegrationCardProps): React.ReactElement {
  const [iconFailed, setIconFailed] = React.useState(false)
  const actionText = unavailableReason ? '暂不可用' : primaryActionLabel ?? (status === '待授权' || status === '待验证' || status === '待配置'
    ? '继续配置'
    : status === '未配置'
      ? (commandLine ? '配置' : '连接')
      : status === '检测中'
        ? '检测中'
        : status === '暂无法检测'
          ? '重试'
          : status === 'Skill 已安装'
            ? '使用'
            : '查看')
  const DomainIcon = {
    'lucide-orbit': Orbit,
    'lucide-plane': Plane,
    'lucide-chart-candlestick': ChartCandlestick,
    'lucide-trending-up': TrendingUp,
    'lucide-cloud': Cloud,
    'lucide-file-text': FileText,
    'lucide-mail': Mail,
    'lucide-search': Search,
    'lucide-smartphone': Smartphone,
    'lucide-book-open': BookOpen,
    'lucide-chrome': Chrome,
  }[iconSlug]

  const localIcon = {
    'asset:brave': braveIcon,
    'asset:tavily': tavilyIcon,
    'asset:exa': exaIcon,
    'asset:tongdaxin': tongdaxinIcon,
    'asset:baidu-netdisk': baiduNetdiskIcon,
    'asset:tencent-docs': tencentDocsIcon,
    'asset:wecom': wecomIcon,
    'asset:feishu': feishuIcon,
    'asset:qichacha': qichachaIcon,
    'asset:dingtalk': dingtalkIcon,
    'asset:ctrip': ctripIcon,
    'asset:xiaohongshu': xiaohongshuIcon,
    'asset:context7': context7Icon,
    'asset:playwright': playwrightIcon,
    'asset:figma': figmaIcon,
    'asset:apify': apifyIcon,
    'asset:n8n': n8nIcon,
    'asset:concat': concatIcon,
    'asset:codebase-memory': codebaseMemoryIcon,
  }[iconSlug]
  const imageIconSizeClass = iconSlug === 'asset:feishu' ? 'size-[34px]' : 'size-7'

  return (
    <article className={cn(
      'group relative flex min-h-[144px] flex-col gap-2 rounded-lg bg-card p-3 text-left shadow-md',
    )}>
      <div className="flex items-start gap-2">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          {localIcon
            ? <img className={cn(imageIconSizeClass, 'object-contain')} src={localIcon} alt="" />
            : DomainIcon
              ? <DomainIcon size={28} strokeWidth={1.8} />
              : iconFailed
                ? commandLine
                  ? <Terminal size={28} className="text-muted-foreground" />
                  : <CircleDashed size={28} className="text-muted-foreground" />
                : <img className="size-7 object-contain" src={`https://cdn.simpleicons.org/${iconSlug}`} alt="" onError={() => setIconFailed(true)} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="truncate text-[15px] font-semibold text-foreground [text-wrap:balance]">{name}</h3>
            {experimental && <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">实验性</span>}
          </div>
          <p className="mt-0.5 line-clamp-2 text-[12px] leading-4 text-muted-foreground">{description}</p>
        </div>
      </div>

      {unavailableReason && <p className="text-[12px] leading-4 text-muted-foreground">{unavailableReason}</p>}

      <div className="mt-1 flex flex-wrap gap-1">
        {capabilities.map((capability) => (
          <span key={capability} className="rounded-md bg-foreground/[0.045] px-1.5 py-0.5 text-[11px] text-foreground/60">{capability}</span>
        ))}
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1.5">
        <span className={cn('inline-flex items-center gap-1 text-[11px] font-medium', statusTone === 'success' ? 'text-primary' : 'text-muted-foreground')}>
          {statusTone === 'success' ? <Check size={12} strokeWidth={2.5} /> : <CircleDashed size={12} />}
          <span className="truncate">{status}</span>
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {onOpenDevice && (
            <button type="button" onClick={onOpenDevice} disabled={installing} aria-label="打开 Mobile MCP 设备面板" className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[11px] font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60">
              <Smartphone size={12} />打开设备
            </button>
          )}
          {onToggle && enabled !== undefined && (
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">启用</span>
              <Switch
                checked={enabled}
                disabled={installing}
                onCheckedChange={onToggle}
                aria-label={`启用 ${name}`}
                className="scale-90"
              />
            </div>
          )}
          {statusTone === 'success' && onDisconnect && (
            <button
              type="button"
              title={`断开连接 ${name}`}
              aria-label={`断开连接 ${name}`}
              disabled={installing}
              onClick={onDisconnect}
              className="pointer-events-none flex shrink-0 items-center gap-1.5 p-0 text-[12px] font-medium text-destructive opacity-0 transition-[color,opacity,background-color] hover:text-destructive/80 focus-visible:pointer-events-auto focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 disabled:cursor-wait disabled:opacity-60"
            >
              <Unplug size={14} />
              <span>断开连接</span>
            </button>
          )}
          {(!onDisconnect || statusTone !== 'success') && (
            <button type="button" title={unavailableReason ?? actionLabel} aria-label={unavailableReason ? `${name} 暂不可用` : actionLabel} disabled={installing || Boolean(unavailableReason)} onClick={onAction} className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-primary px-2 text-[11px] font-medium text-primary-foreground shadow-sm transition-[transform,background-color,box-shadow] hover:bg-primary/90 hover:shadow active:scale-[0.96] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60">
              {installing ? <CircleDashed size={14} className="animate-spin" /> : <span>{actionText}</span>}
            </button>
          )}
        </div>
      </div>
    </article>
  )
}
