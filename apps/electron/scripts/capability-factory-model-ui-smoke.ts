import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  /** 失败时保留菜单实际高度与滚动位置，区分滚动锁、裁切和测试事件时序。 */
  const scroll = await window.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('[aria-label="选择模型"] .overflow-y-auto');
    return list ? { top: list.scrollTop, height: list.clientHeight, total: list.scrollHeight,
      listBottom: list.getBoundingClientRect().bottom, lastBottom: list.querySelector('button:last-child')?.getBoundingClientRect().bottom } : null;
  })()`)
  throw new Error(`${message}；滚动状态：${JSON.stringify(scroll)}；当前页面：${text}`)
}

/** 按文字或 aria-label 找按钮并用真实鼠标点击；同时检查弹层未挡住点击位置。 */
async function click(window: BrowserWindow, label: string): Promise<void> {
  /** 等待入场动画结束，防止取到变换过程中的按钮坐标。 */
  await window.webContents.executeJavaScript('Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined)))')
  /** 渲染进程返回按钮中心坐标；命中遮罩时直接失败，避免脚本 click 绕过模态层。 */
  const position = await window.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('button, [role="menuitem"]')].find((item) => item.textContent?.trim() === ${JSON.stringify(label)} || item.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (!(button instanceof HTMLElement)) return null;
    button.scrollIntoView({ block: 'nearest' });
    const rect = button.getBoundingClientRect();
    const x = Math.round(rect.x + rect.width / 2);
    const y = Math.round(rect.y + rect.height / 2);
    if (!button.contains(document.elementFromPoint(x, y))) return null;
    return { x, y };
  })()`) as { x: number; y: number } | null
  assert.ok(position, `按钮不存在或被遮挡：${label}`)
  window.webContents.sendInputEvent({ type: 'mouseMove', ...position })
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...position })
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...position })
}

/** 发送真实滚轮或触控板精细滚动事件；deltaY 负值向下、正值向上，不用 scrollTop 模拟滚动。 */
async function scrollModelList(window: BrowserWindow, deltaY: number, precise = false): Promise<void> {
  await window.webContents.executeJavaScript('Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined)))')
  /** 获取列表中部坐标，滚动应由当前弹层接收。 */
  const position = await window.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('[aria-label="选择模型"] .overflow-y-auto');
    const rect = list.getBoundingClientRect();
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  })()`) as { x: number; y: number }
  window.webContents.sendInputEvent({ type: 'mouseMove', ...position })
  window.webContents.sendInputEvent({ type: 'mouseWheel', deltaY, deltaX: 0, canScroll: true, hasPreciseScrollingDeltas: precise, ...position })
}

/** 在隐藏 Electron 窗口里验证生产模型选择组件的保存和失败路径。 */
async function runElectronSmoke(app: import('electron').App, BrowserWindowCtor: typeof import('electron').BrowserWindow): Promise<void> {
  const url = process.env.PROMA_FACTORY_MODEL_UI_SMOKE_URL
  if (!url) throw new Error('缺少 smoke URL')
  await app.whenReady()
  const window = new BrowserWindowCtor({ width: 800, height: 620, show: false, webPreferences: { backgroundThrottling: false } })
  window.webContents.on('console-message', (event) => { if (event.level === 'error') console.error('[renderer]', event.message) })
  try {
    await window.loadURL(url)
    await waitFor(window, "document.body.dataset.smokeReady === 'true'", '组件未挂载')
    await waitFor(window, "[...document.querySelectorAll('button')].some((button) => button.textContent.trim() === '模型设置')", '标题栏模型设置按钮未出现')
    assert.equal(await window.webContents.executeJavaScript("Boolean(document.querySelector('[role=dialog]'))"), false, '弹窗不应默认打开')
    assert.equal(await window.webContents.executeJavaScript(`(() => {
      const settings = [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '模型设置');
      const selector = document.querySelector('[aria-label="切换编排场景"]');
      const header = document.querySelector('h1').parentElement.parentElement;
      return header.contains(settings) && header.contains(selector) && settings.getBoundingClientRect().right <= selector.getBoundingClientRect().left;
    })()`), true, '模型设置应在标题栏的场景选择器左侧')
    await click(window, '模型设置')
    await waitFor(window, "document.querySelector('[role=dialog][data-state=open]')", '模型设置弹窗未打开')
    for (const label of ['运行模型', '自动匹配', '评审模型', '跟随运行模型']) {
      assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[role=dialog]').textContent.includes(${JSON.stringify(label)})`), true, `缺少默认说明：${label}`)
    }
    await click(window, '自动匹配')
    await waitFor(window, "[...document.querySelectorAll('button')].some((button) => button.textContent.trim() === '测试模型')", '模型菜单未展开')
    assert.equal(await window.webContents.executeJavaScript(`(() => {
      const list = document.querySelector('[aria-label="选择模型"] .overflow-y-auto');
      return list.scrollHeight > list.clientHeight;
    })()`), true, '夹具需要覆盖超出可见区域的模型长列表')
    await scrollModelList(window, -500)
    await waitFor(window, "document.querySelector('[aria-label=\"选择模型\"] .overflow-y-auto').scrollTop > 100", '弹窗内模型列表不能向下滚动')
    await scrollModelList(window, 500, true)
    await waitFor(window, "document.querySelector('[aria-label=\"选择模型\"] .overflow-y-auto').scrollTop < 10", '弹窗内模型列表不能向上滚动')
    // Chromium 会限制单次普通滚轮事件的距离，像真实使用一样连续滚动到列表末尾。
    for (let attempt = 0; attempt < 10; attempt += 1) {
      /** 每次读取当前位置，只在尚未到底时继续滚动，防止把浏览器的单次限幅误判为控件问题。 */
      const remaining = await window.webContents.executeJavaScript(`(() => {
        const list = document.querySelector('[aria-label="选择模型"] .overflow-y-auto');
        return { top: list.scrollTop, distance: list.scrollHeight - list.clientHeight - list.scrollTop };
      })()`) as { top: number; distance: number }
      if (remaining.distance < 2) break
      await scrollModelList(window, -500)
      await waitFor(window, `document.querySelector('[aria-label="选择模型"] .overflow-y-auto').scrollTop > ${remaining.top}`, '连续滚动时列表停滞')
    }
    await waitFor(window, `(() => {
      const list = document.querySelector('[aria-label="选择模型"] .overflow-y-auto');
      const target = [...list.querySelectorAll('button')].find((button) => button.textContent.trim() === '测试模型');
      return target.getBoundingClientRect().bottom <= list.getBoundingClientRect().bottom + 1;
    })()`, '滚动到底后末尾模型仍不可见')
    assert.equal(await window.webContents.executeJavaScript(`(() => {
      const rect = document.querySelector('[aria-label="选择模型"]').getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= innerHeight;
    })()`), true, '模型菜单不能超出当前窗口的可见高度')
    await click(window, '测试模型')
    await waitFor(window, 'window.__factoryModelSmoke.state.refreshes === 1', '选择未成功保存')
    assert.equal(await window.webContents.executeJavaScript("Boolean(document.querySelector('[role=dialog][data-state=open]'))"), true, '成功保存后应保持弹窗打开')
    assert.deepEqual(await window.webContents.executeJavaScript('window.__factoryModelSmoke.state.calls[0]'), {
      command: 'setModelSelection', input: { sessionId: 'session', sceneId: 'scene', selection: { slots: { main: { channelId: 'test-channel', modelId: 'test-model' } } }, expectedState: { currentVersion: 7, draft: null } },
    }, '保存请求没有携带完整模型引用和版本基线')
    assert.deepEqual(await window.webContents.executeJavaScript('window.__factoryModelSmoke.globalModel()'), { channelId: 'global-channel', modelId: 'global-model' }, '污染全局模型')
    assert.equal(await window.webContents.executeJavaScript('window.__factoryModelSmoke.state.conversationWrites'), 0, '污染对话模型')
    await click(window, '跟随运行模型')
    await waitFor(window, "document.querySelector('[aria-label=\"选择模型\"]')", '评审模型菜单未打开')
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await waitFor(window, "!document.querySelector('[aria-label=\"选择模型\"]')", 'Escape 未关闭模型菜单')
    assert.equal(await window.webContents.executeJavaScript("Boolean(document.querySelector('[role=dialog][data-state=open]'))"), true, '关闭菜单不应连同设置弹窗一起关闭')
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('[role=dialog]').textContent.includes('test-channel')"), false, '常规设置不应展示内部渠道 ID')
    /** 按需输出深浅主题截图，供界面改动时检查真实渲染效果。 */
    const screenshotDir = process.env.PROMA_FACTORY_MODEL_UI_SMOKE_SCREENSHOT_DIR
    if (screenshotDir) {
      await mkdir(screenshotDir, { recursive: true })
      for (const mode of ['light', 'dark']) {
        await window.webContents.executeJavaScript(`window.__factoryModelSmoke.setTheme(${JSON.stringify(mode)}); new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
        // 主题切换会触发控件颜色过渡，等待完成后再截图，避免截到深浅主题混合帧。
        await window.webContents.executeJavaScript('Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined)))')
        await writeFile(join(screenshotDir, `model-settings-${mode}.png`), (await window.webContents.capturePage()).toPNG())
      }
    }
    await window.webContents.executeJavaScript("window.__factoryModelSmoke.state.fail = true")
    await click(window, '自动匹配')
    await waitFor(window, "document.querySelector('[role=alert]')?.textContent.includes('模拟保存失败')", '失败没有展示')
    assert.equal(await window.webContents.executeJavaScript('window.__factoryModelSmoke.state.refreshes'), 1, '失败却触发成功刷新')
    assert.equal(await window.webContents.executeJavaScript("document.body.innerText.includes('测试渠道 · 测试模型')"), true, '失败丢失原模型')
    await click(window, '完成')
    await waitFor(window, "!document.querySelector('[role=dialog]')", '完成按钮未关闭弹窗')
    assert.equal(await window.webContents.executeJavaScript("document.activeElement?.textContent.trim()"), '模型设置', '关闭后焦点未返回入口')
    await click(window, '模型设置')
    await waitFor(window, "document.querySelector('[role=dialog][data-state=open]')", '关闭后不能再次打开')
    await click(window, '关闭')
    await waitFor(window, "!document.querySelector('[role=dialog]')", '项目通用关闭按钮未关闭弹窗')
    await click(window, '模型设置')
    await waitFor(window, "document.querySelector('[role=dialog][data-state=open]')", '失效检查前弹窗未打开')
    await window.webContents.executeJavaScript('window.__factoryModelSmoke.removeChannels()')
    await waitFor(window, "document.body.innerText.includes('所选渠道或模型已不可用，请重新选择')", '缺少失效模型提示')
    assert.equal(await window.webContents.executeJavaScript("document.body.innerText.includes('test-model')"), true, '失效引用应保留模型线索')
    await click(window, '配置渠道')
    await waitFor(window, "!document.querySelector('[role=dialog]')", '跳转配置渠道前未关闭弹窗')
    assert.deepEqual(await window.webContents.executeJavaScript('window.__factoryModelSmoke.settings()'), { open: true, tab: 'channels' })
    await click(window, '模型设置')
    await waitFor(window, "document.querySelector('[role=dialog][data-state=open]')", 'Escape 检查前弹窗未打开')
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await waitFor(window, "!document.querySelector('[role=dialog]')", 'Escape 未关闭弹窗')
    console.log('[Capability Factory model UI smoke] PASS: 模型长列表真实滚轮上下滚动与末尾选择、标题栏位置、保存保持打开、版本基线、会话隔离、失败与失效引用、关闭焦点、渠道跳转、Escape')

  } catch (error) {
    // 在隔离夹具内保存失败截图，用于区分模型菜单裁切与滚轮事件被拦截。
    await writeFile(join(tmpdir(), 'dutydeck-model-scroll-failure.png'), (await window.webContents.capturePage()).toPNG())
    console.error('[model menu bounds]', await window.webContents.executeJavaScript(`(() => {
      const menu = document.querySelector('[aria-label="选择模型"]');
      const list = menu?.querySelector('.overflow-y-auto');
      return { viewport: innerHeight, menu: menu?.getBoundingClientRect().toJSON(), list: list?.getBoundingClientRect().toJSON(), available: menu ? getComputedStyle(menu).getPropertyValue('--radix-popover-content-available-height') : null };
    })()`))
    throw error
  } finally {
    window.destroy()
  }
}

/** Bun 父进程启动临时 Vite，再构建并执行隔离 Electron 子进程。 */
async function orchestrate(): Promise<void> {
  const port = await availablePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const htmlPath = join(process.cwd(), 'scripts', `.capability-factory-model-ui-smoke-${process.pid}.html`)
  const fixtureUrl = `${baseUrl}/@fs${htmlPath}`
  await writeFile(htmlPath, '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Factory Model Smoke</title></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => undefined; window.$RefreshSig$ = () => (type) => type;</script><script type="module" src="./capability-factory-model-ui-smoke-renderer.tsx"></script></body></html>')
  const vite = spawn(process.execPath, [join(process.cwd(), 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: process.cwd(), stdio: 'inherit' })
  try {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      try { if ((await fetch(fixtureUrl)).ok) break } catch { /* 等待 Vite */ }
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
    if (Date.now() >= deadline) throw new Error('Vite smoke 启动超时')
    const buildDir = await mkdtemp(join(tmpdir(), 'proma-factory-model-ui-smoke-'))
    try {
      const userData = await mkdtemp(join(buildDir, 'user-data-'))
      const build = await Bun.build({ entrypoints: [join(process.cwd(), 'scripts/capability-factory-model-ui-smoke.ts')], outdir: buildDir, target: 'node', format: 'cjs', external: ['electron'] })
      if (!build.success || !build.outputs[0]) throw new Error('构建 smoke 入口失败')
      const electronPath = process.env.PROMA_ELECTRON_PATH ?? join(process.cwd(), 'node_modules/.bin/electron')
      const electron = spawn(electronPath, [build.outputs[0].path], { cwd: process.cwd(), stdio: 'inherit', env: {
        ...process.env,
        PROMA_FACTORY_MODEL_UI_SMOKE_CHILD: '1',
        PROMA_FACTORY_MODEL_UI_SMOKE_URL: fixtureUrl,
        PROMA_FACTORY_MODEL_UI_SMOKE_USER_DATA: userData,
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

if (process.env.PROMA_FACTORY_MODEL_UI_SMOKE_CHILD === '1') {
  const electron = require('electron') as typeof import('electron')
  const userData = process.env.PROMA_FACTORY_MODEL_UI_SMOKE_USER_DATA
  if (!userData) throw new Error('缺少隔离 userData')
  electron.app.setPath('userData', userData)
  electron.app.on('window-all-closed', () => undefined)
  const keepAlive = setInterval(() => undefined, 1_000)
  void runElectronSmoke(electron.app, electron.BrowserWindow)
    .then(() => { clearInterval(keepAlive); electron.app.quit() })
    .catch((error: unknown) => { clearInterval(keepAlive); console.error('[Capability Factory model UI smoke] FAIL', error); electron.app.exit(1) })
} else {
  void orchestrate().catch((error: unknown) => { console.error('[Capability Factory model UI smoke] FAIL', error); process.exitCode = 1 })
}
