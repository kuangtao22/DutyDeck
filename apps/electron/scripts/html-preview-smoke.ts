import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { app, BrowserWindow, protocol } from 'electron'
import { createHtmlPreviewService } from '../src/main/lib/html-preview-service'
import { createPromaFileProtocolRegistry } from '../src/main/lib/local-file-protocol'
import { runStableDirectoryNative } from '../src/main/lib/stable-directory-native-host'

/** 隔离测试数据和真实客户端；从 apps/electron 目录运行编译后的脚本。 */
const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'proma-html-preview-smoke-')))
const site = join(fixtureRoot, 'site')
const helperPath = resolve('resources/stable-directory', process.platform === 'win32' ? 'stable-directory-helper.exe' : 'stable-directory-helper')
app.setPath('userData', join(fixtureRoot, 'user-data'))
protocol.registerSchemesAsPrivileged([
  { scheme: 'proma-file', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
])

/** 用真实 sandbox iframe 验证资源、重开、身份防护和关闭回收。 */
async function verify(): Promise<void> {
  mkdirSync(join(site, 'assets'), { recursive: true })
  writeFileSync(join(site, 'index.htm'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="assets/style.css"><h1>HTML 预览已恢复</h1><img src="assets/pixel.png"><script type="module" src="assets/app.mjs"></script>')
  writeFileSync(join(site, 'assets/style.css'), '@font-face{font-family:Fixture;src:url("font.woff2")}h1{color:rgb(12,34,56);font-family:Fixture}')
  writeFileSync(join(site, 'assets/pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'))
  writeFileSync(join(site, 'assets/data.json'), '{"answer":42}')
  writeFileSync(join(site, 'assets/font.woff2'), readFileSync(resolve('node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2')))
  writeFileSync(join(site, 'assets/app.mjs'), `
    window.addEventListener('load', async () => {
      try {
        await document.fonts.ready;
        const data = await (await fetch('./assets/data.json')).json();
        parent.postMessage({ htmlPreviewSmoke: true, color: getComputedStyle(document.querySelector('h1')).color,
          image: document.querySelector('img').naturalWidth, font: document.fonts.check('16px Fixture'), answer: data.answer }, '*');
      } catch (error) { parent.postMessage({ htmlPreviewSmoke: true, error: String(error) }, '*'); }
    });
  `)
  writeFileSync(join(fixtureRoot, 'host.html'), '<!doctype html><script>window.addEventListener("message",e=>{if(e.data?.htmlPreviewSmoke)window.previewResult=e.data})</script><iframe sandbox="allow-scripts allow-forms" style="width:100%;height:90vh;border:0"></iframe>')
  await app.whenReady()
  const registry = createPromaFileProtocolRegistry()
  protocol.handle('proma-file', (request) => registry.handleRequest(request))
  const service = createHtmlPreviewService({ registry, run: (request, authorize) => runStableDirectoryNative(request, authorize, { helperPath: () => helperPath }) })
  const window = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  const errors: string[] = []
  window.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message) })
  try {
    await window.loadFile(join(fixtureRoot, 'host.html'))
    const input = { owner: window.webContents, filePath: join(site, 'index.htm'), authorize: () => true }
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1) writeFileSync(join(site, 'assets/data.json'), '{"answer":43}')
      const preview = await service.create(input)
      await window.webContents.executeJavaScript(`window.previewResult=null;document.querySelector('iframe').src=${JSON.stringify(preview.url)}`)
      const deadline = Date.now() + 15_000
      let result: unknown
      while (Date.now() < deadline) {
        result = await window.webContents.executeJavaScript('window.previewResult')
        if (result) break
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50))
      }
      assert.deepEqual(result, { htmlPreviewSmoke: true, color: 'rgb(12, 34, 56)', image: 1, font: true, answer: 42 + pass }, `渲染失败: ${errors.join('; ')}`)
      if (pass === 0) writeFileSync(join(fixtureRoot, 'preview.png'), (await window.webContents.capturePage()).toPNG())
      service.release(window.webContents, preview.url)
      assert.equal((await registry.handleRequest(new Request(preview.url))).status, 404)
    }
    const preview = await service.create(input)
    renameSync(site, join(fixtureRoot, 'original-site'))
    mkdirSync(site)
    writeFileSync(join(site, 'secret.txt'), 'replacement-secret')
    assert.equal((await registry.handleRequest(new Request(new URL('secret.txt', preview.url)))).status, 403)
    await new Promise<void>((resolveDestroyed) => { window.webContents.once('destroyed', () => resolveDestroyed()); window.destroy() })
    assert.equal((await registry.handleRequest(new Request(preview.url))).status, 404)
    assert.deepEqual(errors, [])
    console.log('HTML_PREVIEW_SMOKE_PASS: htm, CSS, module, image, font, fetch, refresh, release, directory replacement, window cleanup')
  } finally {
    if (!window.isDestroyed()) window.destroy()
  }
}
void verify().then(() => { rmSync(fixtureRoot, { recursive: true, force: true }); app.exit(0) }).catch((error: unknown) => { console.error(error); app.exit(1) })
