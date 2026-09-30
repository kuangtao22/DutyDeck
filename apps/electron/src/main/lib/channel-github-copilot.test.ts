import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { serializeGithubCopilotCredentials, type GithubCopilotOAuthCredentials } from '@proma/shared'

type ChannelManagerModule = typeof import('./channel-manager')

let channelManager: ChannelManagerModule
let tempHome: string
const originalHome = process.env.HOME
const originalPromaDev = process.env.PROMA_DEV

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(process.env.HOME ?? tempHome, 'Library', 'Application Support'),
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString('utf-8').replace(/^encrypted:/, ''),
  },
  shell: { openExternal: async () => undefined },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

const oldCredentials: GithubCopilotOAuthCredentials = {
  access: 'old-access',
  refresh: 'old-refresh',
  expires: Date.now() + 3_600_000,
  availableModelIds: ['gpt-5.3-codex'],
}

/** 创建可由测试精确控制完成时机的 Promise。 */
function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  /** 向测试暴露的 Promise 完成函数。 */
  let resolvePromise!: (value: T) => void
  /** 等待测试显式完成的 Promise。 */
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'proma-github-copilot-'))
  process.env.HOME = tempHome
  process.env.PROMA_DEV = '0'
  channelManager = await import('./channel-manager')
})

beforeEach(() => {
  rmSync(join(tempHome, '.proma'), { recursive: true, force: true })
  mkdirSync(join(tempHome, '.proma'), { recursive: true })
})

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalPromaDev === undefined) delete process.env.PROMA_DEV
  else process.env.PROMA_DEV = originalPromaDev
  rmSync(tempHome, { recursive: true, force: true })
})

/** 创建使用 safeStorage 加密落盘的 Copilot 渠道。 */
function createCopilotChannel(credentials = oldCredentials) {
  return channelManager.createChannel({
    name: 'GitHub Copilot',
    provider: 'github-copilot',
    baseUrl: '',
    apiKey: serializeGithubCopilotCredentials(credentials),
    models: [],
    enabled: true,
  })
}

describe('GitHub Copilot 渠道凭据安全与并发保护', () => {
  test('Given 创建 Copilot 渠道 When 落盘 Then 文件不包含明文 token', () => {
    createCopilotChannel()

    const stored = readFileSync(join(tempHome, '.proma', 'channels.json'), 'utf-8')
    expect(stored).not.toContain(oldCredentials.access)
    expect(stored).not.toContain(oldCredentials.refresh)
  })

  test('Given 用户已切换账号 When 旧运行回写刷新结果 Then 不覆盖新账号', () => {
    const channel = createCopilotChannel()
    const newCredentials = { ...oldCredentials, access: 'new-access', refresh: 'new-refresh' }
    channelManager.updateChannel(channel.id, { apiKey: serializeGithubCopilotCredentials(newCredentials) })

    const persisted = channelManager.persistGithubCopilotOAuthCredentials(
      channel.id,
      { ...oldCredentials, access: 'late-refreshed-access' },
      oldCredentials,
    )

    expect(persisted).toBe(false)
    expect(channelManager.decryptApiKey(channel.id)).toBe(serializeGithubCopilotCredentials(newCredentials))
  })

  test('Given 同一毫秒内切换 Copilot 账号 When 更新渠道 Then 凭据版本时间戳严格递增', () => {
    const originalDateNow = Date.now
    const fixedNow = 1_800_000_000_000
    Date.now = () => fixedNow

    try {
      const channel = createCopilotChannel()
      const newCredentials = { ...oldCredentials, access: 'new-access', refresh: 'new-refresh' }

      const updated = channelManager.updateChannel(channel.id, {
        apiKey: serializeGithubCopilotCredentials(newCredentials),
      })

      expect(channel.updatedAt).toBe(fixedNow)
      expect(updated.updatedAt).toBe(fixedNow + 1)
    } finally {
      Date.now = originalDateNow
    }
  })

  test('Given 旧账号刷新在途时切换账号 When 新旧调用并发解析 Then 两次调用都返回新账号凭据', async () => {
    /** 两个账号都已过期，确保解析流程进入各自的刷新请求。 */
    const expiredOldCredentials = { ...oldCredentials, expires: 1 }
    const expiredNewCredentials = {
      ...expiredOldCredentials,
      access: 'new-expired-access',
      refresh: 'new-refresh',
    }
    /** 分别控制旧账号与新账号刷新完成顺序。 */
    const oldRefresh = createDeferred<GithubCopilotOAuthCredentials>()
    const newRefresh = createDeferred<GithubCopilotOAuthCredentials>()
    /** 记录实际发起刷新的账号，证明换号后没有复用旧代 Promise。 */
    const refreshedAccounts: string[] = []
    /** 按 refresh token 返回对应账号的可控刷新请求。 */
    const refreshCredentials = async (credentials: GithubCopilotOAuthCredentials): Promise<GithubCopilotOAuthCredentials> => {
      refreshedAccounts.push(credentials.refresh)
      return credentials.refresh === expiredOldCredentials.refresh
        ? oldRefresh.promise
        : newRefresh.promise
    }
    const channel = createCopilotChannel(expiredOldCredentials)

    /** 先启动旧账号刷新，再在其完成前切换到新账号。 */
    const oldResolve = channelManager.resolveGithubCopilotOAuthCredentials(channel.id, refreshCredentials)
    channelManager.updateChannel(channel.id, {
      apiKey: serializeGithubCopilotCredentials(expiredNewCredentials),
    })
    /** 新账号解析必须启动独立刷新，而不是复用旧账号结果。 */
    const newResolve = channelManager.resolveGithubCopilotOAuthCredentials(channel.id, refreshCredentials)

    expect(refreshedAccounts).toEqual([expiredOldCredentials.refresh, expiredNewCredentials.refresh])

    /** 旧刷新先返回，CAS 失败后应转而等待新账号刷新。 */
    oldRefresh.resolve({ ...expiredOldCredentials, access: 'old-refreshed-access', expires: Date.now() + 3_600_000 })
    /** 等待旧代执行 CAS 与 finally，验证它不会删除新代的单飞记录。 */
    await Promise.resolve()
    await Promise.resolve()
    const repeatedNewResolve = channelManager.resolveGithubCopilotOAuthCredentials(channel.id, refreshCredentials)
    expect(refreshedAccounts).toEqual([expiredOldCredentials.refresh, expiredNewCredentials.refresh])

    const refreshedNewCredentials = {
      ...expiredNewCredentials,
      access: 'new-refreshed-access',
      expires: Date.now() + 3_600_000,
    }
    newRefresh.resolve(refreshedNewCredentials)

    expect(await oldResolve).toEqual(refreshedNewCredentials)
    expect(await newResolve).toEqual(refreshedNewCredentials)
    expect(await repeatedNewResolve).toEqual(refreshedNewCredentials)
    expect(channelManager.decryptApiKey(channel.id)).toBe(serializeGithubCopilotCredentials(refreshedNewCredentials))
  })
})

describe('GitHub Copilot 连接测试', () => {
  test('Given 登录有效但可用模型为空 When 直接测试 Then 返回连接成功', async () => {
    const result = await channelManager.testGithubCopilotCredentials(
      serializeGithubCopilotCredentials({ ...oldCredentials, availableModelIds: [] }),
      async () => [],
    )

    expect(result).toEqual({ success: true, message: '连接成功，当前账号未返回可用模型' })
  })

  test.each([
    [401, 'auth'],
    [403, 'permission'],
    [429, 'rate_limit'],
  ] as const)('Given 模型目录返回 HTTP %i When 直接测试 Then 错误归一化为 %s', async (status, expectedType) => {
    const result = await channelManager.testGithubCopilotCredentials(
      serializeGithubCopilotCredentials(oldCredentials),
      async () => { throw new Error(`HTTP ${status}`) },
    )

    expect(result.errorType).toBe(expectedType)
    expect(result.statusCode).toBe(status)
  })
})
