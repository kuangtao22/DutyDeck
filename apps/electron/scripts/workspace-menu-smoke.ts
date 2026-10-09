/**
 * 真实 Electron 菜单回归：先运行 dev:vite 和 build:preload，再在 apps/electron 执行
 * bun run scripts/workspace-menu-smoke.ts。仅使用临时窗口与 userData，不启动业务服务。
 */
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

/** 有界等待真实窗口或 DOM 条件；超时直接指出失败行为。 */
async function waitFor(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  /** 等待上限覆盖菜单 renderer 冷启动。 */
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(message)
}

/** 原生鼠标事件经过 Chromium 命中测试，保留 Radix 的 pointer/select 行为。 */
function clickAt(window: BrowserWindow, x: number, y: number): void {
  window.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
  window.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
}

/** 隔离主窗口只注册菜单与主题 IPC，验证生产菜单组件的打开及关闭行为。 */
async function runElectronSmoke(): Promise<void> {
  /** Electron 与主进程模块仅在子进程导入，Bun 父进程不初始化业务服务。 */
  const { app, BrowserWindow, ipcMain } = await import('electron')
  const { setMainWindow } = await import('../src/main/lib/main-window-store')
  const { prepareWorkspaceMenu, registerWorkspaceMenuIpcHandlers } = await import('../src/main/lib/workspace-menu-ipc')
  /** 测试目录由 Bun 父进程创建并在子进程退出后统一清理。 */
  const testDirectory = process.env.DUTYDECK_MENU_SMOKE_DIRECTORY!
  await mkdir(join(testDirectory, 'profile'), { recursive: true })
  app.setPath('userData', join(testDirectory, 'profile'))
  app.on('window-all-closed', () => undefined)
  await app.whenReady()
  ipcMain.handle('settings:get', () => ({ themeMode: 'dark', themeStyle: 'default' }))
  ipcMain.handle('settings:get-system-theme', () => true)

  /** 测试 owner 提供调用真实菜单 IPC 的隔离 renderer。 */
  const owner = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: { preload: join(testDirectory, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  })
  setMainWindow(owner)
  registerWorkspaceMenuIpcHandlers()
  await owner.loadURL('data:text/html,<h1>Workspace menu smoke</h1>')
  app.focus({ steal: true })
  owner.focus()
  await waitFor(() => owner.isFocused(), '测试主窗口未获焦')
  prepareWorkspaceMenu(owner)
  /** 生产服务创建的真实透明菜单窗口，不能以 DOM 替身代替。 */
  const popup = BrowserWindow.getAllWindows().find((window) => window !== owner)
  assert.ok(popup, '菜单浮窗未创建')

  /** 发起 SHOW 时不要等待选择 Promise，否则测试无法继续操作菜单。 */
  const open = async (): Promise<void> => {
    await owner.webContents.executeJavaScript(`
      window.__menuResult = 'pending';
      void window.electronAPI.showWorkspaceMenu({x:770,y:40,entries:[
        {type:'item',id:'open-file',label:'打开文件'},
        {type:'item',id:'open-memory',label:'打开知识库'}
      ]}).then(value => { window.__menuResult = value });
    `)
    await waitFor(async () => popup.isVisible()
      && await popup.webContents.executeJavaScript('document.querySelectorAll("[role=menu][data-state=open] [data-workspace-menu-action]").length === 2'),
    '菜单未显示完整操作项，或重开后立即闪退')
  }
  /** 专门观察异步焦点恢复后的状态，不能仅验证 show 的瞬间。 */
  const assertRemainsOpen = async (): Promise<void> => {
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    assert.equal(popup.isVisible(), true, '异步焦点事件导致菜单闪退')
    assert.equal(await popup.webContents.executeJavaScript('Boolean(document.querySelector("[role=menu][data-state=open]"))'), true, '原生浮窗可见但菜单 DOM 已关闭')
  }
  /** 同时验证窗口隐藏和调用者收到结果，排除只关闭 renderer 的假成功。 */
  const assertClosed = async (expected: string | null): Promise<void> => {
    await waitFor(async () => !popup.isVisible()
      && await owner.webContents.executeJavaScript(`window.__menuResult === ${JSON.stringify(expected)}`),
    `菜单未关闭或回传结果不等于 ${expected}`)
  }

  await open()
  /** Radix 的真实 focus guard 是旧版本触发 focusOutside 的目标。 */
  await popup.webContents.executeJavaScript(`(() => {
    const guard = document.querySelector('[data-radix-focus-guard]');
    if (!(guard instanceof HTMLElement)) throw new Error('缺少真实 Radix focus guard');
    guard.focus();
  })()`)
  await assertRemainsOpen()
  console.log('[菜单 smoke] PASS 内部焦点恢复不关闭菜单')
  /** 复现旧 renderer blur 晚于新窗口获焦投递；它不能绕过主进程的请求身份校验。 */
  await popup.webContents.executeJavaScript("window.dispatchEvent(new Event('blur'))")
  await assertRemainsOpen()
  console.log('[菜单 smoke] PASS 迟到的 renderer blur 不关闭新菜单')

  /** 原生 Escape 应继续关闭，不得因屏蔽内部失焦而失效。 */
  popup.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  popup.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await assertClosed(null)
  console.log('[菜单 smoke] PASS Escape 关闭并返回空结果')

  await open()
  /** 用真实菜单项的屏幕布局计算点击点。 */
  const point: { x: number; y: number } = await popup.webContents.executeJavaScript(`(() => {
    const item = document.querySelector('[data-workspace-menu-action="open-memory"]');
    const rect = item.getBoundingClientRect();
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  })()`)
  clickAt(popup, point.x, point.y)
  await assertClosed('open-memory')
  console.log('[菜单 smoke] PASS 点击菜单项回传正确动作')

  await open()
  await assertRemainsOpen()
  clickAt(popup, 1, 1)
  await assertClosed(null)
  console.log('[菜单 smoke] PASS 透明留白点击关闭')

  await open()
  await waitFor(() => popup.isFocused(), '菜单未取得原生窗口焦点')
  owner.focus()
  await assertClosed(null)
  console.log('[菜单 smoke] PASS 回到主窗口时关闭')

  /** 每轮均不等待旧 renderer 卸载就重开，覆盖隐藏窗口的延迟焦点恢复。 */
  for (let cycle = 0; cycle < 8; cycle += 1) {
    await open()
    await popup.webContents.executeJavaScript('void window.electronAPI.dismissWorkspaceMenu()')
    await open()
    await assertRemainsOpen()
  }
  console.log('[菜单 smoke] PASS 连续 16 次打开与快速重开')
  app.quit()
}

/** Bun 构建独立入口并回收子进程与临时文件；无需改动正在运行的开发客户端。 */
async function runParent(): Promise<void> {
  /** 菜单生产服务固定使用本地开发入口，测试只读取该服务。 */
  const response = await fetch('http://127.0.0.1:5174', { signal: AbortSignal.timeout(3_000) })
    .catch(() => null)
  assert.ok(response?.ok, '请先在 apps/electron 运行 bun run dev:vite（5174）')
  /** esbuild 保留运行时 __dirname，使生产服务正确找到临时目录中的 preload。 */
  const { build } = await import('esbuild')
  const testDirectory = await mkdtemp(join(tmpdir(), 'dutydeck-menu-smoke-'))
  try {
    await copyFile(join(process.cwd(), 'dist/preload.cjs'), join(testDirectory, 'preload.cjs'))
    await build({
      entryPoints: [join(process.cwd(), 'scripts/workspace-menu-smoke.ts')],
      outfile: join(testDirectory, 'smoke.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron', 'esbuild'],
    })
    /** 子进程只加载隔离入口，不启动真实工作区、自动化或 Agent。 */
    const child = spawn(join(process.cwd(), 'node_modules/.bin/electron'), [join(testDirectory, 'smoke.cjs')], {
      cwd: process.cwd(),
      env: { ...process.env, DUTYDECK_MENU_SMOKE_DIRECTORY: testDirectory },
      stdio: 'inherit',
    })
    /** 超时必须终止测试进程，避免留下后台窗口。 */
    const exitCode = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => child.kill('SIGTERM'), 45_000)
      child.once('error', (error) => { clearTimeout(timeout); reject(error) })
      child.once('exit', (code) => { clearTimeout(timeout); resolve(code ?? 1) })
    })
    assert.equal(exitCode, 0, '菜单 smoke 子进程失败或超时')
  } finally {
    await rm(testDirectory, { recursive: true, force: true })
  }
}

if (process.env.DUTYDECK_MENU_SMOKE_DIRECTORY) {
  void runElectronSmoke().catch(async (error: unknown) => {
    console.error('[菜单 smoke] FAIL', error)
    const { app } = await import('electron')
    app.exit(1)
  })
} else {
  void runParent().catch((error: unknown) => {
    console.error('[菜单 smoke] FAIL', error)
    process.exitCode = 1
  })
}
