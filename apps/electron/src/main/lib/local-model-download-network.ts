/** 本地模型远程下载的代理装配与脱敏网络诊断；不用于回环推理请求。 */
import { createManagedProxyFetch } from './proxy-fetch'
import { getEffectiveProxyUrl } from './proxy-settings-service'

/** 一次下载持有的传输层；必须在响应消费完毕或取消后释放。 */
export interface LocalModelDownloadTransport {
  /** 发送远程请求，参数与返回值遵循 fetch 合同。 */
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  /** 释放本次下载持有的代理连接。 */
  close: () => Promise<void>
}

/** 每次下载读取最新设置并创建独立传输层，返回可释放的下载连接。 */
export async function createLocalModelDownloadTransport(): Promise<LocalModelDownloadTransport> {
  try {
    return createManagedProxyFetch(await getEffectiveProxyUrl())
  } catch (error) {
    throw new Error('无法初始化下载代理，请检查“代理设置”后重试', { cause: error })
  }
}

/** 已知网络错误只展示固定解释和允许的错误码，不复制请求 URL、认证信息或本地路径。 */
const NETWORK_REASONS: Readonly<Record<string, string>> = {
  ENOTFOUND: 'DNS 解析失败',
  EAI_AGAIN: 'DNS 解析暂时失败',
  ETIMEDOUT: '连接超时',
  UND_ERR_CONNECT_TIMEOUT: '连接超时',
  UND_ERR_HEADERS_TIMEOUT: '等待下载响应超时',
  UND_ERR_BODY_TIMEOUT: '下载数据接收超时',
  ECONNREFUSED: '连接被拒绝',
  ECONNRESET: '下载连接中断',
  EPIPE: '下载连接中断',
  UND_ERR_SOCKET: '下载连接中断',
  CERT_HAS_EXPIRED: '服务器或代理证书已过期',
  DEPTH_ZERO_SELF_SIGNED_CERT: '服务器或代理证书不受信任',
  SELF_SIGNED_CERT_IN_CHAIN: '服务器或代理证书不受信任',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '服务器或代理证书校验失败',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: '服务器或代理证书校验失败',
  ERR_TLS_CERT_ALTNAME_INVALID: '服务器或代理证书域名不匹配',
}

/** 从异常及其 cause/AggregateError 中提取有界网络诊断；非网络错误返回 undefined。 */
export function getLocalModelDownloadNetworkMessage(error: unknown): string | undefined {
  /** 限制遍历规模并去重，防止异常 cause 环或过大的聚合异常。 */
  const pending: unknown[] = [error]
  const seen = new Set<object>()
  let genericNetworkFailure = false
  for (let index = 0; index < pending.length && index < 16; index++) {
    /** 异常可能不是 Error 实例，例如测试替身或跨边界序列化对象。 */
    const item = pending[index]
    if (!item || typeof item !== 'object' || seen.has(item)) continue
    seen.add(item)
    /** 只读取固定字段，绝不将底层 message 拼入用户诊断。 */
    const value = item as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown }
    if (typeof value.code === 'string' && Object.hasOwn(NETWORK_REASONS, value.code)) {
      return `${NETWORK_REASONS[value.code]}（${value.code}），请检查网络或“代理设置”后重试`
    }
    if (typeof value.message === 'string' && /fetch failed|failed to fetch|terminated|socket hang up/i.test(value.message)) genericNetworkFailure = true
    if (value.cause !== undefined && pending.length < 16) pending.push(value.cause)
    if (Array.isArray(value.errors)) pending.push(...value.errors.slice(0, 16 - pending.length))
  }
  return genericNetworkFailure ? '下载连接失败，请检查网络或“代理设置”后重试' : undefined
}
