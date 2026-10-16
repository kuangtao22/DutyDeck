import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpServerEntry } from '@proma/shared'
import { getMcpApiKeyEnvironment, getMcpOAuthHeaders } from '../mcp-oauth-service'
import { createManagedProxyFetch } from '../proxy-fetch'
import { getEffectiveProxyUrl } from '../proxy-settings-service'
import { MOBILE_MIRROR_TOOLS } from './protocol'
import type { MobileMirrorConnection } from './service'
/** 根据可信工作区 mobile-mcp 配置建立独立 SDK 连接，发现工具后才开放操作。 */
export async function connectMobileMirror(entry: McpServerEntry, workspaceSlug: string, signal: AbortSignal): Promise<MobileMirrorConnection> {
  if (!entry.enabled || signal.aborted) throw new Error('Mobile MCP 未启用或面板已关闭')
  const client = new Client({ name: 'DutyDeck Mobile Mirror', version: '1.0.0' }, { capabilities: {} })
  let transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport | undefined
  let proxy: ReturnType<typeof createManagedProxyFetch> | undefined
  let closed = false
  /** 多个取消来源共享一次关闭，防止重复关闭 SDK 和代理。 */
  let closing: Promise<void> | undefined
  /** 重复关闭安全；初始化中止时也释放已创建传输与代理。 */
  const close = async (): Promise<void> => {
    if (closing) return closing
    closed = true
    signal.removeEventListener('abort', abort)
    closing = (async () => {
      try { await client.close() } catch { /* 尚未握手时也继续关闭传输。 */ }
      try { await transport?.close() } catch { /* 已退出的子进程无需重复关闭。 */ }
      await proxy?.close()
    })()
    return closing
  }
  /** 外部取消无需等待 connect 返回。 */
  const abort = (): void => { void close().catch(() => undefined) }
  signal.addEventListener('abort', abort, { once: true })
  /** 每个异步初始化边界重查取消，防止 close 后创建资源。 */
  const active = (): void => { if (closed || signal.aborted) throw new Error('手机面板已关闭') }
  try {
    if (entry.type === 'stdio') {
      if (!entry.command) throw new Error('Mobile MCP 缺少启动命令')
      const credentialEnv = getMcpApiKeyEnvironment(workspaceSlug, 'mobile-mcp', entry)
      active()
      transport = new StdioClientTransport({ command: entry.command, args: entry.args, env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), ...entry.env, ...credentialEnv }, stderr: 'pipe' })
    } else if (entry.type === 'http' || entry.type === 'sse') {
      if (!entry.url) throw new Error('Mobile MCP 缺少服务地址')
      const proxyUrl = await getEffectiveProxyUrl(); active()
      proxy = createManagedProxyFetch(proxyUrl)
      const headers = { ...entry.headers, ...await getMcpOAuthHeaders(workspaceSlug, 'mobile-mcp', entry.url) }; active()
      const options = { requestInit: { headers }, fetch: proxy.fetch }
      transport = entry.type === 'http' ? new StreamableHTTPClientTransport(new URL(entry.url), options) : new SSEClientTransport(new URL(entry.url), options)
    } else throw new Error('不支持此 Mobile MCP 传输类型')
    active()
    const timeout = Math.min(120, Math.max(1, entry.timeout ?? 30)) * 1000
    if (transport instanceof StdioClientTransport) transport.stderr?.on('data', () => { /* 持续排空 stderr，避免日志背压阻塞设备调用；不持久化手机日志。 */ })
    await client.connect(transport, { timeout, signal }); active()
    const names = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const result = await client.listTools(cursor ? { cursor } : undefined, { timeout, signal }); active()
      for (const tool of result.tools) names.add(tool.name)
      cursor = result.nextCursor
      if (!cursor) break
    }
    if (MOBILE_MIRROR_TOOLS.some(name => !names.has(name))) throw new Error('当前 Mobile MCP 缺少手机镜像所需工具，请升级服务')
    return {
      close,
      callTool: async input => {
        active()
        if (!(MOBILE_MIRROR_TOOLS as readonly string[]).includes(input.name)) throw new Error('不允许此手机工具')
        return client.callTool(input, undefined, { timeout, signal })
      },
    }
  } catch (error) { await close(); throw error }
}
