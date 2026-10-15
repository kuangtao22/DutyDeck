import { afterAll, describe, expect, mock, test } from 'bun:test'

/** 代理配置替身只替换读取入口，不读写真实用户设置。 */
let proxyUrl: string | undefined
let configurationError = false
const selectedProxies: Array<string | undefined> = []
mock.module('./proxy-settings-service', () => ({ getEffectiveProxyUrl: async () => {
  if (configurationError) throw new Error('https://user:secret@example.invalid')
  return proxyUrl
} }))
mock.module('./proxy-fetch', () => ({ createManagedProxyFetch: (url?: string) => {
  selectedProxies.push(url)
  return { fetch, close: async () => undefined }
} }))
const { createLocalModelDownloadTransport, getLocalModelDownloadNetworkMessage } = await import('./local-model-download-network')
afterAll(() => { mock.restore() })

describe('本地模型下载网络策略', () => {
  test('Given 系统或手动代理解析结果变化 When 新建下载 Then 使用最新结果且关闭代理恢复直连', async () => {
    proxyUrl = 'http://127.0.0.1:9001'
    await (await createLocalModelDownloadTransport()).close()
    proxyUrl = 'http://127.0.0.1:9002'
    await (await createLocalModelDownloadTransport()).close()
    proxyUrl = undefined
    await (await createLocalModelDownloadTransport()).close()
    expect(selectedProxies).toEqual(['http://127.0.0.1:9001', 'http://127.0.0.1:9002', undefined])
  })

  test('Given 代理解析失败 When 创建下载 Then 不泄漏配置中的凭据', async () => {
    configurationError = true
    try { await expect(createLocalModelDownloadTransport()).rejects.toThrow('无法初始化下载代理，请检查“代理设置”后重试') }
    finally { configurationError = false }
  })

  test.each([
    ['ENOTFOUND', 'DNS'], ['UND_ERR_CONNECT_TIMEOUT', '连接超时'],
    ['ECONNRESET', '下载连接中断'], ['CERT_HAS_EXPIRED', '证书已过期'],
  ])('Given 底层错误 %s When 生成诊断 Then 显示 %s 并隐藏请求详情', (code, expected) => {
    /** 模拟 undici 的聚合 cause；明文请求信息不得进入 UI。 */
    const cause = Object.assign(new Error('https://user:secret@example.invalid/?token=private'), { code })
    const message = getLocalModelDownloadNetworkMessage(new TypeError('fetch failed', { cause: new AggregateError([cause]) }))
    expect(message).toContain(expected)
    expect(message).toContain(code)
    expect(message).not.toContain('secret')
    expect(message).not.toContain('private')
  })

  test('Given cause 循环且未知网络原因 When 诊断 Then 有界返回通用中文提示', () => {
    const error = new TypeError('fetch failed')
    error.cause = error
    expect(getLocalModelDownloadNetworkMessage(error)).toBe('下载连接失败，请检查网络或“代理设置”后重试')
    expect(getLocalModelDownloadNetworkMessage(new Error('SHA-256 校验失败'))).toBeUndefined()
  })
})
