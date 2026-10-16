/**
 * 隔离验证运行方式（工作目录 apps/electron）：
 * 1. bunx --no-install vite --host 127.0.0.1 --port 5197
 * 2. bunx --no-install esbuild scripts/canvas-agent-view-smoke.ts --bundle --platform=node --format=cjs --external:electron --outfile=/private/tmp/canvas-agent-view-smoke.cjs
 * 3. ./node_modules/.bin/electron /private/tmp/canvas-agent-view-smoke.cjs
 * 测试结束停止第1步Vite；临时Electron userData由脚本自动清理。不得连接用户客户端。
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import type { CanvasViewCommand, CanvasViewCommandResponse } from '@proma/shared'

/** 独立Vite fixture URL，不加载用户应用入口。 */
const fixtureUrl = `http://127.0.0.1:${process.env.PROMA_CANVAS_SMOKE_PORT ?? '5197'}/@fs${join(process.cwd(), 'scripts/canvas-agent-view-smoke.html')}`
/** 消息桥测试入口。 */
const state = 'window.__canvasAgentViewSmoke'
/** 等待真实DOM和会话状态。 */
async function waitFor(window: BrowserWindow, expression: string): Promise<void> {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 40))
  }
  throw new Error(`等待失败：${expression}; ${await window.webContents.executeJavaScript('document.body.innerText.slice(0,600)')}`)
}
/** 隔离Electron实例验证真实Workspace及ELK Worker。 */
async function run(): Promise<void> {
  const userDataPath = mkdtempSync(join(tmpdir(), 'dutydeck-agent-view-smoke-'))
  app.setPath('userData', userDataPath)
  app.on('window-all-closed', () => undefined)
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { backgroundThrottling: false } })
  const errors: string[] = []
  window.webContents.on('console-message', (event) => { if (event.level === 'error') { errors.push(event.message); console.error(event.message) } })
  const js = (code: string): Promise<unknown> => window.webContents.executeJavaScript(code)
  const command = (value: CanvasViewCommand): Promise<CanvasViewCommandResponse> => window.webContents.executeJavaScript(`${state}.command(${JSON.stringify(value)})`)
  try {
    await window.loadURL(fixtureUrl)
    await waitFor(window, `${state}?.ready()`)
    assert.equal((await command({ action: 'query' })).ok, true)
    assert.equal((await command({ action: 'select', nodeIds: ['a'] })).ok, true)
    await waitFor(window, `document.querySelector('.react-flow__node[data-id="a"]')?.classList.contains('selected')`)
    assert.equal((await command({ action: 'focus', nodeIds: ['b'] })).ok, true)
    await waitFor(window, `(() => { const n=document.querySelector('.react-flow__node[data-id="b"]').getBoundingClientRect(), s=document.querySelector('[data-native-canvas-surface]').getBoundingClientRect(); return n.left>=s.left && n.right<=s.right && n.top>=s.top && n.bottom<=s.bottom })()`)
    assert.equal((await command({ action: 'fit' })).ok, true)
    assert.equal((await command({ action: 'viewport', viewport: { x: 100, y: 120, zoom: 0.5 } })).ok, true)
    assert.equal((await command({ action: 'tool', tool: 'pan' })).ok, true)
    assert.equal((await command({ action: 'workbench', nodeId: 'a', size: { width: 600, height: 400 }, offset: { x: 30, y: 20 } })).ok, true)
    await waitFor(window, `document.querySelector('[data-smoke-workbench]')`)
    await js(`${state}.dirty(true)`)
    assert.equal(await command({ action: 'workbench', nodeId: 'b' }).then((response) => response.ok ? null : response.code), 'CANVAS_VIEW_UNSAVED_DRAFT')
    assert.equal(await js(`${state}.view().expandedNodeId`), 'a')
    await js(`${state}.dirty(false)`)
    assert.equal((await command({ action: 'workbench', nodeId: null })).ok, true)
    /** 真实ELK结果应是草案，Renderer不得通过普通SAVE持久化。 */
    const layout = await command({ action: 'arrange', scope: 'all', expectedRevision: 0 })
    assert.equal(layout.ok, true)
    if (!layout.ok) throw new Error(layout.code)
    assert.equal(layout.snapshot.revision, 0)
    assert.equal(layout.snapshot.arrangement?.expectedRevision, 0)
    assert.ok(layout.snapshot.arrangement!.positions.length > 0)
    assert.equal(await js(`${state}.saves()`), 0)
    assert.equal(await command({ action: 'arrange', scope: 'all', expectedRevision: 99 }).then((response) => response.ok ? null : response.code), 'CANVAS_REVISION_CONFLICT')
    /** 同一JS任务先启动Worker后切前台，验证清理与授权守卫。 */
    const cancelled = await js(`(() => { const result=${state}.command({action:'arrange',scope:'all',expectedRevision:0}); ${state}.active(false); return result })()`) as CanvasViewCommandResponse
    assert.equal(cancelled.ok, false)
    await waitFor(window, `!${state}.ready()`)
    await js(`${state}.active(true)`)
    await waitFor(window, `${state}.ready()`)
    assert.equal((await command({ action: 'query' })).ok, true)
    assert.equal(await js(`${state}.saves()`), 0)
    assert.deepEqual(errors, [])
    console.log('PASS：真实Workspace query/select/focus/fit/viewport/tool/workbench、草稿保护、真实ELK布局草案/旧revision拒绝、前台切换取消与重登记；普通SAVE始终0次。')
  } finally { window.destroy(); await rm(userDataPath, { recursive: true, force: true }) }
}
void run().then(() => app.quit()).catch((error) => { console.error(error); app.exit(1) })
