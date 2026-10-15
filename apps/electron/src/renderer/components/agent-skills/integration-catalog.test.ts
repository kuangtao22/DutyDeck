import { expect, test } from 'bun:test'
import { MCP_INTEGRATION_CATALOG, compareCatalogConnectionCards, isCatalogIntegrationVisible, type CatalogCredentialIntegration } from './integration-catalog'

function credentialIntegration(id: string): CatalogCredentialIntegration {
  const integration = MCP_INTEGRATION_CATALOG.find((item) => item.id === id)
  if (!integration || integration.kind !== 'credential') throw new Error(`missing credential integration: ${id}`)
  return integration
}

test('Given the MCP connection catalog When listing search providers Then Brave and Tavily require only their API key with official console links', () => {
  const brave = credentialIntegration('brave-search-mcp')
  const tavily = credentialIntegration('tavily-search-mcp')

  expect(brave.entry).toEqual({
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@brave/brave-search-mcp-server', '--transport', 'stdio'],
    enabled: false,
  })
  expect(brave.credential).toMatchObject({
    envName: 'BRAVE_API_KEY',
    credentialStorageUrl: 'https://api.search.brave.com/',
    acquisitionUrl: 'https://api-dashboard.search.brave.com/app/keys',
  })

  expect(tavily.entry).toEqual({ type: 'http', url: 'https://mcp.tavily.com/mcp', enabled: false })
  expect(tavily.credential).toMatchObject({
    headerName: 'Authorization',
    valuePrefix: 'Bearer ',
    credentialStorageUrl: 'https://mcp.tavily.com/mcp',
    acquisitionUrl: 'https://app.tavily.com/home',
  })
})

test('搜索服务目录顺序固定为飞书、钉钉、企业微信、Tavily、Brave，再到其他集成', () => {
  const expected = ['feishu-cli', 'dingtalk-cli', 'wecom-cli', 'tavily-search-mcp', 'brave-search-mcp']
  const actual = [...MCP_INTEGRATION_CATALOG]
    .sort((left, right) => compareCatalogConnectionCards(
      { priority: left.priority, placement: left.placement, featured: left.featured, statusRank: 1 },
      { priority: right.priority, placement: right.placement, featured: right.featured, statusRank: 1 },
    ))
    .map((integration) => integration.id)

  expect(actual.slice(0, expected.length)).toEqual(expected)
})

test('Given GitHub MCP When 展示 OAuth 目录 Then 只包含公开元数据且要求安全输入 Client Secret', () => {
  const github = MCP_INTEGRATION_CATALOG.find((integration) => integration.id === 'github-mcp')

  expect(github && isCatalogIntegrationVisible(github)).toBe(true)
  expect(github?.kind).toBe('mcp')
  if (!github || github.kind !== 'mcp') throw new Error('missing GitHub MCP integration')
  expect(github.entry.oauth).toMatchObject({
    provider: 'github',
    authorizationEndpoint: 'https://github.com/login/oauth/authorize',
    tokenEndpoint: 'https://github.com/login/oauth/access_token',
    clientSecretRequired: true,
  })
  expect(JSON.stringify(github.entry.oauth)).not.toContain('clientSecret"')
})

test('Given 小红书 MCP 目录项 When 上游 transport 和登录契约仍需核验 Then 使用引导模式且不猜测连接参数', () => {
  const xiaohongshu = MCP_INTEGRATION_CATALOG.find((integration) => integration.id === 'xiaohongshu-mcp')

  expect(xiaohongshu && isCatalogIntegrationVisible(xiaohongshu)).toBe(true)
  expect(xiaohongshu?.kind).toBe('guided')
  if (!xiaohongshu || xiaohongshu.kind !== 'guided') throw new Error('missing Xiaohongshu MCP integration')
  expect(xiaohongshu.serverName).toBeUndefined()
  expect(xiaohongshu.setupUrl).toBe('https://github.com/xpzouying/xiaohongshu-mcp')
  expect(xiaohongshu.agentPrompt).toContain('不要把 GitHub 仓库地址直接当作 MCP endpoint')
  expect(xiaohongshu.agentPrompt).toContain('真实 MCP handshake 和 listTools 验证')
  expect(xiaohongshu.agentPrompt).toContain('不要代替我输入密码、验证码或读取/导出 Cookie')
})
