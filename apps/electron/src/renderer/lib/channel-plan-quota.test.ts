import { describe, expect, test } from 'bun:test'
import type { ChannelPlanQuotaResult } from '@proma/shared'
import { fetchChannelPlanQuota, getCachedPlanQuota, supportsChannelPlanQuota } from './channel-plan-quota'

/** 创建可手动结束的 Promise，用于覆盖并发和换号竞态。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve })
  return { promise, resolve: (value) => resolvePromise?.(value) }
}

/** 构造额度结果并固定时间，避免测试依赖真实网络或时钟。 */
function quota(updatedAt: number, remainingPercent: number): ChannelPlanQuotaResult {
  return {
    supported: true,
    provider: 'github-copilot',
    windows: [{ type: 'custom', label: 'Premium', remainingPercent, usedPercent: 100 - remainingPercent }],
    updatedAt,
  }
}

/** 安装最小 Electron bridge，测试后由 Bun 进程退出统一释放。 */
function installQuotaBridge(getChannelPlanQuota: (channelId: string) => Promise<ChannelPlanQuotaResult>): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { electronAPI: { getChannelPlanQuota } },
  })
}

describe('渠道额度缓存', () => {
  test('Given Copilot 渠道 When 判断能力 Then 支持额度查询', () => {
    expect(supportsChannelPlanQuota({ provider: 'github-copilot', baseUrl: '' })).toBe(true)
  })

  test('Given 同一账号同时查询 When 请求未完成 Then 复用同一请求', async () => {
    const pending = deferred<ChannelPlanQuotaResult>()
    let calls = 0
    installQuotaBridge(async () => { calls += 1; return pending.promise })

    const first = fetchChannelPlanQuota('copilot-singleflight', 1)
    const second = fetchChannelPlanQuota('copilot-singleflight', 1)
    pending.resolve(quota(Date.now(), 80))

    expect(await first).toEqual(await second)
    expect(calls).toBe(1)
  })

  test('Given 换号时旧请求后返回 When 写缓存 Then 旧账号结果不得覆盖新账号', async () => {
    const oldRequest = deferred<ChannelPlanQuotaResult>()
    const newRequest = deferred<ChannelPlanQuotaResult>()
    installQuotaBridge(async () => oldRequest.promise)

    const oldResult = fetchChannelPlanQuota('copilot-switch-account', 1)
    // 等旧账号请求真正进入 bridge，再模拟用户保存新凭据。
    await Promise.resolve()
    installQuotaBridge(async () => newRequest.promise)
    const newResult = fetchChannelPlanQuota('copilot-switch-account', 2)

    newRequest.resolve(quota(Date.now(), 90))
    expect((await newResult).windows[0]?.remainingPercent).toBe(90)
    oldRequest.resolve(quota(Date.now(), 10))
    expect((await oldResult).windows[0]?.remainingPercent).toBe(10)
    expect(getCachedPlanQuota('copilot-switch-account', 2)?.windows[0]?.remainingPercent).toBe(90)
    expect(getCachedPlanQuota('copilot-switch-account', 1)).toBeNull()
  })

  test('Given bridge 抛出敏感错误 When 查询 Then 返回固定错误文案', async () => {
    installQuotaBridge(async () => { throw new Error('secret-token-in-error') })

    const result = await fetchChannelPlanQuota('copilot-sanitized-error', 1)

    expect(result.supported).toBe(false)
    expect(result.message).toBe('订阅额度查询失败，请稍后重试')
  })
})
