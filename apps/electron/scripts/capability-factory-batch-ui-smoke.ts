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

/** 点击精确文字或 aria-label 按钮，兼容图标按钮只把当前模式作为可见文本的情况。 */
async function click(window: BrowserWindow, label: string): Promise<void> {
  const clicked = await window.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('button, [role="menuitem"]')].find((item) => item.textContent?.trim() === ${JSON.stringify(label)} || item.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (!(button instanceof HTMLElement)) return false;
    if (button.getAttribute('aria-haspopup') === 'menu') {
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    }
    button.click(); return true;
  })()`)
  assert.equal(clicked, true, `找不到按钮：${label}`)
}

/** 在隐藏 Electron 窗口里验证生产 hook 与历史组件。 */
async function runElectronSmoke(app: import('electron').App, BrowserWindowCtor: typeof import('electron').BrowserWindow): Promise<void> {
  const url = process.env.PROMA_FACTORY_BATCH_UI_SMOKE_URL
  if (!url) throw new Error('缺少 smoke URL')
  await app.whenReady()
  const window = new BrowserWindowCtor({ width: 800, height: 620, show: false, webPreferences: { backgroundThrottling: false } })
  try {
    await window.loadURL(url)
    await waitFor(window, "document.body.dataset.smokeReady === 'true' && document.querySelector('[aria-label=\"当前批次\"]')?.textContent === 'agent-existing'", 'Agent 既有批次未恢复')
    assert.equal(await window.webContents.executeJavaScript('window.__factoryBatchSmoke.state.runBatchCalls'), 0, '恢复历史时错误重跑批次')

    const selectedOld = await window.webContents.executeJavaScript(`(() => {
      const rows = document.querySelectorAll('[aria-label="测试批次"] button[aria-pressed]');
      const button = rows.item(1);
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click(); return true;
    })()`)
    assert.equal(selectedOld, true, '缺少第二条历史批次')
    await waitFor(window, "document.querySelector('[aria-label=\"当前批次\"]')?.textContent === 'history-old'", '未选中旧历史')
    await window.webContents.executeJavaScript('window.__factoryBatchSmoke.addAgentBatch()')
    await waitFor(window, "document.body.textContent?.includes('agent-newest') === false && document.querySelector('[aria-label=\"当前批次\"]')?.textContent === 'history-old'", 'Agent 事件抢走手选历史')

    await click(window, '切到慢会话')
    await click(window, '切到快会话')
    await waitFor(window, "document.querySelector('[aria-label=\"当前批次\"]')?.textContent === 'fast-batch'", '快会话未先显示')
    await window.webContents.executeJavaScript('window.__factoryBatchSmoke.releaseSlow()')
    await new Promise<void>((resolve) => setTimeout(resolve, 180))
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('[aria-label=\"当前批次\"]')?.textContent"), 'fast-batch', '慢会话迟到响应覆盖当前会话')

    await click(window, '双重启动')
    await waitFor(window, 'window.__factoryBatchSmoke.state.runBatchCalls === 1', '同步重复启动没有被锁住')
    await waitFor(window, "document.body.textContent?.includes('停止批次')", '运行批次未显示取消入口')
    await click(window, '停止批次')
    await waitFor(window, 'window.__factoryBatchSmoke.state.cancelCalls === 1', '取消没有调用宿主')
    await waitFor(window, "document.querySelector('[aria-label=\"当前批次\"]')?.textContent === 'manual-running' && !document.body.textContent?.includes('停止批次')", '取消终态未刷新')

    await window.loadURL(`${url}?case=evaluation`)
    await waitFor(window, "document.body.dataset.smokeReady === 'true' && document.querySelectorAll('[data-capability-factory-cases] input[type=checkbox]').length === 12", '十二条评测数据集未挂载')
    const initialSelection = await window.webContents.executeJavaScript(`(() => {
      const boxes = [...document.querySelectorAll('[data-capability-factory-cases] input[type=checkbox]')];
      return { checked: boxes.filter((box) => box.checked).length, disabled: boxes.map((box) => box.disabled) };
    })()`)
    assert.equal(initialSelection.checked, 10, '超过十条的数据集没有默认选前十条')
    assert.deepEqual(initialSelection.disabled, [false, false, false, false, false, false, false, false, false, false, true, true], '未选用例没有在达到十条时禁用')

    const switched = await window.webContents.executeJavaScript(`(() => {
      const boxes = [...document.querySelectorAll('[data-capability-factory-cases] input[type=checkbox]')];
      const first = boxes[0]; const eleventh = boxes[10];
      if (!(first instanceof HTMLInputElement) || !(eleventh instanceof HTMLInputElement)) return false;
      first.click();
      return true;
    })()`)
    assert.equal(switched, true, '无法取消第一条用例')
    await waitFor(window, "document.querySelectorAll('[data-capability-factory-cases] input[type=checkbox]')[10]?.disabled === false", '腾出名额后第十一条仍不可选')
    const selectedEleventh = await window.webContents.executeJavaScript(`(() => {
      const box = document.querySelectorAll('[data-capability-factory-cases] input[type=checkbox]')[10];
      if (!(box instanceof HTMLInputElement)) return false;
      box.click(); return box.checked;
    })()`)
    assert.equal(selectedEleventh, true, '第十一条用例未选中')
    await click(window, '跑评测')
    await waitFor(window, 'window.__factoryBatchSmoke.state.runBatchCalls === 1', '评测没有提交批次')
    assert.deepEqual(await window.webContents.executeJavaScript('window.__factoryBatchSmoke.state.runBatchInput.caseIds'), [
      'case-2', 'case-3', 'case-4', 'case-5', 'case-6', 'case-7', 'case-8', 'case-9', 'case-10', 'case-11',
    ], 'runBatch 没有收到界面精确选择的十条 caseIds')

    await window.loadURL(`${url}?case=permission`)
    await waitFor(window, "document.body.dataset.smokeReady === 'true' && document.body.textContent?.includes('read_file') && window.__factoryBatchSmoke.capturedKeydownCount() > 0", '普通审批没有注册 Enter handler')
    await window.webContents.executeJavaScript("window.__factoryBatchSmoke.enqueueAdoption('adoption-1')")
    await waitFor(window, "document.querySelector('[data-testid=\"factory-adoption-review\"]')", '普通审批切换后采纳审批没有出现在 Agent 原有权限卡')
    assert.equal(await window.webContents.executeJavaScript('window.__factoryBatchSmoke.invokeCapturedEnter()'), true, '没有捕获到普通审批的旧 Enter handler')
    await new Promise<void>((resolve) => setTimeout(resolve, 80))
    assert.equal(await window.webContents.executeJavaScript('window.__factoryBatchSmoke.state.permissionCalls.length'), 0, '普通审批的旧 Enter handler 批准了新采纳请求')
    const adoptionCopy = await window.webContents.executeJavaScript('document.body.innerText')
    assert.match(adoptionCopy, /采纳草案需要确认/, '采纳审批缺少明确标题')
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('[role=alertdialog]')"), null, '采纳审批不应占用独立全屏 AlertDialog')
    assert.match(adoptionCopy, /本次改动/, '采纳审批没有标明实际改动')
    assert.match(adoptionCopy, /把回答约束改为：每条事实必须引用证据编号/, '采纳审批没有显示具体改动')
    assert.match(adoptionCopy, /要解决的问题（Agent 判断）/, '采纳审批没有标明 Agent 判断的问题')
    assert.match(adoptionCopy, /旧提示词可能生成无法追溯的结论/, '采纳审批没有显示 Agent 判断的问题')
    assert.match(adoptionCopy, /预期收益（待验证）/, '采纳审批没有标明预期收益仍待验证')
    assert.match(adoptionCopy, /预计减少无依据引用/, '采纳审批没有显示 Agent 预期收益')
    assert.match(adoptionCopy, /取舍与风险/, '采纳审批没有标明取舍与风险')
    assert.match(adoptionCopy, /可能让回复更保守/, '采纳审批没有显示 Agent 判断的风险')
    assert.match(adoptionCopy, /测试已证明/, '采纳审批没有单列测试已证明的结果')
    assert.match(adoptionCopy, /候选在同条件测试中修复了错误引用/, '采纳审批没有显示候选测试收益')
    assert.match(adoptionCopy, /当前版测试问题/, '采纳审批没有单列当前版本测试问题')
    assert.match(adoptionCopy, /基线在两个样本中均出现错误引用/, '采纳审批没有显示基线测试问题')
    assert.match(adoptionCopy, /仍有局限/, '采纳审批没有单列剩余局限')
    assert.match(adoptionCopy, /测试样本只有两个/, '采纳审批没有显示测试局限')
    assert.match(adoptionCopy, /验证状态/, '采纳审批没有把验证状态单列')
    assert.match(adoptionCopy, /2条同条件对比，候选2\/2通过/, '采纳审批没有显示真实测试结论')
    assert.doesNotMatch(adoptionCopy, /总是允许/, '采纳审批不允许持久白名单绕过后续人工复核')
    /** 保留隔离窗口截图，供人工检查卡片高度与信息层次；不包含真实用户数据。 */
    const adoptionScreenshotPath = '/private/tmp/dutydeck-factory-adoption-review.png'
    await writeFile(adoptionScreenshotPath, (await window.webContents.capturePage()).toPNG())

    await window.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
    await new Promise<void>((resolve) => setTimeout(resolve, 80))
    assert.equal(await window.webContents.executeJavaScript('window.__factoryBatchSmoke.state.permissionCalls.length'), 0, '全局 Enter 自动批准了采纳')

    await click(window, '暂不采纳')
    await waitFor(window, 'window.__factoryBatchSmoke.state.permissionCalls.length === 1 && !document.querySelector(\'[data-testid="factory-adoption-review"]\')', '拒绝采纳没有响应或关闭审批卡')
    assert.deepEqual(await window.webContents.executeJavaScript('window.__factoryBatchSmoke.state.permissionCalls[0]'), {
      requestId: 'adoption-1', behavior: 'deny', alwaysAllow: false,
    }, '暂不采纳没有发送逐次拒绝')
    assert.equal(await window.webContents.executeJavaScript('window.__factoryBatchSmoke.state.sceneVersion'), 2, '拒绝采纳却改变了已有版本')

    await window.webContents.executeJavaScript("window.__factoryBatchSmoke.enqueueAdoption('adoption-2')")
    await waitFor(window, "document.querySelector('[data-testid=\"factory-adoption-review\"]')", '第二次采纳没有重新显示人工审批')
    await click(window, '确认采纳')
    await waitFor(window, 'window.__factoryBatchSmoke.state.permissionCalls.length === 2 && !document.querySelector(\'[data-testid="factory-adoption-review"]\')', '批准采纳没有响应或关闭审批卡')
    assert.deepEqual(await window.webContents.executeJavaScript('window.__factoryBatchSmoke.state.permissionCalls[1]'), {
      requestId: 'adoption-2', behavior: 'allow', alwaysAllow: false,
    }, '批准采纳没有保持逐次审批')
    assert.equal(await window.webContents.executeJavaScript('window.__factoryBatchSmoke.state.sceneVersion'), 3, '批准采纳没有应用新版本 fixture')

    await window.webContents.executeJavaScript("window.__factoryBatchSmoke.enqueueAdoption('other-1', 'session-other'); window.__factoryBatchSmoke.enqueueAdoption('adoption-3')")
    await waitFor(window, "document.querySelector('[data-testid=\"factory-adoption-review\"]')", '新 requestId 没有继续显示采纳审批')
    assert.equal(await window.webContents.executeJavaScript('window.__factoryBatchSmoke.state.permissionCalls.length'), 2, '新采纳请求在未点击时被自动响应')
    assert.deepEqual(await window.webContents.executeJavaScript("window.__factoryBatchSmoke.pendingPermissionIds('session-other')"), ['other-1'], '当前会话审批误消费其他会话请求')

    await window.webContents.executeJavaScript(`(() => {
      window.__factoryBatchSmoke.state.failNextPermission = true;
      const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === '确认采纳');
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click(); button.click(); return true;
    })()`)
    await waitFor(window, "window.__factoryBatchSmoke.state.permissionCalls.length === 3 && document.querySelector('[role=alert]')?.textContent?.includes('提交审核结果失败，请重试')", '审批失败后没有保留弹窗并显示可重试错误')
    assert.deepEqual(await window.webContents.executeJavaScript('window.__factoryBatchSmoke.state.permissionCalls[2]'), {
      requestId: 'adoption-3', behavior: 'allow', alwaysAllow: false,
    }, '失败审批没有保持逐次批准参数')
    assert.deepEqual(await window.webContents.executeJavaScript("window.__factoryBatchSmoke.pendingPermissionIds('session-permission')"), ['adoption-3'], '审批失败后错误移除了待处理请求')
    assert.deepEqual(await window.webContents.executeJavaScript("window.__factoryBatchSmoke.pendingPermissionIds('session-other')"), ['other-1'], '审批失败污染了其他会话队列')

    await click(window, '确认采纳')
    await waitFor(window, "window.__factoryBatchSmoke.state.permissionCalls.length === 4 && !document.querySelector('[data-testid=\"factory-adoption-review\"]')", '审批失败后重试未成功关闭审批卡')
    assert.deepEqual(await window.webContents.executeJavaScript('window.__factoryBatchSmoke.state.permissionCalls[3]'), {
      requestId: 'adoption-3', behavior: 'allow', alwaysAllow: false,
    }, '重试采纳没有保持逐次批准参数')
    assert.deepEqual(await window.webContents.executeJavaScript("window.__factoryBatchSmoke.pendingPermissionIds('session-permission')"), [], '重试成功后未移除当前请求')
    assert.deepEqual(await window.webContents.executeJavaScript("window.__factoryBatchSmoke.pendingPermissionIds('session-other')"), ['other-1'], '重试成功误移除了其他会话请求')

    await window.webContents.executeJavaScript("window.__factoryBatchSmoke.enqueueAdoption('adoption-unverified', 'session-permission', false)")
    await waitFor(window, "document.querySelector('[data-testid=\"factory-adoption-review\"]')", '无测试证据的采纳请求没有显示审批卡')
    const unverifiedCopy = await window.webContents.executeJavaScript("document.querySelector('[data-testid=\"factory-adoption-review\"]')?.textContent ?? ''")
    assert.equal((unverifiedCopy.match(/未验证/g) ?? []).length, 1, '无测试证据时重复渲染了多组“未验证”')
    assert.match(unverifiedCopy, /未验证：尚未运行同条件批量测试/, '无测试证据时没有给出唯一测试结论')

    await window.loadURL(`${url}?case=access`)
    await waitFor(window, "document.body.dataset.smokeReady === 'true' && document.querySelector('[role=dialog]')", 'Agent 授权弹窗没有打开')
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('[aria-label=\"选择 Agent 工具模式\"]') !== null"), true, '授权弹窗没有挂载 Agent 模式控件')
    await click(window, '选择 Agent 工具模式')
    await waitFor(window, "[...document.querySelectorAll('[role=menuitem]')].some((item) => item.textContent?.includes('标准模式'))", 'Agent 模式菜单没有打开')
    await click(window, '标准模式')
    await waitFor(window, "window.__factoryBatchSmoke.state.modeUpdateCalls.length === 1 && document.querySelector('[aria-label=\"访问会话模式\"]')?.textContent === 'standard' && !document.querySelector('[role=dialog]')", '切换标准模式未准确更新会话或关闭授权弹窗')
    assert.deepEqual(await window.webContents.executeJavaScript('window.__factoryBatchSmoke.state.modeUpdateCalls[0]'), { sessionId: 'session-access-a', mode: 'standard' }, '模式切换更新了错误会话')
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('[aria-label=\"其他会话模式\"]')?.textContent"), 'server-ops-write', '模式切换污染了其他会话')
    assert.equal(await window.webContents.executeJavaScript('window.__factoryBatchSmoke.state.resourceSetCalls'), 0, '模式切换错误调用了资源保存')

    await window.loadURL(`${url}?case=access-failure`)
    await waitFor(window, "document.body.dataset.smokeReady === 'true' && document.querySelector('[role=dialog]')", '失败场景授权弹窗没有打开')
    await click(window, '选择 Agent 工具模式')
    await waitFor(window, "[...document.querySelectorAll('[role=menuitem]')].some((item) => item.textContent?.includes('标准模式'))", '失败场景 Agent 模式菜单没有打开')
    await click(window, '标准模式')
    await waitFor(window, "document.querySelector('[role=dialog]') && document.body.innerText.includes('切换运维模式失败')", '模式切换失败后没有保留弹窗与错误')
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('[aria-label=\"访问会话模式\"]')?.textContent"), 'server-ops-write', '模式切换失败却改变了原模式')
    assert.equal(await window.webContents.executeJavaScript('window.__factoryBatchSmoke.state.resourceSetCalls'), 0, '模式切换失败错误调用了资源保存')

    console.log('[Capability Factory batch UI smoke] PASS: 批次与数据集、采纳审核及旧 Enter handler 隔离、失败重试/跨会话隔离，以及运维授权弹窗内 Agent 模式切换成功/失败边界均已验证；截图：/private/tmp/dutydeck-factory-adoption-review.png；未访问真实用户数据')
  } finally {
    window.destroy()
  }
}

/** Bun 父进程启动临时 Vite，再构建并执行隔离 Electron 子进程。 */
async function orchestrate(): Promise<void> {
  const port = await availablePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const htmlPath = join(process.cwd(), 'scripts', `.capability-factory-batch-ui-smoke-${process.pid}.html`)
  const fixtureUrl = `${baseUrl}/@fs${htmlPath}`
  await writeFile(htmlPath, '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Factory Batch Smoke</title></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => undefined; window.$RefreshSig$ = () => (type) => type;</script><script type="module" src="./capability-factory-batch-ui-smoke-renderer.tsx"></script></body></html>')
  const vite = spawn(process.execPath, [join(process.cwd(), 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: process.cwd(), stdio: 'inherit' })
  try {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      try { if ((await fetch(fixtureUrl)).ok) break } catch { /* 等待 Vite */ }
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
    if (Date.now() >= deadline) throw new Error('Vite smoke 启动超时')
    const buildDir = await mkdtemp(join(tmpdir(), 'proma-factory-batch-ui-smoke-'))
    try {
      const userData = await mkdtemp(join(buildDir, 'user-data-'))
      const build = await Bun.build({ entrypoints: [join(process.cwd(), 'scripts/capability-factory-batch-ui-smoke.ts')], outdir: buildDir, target: 'node', format: 'cjs', external: ['electron'] })
      if (!build.success || !build.outputs[0]) throw new Error('构建 smoke 入口失败')
      const electronPath = process.env.PROMA_ELECTRON_PATH ?? join(process.cwd(), 'node_modules/.bin/electron')
      const electron = spawn(electronPath, [build.outputs[0].path], { cwd: process.cwd(), stdio: 'inherit', env: {
        ...process.env,
        PROMA_FACTORY_BATCH_UI_SMOKE_CHILD: '1',
        PROMA_FACTORY_BATCH_UI_SMOKE_URL: fixtureUrl,
        PROMA_FACTORY_BATCH_UI_SMOKE_USER_DATA: userData,
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

if (process.env.PROMA_FACTORY_BATCH_UI_SMOKE_CHILD === '1') {
  const electron = require('electron') as typeof import('electron')
  const userData = process.env.PROMA_FACTORY_BATCH_UI_SMOKE_USER_DATA
  if (!userData) throw new Error('缺少隔离 userData')
  electron.app.setPath('userData', userData)
  electron.app.on('window-all-closed', () => undefined)
  const keepAlive = setInterval(() => undefined, 1_000)
  void runElectronSmoke(electron.app, electron.BrowserWindow)
    .then(() => { clearInterval(keepAlive); electron.app.quit() })
    .catch((error: unknown) => { clearInterval(keepAlive); console.error('[Capability Factory batch UI smoke] FAIL', error); electron.app.exit(1) })
} else {
  void orchestrate().catch((error: unknown) => { console.error('[Capability Factory batch UI smoke] FAIL', error); process.exitCode = 1 })
}
