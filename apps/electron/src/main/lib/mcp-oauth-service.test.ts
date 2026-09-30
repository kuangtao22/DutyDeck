import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 测试独占的加密凭据文件目录。 */
const testRoot = mkdtempSync(join(tmpdir(), 'proma-mcp-oauth-'))
/** 测试独占的加密凭据文件。 */
const credentialPath = join(testRoot, 'mcp-oauth.json')

mock.module('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
  shell: { openExternal: async () => undefined },
}))

mock.module('./config-paths', () => ({
  getMcpOAuthCredentialsPath: () => credentialPath,
}))

mock.module('./oauth-proxy-scope', () => ({
  runWithOAuthProxyScope: async <T>(action: () => Promise<T>): Promise<T> => action(),
}))

const {
  exchangeAuthorizationCode,
  getMcpOAuthHeaders,
  matchesMcpOAuthClientSecretBinding,
  saveMcpOAuthClientSecret,
} = await import('./mcp-oauth-service')

/** 每个用例恢复原始 fetch，避免污染其他测试。 */
const originalFetch = globalThis.fetch

beforeEach(() => {
  globalThis.fetch = originalFetch
  rmSync(credentialPath, { force: true })
})

afterAll(() => {
  globalThis.fetch = originalFetch
  rmSync(testRoot, { recursive: true, force: true })
})

describe('MCP OAuth Client Secret', () => {
  test('Given 已保存 secret When clientId 或 tokenEndpoint 变化 Then 拒绝复用旧绑定', () => {
    const stored = {
      serverUrl: 'https://mcp.example.com/',
      clientId: 'client-a',
      tokenEndpoint: 'https://auth.example.com/token',
    }

    expect(matchesMcpOAuthClientSecretBinding(stored, {
      serverUrl: 'https://mcp.example.com',
      clientId: 'client-b',
      tokenEndpoint: 'https://auth.example.com/token',
    })).toBe(false)
    expect(matchesMcpOAuthClientSecretBinding(stored, {
      serverUrl: 'https://mcp.example.com',
      clientId: 'client-a',
      tokenEndpoint: 'https://other.example.com/token',
    })).toBe(false)
  })

  test('Given 用户输入 client secret When 保存 Then 仅写入加密凭据文件且规范化 URL', () => {
    saveMcpOAuthClientSecret({
      workspaceSlug: 'project-a',
      serverName: 'docs',
      serverUrl: 'https://mcp.example.com',
      clientId: 'public-client',
      tokenEndpoint: 'https://auth.example.com/token',
      clientSecret: '  secret-value  ',
    })

    const file = JSON.parse(readFileSync(credentialPath, 'utf8')) as { credentials: Record<string, string> }
    const credential = JSON.parse(Buffer.from(file.credentials['project-a:docs']!, 'base64').toString('utf8'))
    expect(credential).toEqual({
      kind: 'oauth-client-secret',
      serverUrl: 'https://mcp.example.com/',
      clientId: 'public-client',
      tokenEndpoint: 'https://auth.example.com/token',
      clientSecret: 'secret-value',
    })
  })

  test('Given 仅保存 client secret When 解析请求头 Then 不把 secret 当作 bearer token', async () => {
    saveMcpOAuthClientSecret({
      workspaceSlug: 'project-a',
      serverName: 'docs',
      serverUrl: 'https://mcp.example.com',
      clientId: 'public-client',
      tokenEndpoint: 'https://auth.example.com/token',
      clientSecret: 'secret-value',
    })

    await expect(getMcpOAuthHeaders('project-a', 'docs', 'https://mcp.example.com')).resolves.toBeUndefined()
  })

  test('Given OAuth 提供方要求 client secret When 交换授权码 Then secret 仅进入 token 请求体', async () => {
    let requestBody = ''
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = String(init?.body ?? '')
      return new Response(JSON.stringify({ access_token: 'access-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    await exchangeAuthorizationCode({
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'public-client',
      clientSecret: 'secret-value',
      redirectUri: 'http://127.0.0.1/callback',
      code: 'code',
      verifier: 'verifier',
    })

    expect(new URLSearchParams(requestBody).get('client_secret')).toBe('secret-value')
  })
})
