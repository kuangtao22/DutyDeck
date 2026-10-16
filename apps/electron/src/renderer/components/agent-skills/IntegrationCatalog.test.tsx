import { expect, mock, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MCP_INTEGRATION_CATALOG, isCatalogIntegrationVisible, matchesCatalogSearch, type CatalogIntegration } from './integration-catalog'

// Bun 单测只验证卡片语义，品牌图片的加载与显示由 renderer 构建验证。
for (const filename of readdirSync(new URL('../../assets/integrations/', import.meta.url))) {
  if (/\.(png|svg)$/.test(filename)) mock.module(`@/assets/integrations/${filename}`, () => ({ default: 'brand-icon.png' }))
}
mock.module('@/assets/bots/feishu.png', () => ({ default: 'feishu-icon.png' }))
/** 先注册静态资源替身，再加载真实卡片组件。 */
const { IntegrationCatalog } = await import('./IntegrationCatalog')

/** 用三个独立连接事实渲染单张卡片；回调仅记录行为，不访问宿主 IPC。 */
function renderCatalog(integration: CatalogIntegration, configured = false, enabled = false, verified = false): string {
  /** 目录项可能尚无可连接的服务名，不能为它伪造工作区状态。 */
  const serverName = 'serverName' in integration ? integration.serverName : undefined
  return renderToStaticMarkup(<IntegrationCatalog
    mcps={integration.kind === 'mcp' ? [integration] : []}
    guided={integration.kind === 'guided' ? [integration] : []}
    credentials={integration.kind === 'credential' ? [integration] : []}
    clis={[]} embedded
    installedMcpNames={new Set(configured && serverName ? [serverName] : [])}
    enabledMcpNames={new Set(enabled && serverName ? [serverName] : [])}
    verifiedMcpNames={new Set(verified && serverName ? [serverName] : [])}
    activeSkillSlugs={new Set()} connectedCliIds={new Set()} cliIntegrationProbeState="ready" installingMcpId={null}
    onInstallMcp={() => {}} onGuideCli={() => {}} onDisconnectCli={() => {}}
    onGuide={() => {}} onRequestCredential={() => {}} onToggleMcp={() => {}}
    onOpenMobileMirror={() => {}}
  />)
}

test('Given 上游尚未发布 MCP When 即使存在旧连接记录 Then 显示原因并禁用连接与开关', () => {
  /** 保留旧成功记录的夹具，验证产品可用性不能被历史连接状态覆盖。 */
  const unavailable: CatalogIntegration = {
    id: 'unreleased', name: '未发布服务', kind: 'mcp', authentication: 'none', serverName: 'unreleased',
    description: '本地应用', capabilities: [], iconSlug: 'lucide-cloud', setupUrl: 'https://example.com/docs',
    entry: { type: 'http', url: 'http://127.0.0.1:9000/mcp', enabled: false },
    experimental: true, unavailableReason: '官方尚未提供 MCP 接口，不能把 JSON-RPC 当作 MCP。',
  }
  /** 渲染结果包含真实 button/switch 的可访问性属性。 */
  const html = renderCatalog(unavailable, true, true, true)
  expect(html).toContain('实验性')
  expect(html).toContain('待上游支持')
  expect(html).toContain('官方尚未提供 MCP 接口')
  expect(html).toContain('disabled=""')
  expect(html).not.toContain('已连接')
  expect(html).not.toContain('role="switch"')
})

test('Given Mobile MCP When 已启用且验证通过 Then 显示打开设备入口且保留配置入口', () => {
  /** 使用真实目录条目，防止其它 MCP 误获设备控制入口。 */
  const mobile = MCP_INTEGRATION_CATALOG.find(item => item.id === 'mobile-mcp')!
  expect(renderCatalog(mobile, true, true, true)).toContain('打开设备')
  expect(renderCatalog(mobile, true, true, true)).toContain('查看 Mobile MCP')
  expect(renderCatalog(mobile, true, false, true)).not.toContain('打开设备')
  expect(renderCatalog(mobile, true, true, false)).not.toContain('打开设备')
  expect(renderCatalog(mobile)).not.toContain('打开设备')
})

test('Given 需要本地项目配置的 MCP When 尚未验证 Then 提示待配置而非账号授权', () => {
  /** 本地工具需要路径准备，无 OAuth 账号授权。 */
  const local: CatalogIntegration = {
    id: 'local', name: '本地索引', kind: 'guided', authType: 'local-setup', serverName: 'local',
    description: '准备项目路径', capabilities: [], iconSlug: 'lucide-cloud', setupUrl: 'https://example.com/docs', agentPrompt: '配置路径并验证',
  }
  expect(renderCatalog(local, true)).toContain('待配置')
  expect(renderCatalog(local, true)).not.toContain('待授权')
  expect(renderCatalog(local, true)).toContain('role="switch"')
  expect(renderCatalog(local)).not.toContain('role="switch"')
  expect(renderCatalog(local, true, true, true)).toContain('已连接')
})

test('Given 普通免认证 MCP When 仅添加或启用但未验证 Then 保持待验证直到真实验证通过', () => {
  /** 免认证不等于已连接，必须同时满足配置、启用与验证。 */
  const remote: CatalogIntegration = {
    id: 'remote', name: '文档服务', kind: 'mcp', authentication: 'none', serverName: 'remote',
    description: '查询文档', capabilities: [], iconSlug: 'lucide-cloud', setupUrl: 'https://example.com/docs',
    entry: { type: 'http', url: 'https://example.com/mcp', enabled: false },
  }
  expect(renderCatalog(remote)).toContain('未配置')
  expect(renderCatalog(remote, true)).toContain('待验证')
  expect(renderCatalog(remote, true, true)).not.toContain('已连接')
  expect(renderCatalog(remote, true, true, true)).toContain('已连接')
})

test('Given 新增的九项集成 When 用户搜索目录 Then 均可见且首次展示不会误报已连接', () => {
  /** 覆盖用户要求的实际服务入口，防止加入目录后被隐藏名单或搜索规则漏掉。 */
  const serviceNames = ['Context7', 'Chrome DevTools', 'Playwright', 'Figma', 'DeepWiki', 'Apify', 'n8n MCP', 'codebase-memory', 'Concat']
  for (const name of serviceNames) {
    /** 搜索与正式页面使用同一过滤函数，不依赖底层数组顺序。 */
    const integration = MCP_INTEGRATION_CATALOG.filter(isCatalogIntegrationVisible).find(item => item.name === name && matchesCatalogSearch(item, name))
    expect(integration).toBeDefined()
    if (!integration) throw new Error(`缺少可见目录项：${name}`)
    expect(renderCatalog(integration)).not.toContain('已连接')
    if ('entry' in integration) expect(integration.entry.enabled).toBe(false)
  }
})

test('Given Apify 与本地配置项 When 展示待完成连接 Then 凭据服务待授权而本地服务待配置', () => {
  /** 使用真实目录数据，验证接入类型没有误入免认证直连流程。 */
  const apify = MCP_INTEGRATION_CATALOG.find(item => item.id === 'apify-mcp')
  /** 设计服务和代码索引都必须先在用户本机完成前置配置。 */
  const guidedServices = MCP_INTEGRATION_CATALOG.filter(item => ['figma-mcp', 'codebase-memory-mcp'].includes(item.id))
  expect(apify?.kind).toBe('credential')
  if (!apify) throw new Error('缺少 Apify 目录项')
  expect(renderCatalog(apify, true)).toContain('待授权')
  expect(guidedServices).toHaveLength(2)
  for (const integration of guidedServices) {
    expect(integration.kind).toBe('guided')
    expect(renderCatalog(integration, true)).toContain('待配置')
    expect(renderCatalog(integration, true)).toContain('role="switch"')
  }
})
