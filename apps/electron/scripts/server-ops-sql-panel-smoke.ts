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
    /** 临时 TCP 服务只用于申请端口。 */
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      /** 系统返回的本地监听地址。 */
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('无法分配 smoke 端口'))
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

/** 等待真实 React DOM 满足条件，失败时带回当前页面文字。 */
async function waitFor(window: BrowserWindow, expression: string, message: string): Promise<void> {
  /** 每项界面条件最多等待十二秒。 */
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 40))
  }
  /** 超时页面内容用于定位实际 UI 状态。 */
  const text = await window.webContents.executeJavaScript('document.body.innerText')
  throw new Error(`${message}；当前页面：${text}`)
}

/** 按文字或 aria-label 找按钮并用真实鼠标点击；同时检查弹层未挡住点击位置。 */
async function click(window: BrowserWindow, label: string): Promise<void> {
  /** 等待入场动画结束，防止取到变换过程中的按钮坐标。 */
  await window.webContents.executeJavaScript('Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined)))')
  /** 渲染进程返回按钮中心坐标；命中遮罩时直接失败，避免脚本 click 绕过模态层。 */
  const position = await window.webContents.executeJavaScript(`(() => {
    const root = document.querySelector('[role=alertdialog]') ?? document;
    const button = [...root.querySelectorAll('button, [role="menuitem"]')].find((item) => item.textContent?.trim() === ${JSON.stringify(label)} || item.getAttribute('aria-label') === ${JSON.stringify(label)} || (${JSON.stringify(label)} === '查询历史' && item.getAttribute('role') === 'tab' && item.textContent?.startsWith('查询历史')));
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
  await window.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
}

/** 通过真实历史回填入口更新编辑器，避免隐藏窗口原生菜单快捷键的差异。 */
async function enterSql(window: BrowserWindow, sql: string): Promise<void> {
  await window.webContents.executeJavaScript(`window.__sqlSmoke.state.draftSql = ${JSON.stringify(sql)}`)
  await click(window, '查询历史')
  await click(window, '刷新查询历史')
  await waitFor(window, `document.querySelector('[data-server-ops-sql-history] code')?.textContent === ${JSON.stringify(sql)}`, '夹具历史未刷新')
  await click(window, '填入编辑器')
  await waitFor(window, `document.querySelector('.cm-content').textContent === ${JSON.stringify(sql)}`, '历史回填未生效')
  /** 根据 SQL 自动决定结果页签文字，但不主动发起执行。 */
  const resultLabel = await window.webContents.executeJavaScript("[...document.querySelectorAll('[role=tab]')].find((tab) => tab.textContent.includes('结果')).textContent.trim()") as string
  await click(window, resultLabel)
}

/** 发送执行快捷键，验证鼠标与键盘复用同一确认边界。 */
function executeShortcut(window: BrowserWindow): void {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] })
}

/** 运行真实面板，数据库和配置接口均为纯内存 fixture。 */
async function runElectronSmoke(app: import('electron').App, BrowserWindowCtor: typeof import('electron').BrowserWindow): Promise<void> {
  /** 本机临时 Vite 页面地址，不连接真实数据库。 */
  const url = process.env.PROMA_SQL_PANEL_SMOKE_URL
  if (!url) throw new Error('缺少 smoke URL')
  await app.whenReady()
  /** 隐藏隔离窗口仍启用真实 Chromium 输入、布局和弹层。 */
  const window = new BrowserWindowCtor({ width: 780, height: 760, show: false, webPreferences: { backgroundThrottling: false } })
  window.webContents.on('console-message', (event) => { if (event.level === 'error') console.error('[renderer]', event.message) })
  try {
    await window.loadURL(url)
    await waitFor(window, "document.body.dataset.smokeReady === 'true'", '组件未挂载')
    await waitFor(window, "document.querySelector('[aria-label=\"执行\"]')", 'SQL 面板缺少统一执行入口')
    /** 固定 SQL 同时验证确认展示与请求不发生截断或改写。 */
    const sql = "UPDATE users SET name = '确认测试' WHERE id = 1;"
    await enterSql(window, sql)
    await click(window, '执行')
    await waitFor(window, "document.querySelector('[role=alertdialog]')", '执行未打开写入确认')
    assert.equal(await window.webContents.executeJavaScript('window.__sqlSmoke.state.writes.length'), 0, '确认前触发写入')
    for (const expected of [sql, '/fixture/open-api.db', 'main', '隔离 SSH SQLite']) {
      assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[role=alertdialog]').textContent.includes(${JSON.stringify(expected)})`), true, `确认缺少 ${expected}`)
    }
    await click(window, '取消')
    await waitFor(window, "!document.querySelector('[role=alertdialog]')", '取消未关闭确认')
    await window.webContents.executeJavaScript("document.querySelector('.cm-content').focus()")
    executeShortcut(window)
    await waitFor(window, "document.querySelector('[role=alertdialog]')", '快捷键未打开确认')
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await waitFor(window, "!document.querySelector('[role=alertdialog]')", 'Esc 未关闭确认')
    assert.equal(await window.webContents.executeJavaScript('window.__sqlSmoke.state.writes.length'), 0, '取消或 Esc 触发写入')
    await click(window, '执行')
    await waitFor(window, "document.querySelector('[role=alertdialog]')", '再次执行未确认')
    /** 可选深浅与窄屏截图保留真实确认卡布局。 */
    const screenshotDir = process.env.PROMA_SQL_PANEL_SMOKE_SCREENSHOT_DIR
    if (screenshotDir) {
      await mkdir(screenshotDir, { recursive: true })
      window.setSize(520, 720)
      for (const mode of ['light', 'dark']) {
        await window.webContents.executeJavaScript(`window.__sqlSmoke.setTheme(${JSON.stringify(mode)}); Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined)))`)
        await writeFile(join(screenshotDir, `sql-write-confirm-${mode}.png`), (await window.webContents.capturePage()).toPNG())
      }
      window.setSize(780, 760)
    }
    /** 记录刷新基线，确认回执完成后而非仅初次载入时读取历史。 */
    const historyBefore = await window.webContents.executeJavaScript('window.__sqlSmoke.state.historyReads') as number
    await click(window, '确认执行写入')
    await waitFor(window, 'window.__sqlSmoke.state.writes.length === 1', '批准没有写入')
    await waitFor(window, "!document.querySelector('[role=alertdialog]')", '批准后未关闭确认')
    await window.webContents.executeJavaScript("document.querySelector('.cm-content').focus()")
    executeShortcut(window)
    executeShortcut(window)
    assert.equal(await window.webContents.executeJavaScript('window.__sqlSmoke.state.writes.length'), 1, '在途重复执行')
    assert.equal(await window.webContents.executeJavaScript('window.__sqlSmoke.state.writes[0].sql'), sql)
    assert.equal(await window.webContents.executeJavaScript('window.__sqlSmoke.state.writes[0].source.filePath'), '/fixture/open-api.db')
    await window.webContents.executeJavaScript("window.__sqlSmoke.finish('committed')")
    await waitFor(window, "document.querySelector('[data-server-ops-sql-write-result]')?.textContent.includes('已提交')", '缺少提交回执')
    await waitFor(window, `window.__sqlSmoke.state.historyReads > ${historyBefore}`, '写入未刷新权威历史')
    if (screenshotDir) await writeFile(join(screenshotDir, 'sql-write-result-dark.png'), (await window.webContents.capturePage()).toPNG())
    await click(window, '执行')
    await waitFor(window, "document.querySelector('[role=alertdialog]')", '切库测试未打开确认')
    await window.webContents.executeJavaScript("window.__sqlSmoke.configure({ database: 'other' })")
    await waitFor(window, "!document.querySelector('[role=alertdialog]')", '切库未使旧确认失效')
    await window.webContents.executeJavaScript("window.__sqlSmoke.configure({ database: 'main' })")
    await enterSql(window, sql)
    await click(window, '执行')
    await waitFor(window, "document.querySelector('[role=alertdialog]')", '断线测试未打开确认')
    await window.webContents.executeJavaScript('window.__sqlSmoke.configure({ available: false })')
    await waitFor(window, "!document.querySelector('[role=alertdialog]')", '断线未使旧确认失效')
    assert.equal(await window.webContents.executeJavaScript('window.__sqlSmoke.state.writes.length'), 1, '切库或断线误发请求')
    await window.webContents.executeJavaScript('window.__sqlSmoke.configure({ available: true })')
    await enterSql(window, 'BEGIN;')
    await click(window, '执行')
    await waitFor(window, "document.querySelector('[role=alert]') || document.querySelector('[aria-label=\"SQL 校验提示\"]')", '危险语句未提示')
    assert.equal(await window.webContents.executeJavaScript("Boolean(document.querySelector('[role=alertdialog]'))"), false, 'BEGIN 不应进入确认')
    assert.equal(await window.webContents.executeJavaScript('window.__sqlSmoke.state.writes.length'), 1)
    await enterSql(window, sql)
    await click(window, '执行')
    await waitFor(window, "document.querySelector('[role=alertdialog]')", '配置变更测试未打开确认')
    await window.webContents.executeJavaScript("window.__sqlSmoke.configure({ filePath: '/fixture/other.db' })")
    await waitFor(window, "!document.querySelector('[role=alertdialog]')", '同 ID 文件配置变化没有撤销旧确认')
    assert.equal(await window.webContents.executeJavaScript('window.__sqlSmoke.state.writes.length'), 1, '配置变化触发写入')
    await enterSql(window, sql)
    await click(window, '执行')
    await waitFor(window, "document.querySelector('[role=alertdialog]')", 'unknown 测试未打开确认')
    await click(window, '确认执行写入')
    await waitFor(window, 'window.__sqlSmoke.state.writes.length === 2', '第二次批准未执行')
    await window.webContents.executeJavaScript("window.__sqlSmoke.finish('unknown')")
    await waitFor(window, "document.querySelector('[data-server-ops-sql-write-result]')?.textContent.includes('未知')", 'unknown 未明确展示')
    await new Promise<void>((resolve) => setTimeout(resolve, 600))
    assert.equal(await window.webContents.executeJavaScript('window.__sqlSmoke.state.writes.length'), 2, 'unknown 自动重试')
    await enterSql(window, 'SELECT id FROM users')
    await click(window, '执行')
    await waitFor(window, 'window.__sqlSmoke.state.queries.length === 1', 'SELECT 未走只读查询')
    await waitFor(window, "document.querySelector('[data-server-ops-sql-result]')?.textContent.includes('fixture-row')", '查询结果未出现')
    await window.webContents.executeJavaScript('window.__sqlSmoke.configure({ missingWrite: true })')
    await enterSql(window, sql)
    await waitFor(window, "document.querySelector('[aria-label=\"执行\"]')?.disabled", '缺接口仍可执行写入')
    await window.webContents.executeJavaScript("window.__sqlSmoke.configure({ missingWrite: false, postgres: true })")
    await enterSql(window, sql)
    await click(window, '执行')
    await waitFor(window, "document.querySelector('[role=alertdialog]')", 'PostgreSQL 未打开写入确认')
    assert.equal(await window.webContents.executeJavaScript('window.__sqlSmoke.state.writes.length'), 2, 'PostgreSQL 确认前触发写入')
    await click(window, '取消')
    await waitFor(window, "!document.querySelector('[role=alertdialog]')", 'PostgreSQL 取消未关闭确认')
    console.log('[SQL panel UI smoke] PASS: SSH SQLite、统一执行入口自动分流、确认/取消/Esc、精确目标/SQL、重复执行保护、回执/历史、切库/断线、BEGIN、unknown、SELECT、旧接口及 PostgreSQL')
  } finally {
    window.destroy()
  }
}

/** Bun 父进程启动临时 Vite，再构建并执行隔离 Electron 子进程。 */
async function orchestrate(): Promise<void> {
  /** 系统分配的隔离服务端口。 */
  const port = await availablePort()
  /** 只供本次测试访问的本机地址。 */
  const baseUrl = `http://127.0.0.1:${port}`
  /** 测试完成后删除的临时页面入口。 */
  const htmlPath = join(process.cwd(), 'scripts', `.server-ops-sql-panel-smoke-${process.pid}.html`)
  /** Vite 公开文件入口，不读取应用业务页面。 */
  const fixtureUrl = `${baseUrl}/@fs${htmlPath}`
  await writeFile(htmlPath, '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SQL Panel Smoke</title></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => undefined; window.$RefreshSig$ = () => (type) => type;</script><script type="module" src="./server-ops-sql-panel-smoke-renderer.tsx"></script></body></html>')
  /** 临时开发服务器，由 finally 统一关闭。 */
  const vite = spawn(process.execPath, [join(process.cwd(), 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: process.cwd(), stdio: 'inherit' })
  try {
    /** 服务启动等待上限。 */
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      try { if ((await fetch(fixtureUrl)).ok) break } catch { /* 等待 Vite */ }
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
    if (Date.now() >= deadline) throw new Error('Vite smoke 启动超时')
    /** 子进程构建和配置均限制在临时目录。 */
    const buildDir = await mkdtemp(join(tmpdir(), 'proma-sql-panel-smoke-'))
    try {
      /** 隔离 Electron 配置，禁止访问真实用户目录。 */
      const userData = await mkdtemp(join(buildDir, 'user-data-'))
      /** 使用项目自带 Bun 构建当前测试入口。 */
      const build = await Bun.build({ entrypoints: [join(process.cwd(), 'scripts/server-ops-sql-panel-smoke.ts')], outdir: buildDir, target: 'node', format: 'cjs', external: ['electron'] })
      if (!build.success || !build.outputs[0]) throw new Error('构建 smoke 入口失败')
      /** 允许 CI 指定已安装的 Electron 路径。 */
      const electronPath = process.env.PROMA_ELECTRON_PATH ?? join(process.cwd(), 'node_modules/.bin/electron')
      /** 隔离 Electron 子进程或当前子进程模块。 */
      const electron = spawn(electronPath, [build.outputs[0].path], { cwd: process.cwd(), stdio: 'inherit', env: {
        ...process.env,
        PROMA_SQL_PANEL_SMOKE_CHILD: '1',
        PROMA_SQL_PANEL_SMOKE_URL: fixtureUrl,
        PROMA_SQL_PANEL_SMOKE_USER_DATA: userData,
      } })
      /** 子进程最终退出码，非零直接失败。 */
      const code = await new Promise<number>((resolve, reject) => {
        /** 防止异常 UI 导致无限等待的进程上限。 */
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

if (process.env.PROMA_SQL_PANEL_SMOKE_CHILD === '1') {
  /** 隔离 Electron 子进程或当前子进程模块。 */
  const electron = require('electron') as typeof import('electron')
  /** 隔离 Electron 配置，禁止访问真实用户目录。 */
  const userData = process.env.PROMA_SQL_PANEL_SMOKE_USER_DATA
  if (!userData) throw new Error('缺少隔离 userData')
  electron.app.setPath('userData', userData)
  electron.app.on('window-all-closed', () => undefined)
  /** 维持隐藏窗口测试事件循环，退出时清除。 */
  const keepAlive = setInterval(() => undefined, 1_000)
  void runElectronSmoke(electron.app, electron.BrowserWindow)
    .then(() => { clearInterval(keepAlive); electron.app.quit() })
    .catch((error: unknown) => { clearInterval(keepAlive); console.error('[SQL panel UI smoke] FAIL', error); electron.app.exit(1) })
} else {
  void orchestrate().catch((error: unknown) => { console.error('[SQL panel UI smoke] FAIL', error); process.exitCode = 1 })
}
