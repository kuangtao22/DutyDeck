import { afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ServerOpsAgentFacade } from '../server-ops/server-ops-agent-facade'

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
