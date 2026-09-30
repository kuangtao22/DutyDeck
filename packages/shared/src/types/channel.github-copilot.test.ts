import { describe, expect, test } from 'bun:test'
import {
  isGithubCopilotCredentialExpired,
  isAgentOnlyProvider,
  parseGithubCopilotCredentials,
  serializeGithubCopilotCredentials,
  type GithubCopilotOAuthCredentials,
} from './channel'

/** 覆盖企业域名、重复模型和标准过期时间的有效凭据样本。 */
const sample: GithubCopilotOAuthCredentials = {
  access: 'copilot-access-token',
  refresh: 'github-refresh-token',
  expires: 1_800_000_000_000,
  enterpriseUrl: 'github.example.com',
  availableModelIds: ['gpt-5.3-codex', 'claude-sonnet-4.5', 'gpt-5.3-codex'],
}

describe('GitHub Copilot OAuth 凭据序列化', () => {
  test('Given 含重复模型的凭据 When 序列化再解析 Then 保留业务字段并去重模型', () => {
    expect(parseGithubCopilotCredentials(serializeGithubCopilotCredentials(sample))).toEqual({
      ...sample,
      availableModelIds: ['gpt-5.3-codex', 'claude-sonnet-4.5'],
    })
  })

  test('Given 当前账号未返回可用模型 When 往返 Then 空目录仍是合法凭据', () => {
    const credentials = { ...sample, enterpriseUrl: undefined, availableModelIds: [] }

    expect(parseGithubCopilotCredentials(serializeGithubCopilotCredentials(credentials))).toEqual({
      access: credentials.access,
      refresh: credentials.refresh,
      expires: credentials.expires,
      availableModelIds: [],
    })
  })
})

describe('GitHub Copilot OAuth 凭据解析', () => {
  test('Given 非 JSON 或缺少必需字段 When 解析 Then 返回 null', () => {
    expect(parseGithubCopilotCredentials('copilot-token')).toBeNull()
    expect(parseGithubCopilotCredentials('{"access":"a","refresh":"r","expires":1}')).toBeNull()
    expect(parseGithubCopilotCredentials('{"access":"a","refresh":"r","expires":1,"availableModelIds":[1]}')).toBeNull()
  })

  test('Given JSON 指数溢出为 Infinity When 解析 Then 返回 null', () => {
    expect(parseGithubCopilotCredentials(
      '{"access":"a","refresh":"r","expires":1e999,"availableModelIds":[]}',
    )).toBeNull()
  })
})

describe('GitHub Copilot OAuth 凭据过期判定', () => {
  test('Given 仍有一小时有效期 When 判定 Then 未过期', () => {
    expect(isGithubCopilotCredentialExpired({ ...sample, expires: Date.now() + 3_600_000 })).toBe(false)
  })

  test('Given 凭据进入默认一分钟刷新余量 When 判定 Then 视为过期', () => {
    expect(isGithubCopilotCredentialExpired({ ...sample, expires: Date.now() + 30_000 })).toBe(true)
  })
})

describe('订阅渠道业务模式边界', () => {
  test('Given GitHub Copilot 渠道 When 判断可用模式 Then 只允许 Agent', () => {
    expect(isAgentOnlyProvider('github-copilot')).toBe(true)
  })

  test('Given 普通 API 渠道 When 判断可用模式 Then 不受 Agent-only 限制', () => {
    expect(isAgentOnlyProvider('anthropic')).toBe(false)
  })
})
