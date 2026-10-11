import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { createPromaFileProtocolRegistry } from './local-file-protocol'
import { createHtmlPreviewService } from './html-preview-service'
import type { StableDirectoryNativeHost, StableDirectoryOpenedRoot } from './stable-directory-native-host'

/** 模拟同一窗口的关闭和主文档导航，测试真实 lease 回收流程。 */
class PreviewOwner extends EventEmitter {
  isDestroyed(): boolean { return false }
}

/** 假原生边界只模拟已打开对象与读取结果；授权、缓存和回收均运行真实服务。 */
function fixture(maxCachedBytes?: number) {
  const registry = createPromaFileProtocolRegistry()
  const owner = new PreviewOwner()
  let identity = 'first'
  let reads = 0
  let complete: (() => void) | undefined
  let pause = false
  const run: StableDirectoryNativeHost['run'] = async (request, authorize) => {
    const root: StableDirectoryOpenedRoot = { requestedPath: '/site', canonicalPath: '/site', isDirectory: true, volume: '1', fileId: identity }
    if (!await authorize([root])) throw new Error('未授权目录')
    reads += 1
    if (pause) await new Promise<void>((resolve) => { complete = resolve })
    const content = Buffer.from(request.resourcePath === 'index.html' ? '<h1>ok</h1>' : 'asset')
    return { roots: [root], entries: [], resourceReadOutcome: { status: 'ok', contentBase64: content.toString('base64'), size: content.length } }
  }
  const service = createHtmlPreviewService({ run, registry, maxCachedBytes })
  return { service, registry, owner, reads: () => reads, replace: () => { identity = 'replacement' }, pause: () => { pause = true }, complete: () => complete?.() }
}

describe('HTML 预览生命周期与安全目录', () => {
  test('Given HTML 与相对资源 When 重复加载 Then 按需读取并合并同一资源请求', async () => {
    const f = fixture()
    const { url } = await f.service.create({ owner: f.owner, filePath: '/site/index.html', authorize: () => true })
    expect(await (await f.registry.handleRequest(new Request(url))).text()).toBe('<h1>ok</h1>')
    const assetUrl = new URL('assets/app.js', url).href
    const responses = await Promise.all([f.registry.handleRequest(new Request(assetUrl)), f.registry.handleRequest(new Request(assetUrl))])
    expect(await responses[0]!.text()).toBe('asset')
    expect(await responses[1]!.text()).toBe('asset')
    expect(f.reads()).toBe(2)
    f.service.release(f.owner, url)
    expect((await f.registry.handleRequest(new Request(url))).status).toBe(404)
    expect(f.owner.listenerCount('destroyed')).toBe(0)
  })

  test('Given 目录已绑定 When 原路径被新目录替换 Then 新资源拒绝而已授权快照不泄漏新内容', async () => {
    const f = fixture()
    const { url } = await f.service.create({ owner: f.owner, filePath: '/site/index.html', authorize: () => true })
    f.replace()
    expect((await f.registry.handleRequest(new Request(new URL('new.css', url)))).status).toBe(403)
    expect(f.reads()).toBe(1)
    f.service.release(f.owner, url)
  })

  test('Given 其他窗口持有 URL When 释放 Then 不能撤销原窗口预览且导航会自动回收', async () => {
    const f = fixture()
    const { url } = await f.service.create({ owner: f.owner, filePath: '/site/index.html', authorize: () => true })
    f.service.release(new PreviewOwner(), url)
    expect((await f.registry.handleRequest(new Request(url))).status).toBe(200)
    f.owner.emit('did-start-navigation', {}, 'about:blank', false, false)
    expect((await f.registry.handleRequest(new Request(url))).status).toBe(200)
    f.owner.emit('did-start-navigation', {}, 'about:blank', false, true)
    expect((await f.registry.handleRequest(new Request(url))).status).toBe(404)
  })

  test('Given 创建尚未完成 When 窗口销毁 Then 迟到结果不注册且移除监听', async () => {
    const f = fixture()
    f.pause()
    const pending = f.service.create({ owner: f.owner, filePath: '/site/index.html', authorize: () => true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    f.owner.emit('destroyed')
    f.complete()
    await expect(pending).rejects.toThrow()
    expect(f.owner.listenerCount('destroyed')).toBe(0)
  })

  test('Given 权限被撤销或只授权 HTML 本身 When 读取资源 Then 缓存和新资源均再次校验权限', async () => {
    const f = fixture()
    let allowed = true
    const { url } = await f.service.create({ owner: f.owner, filePath: '/site/index.html', authorize: (_, resource) => allowed && resource === 'index.html' })
    expect((await f.registry.handleRequest(new Request(new URL('secret.txt', url)))).status).toBe(403)
    allowed = false
    expect((await f.registry.handleRequest(new Request(url))).status).toBe(403)
    f.service.release(f.owner, url)
  })

  test('Given 缓存预算已满 When 读更多资源 Then 拒绝超限并在关闭后归还预算', async () => {
    const f = fixture(13)
    const { url } = await f.service.create({ owner: f.owner, filePath: '/site/index.html', authorize: () => true })
    expect((await f.registry.handleRequest(new Request(new URL('asset.js', url)))).status).toBe(413)
    f.service.release(f.owner, url)
    const reopened = await f.service.create({ owner: f.owner, filePath: '/site/index.html', authorize: () => true })
    expect((await f.registry.handleRequest(new Request(reopened.url))).status).toBe(200)
    f.service.release(f.owner, reopened.url)
  })
})

 test('Given 已缓存 HTML 的会话失效 When 授权函数抛出 Then 仍报告授权拒绝', async () => {
  const f = fixture()
  let revoked = false
  const { url } = await f.service.create({ owner: f.owner, filePath: '/site/index.html', authorize: () => {
    if (revoked) throw new Error('Agent 会话不存在')
    return true
  } })
  revoked = true
  expect((await f.registry.handleRequest(new Request(url))).status).toBe(403)
  f.service.release(f.owner, url)
})
