import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LocalModelCatalogEntry } from '@proma/shared'
import { LocalModelStore } from './local-model-store'
import type { LocalModelEngineManager } from './local-model-engine-manager'
import { LocalModelRuntime, type ManagedProcess } from './local-model-runtime'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createCatalog(payload = '{"choices":[{"message":{"content":"ok"}}]}'): { root: string; entry: LocalModelCatalogEntry; bytes: Uint8Array<ArrayBuffer> } {
  const root = mkdtempSync(join(tmpdir(), 'proma-local-model-runtime-'))
  temporaryRoots.push(root)
  const bytes = new TextEncoder().encode(payload)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  return {
    root,
    bytes,
    entry: {
      assetId: 'qwen3-8b-q4km-r1', modelId: 'qwen3-8b', name: 'Qwen3 8B', family: 'qwen',
      architecture: 'llama', quantization: 'Q4_K_M', revision: 'r1', downloadUrl: 'https://example.invalid/qwen.gguf',
      sha256, sizeBytes: bytes.byteLength, diskBytes: bytes.byteLength, memoryBytes: 1024,
      license: 'Apache-2.0', contextWindow: 4096, maxTokens: 1024,
    },
  }
}

class FakeProcess implements ManagedProcess {
  pid = 100
  killedSignals: NodeJS.Signals[] = []
  private readonly listeners = new Map<'exit' | 'error', (...args: unknown[]) => void>()

  kill(signal?: NodeJS.Signals): boolean {
    if (signal) this.killedSignals.push(signal)
    this.listeners.get('exit')?.(0)
    return true
  }

  once(event: 'exit' | 'error', listener: (...args: unknown[]) => void): ManagedProcess {
    this.listeners.set(event, listener)
    return this
  }
}

describe('LocalModelRuntime', () => {
  test('下载流式写入，哈希通过后才登记为 installed', async () => {
    const { root, entry, bytes } = createCatalog()
    const runtime = new LocalModelRuntime({
      catalog: [entry],
      store: new LocalModelStore({ configDir: root }),
      fetch: async () => new Response(new Blob([bytes]), { status: 200 }),
    })
    const installed = await runtime.download({ assetId: entry.assetId })
    expect(installed.status).toBe('installed')
    expect(runtime.listSnapshot().assets[0]?.status).toBe('installed')
    expect(existsSync(join(root, 'models', entry.assetId, 'qwen.gguf'))).toBe(true)
  })

  test('哈希不匹配不会登记半文件', async () => {
    const { root, entry, bytes } = createCatalog()
    const runtime = new LocalModelRuntime({
      catalog: [{ ...entry, sha256: 'b'.repeat(64) }],
      store: new LocalModelStore({ configDir: root }),
      fetch: async () => new Response(new Blob([bytes]), { status: 200 }),
    })
    await expect(runtime.download({ assetId: entry.assetId })).rejects.toThrow('SHA-256')
    expect(runtime.listSnapshot().assets[0]?.status).toBe('error')
    expect(existsSync(join(root, 'models', 'staging', `${entry.assetId}.part`))).toBe(false)
  })

  test('没有随包引擎时拒绝启动，不伪装成可运行', async () => {
    const { root, entry, bytes } = createCatalog()
    const store = new LocalModelStore({ configDir: root })
    const runtime = new LocalModelRuntime({
      catalog: [entry], store, fetch: async () => new Response(new Blob([bytes]), { status: 200 }),
    })
    await runtime.download({ assetId: entry.assetId })
    await expect(runtime.start({ assetId: entry.assetId })).rejects.toThrow('当前未提供经过校验的本地运行环境')
    expect(runtime.listSnapshot().runtime.state).toBe('error')
  })

  test('Given 按需引擎未安装 When 直接请求模型下载 Then 主进程也拒绝并保持模型未登记', async () => {
    const { root, entry, bytes } = createCatalog()
    const store = new LocalModelStore({ configDir: root })
    const engineManager = {
      resolveEngine: () => ({ message: '请先安装 llama.cpp' }),
      snapshot: () => ({ state: 'not-installed', available: false, source: 'none' }),
      subscribe: () => () => undefined,
      cancelDownload: () => undefined,
      shutdown: () => undefined,
    } as unknown as LocalModelEngineManager
    const runtime = new LocalModelRuntime({
      catalog: [entry], store, engineManager, fetch: async () => new Response(new Blob([bytes]), { status: 200 }),
    })
    await expect(runtime.download({ assetId: entry.assetId })).rejects.toThrow('请先安装 llama.cpp')
    expect(runtime.listSnapshot().assets[0]?.status).toBe('not-installed')
  })

  test('健康检查通过后才进入 running，测试不修改 enabled', async () => {
    const { root, entry, bytes } = createCatalog()
    const store = new LocalModelStore({ configDir: root })
    const process = new FakeProcess()
    const runtime = new LocalModelRuntime({
      catalog: [entry], store, enginePath: '/fake/llama-server', engineVersion: 'b9000',
      spawn: () => process,
      fetch: async (input) => {
        const url = String(input)
        if (url.includes('example.invalid')) return new Response(new Blob([bytes]), { status: 200 })
        if (url.endsWith('/health')) return new Response('ok', { status: 200 })
        return new Response('{"choices":[{"message":{"content":"{\\"ok\\":true}"}}]}', { status: 200 })
      },
      healthTimeoutMs: 100, stopTimeoutMs: 1,
      findFreePort: async () => 43123,
    })
    await runtime.download({ assetId: entry.assetId })
    store.setEnabled(entry.assetId, true)
    await runtime.start({ assetId: entry.assetId })
    expect(runtime.listSnapshot().runtime.state).toBe('running')
    const result = await runtime.test({ assetId: entry.assetId, prompt: 'ping', includeJson: true })
    expect(result.success).toBe(false)
    expect(runtime.listSnapshot().assets[0]?.enabled).toBe(true)
    await runtime.stop()
    expect(process.killedSignals).toContain('SIGTERM')
    expect(runtime.listSnapshot().runtime.state).toBe('idle')
  })
})

test('Given 普通聊天可用但没有 tools When 测试 Then 不得宣称 Agent 能力可用', async () => {
  const { root, entry, bytes } = createCatalog()
  const runtime = new LocalModelRuntime({ store: new LocalModelStore({ configDir: root }), catalog: [entry], enginePath: '/fake/llama-server', engineVersion: 'b9000', spawn: () => new FakeProcess(), findFreePort: async () => 43123, stopTimeoutMs: 1,
    fetch: async (url) => String(url).includes('example.invalid') ? new Response(new Blob([bytes])) : String(url).endsWith('/health') ? new Response('ok') : Response.json({ choices: [{ message: { content: 'ok' } }] }),
  })
  await runtime.download({ assetId: entry.assetId })
  const result = await runtime.test({ assetId: entry.assetId, prompt: 'ping' })
  expect(result.success).toBe(false)
  expect(result.capability.state).toBe('unavailable')
  await runtime.stop()
})

test('Given 未登记模型 When 伪造 modelId 别名 Then 拒绝使用非资产 ID', async () => {
  const { root, entry, bytes } = createCatalog()
  const runtime = new LocalModelRuntime({ store: new LocalModelStore({ configDir: root }), catalog: [entry], fetch: async () => new Response(new Blob([bytes])) })
  await runtime.download({ assetId: entry.assetId })
  expect(() => runtime.getModelCatalogEntry(entry.modelId)).toThrow()
})

/** 创建可完整完成探测协议的受管运行时，所有权重均为最小测试数据。 */
async function workingRuntime(idleUnloadMs?: number) {
  const { root, entry, bytes } = createCatalog()
  const store = new LocalModelStore({ configDir: root })
  const child = new FakeProcess()
  let launches = 0
  const runtime = new LocalModelRuntime({ store, catalog: [entry], idleUnloadMs, enginePath: '/fake/llama-server', engineVersion: 'b9000', spawn: () => { launches++; return child }, findFreePort: async () => 43123, stopTimeoutMs: 10,
    fetch: async (url, init) => {
      if (String(url).includes('example.invalid')) return new Response(new Blob([bytes]))
      if (String(url).endsWith('/health')) return new Response('ok')
      const body = JSON.parse(String(init?.body)) as { tool_choice?: unknown; response_format?: unknown; messages: Array<{ role: string; content: string }> }
      if (body.tool_choice && typeof body.tool_choice === 'object') return Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'dutydeck_probe', arguments: '{"value":7}' } }] } }] })
      const content = body.response_format ? '{"ok":true,"value":7}' : body.tool_choice === 'none' ? body.messages.at(-1)?.content : 'hello'
      return Response.json({ choices: [{ message: { content } }] })
    },
  })
  await runtime.download({ assetId: entry.assetId })
  return { runtime, store, child, entry, root, launches: () => launches }
}

test('Given 父Agent持有模型 When 子Agent取得同模型租约 Then 允许共享且忙时拒绝停止', async () => {
  const { runtime, store, entry, child } = await workingRuntime()
  expect((await runtime.test({ assetId: entry.assetId, prompt: 'hello', includeToolCall: false, includeJson: false })).success).toBe(true)
  store.setEnabled(entry.assetId, true)
  const first = await runtime.acquire(entry.assetId)
  let granted = false
  const pending = runtime.acquire(entry.assetId).then((lease) => { granted = true; return lease })
  const second = await pending
  expect(granted).toBe(true)
  await expect(runtime.test({ assetId: entry.assetId, prompt: 'hello' })).rejects.toThrow('占用')
  await expect(runtime.stop()).rejects.toThrow('占用')
  await expect(runtime.start({ assetId: entry.assetId })).rejects.toThrow('占用')
  first.release(); first.release()
  expect(second.contextWindow).toBe(4096)
  second.release()
  await runtime.stop()
  expect(child.killedSignals).toEqual(['SIGTERM'])
})

test('Given 同模型租约获取取消 When 其它任务释放 Then 取消引用不遗留占用', async () => {
  const { runtime, store, entry } = await workingRuntime()
  await runtime.test({ assetId: entry.assetId, prompt: 'hello' })
  store.setEnabled(entry.assetId, true)
  const first = await runtime.acquire(entry.assetId)
  const controller = new AbortController()
  const waiting = runtime.acquire(entry.assetId, controller.signal)
  controller.abort()
  await expect(waiting).rejects.toThrow()
  first.release()
  const next = await runtime.acquire(entry.assetId)
  next.release()
  await runtime.stop()
})

test('Given 测试未知资产 When 再次测试真实资产 Then 不泄漏独占锁', async () => {
  const { runtime, entry } = await workingRuntime()
  await expect(runtime.test({ assetId: 'unknown', prompt: 'hello' })).rejects.toThrow()
  const result = await Promise.race([runtime.test({ assetId: entry.assetId, prompt: 'hello' }), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('租约泄漏')), 150))])
  expect(result.success).toBe(true)
  await runtime.stop()
})

test('Given 下载流在 EOF 同时取消 When 下载返回 Then 不登记资产且保留可续传部分', async () => {
  const { root, entry, bytes } = createCatalog()
  const runtime = new LocalModelRuntime({ store: new LocalModelStore({ configDir: root }), catalog: [entry], fetch: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); runtime.cancelDownload({ assetId: entry.assetId }) } })) })
  await expect(runtime.download({ assetId: entry.assetId })).rejects.toThrow()
  expect(runtime.listSnapshot().assets[0]?.status).toBe('error')
  expect(existsSync(join(root, 'models', entry.assetId, 'qwen.gguf'))).toBe(false)
})

test('Given 已下载部分文件 When 重试 Then 发起 Range 且最终校验完整文件', async () => {
  const { root, entry, bytes } = createCatalog()
  const store = new LocalModelStore({ configDir: root })
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(join(store.ensureModelsDir(), 'staging'), { recursive: true })
  writeFileSync(join(root, 'models', 'staging', `${entry.assetId}.part`), bytes.slice(0, 10))
  let range = ''
  const runtime = new LocalModelRuntime({ store, catalog: [entry], fetch: async (_, init) => {
    range = new Headers(init?.headers).get('range') ?? ''
    return new Response(bytes.slice(10), { status: 206, headers: { 'content-range': `bytes 10-${bytes.length - 1}/${bytes.length}` } })
  } })
  expect((await runtime.download({ assetId: entry.assetId })).status).toBe('installed')
  expect(range).toBe('bytes=10-')
})

test('Given 超大响应 When 下载 Then 有界中止并丢弃部分文件', async () => {
  const { root, entry } = createCatalog()
  const runtime = new LocalModelRuntime({ store: new LocalModelStore({ configDir: root }), catalog: [entry], fetch: async () => new Response('x'.repeat(entry.sizeBytes + 1)) })
  await expect(runtime.download({ assetId: entry.assetId })).rejects.toThrow('上限')
  expect(existsSync(join(root, 'models', 'staging', `${entry.assetId}.part`))).toBe(false)
})

test('Given 健康请求迟到 When 用户停止加载 Then 不得恢复 running', async () => {
  const { root, entry, bytes } = createCatalog()
  let healthStarted!: () => void
  const started = new Promise<void>((resolve) => { healthStarted = resolve })
  let complete!: (response: Response) => void
  const delayed = new Promise<Response>((resolve) => { complete = resolve })
  const runtime = new LocalModelRuntime({ store: new LocalModelStore({ configDir: root }), catalog: [entry], enginePath: '/fake/server', engineVersion: 'b9000', spawn: () => new FakeProcess(), findFreePort: async () => 43123, stopTimeoutMs: 10,
    fetch: async (url) => { if (String(url).includes('example.invalid')) return new Response(bytes); healthStarted(); return delayed },
  })
  await runtime.download({ assetId: entry.assetId })
  const starting = runtime.start({ assetId: entry.assetId })
  await started
  await runtime.stop()
  complete(new Response('ok'))
  await expect(starting).rejects.toThrow()
  expect(runtime.listSnapshot().runtime.state).toBe('idle')
})

test('Given 持久化 running 状态 When 主进程重启 Then 恢复 installed 且端点未就绪', async () => {
  const { runtime, store, entry } = await workingRuntime()
  store.updateStatus(entry.assetId, 'running')
  const restarted = new LocalModelRuntime({ store, catalog: [entry] })
  expect(restarted.listSnapshot().assets[0]?.status).toBe('installed')
  expect(restarted.listSnapshot().runtime.endpointReady).toBe(false)
  runtime.shutdown()
})

test('Given 切换模型正在等旧进程退出 When 停止 Then 新进程不得迟到启动', async () => {
  const { root, entry, bytes } = createCatalog()
  const other = { ...entry, assetId: 'second-asset', modelId: 'second-model' }
  const store = new LocalModelStore({ configDir: root })
  const { EventEmitter } = await import('node:events')
  class DelayedProcess extends EventEmitter implements ManagedProcess {
    pid = 101
    kill(): boolean { return true }
  }
  const first = new DelayedProcess()
  let spawned = 0
  const runtime = new LocalModelRuntime({ store, catalog: [entry, other], enginePath: '/fake/server', engineVersion: 'b9000', spawn: () => { spawned++; return spawned === 1 ? first : new FakeProcess() }, findFreePort: async () => 43123, stopTimeoutMs: 100,
    fetch: async (url) => String(url).includes('example.invalid') ? new Response(bytes) : new Response('ok'),
  })
  await runtime.download({ assetId: entry.assetId }); await runtime.download({ assetId: other.assetId })
  await runtime.start({ assetId: entry.assetId })
  const switching = runtime.start({ assetId: other.assetId })
  const stopping = runtime.stop()
  first.emit('exit', 0)
  await stopping
  await expect(switching).rejects.toThrow()
  expect(spawned).toBe(1)
})

test('Given 能力已测试 When 重启注入不同引擎版本 Then 旧证据失效', async () => {
  const { runtime, store, entry } = await workingRuntime()
  await runtime.test({ assetId: entry.assetId, prompt: 'hello' })
  store.setEnabled(entry.assetId, true)
  await runtime.stop()
  const restarted = new LocalModelRuntime({ store, catalog: [entry], enginePath: '/fake/server', engineVersion: 'b9001' })
  expect(restarted.listSnapshot().assets[0]?.capability.state).toBe('unknown')
  await expect(restarted.acquire(entry.assetId)).rejects.toThrow('检查已失效')
})

test('Given 正在持有模型租约 When shutdown Then 同步终止进程且拒绝新请求', async () => {
  const { runtime, store, entry, child } = await workingRuntime()
  await runtime.test({ assetId: entry.assetId, prompt: 'hello' })
  store.setEnabled(entry.assetId, true)
  const lease = await runtime.acquire(entry.assetId)
  runtime.shutdown()
  const pending = runtime.acquire(entry.assetId)
  expect(child.killedSignals).toContain('SIGKILL')
  await expect(pending).rejects.toThrow('关闭')
  lease.release()
  await expect(runtime.acquire(entry.assetId)).rejects.toThrow('关闭')
})

test('Given Range 响应偏移错误 When 续传 Then 拒绝拼接并保持未安装', async () => {
  const { root, entry, bytes } = createCatalog()
  const store = new LocalModelStore({ configDir: root })
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(join(store.ensureModelsDir(), 'staging'), { recursive: true })
  writeFileSync(join(root, 'models', 'staging', `${entry.assetId}.part`), bytes.slice(0, 10))
  const runtime = new LocalModelRuntime({ store, catalog: [entry], fetch: async () => new Response(bytes.slice(10), { status: 206, headers: { 'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}` } }) })
  await expect(runtime.download({ assetId: entry.assetId })).rejects.toThrow('Content-Range')
  expect(store.listAssets()).toEqual([])
})

test('Given 未测试或过期能力 When 开启模型 Then 明确拒绝启用', async () => {
  const { runtime, entry } = await workingRuntime()
  expect(() => runtime.setEnabled(entry.assetId, true)).toThrow('测试')
  expect(runtime.listSnapshot().assets[0]?.enabled).toBe(false)
})

test('Given UI 订阅状态 When 加载和停止完成 Then 最后事件必须解除 busy', async () => {
  const { runtime, entry } = await workingRuntime()
  let lastBusy: boolean | undefined
  runtime.subscribe((snapshot) => { lastBusy = snapshot.runtime.busy })
  await runtime.start({ assetId: entry.assetId })
  expect(lastBusy).toBe(false)
  await runtime.stop()
  expect(lastBusy).toBe(false)
})

test('Given 手动启动尚未完成 When 租约等待取消 Then 及时退出等待并释放引用', async () => {
  const { root, entry, bytes } = createCatalog()
  const store = new LocalModelStore({ configDir: root })
  let complete!: (response: Response) => void
  const delayed = new Promise<Response>((resolve) => { complete = resolve })
  let healthStarted!: () => void
  const started = new Promise<void>((resolve) => { healthStarted = resolve })
  const runtime = new LocalModelRuntime({ store, catalog: [entry], enginePath: '/fake/server', engineVersion: 'b9000', spawn: () => new FakeProcess(), findFreePort: async () => 43123, stopTimeoutMs: 10,
    fetch: async (url) => { if (String(url).includes('example.invalid')) return new Response(bytes); healthStarted(); return delayed },
  })
  await runtime.download({ assetId: entry.assetId })
  store.updateCapability(entry.assetId, { state: 'available', assetSha256: entry.sha256, engineVersion: 'b9000', chatTemplate: 'gguf-embedded', contextWindow: 4096, probeVersion: 3 })
  store.setEnabled(entry.assetId, true)
  const starting = runtime.start({ assetId: entry.assetId })
  await started
  const controller = new AbortController()
  const acquiring = runtime.acquire(entry.assetId, controller.signal)
  await Promise.resolve(); await Promise.resolve()
  controller.abort()
  try {
    await expect(Promise.race([acquiring, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('取消未及时完成')), 100))])).rejects.toThrow('aborted')
  } finally { complete(new Response('ok')); await starting; await acquiring.catch(() => undefined); await runtime.stop() }
})


test('Given 父任务持有模型 When 子任务请求不同模型 Then 立即拒绝不无限等待', async () => {
  const { runtime, entry } = await workingRuntime()
  await runtime.test({ assetId: entry.assetId, prompt: 'hello' })
  runtime.setEnabled(entry.assetId, true)
  const parent = await runtime.acquire(entry.assetId)
  try {
    await expect(Promise.race([runtime.acquire('different-asset'), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('死锁')), 100))])).rejects.toThrow('不同模型')
  } finally { parent.release(); await runtime.stop() }
})


test('Given 模型已验证但未加载 When 同模型并发租约到达 Then 只启动一次引擎', async () => {
  const { runtime, entry, launches } = await workingRuntime()
  await runtime.test({ assetId: entry.assetId, prompt: 'hello' })
  runtime.setEnabled(entry.assetId, true)
  await runtime.stop()
  const [parent, child] = await Promise.all([runtime.acquire(entry.assetId), runtime.acquire(entry.assetId)])
  expect(launches()).toBe(2)
  expect(parent.endpoint).toEqual(child.endpoint)
  parent.release()
  await expect(runtime.stop()).rejects.toThrow('占用')
  child.release()
  await runtime.stop()
})

test('Given 设备物理内存不足 When 启动 Then 拒绝创建引擎进程', async () => {
  const { root, entry, bytes } = createCatalog()
  let spawned = false
  const runtime = new LocalModelRuntime({ store: new LocalModelStore({ configDir: root }), catalog: [{ ...entry, memoryBytes: 8192 }], totalMemory: () => 4096, findFreePort: async () => 43123, enginePath: '/fake/server', engineVersion: 'b9000', spawn: () => { spawned = true; return new FakeProcess() }, fetch: async () => new Response(bytes) })
  await runtime.download({ assetId: entry.assetId })
  await expect(runtime.start({ assetId: entry.assetId })).rejects.toThrow('内存')
  expect(spawned).toBe(false)
})

test('Given 手动加载后没有任务 When 超过空闲期限 Then 自动卸载模型', async () => {
  const { root, entry, bytes } = createCatalog()
  const child = new FakeProcess()
  const runtime = new LocalModelRuntime({ store: new LocalModelStore({ configDir: root }), catalog: [entry], idleUnloadMs: 10, enginePath: '/fake/server', engineVersion: 'b9000', spawn: () => child, findFreePort: async () => 43123, stopTimeoutMs: 10, fetch: async (url) => String(url).includes('example.invalid') ? new Response(bytes) : new Response('ok') })
  await runtime.download({ assetId: entry.assetId })
  await runtime.start({ assetId: entry.assetId })
  await new Promise((resolve) => setTimeout(resolve, 40))
  expect(runtime.listSnapshot().runtime.state).toBe('idle')
  expect(child.killedSignals).toEqual(['SIGTERM'])
})


test('Given 文本模式 Agent When 启动 llama-server Then 显式关闭 reasoning 保留可见输出预算', async () => {
  const { root, entry, bytes } = createCatalog()
  let flags: string[] = []
  const runtime = new LocalModelRuntime({ store: new LocalModelStore({ configDir: root }), catalog: [entry], enginePath: '/fake/server', engineVersion: 'b9000', spawn: (_, args) => { flags = args; return new FakeProcess() }, findFreePort: async () => 43123, stopTimeoutMs: 10, fetch: async (url) => String(url).includes('example.invalid') ? new Response(bytes) : new Response('ok') })
  await runtime.download({ assetId: entry.assetId })
  await runtime.start({ assetId: entry.assetId })
  expect(flags[flags.indexOf('--reasoning-budget') + 1]).toBe('0')
  expect(flags[flags.indexOf('--chat-template-kwargs') + 1]).toBe('{"enable_thinking":false}')
  await runtime.stop()
})


test('Given 空闲卸载计时中 When 新任务获得租约 Then 在用期间不卸载并在最后释放后卸载', async () => {
  const { runtime, entry } = await workingRuntime(25)
  await runtime.test({ assetId: entry.assetId, prompt: 'hello' })
  runtime.setEnabled(entry.assetId, true)
  const lease = await runtime.acquire(entry.assetId)
  await new Promise((resolve) => setTimeout(resolve, 70))
  expect(runtime.listSnapshot().runtime.state).toBe('running')
  lease.release()
  await new Promise((resolve) => setTimeout(resolve, 70))
  expect(runtime.listSnapshot().runtime.state).toBe('idle')
})

test('Given 正式文件已完整落盘但清单缺失 When 重试下载 Then 校验恢复登记且不请求网络', async () => {
  const { root, entry, bytes } = createCatalog()
  const store = new LocalModelStore({ configDir: root })
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(join(store.ensureModelsDir(), entry.assetId), { recursive: true })
  writeFileSync(store.resolveAssetFilePath(entry.assetId, 'qwen.gguf'), bytes)
  let requests = 0
  const runtime = new LocalModelRuntime({ store, catalog: [entry], fetch: async () => { requests++; throw new Error('不应联网') } })
  expect((await runtime.download({ assetId: entry.assetId })).status).toBe('installed')
  expect(requests).toBe(0)
})


test('Given 已登记文件被删除 When 启动 Then 持久化 error 保留 installedAt 允许重下', async () => {
  const { root, entry, bytes } = createCatalog()
  const store = new LocalModelStore({ configDir: root })
  const runtime = new LocalModelRuntime({ store, catalog: [entry], fetch: async () => new Response(bytes) })
  const installed = await runtime.download({ assetId: entry.assetId })
  const { rmSync } = await import('node:fs')
  rmSync(store.resolveAssetFilePath(entry.assetId, installed.fileName))
  await expect(runtime.start({ assetId: entry.assetId })).rejects.toThrow('文件缺失')
  const saved = store.getAsset(entry.assetId)
  expect(saved?.status).toBe('error')
  expect(saved?.installedAt).toBeDefined()
})
