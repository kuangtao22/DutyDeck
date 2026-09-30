/** 工作区 MCP 配置的纯策略函数。 */

import type { McpOAuthConfiguration, McpServerEntry, McpTransportType } from '@proma/shared'
import { RESERVED_BUILTIN_KEYS } from './builtin-mcp/baseline'

/** 会影响普通对象继承链的危险属性名。 */
const PROTOTYPE_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Agent 配置 MCP 时可提交的非敏感字段。 */
export interface ConfigureWorkspaceMcpInput {
  name: string
  type: McpTransportType
  command?: string
  args?: string[]
  url?: string
  timeout?: number
  enabled?: boolean
  oauth?: McpOAuthConfiguration
  /** 已向用户说明影响并确认覆盖已有连接时显式传入。 */
  replaceExisting?: boolean
}

/** 校验并规范化工作区 MCP 服务名。 */
export function requireWorkspaceMcpServerName(name: string): string {
  const normalized = name.trim()
  if (!normalized) throw new Error('MCP 服务名不能为空')
  if (RESERVED_BUILTIN_KEYS.has(normalized)) throw new Error(`MCP 服务名 ${normalized} 是 Proma 运行时保留名`)
  if (PROTOTYPE_POLLUTION_KEYS.has(normalized)) throw new Error(`MCP 服务名 ${normalized} 不可用`)
  if (normalized.length > 120) throw new Error('MCP 服务名不能超过 120 个字符')
  if (/\p{C}/u.test(normalized)) throw new Error('MCP 服务名不能包含控制字符')
  return normalized
}

/** 规范化公开 OAuth 元数据，并拒绝不安全端点。 */
function normalizeOAuthConfiguration(oauth: McpOAuthConfiguration | undefined): McpOAuthConfiguration | undefined {
  if (!oauth) return undefined
  const normalizeUrl = (value: string | undefined, field: string): string | undefined => {
    if (!value?.trim()) return undefined
    let parsed: URL
    try {
      parsed = new URL(value.trim())
    } catch {
      throw new Error(`OAuth ${field} 不是有效 URL`)
    }
    if (parsed.protocol !== 'https:') throw new Error(`OAuth ${field} 必须使用 HTTPS`)
    if (parsed.username || parsed.password) throw new Error(`OAuth ${field} 不能包含用户名或密码`)
    return parsed.toString()
  }
  const provider = oauth.provider?.trim()
  const clientId = oauth.clientId?.trim()
  const scopes = oauth.scopes?.map((scope) => scope.trim()).filter(Boolean)
  const authorizationEndpoint = normalizeUrl(oauth.authorizationEndpoint, 'authorizationEndpoint')
  const tokenEndpoint = normalizeUrl(oauth.tokenEndpoint, 'tokenEndpoint')
  const registrationEndpoint = normalizeUrl(oauth.registrationEndpoint, 'registrationEndpoint')
  const normalized: McpOAuthConfiguration = {
    ...(provider ? { provider } : {}),
    ...(authorizationEndpoint ? { authorizationEndpoint } : {}),
    ...(tokenEndpoint ? { tokenEndpoint } : {}),
    ...(registrationEndpoint ? { registrationEndpoint } : {}),
    ...(clientId ? { clientId } : {}),
    ...(oauth.clientSecretRequired === true ? { clientSecretRequired: true } : {}),
    ...(scopes && scopes.length > 0 ? { scopes } : {}),
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

/** 将 Agent 输入收敛为无凭据的 MCP transport 配置。 */
export function buildWorkspaceMcpEntry(input: ConfigureWorkspaceMcpInput): McpServerEntry {
  const timeout = input.timeout == null ? undefined : Math.max(1, Math.floor(input.timeout))
  const oauth = normalizeOAuthConfiguration(input.oauth)
  if (input.type === 'stdio') {
    const command = input.command?.trim()
    if (!command) throw new Error('stdio MCP 需要 command')
    /** stdio 参数可能有意包含空串或首尾空格，必须按原义传递。 */
    const args = input.args ? [...input.args] : undefined
    return {
      type: 'stdio',
      command,
      ...(args && args.length > 0 ? { args } : {}),
      ...(timeout ? { timeout } : {}),
      ...(oauth ? { oauth } : {}),
      enabled: input.enabled !== false,
    }
  }

  const url = input.url?.trim()
  if (!url) throw new Error(`${input.type} MCP 需要 url`)
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    throw new Error(`无效的 MCP URL: ${url}`)
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`${input.type} MCP URL 必须使用 HTTP 或 HTTPS`)
  }
  return {
    type: input.type,
    url,
    ...(timeout ? { timeout } : {}),
    ...(oauth ? { oauth } : {}),
    enabled: input.enabled !== false,
  }
}

/** 更新同一 transport 时保留 UI 或 Keychain 流程管理的敏感字段。 */
export function preserveSensitiveConnectionFields(previous: McpServerEntry | undefined, next: McpServerEntry): McpServerEntry {
  if (!previous || previous.type !== next.type) return next
  if (next.type === 'stdio' && previous.env) return { ...next, env: previous.env }
  if ((next.type === 'http' || next.type === 'sse') && previous.headers) return { ...next, headers: previous.headers }
  return next
}

/** 判断 Agent 的目标变更是否会让既有秘密失去原绑定。 */
export function hasSensitiveConnectionBindingConflict(previous: McpServerEntry, next: McpServerEntry): boolean {
  if (previous.type === 'stdio' && previous.env) {
    if (next.type !== 'stdio') return true
    const previousArgs = previous.args ?? []
    const nextArgs = next.args ?? []
    return previous.command !== next.command
      || previousArgs.length !== nextArgs.length
      || previousArgs.some((arg, index) => arg !== nextArgs[index])
  }
  if ((previous.type === 'http' || previous.type === 'sse') && previous.headers) {
    return next.type !== previous.type || next.url !== previous.url
  }
  return false
}

/** 比较 Agent 有权管理的非敏感 transport 字段。 */
export function hasWorkspaceMcpTransportChanged(previous: McpServerEntry, next: McpServerEntry): boolean {
  if (previous.type !== next.type || previous.timeout !== next.timeout || JSON.stringify(previous.oauth) !== JSON.stringify(next.oauth)) return true
  if (next.type === 'stdio') {
    const previousArgs = previous.args ?? []
    const nextArgs = next.args ?? []
    return previous.command !== next.command
      || previousArgs.length !== nextArgs.length
      || previousArgs.some((arg, index) => arg !== nextArgs[index])
  }
  return previous.url !== next.url
}
