import { describe, expect, mock, test } from 'bun:test'

mock.module('electron', () => ({
  shell: { openExternal: async () => undefined },
}))

mock.module('./oauth-proxy-scope', () => ({
  runWithOAuthProxyScope: async <T>(action: () => Promise<T>): Promise<T> => action(),
}))

const {
  cancelGithubCopilotOAuthLogin,
  loginGithubCopilotOAuth,
  normalizeGithubCopilotOAuthCredentials,
  normalizeGithubCopilotOAuthError,
} = await import('./github-copilot-oauth-service')

/** 创建可由测试决定完成时机的 Promise。 */
function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  /** 暴露给测试的完成函数。 */
  let resolvePromise!: (value: T) => void
  /** 在测试显式推进前保持等待的 Promise。 */
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

describe('GitHub Copilot OAuth 凭据归一化', () => {
  test('Given Pi 返回空模型目录 When 归一化 Then 保留为空而不误报登录失败', () => {
    expect(normalizeGithubCopilotOAuthCredentials({
      type: 'oauth',
      access: 'access',
      refresh: 'refresh',
      expires: 123,
      availableModelIds: [],
    })).toEqual({
      access: 'access',
      refresh: 'refresh',
      expires: 123,
      availableModelIds: [],
    })
  })

  test('Given Pi 返回缺字段凭据 When 归一化 Then 明确拒绝', () => {
    expect(() => normalizeGithubCopilotOAuthCredentials({ access: 'access' }))
      .toThrow('GitHub Copilot 凭据不完整')
  })

  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'Given Pi 返回非有限过期时间 %s When 归一化 Then 明确拒绝',
    (expires) => {
      expect(() => normalizeGithubCopilotOAuthCredentials({
        access: 'access',
        refresh: 'refresh',
        expires,
        availableModelIds: [],
      })).toThrow('GitHub Copilot 凭据不完整')
    },
  )
})

describe('GitHub Copilot OAuth 登录取消', () => {
  test('Given Pi SDK 仍在懒加载 When 用户取消 Then 加载完成后不创建 runtime', async () => {
    /** 模拟尚未完成的 Pi 动态导入。 */
    const deferredSdk = createDeferred<never>()
    /** 记录登录 Promise，取消后应以 AbortError 结束。 */
    const login = loginGithubCopilotOAuth(undefined, () => deferredSdk.promise)

    cancelGithubCopilotOAuthLogin()
    deferredSdk.resolve({} as never)

    await expect(login).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('Given runtime 仍在创建 When 用户取消 Then 创建完成后不启动 device-code 登录', async () => {
    /** 模拟尚未完成的 runtime 创建。 */
    const deferredRuntime = createDeferred<{
      login: () => Promise<never>
    }>()
    /** 通知测试 runtime.create 已进入，确保取消发生在目标窗口。 */
    const runtimeCreateStarted = createDeferred<void>()
    /** 记录是否错误进入 Pi 登录。 */
    let loginCalled = false
    /** 最小 Pi SDK 替身，仅暴露本测试需要的 ModelRuntime.create。 */
    const sdk = {
      ModelRuntime: {
        create: async () => {
          runtimeCreateStarted.resolve()
          return deferredRuntime.promise
        },
      },
    }
    /** 开始登录并等待进入 runtime 创建阶段。 */
    const login = loginGithubCopilotOAuth(undefined, async () => sdk as never)
    await runtimeCreateStarted.promise
    cancelGithubCopilotOAuthLogin()
    deferredRuntime.resolve({
      login: async () => {
        loginCalled = true
        throw new Error('不应执行登录')
      },
    })

    await expect(login).rejects.toMatchObject({ name: 'AbortError' })
    expect(loginCalled).toBe(false)
  })
})

describe('GitHub Copilot 连接错误归一化', () => {
  test.each([
    [new Error('HTTP 401 Unauthorized'), 'auth'],
    [new Error('HTTP 403 Forbidden'), 'permission'],
    [new Error('HTTP 429 Too Many Requests'), 'rate_limit'],
    [new DOMException('The operation timed out', 'TimeoutError'), 'timeout'],
  ] as const)('Given %s When 归一化 Then 分类为 %s', (error, expectedType) => {
    expect(normalizeGithubCopilotOAuthError(error).errorType).toBe(expectedType)
  })

  test('Given Pi 异常包含 token 与代理参数 When 归一化 Then 不向界面透传敏感正文', () => {
    const result = normalizeGithubCopilotOAuthError(
      new Error('request failed: ghu_secret-token tid=trace-value;proxy-ep=proxy.internal'),
    )

    expect(result.message).toBe('GitHub Copilot 连接失败，请稍后重试')
    expect(result.message).not.toContain('ghu_')
    expect(result.message).not.toContain('proxy.internal')
  })
})
