import { describe, expect, test } from 'bun:test'
import { startHtmlPreviewLease, type HtmlPreviewLeaseState } from './html-preview-lease'

/** 创建可手动完成的请求，模拟 IPC 在卸载或刷新后才返回。 */
function deferredPreview() {
  let resolve!: (value: { url: string } | null) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<{ url: string } | null>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

/** 等待请求完成与 Promise 回调提交状态。 */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('HTML 预览授权生命周期', () => {
  test('Given 正常请求 When 关闭预览 Then 释放 URL 且重复清理不重复释放', async () => {
    const states: HtmlPreviewLeaseState[] = []
    const released: string[] = []
    const dispose = startHtmlPreviewLease(async () => ({ url: 'proma-file://page/index.html' }), async (url) => { released.push(url) }, (state) => { states.push(state) })
    await settle()
    expect(states).toEqual([{ status: 'loading' }, { status: 'ready', url: 'proma-file://page/index.html' }])
    dispose()
    dispose()
    expect(released).toEqual(['proma-file://page/index.html'])
  })

  test('Given 等待中的旧文件 When 切换文件并返回迟到结果 Then 释放旧授权且不覆盖新状态', async () => {
    const pending = deferredPreview()
    const states: HtmlPreviewLeaseState[] = []
    const released: string[] = []
    const dispose = startHtmlPreviewLease(() => pending.promise, async (url) => { released.push(url) }, (state) => { states.push(state) })
    dispose()
    pending.resolve({ url: 'proma-file://old/index.html' })
    await settle()
    expect(states).toEqual([{ status: 'loading' }])
    expect(released).toEqual(['proma-file://old/index.html'])
  })

  test('Given 授权失败 When 读取完成 Then 保留具体错误供源码降级与重试使用', async () => {
    const states: HtmlPreviewLeaseState[] = []
    startHtmlPreviewLease(async () => { throw new Error('目录身份已变化') }, async () => {}, (state) => { states.push(state) })
    await settle()
    expect(states.at(-1)).toEqual({ status: 'error', error: '目录身份已变化' })
  })

  test('Given 空授权结果 When 读取完成 Then 展示可理解的错误', async () => {
    const states: HtmlPreviewLeaseState[] = []
    startHtmlPreviewLease(async () => null, async () => {}, (state) => { states.push(state) })
    await settle()
    expect(states.at(-1)).toEqual({ status: 'error', error: '无法创建 HTML 预览，请确认文件仍存在且有访问权限。' })
  })

  test('Given 已关闭预览 When 迟到请求失败 Then 不再修改界面', async () => {
    const pending = deferredPreview()
    const states: HtmlPreviewLeaseState[] = []
    const dispose = startHtmlPreviewLease(() => pending.promise, async () => {}, (state) => { states.push(state) })
    dispose()
    pending.reject(new Error('已关闭'))
    await settle()
    expect(states).toEqual([{ status: 'loading' }])
  })
})
