/**
 * GitHub Copilot 订阅 OAuth 登录服务。
 *
 * Pi 负责 device-code 登录和 token 续签；Proma 只注入一次性内存凭据仓库，
 * 持久化仍统一经过 Channel.apiKey 的 safeStorage 加密路径。
 */

import { shell } from 'electron'
import type {
  ChannelTestResult,
  GithubCopilotOAuthCredentials,
  GithubCopilotOAuthDeviceCode,
} from '@proma/shared'
import { normalizeRequestError } from './channel-test-error'
import { runWithOAuthProxyScope } from './oauth-proxy-scope'

/** Pi SDK 动态导入后的模块类型。 */
type PiSdk = typeof import('@earendil-works/pi-coding-agent')
/** Pi 凭据仓库要求的 OAuth 运行时结构。 */
type OAuthCredential = GithubCopilotOAuthCredentials & { type: 'oauth'; [key: string]: unknown }

/** 复用动态导入，避免每次登录或续签重复加载 Pi。 */
let piSdkPromise: Promise<PiSdk> | undefined
/** 当前 device-code 登录的取消控制器；新登录会取消旧登录。 */
let activeLoginAbort: AbortController | undefined

/** 延迟加载 Pi，避免 Electron 主包内联运行时。 */
function loadPiSdk(): Promise<PiSdk> {
  piSdkPromise ??= import('@earendil-works/pi-coding-agent')
  return piSdkPromise
}

/** 构造不会读写全局 ~/.pi 的最小内存凭据仓库。 */
function createEphemeralCredentialStore(initial?: OAuthCredential) {
  /** 仅在当前登录/续签流程内存活的凭据。 */
  let credential = initial
  return {
    async read(providerId: string): Promise<OAuthCredential | undefined> {
      return providerId === 'github-copilot' ? credential : undefined
    },
    async list(): Promise<readonly { providerId: string; type: 'oauth' }[]> {
      return credential ? [{ providerId: 'github-copilot', type: 'oauth' }] : []
    },
    async modify(
      providerId: string,
      modify: (current: OAuthCredential | undefined) => Promise<OAuthCredential | undefined>,
    ): Promise<OAuthCredential | undefined> {
      if (providerId !== 'github-copilot') return undefined
      credential = await modify(credential)
      return credential
    },
    async delete(providerId: string): Promise<void> {
      if (providerId === 'github-copilot') credential = undefined
    },
  }
}

/** 将 Pi 凭据裁剪成 Proma 可持久化的稳定业务结构。 */
export function normalizeGithubCopilotOAuthCredentials(value: unknown): GithubCopilotOAuthCredentials {
  if (!value || typeof value !== 'object') throw new Error('Pi OAuth 返回的 GitHub Copilot 凭据不完整')
  /** 按 Pi OAuth 字段读取未知输入，随后逐项校验。 */
  const credential = value as Partial<OAuthCredential>
  if (typeof credential.access !== 'string' || !credential.access
    || typeof credential.refresh !== 'string' || !credential.refresh
    || typeof credential.expires !== 'number'
    || !Number.isFinite(credential.expires)
    || !Array.isArray(credential.availableModelIds)
    || !credential.availableModelIds.every((modelId) => typeof modelId === 'string')) {
    throw new Error('Pi OAuth 返回的 GitHub Copilot 凭据不完整')
  }
  return {
    access: credential.access,
    refresh: credential.refresh,
    expires: credential.expires,
    availableModelIds: [...new Set(credential.availableModelIds)],
    ...(typeof credential.enterpriseUrl === 'string' && credential.enterpriseUrl ? { enterpriseUrl: credential.enterpriseUrl } : {}),
  }
}

/** 将 OAuth/目录异常转换成渠道连接测试统一结果。 */
export function normalizeGithubCopilotOAuthError(error: unknown): ChannelTestResult {
  /** 仅用于状态分类的异常文本，最终未知错误仍走统一脱敏。 */
  const message = error instanceof Error ? error.message : String(error)
  /** 从 Pi 或 HTTP 异常中提取可操作状态码。 */
  const statusMatch = message.match(/(?:HTTP\s*)?(401|403|429)\b/i)
  /** 渠道连接测试统一使用的 HTTP 状态码。 */
  const statusCode = statusMatch ? Number(statusMatch[1]) : undefined
  if (statusCode === 401) {
    return { success: false, message: 'GitHub Copilot 登录已失效，请重新登录', errorType: 'auth', statusCode }
  }
  if (statusCode === 403) {
    return { success: false, message: '当前 GitHub 账号无权使用 Copilot，请检查订阅或组织策略', errorType: 'permission', statusCode }
  }
  if (statusCode === 429) {
    return { success: false, message: 'GitHub Copilot 请求过于频繁，请稍后重试', errorType: 'rate_limit', statusCode }
  }
  /** 仅复用通用分类，不把 Pi 响应正文、token 或代理参数透传到界面。 */
  const normalized = normalizeRequestError(error)
  switch (normalized.errorType) {
    case 'timeout':
      return { success: false, message: 'GitHub Copilot 请求超时，请稍后重试', errorType: 'timeout' }
    case 'bad_request':
      return { success: false, message: 'GitHub Copilot 请求配置无效，请重新登录后重试', errorType: 'bad_request' }
    case 'network':
      return { success: false, message: 'GitHub Copilot 连接失败，请稍后重试', errorType: 'network' }
    default:
      return { success: false, message: 'GitHub Copilot 连接失败，请稍后重试', errorType: 'unknown' }
  }
}

export interface GithubCopilotLoginOptions {
  /** GitHub Enterprise Server 域名；空值代表 github.com。 */
  enterpriseUrl?: string
  onDeviceCode?: (deviceCode: GithubCopilotOAuthDeviceCode) => void
}

/** 通过 GitHub device-code 登录，并取得账号当前实际允许的模型目录。 */
export async function loginGithubCopilotOAuth(
  options?: GithubCopilotLoginOptions,
  loadSdk: () => Promise<PiSdk> = loadPiSdk,
): Promise<GithubCopilotOAuthCredentials> {
  activeLoginAbort?.abort()
  /** 首个异步操作前注册控制器，覆盖 Pi 懒加载期间的立即取消。 */
  const loginAbort = new AbortController()
  activeLoginAbort = loginAbort

  try {
    /** 延迟加载的 Pi SDK；加载完成后必须再次确认本次登录仍有效。 */
    const sdk = await loadSdk()
    loginAbort.signal.throwIfAborted()
    return await runWithOAuthProxyScope(async () => {
      // 代理配置解析也可能等待磁盘或系统状态，进入网络作用域后重新检查取消。
      loginAbort.signal.throwIfAborted()
      /** 本次登录独占的 Pi runtime，不读取或写入用户全局 ~/.pi。 */
      const runtime = await sdk.ModelRuntime.create({
        credentials: createEphemeralCredentialStore(),
        allowModelNetwork: false,
      })
      loginAbort.signal.throwIfAborted()
      /** Pi device-code 登录结果，完成后裁剪为 Proma 的稳定凭据结构。 */
      const credentials = await runtime.login('github-copilot', 'oauth', {
        signal: loginAbort.signal,
        prompt: async (prompt) => {
          if (prompt.type === 'text') return options?.enterpriseUrl?.trim() ?? ''
          return new Promise<string>((_resolve, reject) => {
            /** 用户或 Pi 取消选择时，结束当前登录等待。 */
            const cancelPrompt = () => reject(new Error('登录已取消'))
            prompt.signal?.addEventListener('abort', cancelPrompt, { once: true })
            loginAbort.signal.addEventListener('abort', cancelPrompt, { once: true })
          })
        },
        notify: (event) => {
          if (loginAbort.signal.aborted) return
          if (event.type === 'device_code') {
            options?.onDeviceCode?.({ userCode: event.userCode, verificationUri: event.verificationUri })
            shell.openExternal(event.verificationUri).catch((error) => {
              console.error('[GitHub Copilot OAuth] 打开授权页面失败:', error)
            })
          } else if (event.type === 'progress' || event.type === 'info') {
            console.log(`[GitHub Copilot OAuth] ${event.message}`)
          }
        },
      })
      return normalizeGithubCopilotOAuthCredentials(credentials)
    })
  } finally {
    if (activeLoginAbort === loginAbort) activeLoginAbort = undefined
  }
}

/** 取消当前 GitHub Copilot device-code 登录。 */
export function cancelGithubCopilotOAuthLogin(): void {
  activeLoginAbort?.abort()
  activeLoginAbort = undefined
}

/** 使用 Pi 内置 provider 续签 access token，并同步最新模型策略。 */
export async function refreshGithubCopilotOAuth(
  credentials: GithubCopilotOAuthCredentials,
): Promise<GithubCopilotOAuthCredentials> {
  /** 延迟加载的 Pi SDK。 */
  const sdk = await loadPiSdk()
  return runWithOAuthProxyScope(async () => {
    /** 只承载本次续签的内存凭据仓库。 */
    const store = createEphemeralCredentialStore({ type: 'oauth', ...credentials })
    /** 关闭模型网络探测，只执行 provider 认证刷新。 */
    const runtime = await sdk.ModelRuntime.create({ credentials: store, allowModelNetwork: false })
    await runtime.getAuth('github-copilot')
    return normalizeGithubCopilotOAuthCredentials(await store.read('github-copilot'))
  })
}
