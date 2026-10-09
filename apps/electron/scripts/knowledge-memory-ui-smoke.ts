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
  const evidence = await window.webContents.executeJavaScript(`({ text: document.body.innerText.slice(0, 1800), html: document.body.innerHTML.slice(0, 1200) })`)
  console.error(`[Knowledge Memory UI smoke] 等待失败：${message}`, evidence)
  throw new Error(message)
}

/** 点击精确文本的可见按钮或 Radix Tab。 */
async function click(window: BrowserWindow, label: string): Promise<void> {
  const expression = `[...document.querySelectorAll('button,[role="tab"]')].find((element) => element.textContent?.trim() === ${JSON.stringify(label)} && element.getBoundingClientRect().width > 0)`
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

/** 记忆列表按钮包含路径与大小，按独立名称 span 定位。 */
async function clickMemoryFile(window: BrowserWindow, label: string): Promise<void> {
  const expression = `[...document.querySelectorAll('button[aria-pressed]')].find((button) => [...button.querySelectorAll('span')].some((span) => span.textContent?.trim() === ${JSON.stringify(label)}) && button.getBoundingClientRect().width > 0)`
  await waitFor(window, expression, `缺少记忆文件：${label}`)
  const point = await window.webContents.executeJavaScript(`(async () => { const button = ${expression}; if (!(button instanceof HTMLButtonElement)) return null; button.scrollIntoView({ block: 'nearest' }); await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); const rect = button.getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } })()`)
  assert.ok(point, `无法打开记忆文件：${label}`)
  window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
  window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
}

/** 读取当前可见编辑器的源文档，冲突只读状态也允许核验保留的草稿。 */
async function editorText(window: BrowserWindow): Promise<string> {
  await waitFor(window, `document.querySelector('.cm-content')?.getBoundingClientRect().width > 0`, '记忆 Markdown 编辑器未挂载')
  return await window.webContents.executeJavaScript(`window.__knowledgeMemorySmoke.editorText()`) as string
}

/** 通过真实键盘事件替换 CodeMirror 全文。 */
async function replaceEditorText(window: BrowserWindow, content: string): Promise<void> {
  const focused = await window.webContents.executeJavaScript(`(() => {
    const editor = document.querySelector('.cm-content[contenteditable="true"]');
    if (!(editor instanceof HTMLElement)) return false;
    editor.focus();
    return true;
  })()`)
  assert.equal(focused, true, '无法聚焦记忆 Markdown 编辑器')
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['meta'] })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['meta'] })
  await waitFor(window, `window.__knowledgeMemorySmoke.editorHasFullSelection()`, '全选事件尚未提交到 CodeMirror')
  await window.webContents.insertText(content)
  await waitFor(window, `window.__knowledgeMemorySmoke.editorText() === ${JSON.stringify(content)}`, '编辑内容未进入 CodeMirror')
}

/** 等待 DOM 更新绘制到窗口后留存截图，避免保存上一帧的标签高亮或加载态。 */
async function captureScreenshot(window: BrowserWindow, path: string): Promise<void> {
  await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  const screenshot = await window.webContents.capturePage()
  assert.equal(screenshot.isEmpty(), false, '页面截图为空')
  await writeFile(path, screenshot.toPNG())
}

/** 更新入口每次新建项目会话；后续生成复用整理会话，来源复扫不创建会话。 */
async function verifyUpdateCreatesNewConversation(window: BrowserWindow, fixtureUrl: string): Promise<void> {
  await window.loadURL(`${fixtureUrl}?case=new-conversation`)
  await waitFor(window, `document.querySelector('[aria-label="知识目录"]')`, '知识目录未就绪')
  await click(window, '更新知识库')
  await waitFor(window, `window.__knowledgeMemorySmoke.workflowState().pendingPrompt`, '更新任务未投递')
  assert.equal(await window.webContents.executeJavaScript(`window.__knowledgeMemorySmoke.state.createdSessions.length`), 1, '更新知识库未新建会话，而是挤入当前对话')
  assert.deepEqual(await window.webContents.executeJavaScript(`(() => { const smoke = window.__knowledgeMemorySmoke; const flow = smoke.workflowState(); const session = smoke.state.createdSessions[0]; return { target: flow.pendingPrompt.sessionId, active: flow.currentSessionId, workspace: session.workspaceId, title: session.title, channel: session.channelId, model: session.modelId, draft: flow.originalDraft, skills: flow.pendingPrompt.mentionedSkills, autoSend: flow.pendingPrompt.autoSend } })()`), {
    target: 'created-knowledge-1', active: 'created-knowledge-1', workspace: 'workspace-knowledge-memory-smoke', title: '项目知识整理', channel: 'fixture-channel', model: 'fixture-model', draft: '保留当前对话草稿', skills: ['knowledge-maintenance'], autoSend: true,
  })

  await window.webContents.executeJavaScript('window.__knowledgeMemorySmoke.consumePrompt()')
  await click(window, '更新知识库')
  await waitFor(window, `window.__knowledgeMemorySmoke.workflowState().pendingPrompt`, '再次更新未投递')
  assert.equal(await window.webContents.executeJavaScript(`window.__knowledgeMemorySmoke.state.createdSessions.length`), 2, '再次更新错误复用了上次整理会话')
  assert.equal(await window.webContents.executeJavaScript(`window.__knowledgeMemorySmoke.workflowState().pendingPrompt.sessionId`), 'created-knowledge-2')

  await window.webContents.executeJavaScript('window.__knowledgeMemorySmoke.consumePrompt()')
  await click(window, '继续生成')
  await waitFor(window, `window.__knowledgeMemorySmoke.workflowState().pendingPrompt`, '继续生成未投递')
  assert.equal(await window.webContents.executeJavaScript(`window.__knowledgeMemorySmoke.state.createdSessions.length`), 2, '继续生成不应另起对话')
  assert.equal(await window.webContents.executeJavaScript(`window.__knowledgeMemorySmoke.workflowState().pendingPrompt.sessionId`), 'created-knowledge-2', '继续生成未回到整理会话')

  await window.webContents.executeJavaScript('window.__knowledgeMemorySmoke.consumePrompt()')
  await click(window, '来源资料')
  await click(window, '更新来源')
  await waitFor(window, `window.__knowledgeMemorySmoke.state.knowledgeCalls.filter((call) => call === 'scan').length === 3`, '来源复扫未执行')
  assert.equal(await window.webContents.executeJavaScript(`window.__knowledgeMemorySmoke.state.createdSessions.length`), 2, '来源复扫不应新建 Agent 会话')
  assert.equal(await window.webContents.executeJavaScript(`window.__knowledgeMemorySmoke.workflowState().pendingPrompt`), null)
}

/** 创建失败必须展示错误，不把维护任务发送到原对话。 */
async function verifyConversationCreationFailure(window: BrowserWindow, fixtureUrl: string): Promise<void> {
  await window.loadURL(`${fixtureUrl}?session-error=1`)
  await waitFor(window, `document.querySelector('[aria-label="知识目录"]')`, '失败场景未就绪')
  await click(window, '更新知识库')
  await waitFor(window, `document.body.textContent?.includes('无法创建项目知识整理会话')`, '新建失败未显示错误')
  assert.equal(await window.webContents.executeJavaScript(`window.__knowledgeMemorySmoke.workflowState().pendingPrompt`), null, '新建失败后任务错误回退到当前对话')
  assert.equal(await window.webContents.executeJavaScript(`window.__knowledgeMemorySmoke.workflowState().currentSessionId`), 'session-knowledge-memory-smoke')
}

/** 验证主路径：顶部 Tabs、来源二级入口、暂停状态下编辑与 CAS、跨 Tab 状态及变更导航。 */
async function verifyMainFlow(window: BrowserWindow, fixtureUrl: string): Promise<void> {
  await window.loadURL(`${fixtureUrl}?theme=light&hold-search=1`)
  await waitFor(window, `document.body.dataset.smokeReady === 'true' && document.querySelector('[role="tab"]')`, '知识与记忆页面未挂载')
  assert.deepEqual(await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[role="tab"]'), element => element.textContent?.trim())`), ['知识库', '记忆'])
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[role="tab"][data-state="active"]')?.textContent?.trim()`), '知识库')
  await waitFor(window, `document.body.textContent?.includes('产品原则')`, '知识目录未展示已提炼文档')
  await waitFor(window, `window.__knowledgeMemorySmoke.hasPendingSearch()`, '未建立知识目录延迟请求')
  await window.webContents.executeJavaScript(`document.querySelector('[aria-label="打开产品原则"]')?.click()`)
  await waitFor(window, `document.querySelector('[aria-label="资料正文预览"]')`, '知识正文未打开')
  assert.equal(await window.webContents.executeJavaScript(`(() => {
    const directory = document.querySelector('[aria-label="知识目录"]')?.getBoundingClientRect();
    const article = document.querySelector('[aria-label="资料正文预览"]')?.getBoundingClientRect();
    return directory && article && directory.width > 250 && article.width > 300 && directory.right <= article.left + 1 && Math.abs(directory.top - article.top) < 2;
  })()`), true, '宽屏知识目录与正文未左右并排')
  await window.webContents.executeJavaScript('window.__knowledgeMemorySmoke.releaseSearch()')
  await waitFor(window, `document.querySelector('[aria-label="知识目录"]')?.textContent?.includes('产品原则') && !document.querySelector('[aria-label="知识目录"]')?.textContent?.includes('正在更新')`, '知识列表尚未完成加载')
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[aria-label="资料正文预览"]')?.textContent?.includes('用户确认后生成结构化资料')`), true, '迟到的目录请求关闭了用户正在阅读的知识正文')
  await captureScreenshot(window, '/private/tmp/knowledge-memory-ui-smoke-knowledge.png')
  await window.webContents.executeJavaScript(`document.querySelector('[aria-label="关闭正文预览"]')?.click()`)

  await click(window, '来源资料')
  await waitFor(window, `document.body.textContent?.includes('README.md') && document.querySelector('[aria-label="来源目录"]')`, '来源资料未作为知识库二级视图打开')
  await click(window, '返回知识库')
  await waitFor(window, `document.querySelector('[aria-label="知识目录"]')`, '来源资料未返回知识库目录')

  await click(window, '记忆')
  await waitFor(window, `document.body.textContent?.includes('建立项目地图与协作画像') && document.body.textContent?.includes('授权会话补证据')`, '原记忆画像与历史授权入口未保留')
  assert.equal(await window.webContents.executeJavaScript(`document.body.textContent?.includes('只读历史') ?? false`), false, '已确认或暂停的知识库错误地把记忆设为只读')
  await clickMemoryFile(window, 'user-profile.md')
  await waitFor(window, `document.body.textContent?.includes('/fixtures/knowledge-memory-smoke/memory/user-profile.md')`, '未打开 user-profile.md 详情')

  const editedProfile = '# 协作画像\n\n- 偏好：结论先行\n- 偏好：提供验证证据\n'
  await replaceEditorText(window, editedProfile)
  await click(window, '知识库')
  await click(window, '记忆')
  assert.equal(await editorText(window), editedProfile, '跨 Tab 后未保存记忆草稿或当前选中文件丢失')
  await waitFor(window, `window.__knowledgeMemorySmoke.state.writeCalls.some((call) => call.relativePath === 'user-profile.md' && call.content === ${JSON.stringify(editedProfile)} && call.expectedContent === window.__knowledgeMemorySmoke.initialProfile)`, '记忆写入未携带打开时 CAS 基线')

  const externalProfile = '# 协作画像\n\n- 外部更新：保留此行\n'
  await window.webContents.executeJavaScript(`window.__knowledgeMemorySmoke.setExternalProfile(${JSON.stringify(externalProfile)})`)
  const conflictedDraft = `${editedProfile}- 本地草稿：等待人工处理\n`
  await replaceEditorText(window, conflictedDraft)
  await waitFor(window, `document.body.textContent?.includes('文件已被外部更新，已停止保存以避免覆盖')`, 'CAS 冲突未停止保存或未显示处理提示')
  await click(window, '知识库')
  await click(window, '记忆')
  await waitFor(window, `document.body.textContent?.includes('文件已被外部更新，已停止保存以避免覆盖')`, '跨 Tab 后冲突状态被清空')
  assert.equal(await window.webContents.executeJavaScript(`window.__knowledgeMemorySmoke.state.memoryFiles['user-profile.md']`), externalProfile, 'CAS 冲突覆盖了外部版本')
  assert.equal(await editorText(window), conflictedDraft, 'CAS 冲突后本地草稿丢失')

  await click(window, '知识库')
  await window.webContents.executeJavaScript('window.__knowledgeMemorySmoke.requestMemoryChange()')
  await waitFor(window, `document.querySelector('[role="tab"][data-state="active"]')?.textContent?.trim() === '记忆' && document.body.textContent?.includes('项目记忆已更新') && document.body.textContent?.includes('提供验证证据')`, '记忆变更导航未激活记忆 Tab 并打开 Diff')

  await captureScreenshot(window, '/private/tmp/knowledge-memory-ui-smoke.png')
}

/** 外部更新后在防抖落盘前切文件，必须停在原文件并保留草稿与冲突。 */
async function verifyConflictBlocksFileSwitch(window: BrowserWindow, fixtureUrl: string): Promise<void> {
  await window.loadURL(`${fixtureUrl}?case=conflict-switch`)
  await waitFor(window, `document.body.dataset.smokeReady === 'true'`, '冲突切换 fixture 未挂载')
  await click(window, '记忆')
  await clickMemoryFile(window, 'user-profile.md')
  await editorText(window)
  const externalProfile = '# 协作画像\n\n- 外部更新：切换前发生\n'
  const localDraft = '# 协作画像\n\n- 本地草稿：不能被另一个文件覆盖\n'
  await window.webContents.executeJavaScript(`window.__knowledgeMemorySmoke.setExternalProfile(${JSON.stringify(externalProfile)})`)
  await replaceEditorText(window, localDraft)
  await clickMemoryFile(window, 'MEMORY.md')
  await waitFor(window, `document.body.textContent?.includes('文件已被外部更新，已停止保存以避免覆盖')`, '切换文件前的 CAS 失败未进入冲突态')
  assert.equal(await editorText(window), localDraft, 'CAS 失败后另一个文件覆盖了本地草稿')
  assert.equal(await window.webContents.executeJavaScript(`document.body.textContent?.includes('/memory/user-profile.md') && !document.body.textContent?.includes('/memory/MEMORY.md')`), true, 'CAS 失败后仍切换到了另一个文件')
  assert.equal(await window.webContents.executeJavaScript(`window.__knowledgeMemorySmoke.state.memoryFiles['user-profile.md']`), externalProfile, 'CAS 失败覆盖了外部版本')
}

/** 先打开的慢读取晚于后打开的文件返回时，不得覆盖后者选中状态和输入。 */
async function verifyLateReadDoesNotOverwrite(window: BrowserWindow, fixtureUrl: string): Promise<void> {
  await window.loadURL(`${fixtureUrl}?case=late-read`)
  await waitFor(window, `document.body.dataset.smokeReady === 'true'`, '迟到读取 fixture 未挂载')
  await click(window, '记忆')
  await window.webContents.executeJavaScript(`window.__knowledgeMemorySmoke.delayRead('user-profile.md')`)
  await clickMemoryFile(window, 'user-profile.md')
  await waitFor(window, `window.__knowledgeMemorySmoke.hasPendingRead('user-profile.md')`, '未建立 user-profile.md 延迟读取')
  await clickMemoryFile(window, 'MEMORY.md')
  await waitFor(window, `document.body.textContent?.includes('/memory/MEMORY.md')`, '后发 MEMORY.md 读取未先提交')
  const memoryDraft = '# 记忆索引\n\n- 后发文件中的本地输入\n'
  await replaceEditorText(window, memoryDraft)
  await window.webContents.executeJavaScript(`window.__knowledgeMemorySmoke.releaseRead('user-profile.md')`)
  await new Promise<void>((resolve) => setTimeout(resolve, 250))
  assert.equal(await editorText(window), memoryDraft, '迟到的 user-profile.md 读取覆盖了后发文件输入')
  assert.equal(await window.webContents.executeJavaScript(`document.body.textContent?.includes('/memory/MEMORY.md') && !document.body.textContent?.includes('/memory/user-profile.md')`), true, '迟到读取改变了当前选中文件')
}

/** 360px 窄 Pane 必须按列表→详情→返回退化，正文不得撑出横向页面。 */
async function verifyNarrowMemoryLayout(window: BrowserWindow, fixtureUrl: string): Promise<void> {
  window.setContentSize(360, 760)
  await window.loadURL(`${fixtureUrl}?case=narrow&theme=dark`)
  await waitFor(window, `document.body.dataset.smokeReady === 'true'`, '窄屏 fixture 未挂载')
  await click(window, '记忆')
  await waitFor(window, `(() => { const list = document.querySelector('.workspace-memory-list'); const detail = document.querySelector('.workspace-memory-detail'); return list && detail && getComputedStyle(list).display !== 'none' && getComputedStyle(detail).display === 'none' })()`, '窄屏首次进入记忆未只显示列表')
  await clickMemoryFile(window, 'user-profile.md')
  await waitFor(window, `(() => { const list = document.querySelector('.workspace-memory-list'); const detail = document.querySelector('.workspace-memory-detail'); const back = document.querySelector('.workspace-memory-back'); return list && detail && back && getComputedStyle(list).display === 'none' && getComputedStyle(detail).display !== 'none' && back.getBoundingClientRect().width > 0 })()`, '窄屏打开文件后未进入详情或缺少返回入口')
  assert.equal(await window.webContents.executeJavaScript(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true, '窄屏记忆正文发生页面横向溢出')
  await waitFor(window, `document.querySelector('[role="tab"][data-state="active"]')?.textContent?.trim() === '记忆' && window.__knowledgeMemorySmoke.editorText() === window.__knowledgeMemorySmoke.initialProfile`, '窄屏记忆内容尚未就绪')
  await captureScreenshot(window, '/private/tmp/knowledge-memory-ui-smoke-narrow-memory.png')
  await click(window, '返回列表')
  await waitFor(window, `getComputedStyle(document.querySelector('.workspace-memory-list')).display !== 'none' && getComputedStyle(document.querySelector('.workspace-memory-detail')).display === 'none'`, '窄屏返回列表未恢复列表视图')
  window.setContentSize(1180, 820)
}

/** 知识库读取失败时，顶部记忆入口仍必须可用。 */
async function verifyKnowledgeErrorIsolation(window: BrowserWindow, fixtureUrl: string): Promise<void> {
  await window.loadURL(`${fixtureUrl}?knowledge-error=1`)
  await waitFor(window, `document.body.textContent?.includes('fixture 知识库读取失败')`, '知识库 fixture 错误未展示')
  await click(window, '记忆')
  await waitFor(window, `document.body.textContent?.includes('AGENTS.md') && document.body.textContent?.includes('user-profile.md')`, '知识库错误阻断了记忆入口')
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.cm-content[contenteditable="true"]') !== null`), true, '知识库错误下记忆编辑器不可编辑')
}

/** 隐藏窗口使用隔离 userData，且所有业务数据均来自 renderer 内存。 */
async function runElectronSmoke(app: import('electron').App, BrowserWindowCtor: typeof import('electron').BrowserWindow): Promise<void> {
  const fixtureUrl = process.env.PROMA_KNOWLEDGE_MEMORY_FIXTURE_URL
  if (!fixtureUrl) throw new Error('缺少 PROMA_KNOWLEDGE_MEMORY_FIXTURE_URL')
  await app.whenReady()
  const window = new BrowserWindowCtor({ width: 1180, height: 820, show: false, backgroundColor: '#ffffff', webPreferences: { backgroundThrottling: false } })
  const errors: string[] = []
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') {
      errors.push(event.message)
      console.error('[Knowledge Memory UI smoke 页面]', event.message)
    }
  })
  try {
    await verifyUpdateCreatesNewConversation(window, fixtureUrl)
    await verifyConversationCreationFailure(window, fixtureUrl)
    await verifyMainFlow(window, fixtureUrl)
    await verifyConflictBlocksFileSwitch(window, fixtureUrl)
    await verifyLateReadDoesNotOverwrite(window, fixtureUrl)
    await verifyNarrowMemoryLayout(window, fixtureUrl)
    await verifyKnowledgeErrorIsolation(window, fixtureUrl)
    const unexpectedErrors = errors.filter((message) => !message.includes('[工作区记忆] 自动保存失败') && !message.includes('[创建会话] 创建 Agent 会话失败: Error: fixture 新建会话失败'))
    assert.deepEqual(unexpectedErrors, [], `页面控制台错误：${unexpectedErrors.join(' | ')}`)
    console.log('[Knowledge Memory UI smoke] screenshots: /private/tmp/knowledge-memory-ui-smoke.png, /private/tmp/knowledge-memory-ui-smoke-narrow-memory.png')
    console.log('[Knowledge Memory UI smoke] PASS: 顶部 Tabs、知识目录/来源、暂停知识库下的记忆编辑、CAS、跨 Tab 草稿与冲突、冲突切换阻断、迟到读取隔离、变更导航、知识错误隔离均已验证；未访问真实用户数据')
  } finally {
    window.destroy()
  }
}

/** Bun 父进程启动临时 Vite，再构建并执行 Electron 子进程。 */
async function orchestrate(): Promise<void> {
  const port = await availablePort()
  const baseUrl = `http://127.0.0.1:${port}`
  /** HTML 只在 smoke 运行期间存在，结束后删除，仓库仍只保留两份脚本。 */
  const fixtureHtmlPath = join(process.cwd(), 'scripts', `.knowledge-memory-ui-smoke-${process.pid}.html`)
  const fixtureUrl = `${baseUrl}/@fs${fixtureHtmlPath}`
  await writeFile(fixtureHtmlPath, '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Knowledge Memory UI Smoke</title></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => undefined; window.$RefreshSig$ = () => (type) => type;</script><script type="module" src="./knowledge-memory-ui-smoke-renderer.tsx"></script></body></html>')
  const vite = spawn(process.execPath, [join(process.cwd(), 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: process.cwd(), stdio: 'inherit' })
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

    const buildDir = await mkdtemp(join(tmpdir(), 'proma-knowledge-memory-ui-smoke-build-'))
    try {
      /** 父进程在 Electron 完全退出后清理 userData，避免 Chromium 退出写入与删除竞争。 */
      const userDataPath = await mkdtemp(join(buildDir, 'user-data-'))
      const build = await Bun.build({ entrypoints: [join(process.cwd(), 'scripts/knowledge-memory-ui-smoke.ts')], outdir: buildDir, target: 'node', format: 'cjs', external: ['electron'] })
      if (!build.success || !build.outputs[0]) throw new Error('构建 Knowledge Memory UI smoke 入口失败')
      const electronPath = process.env.PROMA_ELECTRON_PATH ?? join(process.cwd(), 'node_modules/.bin/electron')
      const electron = spawn(electronPath, [build.outputs[0].path], {
        cwd: process.cwd(),
        env: { ...process.env, PROMA_KNOWLEDGE_MEMORY_UI_SMOKE_CHILD: '1', PROMA_KNOWLEDGE_MEMORY_FIXTURE_URL: fixtureUrl, PROMA_KNOWLEDGE_MEMORY_SMOKE_USER_DATA: userDataPath },
        stdio: 'inherit',
      })
      const code = await new Promise<number>((resolve, reject) => {
        /** 超时也等子进程退出才清理临时目录。 */
        let timedOut = false
        const timeout = setTimeout(() => { timedOut = true; electron.kill('SIGKILL') }, 90_000)
        electron.once('error', (error) => { clearTimeout(timeout); reject(error) })
        electron.once('exit', (value) => {
          clearTimeout(timeout)
          if (timedOut) reject(new Error('Knowledge Memory UI smoke 超时'))
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
  }
}

if (process.env.PROMA_KNOWLEDGE_MEMORY_UI_SMOKE_CHILD === '1') {
  const electron = require('electron') as typeof import('electron')
  const userDataPath = process.env.PROMA_KNOWLEDGE_MEMORY_SMOKE_USER_DATA
  if (!userDataPath) throw new Error('缺少隔离 userData 目录')
  electron.app.setPath('userData', userDataPath)
  /** 失败时 finally 会先销毁窗口；阻止默认生命周期抢在 catch 前以 0 退出。 */
  electron.app.on('window-all-closed', () => undefined)
  const keepAlive = setInterval(() => undefined, 1_000)
  void runElectronSmoke(electron.app, electron.BrowserWindow)
    .then(() => { clearInterval(keepAlive); electron.app.quit() })
    .catch((error: unknown) => {
      clearInterval(keepAlive)
      console.error('[Knowledge Memory UI smoke] FAIL', error)
      electron.app.exit(1)
    })
} else {
  void orchestrate().catch((error: unknown) => { console.error('[Knowledge Memory UI smoke] FAIL', error); process.exitCode = 1 })
}
