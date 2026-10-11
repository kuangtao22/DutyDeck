import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

/** 从系统取得空闲端口，避免碰撞正在运行的开发服务。 */
async function availablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('无法分配 smoke 端口'))
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

/** 等待真实 React DOM 满足条件，失败时带回当前页面文字。 */
async function waitFor(window: BrowserWindow, expression: string, message: string): Promise<void> {
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 40))
  }
  const text = await window.webContents.executeJavaScript('document.body.innerText')
  throw new Error(`${message}；当前页面：${text}`)
}

/** 真实窗口检查实验摘要的键盘、主题、窄面板与证据表。 */
async function runElectronSmoke(app: import('electron').App, BrowserWindowCtor: typeof import('electron').BrowserWindow): Promise<void> {
  const url = process.env.PROMA_FACTORY_EXPERIMENT_UI_SMOKE_URL
  if (!url) throw new Error('缺少预览地址')
  await app.whenReady()
  const window = new BrowserWindowCtor({ width: 390, height: 700, show: true, webPreferences: { backgroundThrottling: false } })
  try {
    await window.loadURL(url)
    await waitFor(window, "document.querySelector('summary')", '摘要未挂载')
    window.focus()
    window.webContents.focus()
    await window.webContents.executeJavaScript("document.querySelector('summary').focus()")
    await waitFor(window, "document.activeElement === document.querySelector('summary')", '摘要未获得焦点')
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
    window.webContents.sendInputEvent({ type: 'char', keyCode: ' ' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
    await waitFor(window, "document.querySelector('details').open", '键盘未展开摘要')
    for (const theme of ['light', 'dark']) {
      await window.webContents.executeJavaScript(`window.setSmokeTheme('${theme}')`)
      await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      assert.equal(await window.webContents.executeJavaScript('document.documentElement.scrollWidth <= innerWidth'), true, '窄窗口不能横向溢出')
      assert.equal(await window.webContents.executeJavaScript("document.body.innerText.includes('费用未知')"), true)
      assert.equal(await window.webContents.executeJavaScript("document.body.innerText.includes('小样本初步结果')"), true)
      assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('table tbody tr').length"), 1)
      await writeFile(join(tmpdir(), `dutydeck-experiment-${theme}.png`), (await window.webContents.capturePage()).toPNG())
    }
    await window.webContents.executeJavaScript("document.querySelector('summary').focus()")
    await waitFor(window, "document.activeElement === document.querySelector('summary')", '摘要未获得焦点')
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
    window.webContents.sendInputEvent({ type: 'char', keyCode: ' ' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
    await waitFor(window, "!document.querySelector('details').open", '键盘未收起摘要')
    console.log('[Capability Factory experiment UI smoke] PASS: 深浅主题、390px 窄窗口、键盘展开收起、未知费用、小样本与证据表')
  } finally { window.destroy() }
}

/** Bun 父进程启动临时 Vite，再构建并执行隔离 Electron 子进程。 */
async function orchestrate(): Promise<void> {
  const port = await availablePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const htmlPath = join(process.cwd(), 'scripts', `.capability-factory-experiment-ui-smoke-${process.pid}.html`)
  const fixtureUrl = `${baseUrl}/@fs${htmlPath}`
  await writeFile(htmlPath, '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Factory Model Smoke</title></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => undefined; window.$RefreshSig$ = () => (type) => type;</script><script type="module" src="./capability-factory-experiment-ui-smoke-renderer.tsx"></script></body></html>')
  const vite = spawn(process.execPath, [join(process.cwd(), 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: process.cwd(), stdio: 'inherit' })
  try {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      try { if ((await fetch(fixtureUrl)).ok) break } catch { /* 等待 Vite */ }
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
    if (Date.now() >= deadline) throw new Error('Vite smoke 启动超时')
    const buildDir = await mkdtemp(join(tmpdir(), 'proma-factory-experiment-ui-smoke-'))
    try {
      const userData = await mkdtemp(join(buildDir, 'user-data-'))
      const build = await Bun.build({ entrypoints: [join(process.cwd(), 'scripts/capability-factory-experiment-ui-smoke.ts')], outdir: buildDir, target: 'node', format: 'cjs', external: ['electron'] })
      if (!build.success || !build.outputs[0]) throw new Error('构建 smoke 入口失败')
      const electronPath = process.env.PROMA_ELECTRON_PATH ?? join(process.cwd(), 'node_modules/.bin/electron')
      const electron = spawn(electronPath, [build.outputs[0].path], { cwd: process.cwd(), stdio: 'inherit', env: {
        ...process.env,
        PROMA_FACTORY_EXPERIMENT_UI_SMOKE_CHILD: '1',
        PROMA_FACTORY_EXPERIMENT_UI_SMOKE_URL: fixtureUrl,
        PROMA_FACTORY_EXPERIMENT_UI_SMOKE_USER_DATA: userData,
      } })
      const code = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => electron.kill('SIGKILL'), 60_000)
        electron.once('error', (error) => { clearTimeout(timer); reject(error) })
        electron.once('exit', (value) => { clearTimeout(timer); resolve(value ?? 1) })
      })
      assert.equal(code, 0, `Electron smoke 退出码 ${code}`)
    } finally {
      await rm(buildDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  } finally {
    vite.kill('SIGTERM')
    await rm(htmlPath, { force: true })
  }
}

if (process.env.PROMA_FACTORY_EXPERIMENT_UI_SMOKE_CHILD === '1') {
  const electron = require('electron') as typeof import('electron')
  const userData = process.env.PROMA_FACTORY_EXPERIMENT_UI_SMOKE_USER_DATA
  if (!userData) throw new Error('缺少隔离 userData')
  electron.app.setPath('userData', userData)
  electron.app.on('window-all-closed', () => undefined)
  const keepAlive = setInterval(() => undefined, 1_000)
  void runElectronSmoke(electron.app, electron.BrowserWindow)
    .then(() => { clearInterval(keepAlive); electron.app.quit() })
    .catch((error: unknown) => { clearInterval(keepAlive); console.error('[Capability Factory experiment UI smoke] FAIL', error); electron.app.exit(1) })
} else {
  void orchestrate().catch((error: unknown) => { console.error('[Capability Factory experiment UI smoke] FAIL', error); process.exitCode = 1 })
}
