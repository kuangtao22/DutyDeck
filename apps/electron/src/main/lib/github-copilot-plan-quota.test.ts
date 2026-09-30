import { describe, expect, test } from 'bun:test'
import type { ManagedProxyFetch } from './proxy-fetch'
import {
  parseGithubCopilotPlanQuotaResponse,
  queryGithubCopilotPlanQuota,
} from './github-copilot-plan-quota'

/** 构造可被额度接口读取的完整 Copilot OAuth 凭据。 */
function credentials(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    access: 'copilot-access-token',
    refresh: 'github-oauth-token',
    expires: Date.now() + 60_000,
    availableModelIds: ['gpt-4.1'],
    ...overrides,
  })
}

/** 构造受控传输，便于验证状态码归一化与资源释放。 */
function transportFor(response: Response | Error): {
  createTransport: () => ManagedProxyFetch
  requests: Array<{ input: string; init?: RequestInit }>
  closed: () => number
} {
  const requests: Array<{ input: string; init?: RequestInit }> = []
  let closeCount = 0
  return {
    requests,
    closed: () => closeCount,
    createTransport: () => ({
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ input: String(input), init })
        if (response instanceof Error) throw response
        return response
      }) as unknown as typeof globalThis.fetch,
      close: async () => { closeCount += 1 },
    }),
  }
}

describe('GitHub Copilot 额度解析', () => {
  test('Given 已知额度字段 When 解析 Then 只输出可展示窗口并保留重置时间', () => {
    const result = parseGithubCopilotPlanQuotaResponse({
      copilot_plan: 'pro_plus',
      quota_reset_date: '2026-10-01T00:00:00Z',
      quota_snapshots: {
        premium_interactions: { entitlement: 300, remaining: 75, percent_remaining: 25 },
        chat: { unlimited: true },
        completions: { entitlement: 0, remaining: 0, percent_remaining: 100 },
        unknown_secret_echo: { token: 'do-not-forward' },
      },
      monthly_quotas: { completions: 2_000 },
      limited_user_quotas: { completions: 1_500 },
    })

    expect(result).toMatchObject({
      supported: true,
      provider: 'github-copilot',
      planName: 'GitHub Copilot Pro+',
    })
    expect(result.windows.map((window) => [window.label, window.remainingLabel, window.remainingPercent, window.showProgress]))
      .toEqual([
        ['Premium', '75 / 300', 25, undefined],
        ['Chat', '不限额', 0, false],
        ['补全', '1500 / 2000', 75, undefined],
      ])
    expect(JSON.stringify(result)).not.toContain('do-not-forward')
    expect(result.windows.every((window) => window.resetAt === Date.parse('2026-10-01T00:00:00Z'))).toBe(true)
  })

  test('Given 空占位和无效日期 When 解析 Then 不伪造额度或重置时间', () => {
    const result = parseGithubCopilotPlanQuotaResponse({
      quota_reset_date: '2026-02-31',
      quota_snapshots: { premium_interactions: { entitlement: 0, remaining: 0, percent_remaining: 100 } },
    })

    expect(result.supported).toBe(false)
    expect(result.windows).toEqual([])
    expect(result.message).toContain('未返回可用额度数据')
  })

  test('Given 按量计费 When 解析 Then 独立显示计费方式', () => {
    const result = parseGithubCopilotPlanQuotaResponse({ token_based_billing: true })

    expect(result.supported).toBe(true)
    expect(result.windows[0]).toMatchObject({ label: '计费方式', remainingLabel: '按量计费', showProgress: false })
  })
})

describe('GitHub Copilot 额度请求', () => {
  test('Given 完整凭据 When 查询 Then 使用 GitHub OAuth refresh token 且释放传输', async () => {
    const controlled = transportFor(new Response(JSON.stringify({
      copilot_plan: 'individual',
      quota_snapshots: { premium_interactions: { entitlement: 100, remaining: 80 } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    const result = await queryGithubCopilotPlanQuota(credentials(), undefined, controlled.createTransport)

    expect(result.supported).toBe(true)
    expect(controlled.requests).toHaveLength(1)
    expect(controlled.requests[0]?.input).toBe('https://api.github.com/copilot_internal/user')
    expect(new Headers(controlled.requests[0]?.init?.headers).get('authorization')).toBe('token github-oauth-token')
    expect(new Headers(controlled.requests[0]?.init?.headers).get('authorization')).not.toContain('copilot-access-token')
    expect(controlled.closed()).toBe(1)
  })

  for (const [status, expected] of [
    [401, '登录已失效'],
    [403, '订阅或组织授权'],
    [429, '查询过于频繁'],
  ] as const) {
    test(`Given HTTP ${status} When 查询 Then 返回明确可操作原因`, async () => {
      const controlled = transportFor(new Response('private response body', { status }))

      const result = await queryGithubCopilotPlanQuota(credentials(), undefined, controlled.createTransport)

      expect(result.supported).toBe(false)
      expect(result.message).toContain(expected)
      expect(result.message).toContain(`HTTP ${status}`)
      expect(result.message).not.toContain('private response body')
      expect(controlled.closed()).toBe(1)
    })
  }

  test('Given 请求超时 When 查询 Then 返回超时原因且不泄漏异常文本', async () => {
    const controlled = transportFor(new DOMException('contains-sensitive-proxy', 'TimeoutError'))

    const result = await queryGithubCopilotPlanQuota(credentials(), 'http://secret-proxy', controlled.createTransport)

    expect(result.supported).toBe(false)
    expect(result.message).toContain('查询超时')
    expect(result.message).not.toContain('contains-sensitive-proxy')
    expect(result.message).not.toContain('secret-proxy')
    expect(controlled.closed()).toBe(1)
  })

  test('Given 非法凭据 When 查询 Then 不创建网络传输', async () => {
    let created = 0
    const result = await queryGithubCopilotPlanQuota('{"refresh":"bad token"}', undefined, () => {
      created += 1
      return transportFor(new Response('{}')).createTransport()
    })

    expect(result.supported).toBe(false)
    expect(result.message).toContain('凭据无效或缺失')
    expect(created).toBe(0)
  })
})
