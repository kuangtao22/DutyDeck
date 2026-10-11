/** 一次 HTML 预览授权的界面状态；与源码加载状态独立。 */
export type HtmlPreviewLeaseState =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'error'; error: string }

/**
 * 开始一份 HTML 预览授权，返回 effect 的清理函数。
 * load 创建授权，release 释放授权，publish 仅向仍存活的预览提交状态。
 * 关闭后迟到的授权立即释放，避免切换文件、刷新和 StrictMode 重挂时泄漏。
 */
export function startHtmlPreviewLease(
  load: () => Promise<{ url: string } | null>,
  release: (url: string) => Promise<void>,
  publish: (state: HtmlPreviewLeaseState) => void,
): () => void {
  /** 当前 effect 是否仍拥有这份授权。 */
  let active = true
  /** 已创建且等待清理的授权 URL。 */
  let currentUrl = ''
  /** IPC 清理失败由主进程的 owner 销毁兜底，不能产生未处理拒绝。 */
  const releaseSafely = (url: string): void => {
    void release(url).catch((error: unknown) => { console.warn('释放 HTML 预览失败', error) })
  }
  publish({ status: 'loading' })
  void (async () => {
    try {
      const result = await load()
      if (!result?.url) throw new Error('无法创建 HTML 预览，请确认文件仍存在且有访问权限。')
      if (!active) {
        releaseSafely(result.url)
        return
      }
      currentUrl = result.url
      publish({ status: 'ready', url: currentUrl })
    } catch (error) {
      if (active) publish({ status: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  })()
  return () => {
    if (!active) return
    active = false
    if (currentUrl) releaseSafely(currentUrl)
    currentUrl = ''
  }
}
