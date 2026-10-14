import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

/** 从系统申请空闲端口，避免和用户正在运行的 dev 实例冲突。 */
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

/** 等待真实 DOM 或内存状态成立，超时附带当前页面文本。 */
async function waitFor(window: BrowserWindow, expression: string, message: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 40))
  }
  const evidence = await window.webContents.executeJavaScript(`({ text: document.body.innerText.slice(0, 1800), html: document.body.innerHTML.slice(0, 1200), calls: window.__interactionSmoke?.state?.calls?.slice(-8) })`)
  console.error(`[Interaction Design UI smoke] 等待失败：${message}`, evidence)
  throw new Error(message)
}

/** 点击精确文本的可见按钮或 Radix Tab。 */
async function click(window: BrowserWindow, label: string): Promise<void> {
  const expression = `[...document.querySelectorAll('button,[role="tab"],[role="menuitem"]')].find((element) => element.textContent?.trim() === ${JSON.stringify(label)} && element.getBoundingClientRect().width > 0)`
  await waitFor(window, expression, `缺少可见入口：${label}`)
  const point = await window.webContents.executeJavaScript(`(async () => {
    const element = ${expression};
    if (!(element instanceof HTMLElement)) return null;
    element.scrollIntoView({ block: 'nearest' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = element.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`)
  assert.ok(point, `无法点击：${label}`)
  window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
  window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
}


/** 真实指针事件覆盖 Radix pointerdown。 */
async function clickSelector(window: BrowserWindow, selector: string): Promise<void> {
  await waitFor(window, `document.querySelector(${JSON.stringify(selector)})`, `缺少节点 ${selector}`)
  const point = await window.webContents.executeJavaScript(`(() => {const node=document.querySelector(${JSON.stringify(selector)});const rect=node.getBoundingClientRect();return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)}})()`)
  window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
  window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
}
/** Escape 逐层关闭真实菜单。 */
async function escape(window: BrowserWindow): Promise<void> {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
}
/** 隔离 userData，业务 API 全为内存 fixture。 */
async function runElectronSmoke(app: import('electron').App, BrowserWindowCtor: typeof import('electron').BrowserWindow): Promise<void> {
  const url = process.env.PROMA_INTERACTION_DESIGN_FIXTURE_URL
  if (!url) throw new Error('缺少 fixture URL')
  await app.whenReady()
  const window = new BrowserWindowCtor({ width: 1180, height: 850, show: false, webPreferences: { backgroundThrottling: false } })
  const errors: string[] = []
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
  try {
    await window.loadURL(url)
    await waitFor(window, `document.querySelector('iframe') && document.body.textContent.includes('已保存 v1')`, '工作区未就绪')
    for (const width of [1180, 820, 390]) {
      window.setSize(width, 850)
      await window.webContents.executeJavaScript(`new Promise(resolve=>setTimeout(resolve,180))`)
      await window.webContents.executeJavaScript(`window.__frame=document.querySelector('iframe');window.__rect=JSON.stringify(window.__frame.getBoundingClientRect().toJSON());window.__src=window.__frame.srcdoc`)
      await click(window, '页面'); await waitFor(window, `document.querySelector('.id-directory')`, '目录未展开')
      assert.equal(await window.webContents.executeJavaScript(`window.__frame===document.querySelector('iframe') && window.__src===window.__frame.srcdoc && window.__rect===JSON.stringify(window.__frame.getBoundingClientRect().toJSON())`), true, `${width}px 目录挤压或重建预览`)
      await clickSelector(window, '[aria-label="今日习惯页面操作"]'); await waitFor(window, `document.querySelector('[role="menu"]')`, '页面菜单未显示')
      const menu = await window.webContents.executeJavaScript(`document.querySelector('[role="menu"]').textContent`)
      for (const label of ['复制', '重命名', '设为入口', '删除']) assert.ok(menu.includes(label), `缺少菜单 ${label}`)
      assert.ok(!menu.includes('移动到'), '无分组页面不应显示移动到菜单')
      if (width === 1180) { await window.webContents.executeJavaScript(`Promise.all(document.getAnimations().filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation=>animation.finished.catch(()=>undefined))).then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))`); await writeFile('/private/tmp/interaction-design-ui-directory-menu.png', (await window.webContents.capturePage()).toPNG()) }
      await escape(window); await waitFor(window, `!document.querySelector('[role="menu"]')`, '菜单未收起')
      await escape(window); await waitFor(window, `!document.querySelector('.id-directory')`, '目录未收起')
      assert.equal(await window.webContents.executeJavaScript(`window.__frame===document.querySelector('iframe')`), true)
    }
    /** Agent 在当前项目新建其他原型时，变更事件必须刷新目录并让候选可发现。 */
    await window.webContents.executeJavaScript(`window.__interactionSmoke.change('workspace-a', 'proto-remote')`)
    await waitFor(window, `document.querySelectorAll('select[aria-label="选择原型"] option').length === 2`, '其他原型变更后目录未刷新')
    await window.webContents.executeJavaScript(`(() => { const select = document.querySelector('select[aria-label="选择原型"]'); if (!(select instanceof HTMLSelectElement)) return false; const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set; setter?.call(select, 'proto-remote'); select.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
    await waitFor(window, `document.querySelector('select[aria-label="选择原型"]')?.value === 'proto-remote' && document.body.textContent.includes('导入缓存页面')`, '切换新原型后候选未显示')
    assert.equal(await window.webContents.executeJavaScript(`window.__interactionSmoke.state.calls.filter(call => call === 'list:session-a').length > 1`), true, '其他原型事件未触发目录读取')
    await click(window, '预览'); await waitFor(window, `document.querySelector('.id-candidate-preview') && document.body.textContent.includes('缓存页')`, '导入候选预览未定位新增页面')
    await click(window, '返回当前版本')
    /** 无原型项目的新建页面表单不应被外部变更事件误判为旧版本冲突。 */
    await window.webContents.executeJavaScript(`window.__interactionSmoke.switchEmpty()`)
    await waitFor(window, `document.querySelector('select[aria-label="选择原型"]')?.value === '' && document.body.textContent.includes('从需求或现有项目开始')`, '无原型项目未就绪')
    await click(window, '页面'); await waitFor(window, `document.querySelector('.id-directory')`, '无原型项目目录未展开')
    await waitFor(window, `document.body.textContent.includes('当前项目还没有页面')`, '无页面目录内容未就绪')
    await click(window, '新建页面'); await waitFor(window, `document.querySelector('[role="dialog"]')`, '新建页面表单未打开')
    await window.webContents.executeJavaScript(`window.__interactionSmoke.change('workspace-c')`)
    await waitFor(window, `document.querySelector('[role="dialog"]') && !document.body.textContent.includes('外部版本已变化')`, '新建页面表单被误报外部版本变化')
    await clickSelector(window, 'input[aria-label="新建页面"]')
    await window.webContents.executeJavaScript(`(() => { const input = document.querySelector('input[aria-label="新建页面"]'); if (!(input instanceof HTMLInputElement)) return false; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; setter?.call(input, '你好'); input.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await click(window, '保存')
    await waitFor(window, `document.body.textContent.includes('已保存 v1') && document.body.textContent.includes('你好') && !document.querySelector('[role="dialog"]')`, '新建页面表单提交失败')
    await window.loadURL(url)
    await waitFor(window, `document.querySelector('iframe') && document.body.textContent.includes('已保存 v1')`, '新建回归后工作区未重置')
    await window.webContents.executeJavaScript(`window.__frame=document.querySelector('iframe');window.__src=window.__frame.srcdoc`)
    window.setSize(1180, 850)
    await click(window, '选择修改'); await click(window, '体验')
    assert.equal(await window.webContents.executeJavaScript(`window.__frame===document.querySelector('iframe') && window.__src===window.__frame.srcdoc`), true, '切换选择模式重建正文')
    await clickSelector(window, '[aria-label="桌面预览"]')
    assert.equal(await window.webContents.executeJavaScript(`window.__frame===document.querySelector('iframe') && window.__src===window.__frame.srcdoc`), true, '设备切换重建正文')
    await clickSelector(window, '[aria-label="手机预览"]')
    const lightBackground = await window.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.interaction-design')).backgroundColor`)
    await window.webContents.executeJavaScript(`document.documentElement.classList.add('dark');new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
    const darkBackground = await window.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.interaction-design')).backgroundColor`)
    assert.notEqual(darkBackground, lightBackground, '深色主题未生效')
    assert.equal(darkBackground, 'rgb(26, 26, 26)', '深色主题背景不匹配宿主变量')
    await window.webContents.executeJavaScript(`Promise.all(document.getAnimations().filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation=>animation.finished.catch(()=>undefined))).then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))`)
    await writeFile('/private/tmp/interaction-design-ui-dark.png', (await window.webContents.capturePage()).toPNG())
    await window.webContents.executeJavaScript(`document.documentElement.classList.remove('dark')`)
    await click(window, '预览'); await waitFor(window, `document.querySelector('.id-candidate-preview')`, '候选未预览')
    assert.equal(await window.webContents.executeJavaScript(`window.__interactionSmoke.state.snapshot.document.revision`), 1, '预览自动采纳')
    await click(window, '返回当前版本'); await click(window, '采纳')
    await waitFor(window, `document.body.textContent.includes('已保存 v2')`, '采纳未形成版本')
    await click(window, 'v2'); await click(window, '恢复此版本')
    await waitFor(window, `document.body.textContent.includes('已保存 v3') && !document.querySelector('[role="dialog"]')`, '恢复未形成新版本')
    await clickSelector(window, '[aria-label="更多原型操作"]'); await click(window, '从现有项目还原')
    await waitFor(window, `document.querySelector('.id-source-list input')`, '项目来源未显示')
    await clickSelector(window, '.id-source-list input'); await click(window, '引用到主会话')
    await waitFor(window, `window.__interactionSmoke.prompt()`, '没有真实会话引用')
    const prompt = await window.webContents.executeJavaScript(`window.__interactionSmoke.prompt()`)
    assert.equal(prompt.sessionId, 'session-a'); assert.equal(prompt.autoSend, false)
    assert.ok(prompt.message.includes('prototypeId: proto-a') && prompt.message.includes('baseRevision: 3') && prompt.message.includes('src/App.tsx'))
    await waitFor(window, `!document.querySelector('[role="dialog"]') && !document.querySelector('[role="menu"]')`, '截图前对话框和菜单尚未退出')
    await window.webContents.executeJavaScript(`Promise.all(document.getAnimations().filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation=>animation.finished.catch(()=>undefined))).then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))`)
    await writeFile('/private/tmp/interaction-design-ui-desktop.png', (await window.webContents.capturePage()).toPNG())
    await window.loadURL(url); await waitFor(window, `document.body.textContent.includes('已保存 v1')`, '迟到场景未就绪')
    await window.webContents.executeJavaScript(`window.__interactionSmoke.state.holdCandidate=true`)
    await click(window, '预览'); await waitFor(window, `window.__interactionSmoke.state.pendingCandidate`, '候选请求未挂起')
    await window.webContents.executeJavaScript(`window.__interactionSmoke.switchHost()`)
    await waitFor(window, `window.__interactionSmoke.state.calls.includes('load:session-b') && document.querySelector('select[aria-label="选择原型"]')?.selectedOptions[0]?.textContent==='新项目原型'`, '新项目尚未加载')
    await window.webContents.executeJavaScript(`window.__interactionSmoke.release()`)
    await waitFor(window, `!window.__interactionSmoke.state.pendingCandidate`, '旧请求未释放')
    assert.equal(await window.webContents.executeJavaScript(`!!document.querySelector('.id-candidate-preview')`), false, '旧候选污染新项目')
    assert.equal(await window.webContents.executeJavaScript(`window.__interactionSmoke.prompt()`), null, '旧响应污染新会话')
    assert.deepEqual(errors, [])
    console.log('[Interaction Design UI smoke] PASS: 3种宽度画布式页面目录覆盖无位移/重建、4项页面菜单、模式/设备稳定、深色、候选/采纳/恢复、项目引用及迟到隔离；未访问真实业务数据')
  } finally { window.destroy() }
}
/** Bun 父进程启动临时 Vite，再构建并执行 Electron 子进程。 */
async function orchestrate(): Promise<void> {
  const port = await availablePort()
  const baseUrl = `http://127.0.0.1:${port}`
  /** HTML 只在 smoke 运行期间存在，结束后删除，仓库仍只保留两份脚本。 */
  const fixtureHtmlPath = join(process.cwd(), 'scripts', `.interaction-design-ui-smoke-${process.pid}.html`)
  const fixtureUrl = `${baseUrl}/@fs${fixtureHtmlPath}`
  await writeFile(fixtureHtmlPath, '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Interaction Design UI Smoke</title></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => undefined; window.$RefreshSig$ = () => (type) => type;</script><script type="module" src="./interaction-design-ui-smoke-renderer.tsx"></script></body></html>')
  const fixtureConfigPath = join(process.cwd(), 'scripts', `.interaction-design-smoke-config-${process.pid}.ts`)
  await writeFile(fixtureConfigPath, "import config from '../vite.config';export default {...config,server:{...config.server,hmr:false,watch:null}}")
  const vite = spawn(process.execPath, [join(process.cwd(), 'node_modules/vite/bin/vite.js'), '--config', fixtureConfigPath, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: process.cwd(), stdio: 'inherit' })
  try {
    const deadline = Date.now() + 20_000
    let ready = false
    while (Date.now() < deadline) {
      try {
        const response = await fetch(fixtureUrl)
        if (response.ok) { ready = true; break }
      } catch { /* 等待 Vite */ }
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error('Vite smoke renderer 启动超时')

    const buildDir = await mkdtemp(join(tmpdir(), 'proma-interaction-design-ui-smoke-build-'))
    try {
      /** 父进程在 Electron 完全退出后清理 userData，避免 Chromium 退出写入与删除竞争。 */
      const userDataPath = await mkdtemp(join(buildDir, 'user-data-'))
      const build = await Bun.build({ entrypoints: [join(process.cwd(), 'scripts/interaction-design-ui-smoke.ts')], outdir: buildDir, target: 'node', format: 'cjs', external: ['electron'] })
      if (!build.success || !build.outputs[0]) throw new Error('构建 Interaction Design UI smoke 入口失败')
      const electronPath = process.env.PROMA_ELECTRON_PATH ?? join(process.cwd(), 'node_modules/.bin/electron')
      const electron = spawn(electronPath, [build.outputs[0].path], {
        cwd: process.cwd(),
        env: { ...process.env, PROMA_INTERACTION_DESIGN_UI_SMOKE_CHILD: '1', PROMA_INTERACTION_DESIGN_FIXTURE_URL: fixtureUrl, PROMA_INTERACTION_DESIGN_SMOKE_USER_DATA: userDataPath },
        stdio: 'inherit',
      })
      const code = await new Promise<number>((resolve, reject) => {
        /** 超时也等子进程退出才清理临时目录。 */
        let timedOut = false
        const timeout = setTimeout(() => { timedOut = true; electron.kill('SIGKILL') }, 90_000)
        electron.once('error', (error) => { clearTimeout(timeout); reject(error) })
        electron.once('exit', (value) => {
          clearTimeout(timeout)
          if (timedOut) reject(new Error('Interaction Design UI smoke 超时'))
          else resolve(value ?? 1)
        })
      })
      assert.equal(code, 0, `Electron smoke 退出码 ${code}`)
    } finally {
      await rm(buildDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  } finally {
    vite.kill('SIGTERM')
    await rm(fixtureHtmlPath, { force: true })
    await rm(fixtureConfigPath, { force: true })
  }
}

if (process.env.PROMA_INTERACTION_DESIGN_UI_SMOKE_CHILD === '1') {
  const electron = require('electron') as typeof import('electron')
  const userDataPath = process.env.PROMA_INTERACTION_DESIGN_SMOKE_USER_DATA
  if (!userDataPath) throw new Error('缺少隔离 userData 目录')
  electron.app.setPath('userData', userDataPath)
  /** 失败时 finally 会先销毁窗口；阻止默认生命周期抢在 catch 前以 0 退出。 */
  electron.app.on('window-all-closed', () => undefined)
  const keepAlive = setInterval(() => undefined, 1_000)
  void runElectronSmoke(electron.app, electron.BrowserWindow)
    .then(() => { clearInterval(keepAlive); electron.app.quit() })
    .catch((error: unknown) => {
      clearInterval(keepAlive)
      console.error('[Interaction Design UI smoke] FAIL', error)
      electron.app.exit(1)
    })
} else {
  void orchestrate().catch((error: unknown) => { console.error('[Interaction Design UI smoke] FAIL', error); process.exitCode = 1 })
}
