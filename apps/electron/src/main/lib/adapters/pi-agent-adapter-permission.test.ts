import { afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ServerOpsAgentFacade } from '../server-ops/server-ops-agent-facade'
import type { ServerOpsAgentReadFacade } from '../server-ops/server-ops-agent-read-facade'
import { AgentPermissionService, revalidateSingleApprovalResult } from '../agent-permission-service'
import type { PermissionRequest, PromaPermissionMode } from '@proma/shared'
import { buildServerOpsReadWriteTools } from './pi-server-ops-read-tools'

type PiAdapterModule = typeof import('./pi-agent-adapter')
type PiBuiltinToolsModule = typeof import('./pi-builtin-tools')
let wrapCustomToolDefinitions: PiAdapterModule['wrapCustomToolDefinitions']
let getPersistedPiSessionFile: PiAdapterModule['getPersistedPiSessionFile']
let buildServerOpsTools: PiBuiltinToolsModule['buildServerOpsTools']
const temporaryDirectories: string[] = []

mock.module('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getName: () => 'Proma Test' },
  BrowserWindow: { getAllWindows: () => [] },
  WebContentsView: class {},
  MessageChannelMain: class {},
  utilityProcess: {},
  ipcMain: { handle: () => undefined, removeHandler: () => undefined },
  shell: { openExternal: async () => undefined, openPath: async () => '' },
  dialog: {}, clipboard: {}, nativeImage: {}, screen: {}, globalShortcut: {},
  powerSaveBlocker: {}, powerMonitor: {}, systemPreferences: {}, Menu: {},
  Notification: class {},
  net: {},
  session: {},
  safeStorage: { isEncryptionAvailable: () => false },
  default: {},
}))

beforeAll(async () => {
  ;({ wrapCustomToolDefinitions, getPersistedPiSessionFile } = await import('./pi-agent-adapter'))
  ;({ buildServerOpsTools } = await import('./pi-builtin-tools'))
})

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const sdk = {
  defineTool: (definition: ToolDefinition) => definition,
} as typeof import('@earendil-works/pi-coding-agent')

test('Given Pi 0.99.1 只返回尚未落盘的 session 路径 When 保存会话元数据 Then 只接受真实文件', () => {
  /** 模拟 Pi 空会话先生成预期路径、首条消息后才落盘的两个阶段。 */
  const directory = mkdtempSync(join(tmpdir(), 'proma-pi-session-file-'))
  temporaryDirectories.push(directory)
  const sessionFile = join(directory, 'session.jsonl')
  expect(getPersistedPiSessionFile(sessionFile)).toBeUndefined()
  writeFileSync(sessionFile, '{"type":"session"}\n', 'utf8')
  expect(getPersistedPiSessionFile(sessionFile)).toBe(sessionFile)
})

test('Given 真实 Pi custom tool wrapper When updatedInput 篡改 hostId Then 权限参数被记录但 Facade 授权边界仍拒绝', async () => {
  const statusCalls: string[] = []
  const facade = {
    status: ({ hostId }: { hostId: string }) => {
      statusCalls.push(hostId)
      if (hostId !== 'host-1') throw new Error('SERVER_OPS_AGENT_ACCESS_REQUIRED')
      return { hostId, phase: 'connected' as const }
    },
  } as ServerOpsAgentFacade
  const permissionCalls: Array<{ toolName: string; input: Record<string, unknown>; toolUseID: string }> = []
  const wrapped = wrapCustomToolDefinitions(buildServerOpsTools(sdk, facade), async (toolName, input, options) => {
    permissionCalls.push({ toolName, input, toolUseID: options.toolUseID })
    return { behavior: 'allow', updatedInput: { ...input, hostId: 'host-2' } }
  })
  const statusTool = wrapped.find((tool) => tool.name === 'server_status')!

  await expect(statusTool.execute(
    'tool-use-1', { hostId: 'host-1' }, new AbortController().signal,
    undefined, {} as ExtensionToolContext,
  )).rejects.toThrow('SERVER_OPS_AGENT_ACCESS_REQUIRED')
  expect(permissionCalls).toEqual([{
    toolName: 'server_status', input: { hostId: 'host-1' }, toolUseID: 'tool-use-1',
  }])
  expect(statusCalls).toEqual(['host-2'])
})

test('Given 恶意模型尝试宿主分派 When 运维只读模式 Then Bash/MCP/server_* 都拒绝执行', async () => {
  const executed: string[] = []
  const tools = ['ops_resources', 'Bash', 'mcp__other__tool', 'server_exec'].map((name) => sdk.defineTool({
    name,
    label: name,
    description: name,
    parameters: { type: 'object', properties: {} },
    async execute() {
      executed.push(name)
      return { content: [{ type: 'text', text: 'executed' }], details: name }
    },
  }))
  const wrapped = wrapCustomToolDefinitions(tools, async () => ({ behavior: 'allow', updatedInput: {} }), 'server-ops-read')
  expect(wrapped.map((tool) => tool.name)).toEqual(['ops_resources'])
  const forbidden = wrapCustomToolDefinitions(tools.slice(1), async () => ({ behavior: 'allow', updatedInput: {} }), 'server-ops-read')
  expect(forbidden).toHaveLength(0)
  expect(executed).toEqual([])
  expect(wrapCustomToolDefinitions(tools, undefined, 'standard')).toHaveLength(4)
})

test.each(['allow', 'deny', 'abort', 'plan', 'stale'] as const)(
  'Given 数据库写工具经过 Pi 包装与原生审批 When %s Then 未获有效单次批准不写库且下次仍需确认',
  async (decision) => {
    /** 真实审批服务与工具包装器连接；仅最末端写库使用无外部副作用的替身。 */
    const service = new AgentPermissionService()
    /** 捕获原生确认卡，核对参数与禁止始终允许的约束。 */
    const requests: PermissionRequest[] = []
    /** 每次底层写入的实际参数与次数。 */
    const writes: unknown[] = []
    /** 模拟确认期间切到计划模式或停止当前运行。 */
    let mode: PromaPermissionMode = 'bypassPermissions'
    /** 标识当前工具调用是否已失去运行身份。 */
    let stale = false
    /** 传递给工具和审批的共同取消信号。 */
    const controller = new AbortController()
    /** 注册真正的数据库工具，外部数据库访问替换为调用记录。 */
    const facade = { databaseWrite: async (input: unknown) => { writes.push(input); return { outcome: 'committed' } } } as unknown as ServerOpsAgentReadFacade
    /** 工具注册后经过与生产相同的 Pi 权限包装器。 */
    const tools = wrapCustomToolDefinitions(buildServerOpsReadWriteTools(sdk, facade), async (name, input, options) => {
      /** 保留生产编排使用的同一单次审批和异步复核。 */
      const result = await service.requestSingleApproval('db-session', name, input, options, request => { requests.push(request) })
      return revalidateSingleApprovalResult(result, () => stale ? { behavior: 'deny', message: '运行已停止' } : undefined, () => mode)
    }, 'standard')
    /** 选取待验证的唯一数据库写入口。 */
    const tool = tools.find(entry => entry.name === 'ops_database_write')!
    /** 工具参数中不包含凭据或额外服务器授权。 */
    const input = { sourceId: 'db-1', database: 'app', sql: 'UPDATE users SET active=1 WHERE id=7' }
    /** 审批尚未返回时工具必须保持等待。 */
    const pending = tool.execute('db-write-1', input, controller.signal, undefined, {} as ExtensionToolContext)
    expect(writes).toEqual([])
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ toolName: 'ops_database_write', toolInput: input, allowAlways: false })
    if (decision === 'abort') controller.abort()
    else {
      if (decision === 'plan') mode = 'plan'
      if (decision === 'stale') stale = true
      service.respondToPermission(requests[0]!.requestId, decision === 'deny' ? 'deny' : 'allow', true)
    }
    if (decision !== 'allow') {
      await expect(pending).rejects.toThrow()
      expect(writes).toEqual([])
      return
    }
    await pending
    expect(writes).toEqual([input])
    /** 即使调用方伪造始终允许，第二次写入仍须新的确认卡，拒绝后不增加写入。 */
    const second = tool.execute('db-write-2', input, controller.signal, undefined, {} as ExtensionToolContext)
    expect(requests).toHaveLength(2)
    expect(writes).toHaveLength(1)
    service.respondToPermission(requests[1]!.requestId, 'deny', false)
    await expect(second).rejects.toThrow('用户拒绝')
    expect(writes).toHaveLength(1)
  },
)

/** 服务器副作用工具的最小合法输入；均通过真实 TypeBox 工具定义进入 Facade。 */
const serverApprovalCases = [
  { toolName: 'server_exec', input: { hostId: 'host-1', command: 'sudo systemctl restart app' } },
  { toolName: 'server_docker_action', input: { hostId: 'host-1', containerId: 'a'.repeat(64), action: 'restart' } },
  { toolName: 'server_files_mutate', input: { hostId: 'host-1', action: 'mkdir', path: '/srv/app/cache' } },
  { toolName: 'server_disconnect', input: { hostId: 'host-1' } },
] as const

for (const operation of serverApprovalCases) {
  test.each(['allow', 'deny', 'abort', 'plan', 'stale'] as const)(
    `Given ${operation.toolName} 经过 Pi 包装与原生审批 When %s Then 未获有效单次批准不产生服务器副作用`,
    async (decision) => {
      const service = new AgentPermissionService()
      const requests: PermissionRequest[] = []
      const effects: Array<{ toolName: string; input: unknown }> = []
      let mode: PromaPermissionMode = 'bypassPermissions'
      let stale = false
      const controller = new AbortController()
      /** 所有副作用替身只记录调用；读工具仍提供完整 Facade 形状供真实 builder 注册。 */
      const facade = {
        list: () => [],
        status: ({ hostId }: { hostId: string }) => ({ hostId, phase: 'connected' as const }),
        connect: async ({ hostId }: { hostId: string }) => ({ hostId, phase: 'connected' as const }),
        exec: async (input: unknown) => {
          effects.push({ toolName: 'server_exec', input })
          return { stdout: '', stderr: '', exitCode: 0, truncated: false }
        },
        disconnect: async (input: { hostId: string }) => {
          effects.push({ toolName: 'server_disconnect', input })
          return { hostId: input.hostId, phase: 'disconnected' as const }
        },
        dockerAction: async (input: unknown) => {
          effects.push({ toolName: 'server_docker_action', input })
          return { hostId: 'host-1', containerId: 'a'.repeat(64), action: 'restart', outcome: 'succeeded' }
        },
        filesMutate: async (input: unknown) => {
          effects.push({ toolName: 'server_files_mutate', input })
          return { hostId: 'host-1', action: 'mkdir', path: '/srv/app/cache', outcome: 'succeeded' }
        },
      } as unknown as ServerOpsAgentFacade
      const tools = wrapCustomToolDefinitions(buildServerOpsTools(sdk, facade), async (name, input, options) => {
        const result = await service.requestSingleApproval('server-session', name, input, options, request => { requests.push(request) })
        return revalidateSingleApprovalResult(
          result,
          () => stale ? { behavior: 'deny', message: '运行已停止' } : undefined,
          () => mode,
        )
      }, 'standard')
      const tool = tools.find(entry => entry.name === operation.toolName)!

      const pending = tool.execute('server-write-1', operation.input, controller.signal, undefined, {} as ExtensionToolContext)
      expect(effects).toEqual([])
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        toolName: operation.toolName,
        toolInput: operation.input,
        allowAlways: false,
      })
      if (decision === 'abort') controller.abort()
      else {
        if (decision === 'plan') mode = 'plan'
        if (decision === 'stale') stale = true
        service.respondToPermission(requests[0]!.requestId, decision === 'deny' ? 'deny' : 'allow', true)
      }
      if (decision !== 'allow') {
        await expect(pending).rejects.toThrow()
        expect(effects).toEqual([])
        return
      }
      await pending
      expect(effects).toEqual([{ toolName: operation.toolName, input: operation.input }])

      /** 第一次请求伪造 alwaysAllow=true 也不能让下一次服务器写动作跳过确认。 */
      const second = tool.execute('server-write-2', operation.input, controller.signal, undefined, {} as ExtensionToolContext)
      expect(requests).toHaveLength(2)
      expect(effects).toHaveLength(1)
      service.respondToPermission(requests[1]!.requestId, 'deny', false)
      await expect(second).rejects.toThrow('用户拒绝')
      expect(effects).toHaveLength(1)
    },
  )
}

test.each(['allow', 'deny', 'abort', 'plan', 'stale'] as const)(
  'Given Redis 写工具经过 Pi 包装与原生审批 When %s Then 未获有效单次批准不写入且下次仍需确认',
  async (decision) => {
    const service = new AgentPermissionService()
    const requests: PermissionRequest[] = []
    const writes: unknown[] = []
    let mode: PromaPermissionMode = 'bypassPermissions'
    let stale = false
    const controller = new AbortController()
    const facade = {
      redisWrite: async (input: unknown) => {
        writes.push(input)
        return { sourceId: 'redis-1', command: 'SET', outcome: 'committed' }
      },
    } as unknown as ServerOpsAgentReadFacade
    const tools = wrapCustomToolDefinitions(buildServerOpsReadWriteTools(sdk, facade), async (name, input, options) => {
      const result = await service.requestSingleApproval('redis-session', name, input, options, request => { requests.push(request) })
      return revalidateSingleApprovalResult(
        result,
        () => stale ? { behavior: 'deny', message: '运行已停止' } : undefined,
        () => mode,
      )
    }, 'standard')
    const tool = tools.find(entry => entry.name === 'ops_redis_write')!
    const input = { sourceId: 'redis-1', command: 'SET', args: ['session:7', 'active', 'EX', '60'] }

    const pending = tool.execute('redis-write-1', input, controller.signal, undefined, {} as ExtensionToolContext)
    expect(writes).toEqual([])
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ toolName: 'ops_redis_write', toolInput: input, allowAlways: false })
    if (decision === 'abort') controller.abort()
    else {
      if (decision === 'plan') mode = 'plan'
      if (decision === 'stale') stale = true
      service.respondToPermission(requests[0]!.requestId, decision === 'deny' ? 'deny' : 'allow', true)
    }
    if (decision !== 'allow') {
      await expect(pending).rejects.toThrow()
      expect(writes).toEqual([])
      return
    }
    await pending
    expect(writes).toEqual([input])

    const second = tool.execute('redis-write-2', input, controller.signal, undefined, {} as ExtensionToolContext)
    expect(requests).toHaveLength(2)
    expect(writes).toHaveLength(1)
    service.respondToPermission(requests[1]!.requestId, 'deny', false)
    await expect(second).rejects.toThrow('用户拒绝')
    expect(writes).toHaveLength(1)
  },
)


/** 创建真正经过权限包装器的文件工具，用事件序列检查副作用边界。 */
async function captureFixture(denied = false, throws = false) {
  const { wrapToolWithPermission } = await import('./pi-agent-adapter')
  const events: string[] = []
  const definition = sdk.defineTool({
    name: 'write', label: 'Write', description: 'write fixture',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    async execute(_id, params) {
      events.push(`execute:${(params as { path: string }).path}`)
      if (throws) throw new Error('partial write')
      return { content: [{ type: 'text', text: 'ok' }], details: {} }
    },
  })
  const wrapped = wrapToolWithPermission(definition, {
    canUseTool: async () => {
      events.push('permission')
      return denied ? { behavior: 'deny', message: 'denied' } : { behavior: 'allow', updatedInput: { file_path: '/approved.ts', content: 'x' } }
    },
    onFileChangeCapture: async capture => { events.push(`${capture.phase}:${capture.path}`) },
  })
  return { events, execute: () => wrapped.execute('capture-test', { path: '/requested.ts' }, new AbortController().signal, undefined, {} as ExtensionToolContext) }
}

test('Given Write 经权限改写路径 When 执行 Then 只采集获准路径并严格按 before execute after 排序', async () => {
  const fixture = await captureFixture()
  await fixture.execute()
  expect(fixture.events).toEqual(['permission', 'before:/approved.ts', 'execute:/approved.ts', 'after:/approved.ts'])
})
test('Given 拒绝 Write When 执行 Then 不读取文件也不调用采集器', async () => {
  const fixture = await captureFixture(true)
  await expect(fixture.execute()).rejects.toThrow('denied')
  expect(fixture.events).toEqual(['permission'])
})
test('Given 工具部分写入后抛错 When 收尾 Then 仍采集实际结果且保留原始错误', async () => {
  const fixture = await captureFixture(false, true)
  await expect(fixture.execute()).rejects.toThrow('partial write')
  expect(fixture.events.at(-1)).toBe('after:/approved.ts')
})


test('Given 采集超时 When 工具正常写入 Then 执行继续且最终请求未知降级', async () => {
  const { wrapToolWithPermission } = await import('./pi-agent-adapter')
  const phases: string[] = []
  let executed = false
  const tool = wrapToolWithPermission(sdk.defineTool({ name: 'edit', label: 'Edit', description: 'fixture',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    async execute() { executed = true; return { content: [], details: {} } },
  }), { onFileChangeCapture: async capture => {
    phases.push(capture.phase)
    if (capture.phase === 'before') throw new Error('capture timeout')
  } })
  await tool.execute('timeout', { path: '/a.ts' }, undefined, undefined, {} as ExtensionToolContext)
  expect(executed).toBe(true)
  expect(phases).toEqual(['before', 'invalidate'])
})
