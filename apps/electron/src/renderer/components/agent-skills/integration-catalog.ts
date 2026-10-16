import type { McpOAuthProvider, McpServerEntry } from '@proma/shared'

export type CatalogIntegrationKind = 'mcp' | 'cli' | 'guided' | 'credential'
export type CatalogAuthentication = 'none' | 'oauth' | 'api-key'

interface CatalogIntegrationBase {
  id: string
  name: string
  description: string
  capabilities: string[]
  iconSlug: string
  setupUrl: string
  kind: CatalogIntegrationKind
  /** Legacy presentation hint; explicit priority controls directory order. */
  featured?: boolean
  /** Fixed catalog order; connection state never affects placement. */
  priority?: number
  placement?: 'bottom'
  /** 标识仍需验证兼容性或使用边界的实验集成。 */
  experimental?: boolean
  /** 上游尚不可接入的原因；存在时目录卡片禁止连接和启用。 */
  unavailableReason?: string
}

export interface CatalogMcpIntegration extends CatalogIntegrationBase {
  kind: 'mcp'
  authentication: CatalogAuthentication
  oauthProvider?: McpOAuthProvider
  serverName: string
  entry: McpServerEntry
}

export interface CatalogCliIntegration extends CatalogIntegrationBase {
  kind: 'cli'
  agentPrompt: string
}

export interface CatalogGuidedIntegration extends CatalogIntegrationBase {
  kind: 'guided'
  authType: 'api-key' | 'provider-app' | 'provider-login' | 'local-setup'
  agentPrompt: string
  /** The MCP entry created by the guided flow, when it has a stable server name. */
  serverName?: string
  /** An active workspace Skill that provides this integration without a Proma MCP entry. */
  expectedSkillSlug?: string
}

/** A fixed-token remote MCP that Proma can configure after the user supplies one credential. */
export interface CatalogCredentialIntegration extends CatalogIntegrationBase {
  kind: 'credential'
  serverName: string
  entry: McpServerEntry
  credential: {
    label: string
    placeholder: string
    helpText: string
    acquisitionUrl: string
    acquisitionLabel: string
    headerName: string
    /** 需要附加到 API Key 前的认证前缀（例如 Bearer）。 */
    valuePrefix?: string
    /** stdio MCP 的 API Key 通过此环境变量注入，远程 MCP 留空。 */
    envName?: string
    /** 凭据安全存储绑定的稳定服务 URL；stdio MCP 不会写入 mcp.json。 */
    credentialStorageUrl: string
  }
}

export type CatalogIntegration = CatalogMcpIntegration | CatalogCliIntegration | CatalogGuidedIntegration | CatalogCredentialIntegration

export type CatalogMcpConnectionStatus = 'unconfigured' | 'pending' | 'connected'
export type CatalogGuidedConnectionStatus = CatalogMcpConnectionStatus | 'skill-available'
export type CatalogCliProbeState = 'loading' | 'ready' | 'failed'
export type CatalogCliConnectionStatus = 'checking' | 'unavailable' | 'unconfigured' | 'connected'

/** 目录卡片排序优先级：已连接 > 待授权 > 未配置。 */
export function getCatalogMcpStatusRank(status: CatalogMcpConnectionStatus): number {
  if (status === 'connected') return 3
  if (status === 'pending') return 2
  return 1
}

/** Directory order is stable: priority, featured placement, then explicit bottom placement. Connection state never moves a card. */
export function compareCatalogConnectionCards(
  left: { placement?: 'bottom'; featured?: boolean; priority?: number; statusRank: number },
  right: { placement?: 'bottom'; featured?: boolean; priority?: number; statusRank: number },
): number {
  const leftPriority = left.priority ?? Number.POSITIVE_INFINITY
  const rightPriority = right.priority ?? Number.POSITIVE_INFINITY
  if (leftPriority !== rightPriority) return leftPriority - rightPriority

  const leftBottom = Number(left.placement === 'bottom')
  const rightBottom = Number(right.placement === 'bottom')
  return leftBottom - rightBottom
}

export function getCatalogMcpConnectionStatus(
  serverName: string | undefined,
  installedMcpNames: Set<string>,
  enabledMcpNames: Set<string>,
  verifiedMcpNames: Set<string>,
): CatalogMcpConnectionStatus {
  if (!serverName || !installedMcpNames.has(serverName)) return 'unconfigured'
  if (!enabledMcpNames.has(serverName) || !verifiedMcpNames.has(serverName)) return 'pending'
  return 'connected'
}

/**
 * Guided integrations normally retain the strict MCP three-state contract.
 * A provider can opt into this separate state only when its official delivery
 * mechanism is an active workspace Skill rather than an MCP server.
 */
export function getCatalogGuidedConnectionStatus(
  integration: CatalogGuidedIntegration,
  activeSkillSlugs: Set<string>,
  installedMcpNames: Set<string>,
  enabledMcpNames: Set<string>,
  verifiedMcpNames: Set<string>,
): CatalogGuidedConnectionStatus {
  if (integration.expectedSkillSlug && activeSkillSlugs.has(integration.expectedSkillSlug)) return 'skill-available'
  return getCatalogMcpConnectionStatus(integration.serverName, installedMcpNames, enabledMcpNames, verifiedMcpNames)
}

export function getCatalogMcpConnectionState(
  serverName: string | undefined,
  installedMcpNames: Set<string>,
  enabledMcpNames: Set<string>,
): { configured: boolean; enabled: boolean } {
  const configured = Boolean(serverName && installedMcpNames.has(serverName))
  return { configured, enabled: Boolean(serverName && enabledMcpNames.has(serverName)) }
}

/** Never render an unprobed or failed local CLI check as an unconfigured integration. */
export function getCatalogCliConnectionStatus(
  id: string,
  connectedCliIds: Set<string>,
  probeState: CatalogCliProbeState,
): CatalogCliConnectionStatus {
  if (probeState === 'loading') return 'checking'
  if (probeState === 'failed') return 'unavailable'
  return connectedCliIds.has(id) ? 'connected' : 'unconfigured'
}

export function getCatalogCliStatusRank(status: CatalogCliConnectionStatus): number {
  if (status === 'connected') return 3
  if (status === 'checking') return 2
  if (status === 'unavailable') return 1
  return 0
}

const remoteMcp = (url: string): McpServerEntry => ({ type: 'http', url, enabled: false })
const stdioMcp = (command: string, args: string[]): McpServerEntry => ({ type: 'stdio', command, args, enabled: false })

const MCP_CONNECTION_ACCEPTANCE_INSTRUCTION = `
最终完成形态：只有当该 MCP 已写入当前 DutyDeck workspace 的 MCP 配置、处于启用状态，并完成真实 SDK handshake 与 listTools 验证成功后，才能显示为「已连接」或称可用；届时才可以通过 # 调用。仅在当前会话环境、OpenClaw/mcporter、临时 shell 中可用，或只安装了 Skill，都不等于 DutyDeck MCP 已连接，必须如实说明未完成的条件。`

const CLI_CONNECTION_ACCEPTANCE_INSTRUCTION = `
最终完成形态：只有当对应官方 CLI 已完成真实认证验证，且已在当前 DutyDeck workspace 的目录中被允许/启用后，才能显示为「已连接」。只在当前会话环境、OpenClaw/mcporter、临时 shell 中可用，或只安装了 Skill，都不等于 DutyDeck CLI 已连接；不要猜测或伪造 CLI 状态。`

const GUIDED_CONNECTION_ACCEPTANCE_INSTRUCTION = `
完成状态必须按实际接入类型如实报告：若最终接入 MCP，只有它已写入当前 DutyDeck workspace 的 MCP 配置、启用，并完成真实 SDK handshake 与 listTools 验证后，才能显示为「已连接」并可通过 # 调用；若最终接入 CLI，只有官方 CLI 已真实认证且已在当前 DutyDeck workspace 的目录中被允许/启用后，才能显示为「已连接」。仅在会话环境、OpenClaw/mcporter、临时 shell 中可用，或只安装了 Skill，都不等于 DutyDeck MCP/CLI 已连接。`

export const MCP_CREDENTIAL_SETUP_INSTRUCTION = `

如果配置需要 API Key、Access Token、授权码或其他必须由用户手动获取的内容：请使用 DutyDeck 内置浏览器打开对应的官方获取或授权页面，先让我自行完成登录、注册、申请权限或授权。不要代替我输入密码、验证码，也不要读取或导出 Cookie、浏览器登录态或其他凭据。页面成功显示需要配置的凭据后，请让我将该凭据直接发送到当前 Agent 对话；收到后仅将其用于本次配置，绝不在回复、日志、AGENTS.md、mcp.json 或其他普通项目文件中回显或保存，并优先使用 DutyDeck/系统提供的安全凭据存储。${MCP_CONNECTION_ACCEPTANCE_INSTRUCTION}`

const cliSetupPrompt = (name: string, setupUrl: string, settingsPath = `设置 → 远程连接 → 配置${name}`): string => `请帮我配置「${name}」。

请优先在当前 DutyDeck 的「${settingsPath}」中完成配置，不要只给我一个网页链接，也不要自动把我切到外部网页。

官方入口：${setupUrl}

执行要求：
1. 先核验官方安装命令、认证方式、权限范围与当前环境要求；不要使用第三方安装包或猜测命令。
2. 能通过终端或当前 DutyDeck 设置完成的步骤直接执行；需要用户登录、授权或确认时，在对应步骤停下来让我操作。
3. CLI 的 token、cookie、OAuth code 和其他敏感信息交给 CLI 自己的安全存储，不写入工作区 mcp.json、AGENTS.md、日志或普通项目文件。
4. 完成后使用官方 CLI 的 status/check 命令验证；不要把 CLI 伪装成 MCP 服务器。
5. 如果官方能力或权限不足，说明已核验事实和下一步，不要只返回链接。${CLI_CONNECTION_ACCEPTANCE_INSTRUCTION}`

const providerSetupPrompt = (name: string, setupUrl: string, authentication: string): string => `请帮我为当前 DutyDeck 工作区配置「${name}」。

官方入口：${setupUrl}
认证方式线索：${authentication}

执行要求：
1. 先通过公开官方文档核验 MCP server URL、transport、所需 scope/权限和认证字段；不要猜测或使用非官方 endpoint。
2. 若可得到可用 MCP 配置，将非敏感 transport 配置写入当前工作区的 mcp.json；不要覆盖已有同名服务器。
3. 不要把 API Key、AppSecret、Cookie、OAuth code 或 access token 写入 mcp.json、AGENTS.md、日志或普通项目文件。需要用户在 DutyDeck 设置中输入敏感值时，明确说明字段名与来源页面。
4. 若官方接入要求企业应用审核、管理员授权、桌面客户端登录或没有公开的 MCP 合约，停止在安全步骤处，说明已核验的事实、缺失条件和用户需要完成的操作。
5. 完成后测试 MCP 连接；仅在测试成功时启用。${MCP_CREDENTIAL_SETUP_INSTRUCTION}${GUIDED_CONNECTION_ACCEPTANCE_INSTRUCTION}`

export function buildCatalogMcpGuidePrompt(integration: CatalogMcpIntegration): string {
  const mcpUrl = integration.entry.type === 'http' || integration.entry.type === 'sse' ? integration.entry.url : '请根据官方文档核验'
  return `请帮我配置「${integration.name}」远程 MCP。

官方入口：${integration.setupUrl}
MCP URL：${mcpUrl}

执行要求：
1. 这是尚未实现 DutyDeck 内置 OAuth 的远程 MCP；不要打开手动 MCP 编辑抽屉，也不要只给我一个网页链接。
2. 先按官方文档核验认证、scope、权限和当前客户端兼容性。
3. 需要用户登录或授权时，使用 DutyDeck 内置浏览器打开官方页面，让用户自行完成登录、授权或获取凭据；不要代替用户输入密码、验证码，也不要读取或导出 Cookie、浏览器登录态或其他凭据。
4. 用户从官方页面取得 API Key、Access Token、授权码或其他必要配置值后，请让用户发送到当前 Agent 对话，再继续完成配置；只将其用于本次配置，优先写入 DutyDeck/系统安全凭据存储，不要在回复、日志、AGENTS.md、mcp.json 或其他普通项目文件中回显或保存。
5. 只有完成官方认证和实际连接验证后，才写入非敏感 transport 配置并启用。${MCP_CREDENTIAL_SETUP_INSTRUCTION}`
}

const tongdaxinVipPrompt = `请帮我配置和使用「通达信」。

第一步：使用 DutyDeck 内置浏览器打开 https://vip.tdx.com.cn/site/app/pc-mall/main.html#/page_product_mcp；不要打开手动 MCP 编辑弹窗，也不要切换到外部浏览器。

用户操作：请引导我在该网站完成注册或登录。登录完成后，基于页面和官方公开文档继续指导我找到可用的正式产品、授权入口或 MCP/Agent 接入方式。

执行要求：
1. 不要尝试读取、导出或要求我粘贴 Cookie、密码、验证码、token 或其他登录态。
2. 先核验是否存在通达信官方 MCP、CLI 或 API 契约，以及对应的权限、套餐和账户要求；不要猜测 endpoint 或安装命令。
3. 能在当前 DutyDeck 环境完成的非敏感步骤直接执行；需要我的确认、付费订阅、实名或额外授权时清楚说明并停下。
4. 不要把敏感信息写入 mcp.json、AGENTS.md、日志或普通项目文件。
5. 完成后说明已验证的接入状态、可使用能力与后续操作。${MCP_CREDENTIAL_SETUP_INSTRUCTION}${GUIDED_CONNECTION_ACCEPTANCE_INSTRUCTION}`

/** 小红书 MCP 的受控配置提示词：上游交付形态和登录方式需以当前仓库文档为准。 */
const xiaohongshuMcpPrompt = `请帮我配置和使用「xpzouying/xiaohongshu-mcp」。

官方仓库：https://github.com/xpzouying/xiaohongshu-mcp

执行要求：
1. 先读取官方仓库当前 README、Release 和许可证，核验本机可用的交付形态（Docker、本地二进制、stdio、HTTP 或 SSE）、启动命令、默认端口、系统要求和当前 MCP 配置示例；不要把 GitHub 仓库地址直接当作 MCP endpoint，也不要猜测命令、端口或 transport。
2. 如果需要安装 Docker、二进制、浏览器插件或其他运行环境，先说明安装内容、磁盘/网络开销和平台限制；能在当前 DutyDeck 环境安全完成的非敏感步骤再执行，需要用户登录、扫码、授权或确认时停下来让我操作。
3. 小红书登录、扫码和浏览器会话由我本人完成。不要代替我输入密码、验证码或读取/导出 Cookie、浏览器登录态、token；不要把这些内容写入 mcp.json、AGENTS.md、日志或普通项目文件。
4. 只把官方文档确认过的非敏感 transport 配置写入当前 DutyDeck workspace；若官方服务要求独立浏览器插件或外部桥接，明确说明它不等于 DutyDeck MCP 已连接。
5. 配置后必须在当前工作区执行真实 MCP handshake 和 listTools 验证；只有验证成功并由我明确启用后，才报告为「已连接」。发布、评论、点赞、收藏等外部写操作必须逐次获得我的明确确认，不得因为连接成功而自动执行。
6. 完成后报告实际启动方式、已验证的工具、登录/权限边界、失败原因和后续手动步骤；没有完成真实验证时，明确标记为未连接。${GUIDED_CONNECTION_ACCEPTANCE_INSTRUCTION}`

/** Figma 优先引导官方桌面服务；远程 OAuth 的动态密钥注册目前不兼容客户端。 */
const figmaMcpPrompt = `请帮我在当前 DutyDeck 工作区配置 Figma 官方 MCP。
官方说明：https://developers.figma.com/docs/figma-mcp-server/
1. 优先核验官方桌面 MCP 接入条件：需 Dev / Full 席位及 Professional、Education、Organization、Government 或 Enterprise 套餐。由用户登录更新后的桌面版、打开 Design 文件，取消选中内容后切到 Dev Mode（Shift+D），在右侧 MCP server 区域启用桌面 MCP；不读取 Cookie。桌面版不支持写回 Canvas。
2. 按官方指引启用桌面 MCP，核实本机 http://127.0.0.1:3845/mcp。确认服务运行后，以 figma 为 server name 添加 type=http 的关闭状态配置；保留已有同名配置，不覆盖用户地址。
3. 官方远程地址为 https://mcp.figma.com/mcp，但当前 DutyDeck 的动态注册仅支持无 client secret 的公共客户端，与 Figma 的注册/换 token 契约不兼容。不要用个人 API Token 伪造 OAuth，也不要编造 clientId；桌面服务不满足条件时说明阻塞项。
4. 配置成功后通过 DutyDeck 的启用开关执行真实 handshake 与 listTools 验证；不要因桌面端已登录就宣称 MCP 已连接。${MCP_CONNECTION_ACCEPTANCE_INSTRUCTION}`

/** 原生代码索引依赖显式项目边界和共享 daemon 检查，不能提供全盘默认模板。 */
const codebaseMemoryMcpPrompt = `请帮我配置 codebase-memory-mcp（实验性）。
官方仓库：https://github.com/DeusData/codebase-memory-mcp
1. 先核实 Node.js 18+、平台支持和当前工作区已授权的项目绝对路径。使用 npx -y codebase-memory-mcp@0.12.0，以 stdio 运行；首次安装会下载并校验约 50 MB 的平台原生程序。
2. 必须把 CBM_ALLOWED_ROOT 限定到该已授权项目的绝对路径，不能默认为整个用户目录、根目录或使用字面量 ~。没有明确项目路径时先让用户选择，不创建无边界配置。
3. 先检查同账号是否已有其他 IDE 的共享 daemon 及其版本、构建、ABI 和缓存根。CBM_CACHE_DIR 必须是绝对路径并与现有 daemon 一致；单独指定缓存目录不构成 daemon 隔离，不要自动停止、替换或升级其他 IDE 的服务。
4. 索引存放在外部工具自己的 SQLite 缓存中，不是 DutyDeck 业务数据库。共享 daemon 可能访问既有索引，不承诺跨工作区读取隔离；若用户需要严格隔离，说明当前限制，不启用。
5. 条件满足后，以 codebase-memory 为 server name 向当前工作区添加默认关闭的配置，保留已有条目。不要执行 install/update/uninstall 子命令，它们可能修改其他 IDE 配置；不要自动扫描整个磁盘或开始索引。
6. 由用户开启后执行真实 handshake 与 listTools 验证。仅在用户明确要求索引时，对授权项目调用工具。${MCP_CONNECTION_ACCEPTANCE_INSTRUCTION}`

/** 固定显式工具范围并关闭遥测，凭据与请求必须绑定同一完整 URL。 */
const APIFY_MCP_URL = 'https://mcp.apify.com?tools=actors,docs,apify/rag-web-browser&telemetry-enabled=false'

// These providers have directory definitions but are intentionally withheld from
// the public MCP picker until their end-to-end connection flows are verified.
// Keep the definitions intact so re-enabling is an explicit, low-risk catalog change.
const HIDDEN_UNTIL_TESTED_INTEGRATION_IDS = new Set([
  'tongdaxin-mcp',
  'google-calendar-mcp',
  'vercel-mcp',
  'github-cli',
  'stripe-mcp',
])

export function isCatalogIntegrationVisible(integration: CatalogIntegration): boolean {
  return !HIDDEN_UNTIL_TESTED_INTEGRATION_IDS.has(integration.id)
}

export const MCP_INTEGRATION_CATALOG: CatalogIntegration[] = [
  {
    id: 'github-mcp', name: 'GitHub', iconSlug: 'github', kind: 'mcp', authentication: 'oauth', oauthProvider: 'github', serverName: 'github',
    description: '让 Agent 在你的 GitHub 上读取代码上下文，并处理协作与代码质量工作流。',
    capabilities: ['仓库与文件', 'Issue / PR', 'Actions 与安全扫描'],
    setupUrl: 'https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/set-up-the-github-mcp-server',
    entry: {
      ...remoteMcp('https://api.githubcopilot.com/mcp/'),
      oauth: {
        provider: 'github',
        authorizationEndpoint: 'https://github.com/login/oauth/authorize',
        tokenEndpoint: 'https://github.com/login/oauth/access_token',
        clientSecretRequired: true,
        scopes: ['repo', 'read:org', 'read:user', 'user:email', 'read:packages', 'write:packages', 'read:project', 'project', 'gist', 'notifications'],
      },
    },
  },
  {
    id: 'notion-mcp', name: 'Notion', iconSlug: 'notion', kind: 'mcp', authentication: 'oauth', oauthProvider: 'notion', serverName: 'notion',
    description: '把页面、数据库和团队知识直接提供给 Agent，用于查询、整理和写回协作文档。',
    capabilities: ['页面与区块', '数据库查询', '评论与内容编辑'],
    setupUrl: 'https://developers.notion.com/guides/mcp/get-started-with-mcp',
    entry: remoteMcp('https://mcp.notion.com/mcp'),
  },
  {
    id: 'google-calendar-mcp', name: 'Google 日历', iconSlug: 'googlecalendar', kind: 'mcp', authentication: 'oauth', serverName: 'google-calendar',
    description: '让 Agent 查询、创建和管理 Google Calendar 日程，并协助安排会议与响应邀请。',
    capabilities: ['日历与事件查询', '创建与更新日程', '会议邀请与时间建议'],
    setupUrl: 'https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server',
    entry: remoteMcp('https://calendarmcp.googleapis.com/mcp/v1'),
  },
  {
    id: 'linear-mcp', name: 'Linear', iconSlug: 'linear', kind: 'mcp', authentication: 'oauth', serverName: 'linear',
    description: '让 Agent 查询和更新 Linear issue、项目、团队与评论，协助推进产品开发工作流。',
    capabilities: ['Issue 与评论', '项目与团队管理', '状态、优先级与负责人'],
    setupUrl: 'https://linear.app/docs/mcp',
    entry: remoteMcp('https://mcp.linear.app/mcp'),
  },
  {
    id: 'vercel-mcp', name: 'Vercel', iconSlug: 'vercel', kind: 'mcp', authentication: 'oauth', serverName: 'vercel', placement: 'bottom',
    description: '为 Agent 提供部署上下文，定位生产问题并查询项目与运行状态。',
    capabilities: ['项目与部署', '日志与运行状态', 'Web Analytics'],
    setupUrl: 'https://vercel.com/docs/agent-resources/vercel-mcp',
    entry: remoteMcp('https://mcp.vercel.com'),
  },
  {
    id: 'supabase-mcp', name: 'Supabase', iconSlug: 'supabase', kind: 'mcp', authentication: 'oauth', serverName: 'supabase', placement: 'bottom',
    description: '让 Agent 查询并管理 Supabase 项目，覆盖数据库、认证、Storage 和 Edge Functions。',
    capabilities: ['SQL 与数据库 schema', 'Auth 与 Storage', '项目与 Edge Functions'],
    setupUrl: 'https://supabase.com/docs/guides/ai-tools/mcp',
    entry: remoteMcp('https://mcp.supabase.com/mcp'),
  },
  {
    id: 'stripe-mcp', name: 'Stripe', iconSlug: 'stripe', kind: 'mcp', authentication: 'oauth', serverName: 'stripe', placement: 'bottom',
    description: '让 Agent 搜索 Stripe 文档并在授权范围内读取或操作支付与账务资源。',
    capabilities: ['API 文档检索', '账户与资源查询', '退款与支付操作'],
    setupUrl: 'https://docs.stripe.com/mcp',
    entry: remoteMcp('https://mcp.stripe.com'),
  },
  {
    id: 'tongdaxin-mcp', name: '通达信 MCP', iconSlug: 'asset:tongdaxin', kind: 'guided', authType: 'provider-login',
    description: '金融行情和投研能力需要先核验通达信的正式 MCP 契约与账户授权方式。',
    capabilities: ['行情与金融数据', '账户授权核验', '官方契约调研'],
    setupUrl: 'https://vip.tdx.com.cn/site/app/pc-mall/main.html#/page_product_mcp',
    agentPrompt: tongdaxinVipPrompt,
  },
  {
    id: 'xiaohongshu-mcp', name: '小红书 MCP', iconSlug: 'asset:xiaohongshu', kind: 'guided', authType: 'provider-login', priority: 12,
    description: '通过官方仓库自托管的小红书 MCP 读取和管理内容；登录、运行环境与发布权限由用户控制。',
    capabilities: ['笔记搜索与详情', '内容发布与互动', '本地服务与账号授权'],
    setupUrl: 'https://github.com/xpzouying/xiaohongshu-mcp',
    agentPrompt: xiaohongshuMcpPrompt,
  },
  {
    id: 'mobile-mcp', name: 'Mobile MCP · 手机控制', iconSlug: 'lucide-smartphone', kind: 'mcp', authentication: 'none', serverName: 'mobile-mcp', priority: 13,
    description: '通过 mobile-next/mobile-mcp 操作 Android / iOS 真机与模拟器。需 Node.js 20+；Android 需 SDK/adb，iOS 模拟器需 macOS/Xcode。连接后仍需准备并授权设备。',
    capabilities: ['设备与应用管理', '截图与界面元素', '点击、滑动与输入'],
    setupUrl: 'https://github.com/mobile-next/mobile-mcp',
    entry: {
      // 固定已核验的官方发行版；添加目录配置不启动服务，用户启用时才下载并验证。
      ...stdioMcp('npx', ['-y', '@mobilenext/mobile-mcp@1.0.11']),
      // 首次运行可能下载平台二进制，给现有握手流程保留冷启动时间。
      timeout: 120,
      // 本地设备控制默认不向上游发送匿名遥测。
      env: { MOBILEMCP_DISABLE_TELEMETRY: '1' },
    },
  },
  {
    id: 'context7-mcp', name: 'Context7', iconSlug: 'asset:context7', kind: 'mcp', authentication: 'none', serverName: 'context7', priority: 14,
    description: '查询最新库文档与代码示例，减少过时 API 用法。远程免密接入，免费额度受上游限制。',
    capabilities: ['库文档查询', '版本相关示例', '代码上下文'],
    setupUrl: 'https://context7.com/docs/resources/all-clients',
    entry: remoteMcp('https://mcp.context7.com/mcp'),
  },
  {
    id: 'chrome-devtools-mcp', name: 'Chrome DevTools', iconSlug: 'lucide-chrome', kind: 'mcp', authentication: 'none', serverName: 'chrome-devtools', priority: 15,
    description: '调试 Chrome 页面、网络和性能。需 Chrome 与 Node.js 20.19+（22 分支需 22.12+）；使用临时浏览器资料，关闭使用统计与 CrUX 查询。',
    capabilities: ['页面与网络调试', '性能分析', '浏览器交互'],
    setupUrl: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
    entry: {
      ...stdioMcp('npx', ['-y', 'chrome-devtools-mcp@1.11.0', '--isolated', '--no-usage-statistics', '--no-performance-crux']),
      // 首次启用可能下载 npm 包，沿用现有冷启动超时。
      timeout: 120,
    },
  },
  {
    id: 'playwright-mcp', name: 'Playwright', iconSlug: 'asset:playwright', kind: 'mcp', authentication: 'none', serverName: 'playwright', priority: 16,
    description: '通过页面结构操作浏览器并验证网页流程。需 Node.js 18+ 和可用浏览器；使用独立临时会话，不复用日常浏览器登录态。',
    capabilities: ['页面导航与交互', '截图与网页验证', '浏览器自动化'],
    setupUrl: 'https://github.com/microsoft/playwright-mcp',
    entry: { ...stdioMcp('npx', ['-y', '@playwright/mcp@0.0.83', '--isolated']), timeout: 120 },
  },
  {
    id: 'figma-mcp', name: 'Figma', iconSlug: 'asset:figma', kind: 'guided', authType: 'local-setup', serverName: 'figma', priority: 17,
    description: '连接 Figma 官方桌面 MCP，读取设计上下文、变量与截图。需桌面版登录并启用 MCP，受席位权限限制；远程 OAuth 暂需客户端适配。',
    capabilities: ['设计上下文', '变量与组件', '设计截图'],
    setupUrl: 'https://developers.figma.com/docs/figma-mcp-server/',
    agentPrompt: figmaMcpPrompt,
  },
  {
    id: 'deepwiki-mcp', name: 'DeepWiki', iconSlug: 'lucide-book-open', kind: 'mcp', authentication: 'none', serverName: 'deepwiki', priority: 18,
    description: '免费查询公开 GitHub 仓库的文档与代码架构，支持围绕仓库提问。不提供私有仓库访问。',
    capabilities: ['公开仓库文档', '代码架构理解', '仓库问答'],
    setupUrl: 'https://docs.devin.ai/work-with-devin/deepwiki-mcp',
    entry: remoteMcp('https://mcp.deepwiki.com/mcp'),
  },
  {
    id: 'apify-mcp', name: 'Apify', iconSlug: 'asset:apify', kind: 'credential', serverName: 'apify', priority: 19,
    description: '搜索和运行 Apify Actors，提取网页与结构化数据。需 Apify API Token；云端运行按账户额度计费。',
    capabilities: ['Actor 搜索与运行', '网页数据提取', '数据集读取'],
    setupUrl: 'https://docs.apify.com/mcp',
    entry: remoteMcp(APIFY_MCP_URL),
    credential: {
      label: 'Apify API Token', placeholder: '粘贴 Apify API Token',
      helpText: 'Token 将加密保存到系统凭据存储，通过 Authorization: Bearer 请求头发送。运行 Actor 可能产生费用，请先确认账户额度。',
      acquisitionUrl: 'https://console.apify.com/settings/integrations', acquisitionLabel: '打开 Apify Token 设置',
      headerName: 'Authorization', valuePrefix: 'Bearer ', credentialStorageUrl: APIFY_MCP_URL,
    },
  },
  {
    id: 'n8n-mcp', name: 'n8n MCP', iconSlug: 'asset:n8n', kind: 'mcp', authentication: 'none', serverName: 'n8n', priority: 20,
    description: '查询 n8n 节点、模板并校验工作流。默认无需账号，不连接你的 n8n 实例；实例管理需另行配置 URL 与安全凭据。需 Node.js 20+。',
    capabilities: ['节点文档与模板', '节点配置校验', '工作流校验'],
    setupUrl: 'https://github.com/czlonkowski/n8n-mcp',
    entry: {
      // 包含节点知识库与原生数据库依赖，首次下载/安装比普通 stdio 服务更慢。
      ...stdioMcp('npx', ['-y', 'n8n-mcp@2.94.0']), timeout: 300,
      // 保持 stdout 为 MCP 协议专用，关闭上游默认遥测；不注入实例凭据。
      env: { MCP_MODE: 'stdio', LOG_LEVEL: 'error', DISABLE_CONSOLE_OUTPUT: 'true', N8N_MCP_TELEMETRY_DISABLED: 'true' },
    },
  },
  {
    id: 'codebase-memory-mcp', name: 'codebase-memory', iconSlug: 'asset:codebase-memory', kind: 'guided', authType: 'local-setup', serverName: 'codebase-memory', priority: 21,
    experimental: true,
    description: '为授权项目建立代码图谱与索引。需配置项目绝对路径并检查共享后台服务；首次下载约 50 MB，跨工作区索引隔离有限。',
    capabilities: ['代码图谱', '符号与调用关系', '项目索引查询'],
    setupUrl: 'https://github.com/DeusData/codebase-memory-mcp',
    agentPrompt: codebaseMemoryMcpPrompt,
  },
  {
    id: 'concat-mcp', name: 'Concat', iconSlug: 'asset:concat', kind: 'guided', authType: 'local-setup', priority: 22,
    experimental: true,
    description: '面向视频剪辑与多轨合成的候选集成，等待上游发布正式 MCP。',
    capabilities: ['视频剪辑', '多轨合成'],
    setupUrl: 'https://concatenate.pages.dev/docs/transports/mcp',
    unavailableReason: '官方尚未发布 MCP；现有 JSON-RPC / gRPC 接口不能直接连接 DutyDeck。',
    agentPrompt: '先核验 https://concatenate.pages.dev/docs/transports/mcp 是否已发布正式 MCP。当前只有 JSON-RPC / gRPC；不要编造 MCP endpoint 或启动命令。',
  },
  {
    id: 'wecom-cli', name: '企业微信 CLI', iconSlug: 'asset:wecom', kind: 'cli', featured: true, priority: 3,
    description: '使用企业微信官方 CLI 配置组织协作、通讯录与消息相关的开发能力。',
    capabilities: ['企业协作与通讯录', '消息与会话', '官方 CLI 配置'],
    setupUrl: 'https://open.work.weixin.qq.com/help2/pc/21676',
    agentPrompt: cliSetupPrompt('企业微信 CLI', 'https://open.work.weixin.qq.com/help2/pc/21676', '设置 → 远程连接 → 配置企业微信 CLI'),
  },
  {
    id: 'dingtalk-cli', name: '钉钉 CLI', iconSlug: 'asset:dingtalk', kind: 'cli', featured: true, priority: 2,
    description: '使用钉钉官方 CLI 调用 AI 开发助手，完成问答、代码生成与开发辅助。',
    capabilities: ['AI 开发助手', '代码生成与解释', '钉钉开发工具'],
    setupUrl: 'https://open.dingtalk.com/document/development/dingtalk-cli-performing-tasks-within',
    agentPrompt: cliSetupPrompt('钉钉 CLI', 'https://open.dingtalk.com/document/development/dingtalk-cli-performing-tasks-within', '设置 → 远程连接 → 配置钉钉 CLI'),
  },
  {
    id: 'exa-search-mcp', name: 'Exa Search', iconSlug: 'asset:exa', kind: 'credential', priority: 6,
    description: '接入 Exa 官方远程 MCP，提供语义网页搜索与页面内容提取能力。',
    capabilities: ['语义网页搜索', '页面内容提取'],
    setupUrl: 'https://dashboard.exa.ai/api-keys',
    serverName: 'exa',
    entry: remoteMcp('https://mcp.exa.ai/mcp'),
    credential: {
      label: 'Exa API Key',
      placeholder: '粘贴 Exa API Key',
      helpText: '仅需填写 API Key。DutyDeck 会加密保存到系统 Keychain，并通过 x-api-key 请求头连接 Exa 官方远程 MCP。',
      acquisitionUrl: 'https://dashboard.exa.ai/api-keys',
      acquisitionLabel: '打开 Exa API Console',
      headerName: 'x-api-key',
      credentialStorageUrl: 'https://mcp.exa.ai/mcp',
    },
  },
  {
    id: 'brave-search-mcp', name: 'Brave Search', iconSlug: 'asset:brave', kind: 'credential', priority: 5,
    description: '接入 Brave 官方搜索 MCP，提供网页、新闻、图片、视频、本地和地点搜索。',
    capabilities: ['网页与新闻搜索', '图片与视频搜索', '地点与本地搜索'],
    setupUrl: 'https://api-dashboard.search.brave.com/app/keys',
    serverName: 'brave-search',
    entry: stdioMcp('npx', ['-y', '@brave/brave-search-mcp-server', '--transport', 'stdio']),
    credential: {
      label: 'Brave Search API Key',
      placeholder: '粘贴 Brave Search API Key',
      helpText: '仅需填写 API Key。DutyDeck 会加密保存到系统 Keychain，并仅在启动 Brave MCP 时作为 BRAVE_API_KEY 注入。',
      acquisitionUrl: 'https://api-dashboard.search.brave.com/app/keys',
      acquisitionLabel: '打开 Brave Search API Console',
      headerName: '',
      envName: 'BRAVE_API_KEY',
      credentialStorageUrl: 'https://api.search.brave.com/',
    },
  },
  {
    id: 'tavily-search-mcp', name: 'Tavily Search', iconSlug: 'asset:tavily', kind: 'credential', priority: 4,
    description: '接入 Tavily 官方远程 MCP，为 Agent 提供面向 AI 的网页搜索、提取和研究能力。',
    capabilities: ['网页搜索', '页面提取', '深度研究'],
    setupUrl: 'https://app.tavily.com/home',
    serverName: 'tavily-search',
    entry: remoteMcp('https://mcp.tavily.com/mcp'),
    credential: {
      label: 'Tavily API Key',
      placeholder: '粘贴 Tavily API Key',
      helpText: '仅需填写 API Key。DutyDeck 会加密保存到系统 Keychain，并通过 Authorization 请求头连接 Tavily 官方远程 MCP。',
      acquisitionUrl: 'https://app.tavily.com/home',
      acquisitionLabel: '打开 Tavily API Console',
      headerName: 'Authorization',
      valuePrefix: 'Bearer ',
      credentialStorageUrl: 'https://mcp.tavily.com/mcp',
    },
  },
  {
    id: 'tencent-docs-mcp', name: '腾讯文档', iconSlug: 'asset:tencent-docs', kind: 'credential', priority: 10, placement: 'bottom',
    description: '使用当前腾讯文档空间的 MCP Token，安全连接文档、表格和空间工具。',
    capabilities: ['文档与表格', '空间 MCP Token', '真实连接验证'],
    setupUrl: 'https://docs.qq.com/open/document/mcp/get-token',
    serverName: 'tencent-docs',
    entry: remoteMcp('https://docs.qq.com/openapi/mcp'),
    credential: {
      label: 'MCP Token',
      placeholder: '粘贴当前腾讯文档空间的 MCP Token',
      helpText: '在当前空间右上角「≡ → 使用 MCP → 获取 MCP token」复制。DutyDeck 将原样作为 Authorization 请求头保存到系统 Keychain，不会添加 Bearer 前缀。',
      acquisitionUrl: 'https://docs.qq.com/open/document/mcp/get-token',
      acquisitionLabel: '打开腾讯文档官方 Token 获取说明',
      headerName: 'Authorization',
      credentialStorageUrl: 'https://docs.qq.com/openapi/mcp',
    },
  },
  {
    id: 'ctrip-wendao', name: '携程问道', iconSlug: 'asset:ctrip', kind: 'guided', authType: 'api-key', priority: 11,
    description: '携程问道 Token 可提供机酒火车、景点推荐和行程规划；官方当前以 Skill 封装接入。',
    capabilities: ['机酒火车查询', '景点与行程规划', 'API Token + Skill'],
    setupUrl: 'https://ctrip.com/wendao/openclaw',
    expectedSkillSlug: 'ctrip-wendao',
    agentPrompt: providerSetupPrompt('携程问道', 'https://ctrip.com/wendao/openclaw', '携程问道开放平台 API Token；获取后安装官方 Skill 封装并验证'),
  },
  {
    id: 'baidu-netdisk', name: '百度网盘', iconSlug: 'asset:baidu-netdisk', kind: 'guided', authType: 'api-key',
    description: '百度网盘官方 MCP 可检索、管理与分享文件；上传场景还需要本地 stdio 服务。',
    capabilities: ['文件与目录管理', '搜索与分享', 'OAuth Access Token'],
    setupUrl: 'https://pan.baidu.com/union/doc/mcp-server/%E4%BD%BF%E7%94%A8%E6%A6%82%E8%BF%B0/',
    agentPrompt: providerSetupPrompt('百度网盘', 'https://pan.baidu.com/union/doc/mcp-server/%E4%BD%BF%E7%94%A8%E6%A6%82%E8%BF%B0/', '百度网盘 OAuth Access Token；SSE 模式不支持上传，上传需官方本地 stdio 方案'),
  },
  {
    id: 'qichacha-mcp', name: '企查查', iconSlug: 'asset:qichacha', kind: 'guided', authType: 'api-key',
    description: '企业工商、风险和关联信息需通过企查查开放平台的业务授权或 API Key 获取。',
    capabilities: ['工商与股权信息', '风险与关联查询', '开放平台 API Key'],
    setupUrl: 'https://agent.qcc.com/',
    // 官方按业务域拆分 MCP；公司信息服务是安装流程写入的首个稳定 server key。
    serverName: 'qcc-company',
    agentPrompt: providerSetupPrompt('企查查', 'https://agent.qcc.com/', '开放平台 API Key 或企业应用授权'),
  },

  {
    id: 'eastmoney-miaoxiang', name: '东方财富妙想', iconSlug: 'lucide-trending-up', kind: 'guided', authType: 'api-key',
    description: '投研与金融数据能力按妙想 Skills、平台预授权或 API Key 的正式路径配置。',
    capabilities: ['金融投研 Skills', '市场与数据能力', 'API Key / 平台授权'],
    setupUrl: 'https://choice.eastmoney.com/mcp/',
    serverName: 'eastmoney-miaoxiang',
    agentPrompt: providerSetupPrompt('东方财富妙想', 'https://choice.eastmoney.com/mcp/', '东方财富妙想 Skills API Key 或平台预授权'),
  },
  {
    id: 'github-cli', name: 'GitHub CLI', iconSlug: 'github', kind: 'cli',
    description: '在终端管理 GitHub 资源，适合开发、协作与仓库自动化，不会作为 MCP 注入。',
    capabilities: ['PR、Issue 与 Release', '仓库与 Actions', '认证与 API 调用'],
    setupUrl: 'https://cli.github.com/',
    agentPrompt: cliSetupPrompt('GitHub CLI', 'https://cli.github.com/', '设置 → 远程连接 → 配置 GitHub CLI'),
  },
  {
    id: 'feishu-cli', name: '飞书 CLI', iconSlug: 'asset:feishu', kind: 'cli', priority: 1,
    description: '飞书官方命令行与 Agent 工具集，可操作消息、日历、文档、多维表格和任务。',
    capabilities: ['消息、日历与文档', '多维表格与任务', '多 Profile 授权'],
    setupUrl: 'https://www.feishu.cn/feishu-cli',
    agentPrompt: cliSetupPrompt('飞书 CLI', 'https://www.feishu.cn/feishu-cli', '设置 → 远程连接 → 配置飞书 CLI'),
  },
]

export function getCatalogServerNames(): Set<string> {
  return new Set(MCP_INTEGRATION_CATALOG
    .filter(isCatalogIntegrationVisible)
    .flatMap((integration) => 'serverName' in integration && integration.serverName ? [integration.serverName] : []))
}
export function matchesCatalogSearch(integration: CatalogIntegration, query: string): boolean {
  if (!query) return true
  return `${integration.name} ${integration.description} ${integration.capabilities.join(' ')} ${integration.kind}`.toLowerCase().includes(query.toLowerCase())
}
