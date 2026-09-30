import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { copyFile, lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import type { AddressInfo } from 'node:net'
import os, { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SDKAssistantMessage, SDKMessage, SDKResultMessage, TerminalOutputEvent, TerminalProfile, TerminalState } from '@proma/shared'
import type { PiAgentQueryOptions } from '../src/main/lib/adapters/pi-agent-adapter'

/** 标记当前进程是由 smoke 父入口启动的 Electron 子进程。 */
const CHILD_FLAG = 'PROMA_UPSTREAM_RUNTIME_SMOKE_CHILD'
/** 向 Electron 与 utility process 传递本轮临时隔离根。 */
const ROOT_ENV = 'PROMA_UPSTREAM_RUNTIME_SMOKE_ROOT'
/** 允许 CI 或本机验收显式指定真实 Electron 可执行文件。 */
const ELECTRON_EXECUTABLE_ENV = 'PROMA_UPSTREAM_SMOKE_ELECTRON'
/** 单个 runtime 生命周期验收点允许的最长等待时间。 */
const SMOKE_TIMEOUT_MS = 20_000
/** 完整 Electron smoke 允许的独立总时限，覆盖多个串行生命周期阶段。 */
const ELECTRON_SMOKE_TIMEOUT_MS = 90_000
/** 父进程终止 Electron 后等待其释放文件句柄的最长时间。 */
const ELECTRON_EXIT_TIMEOUT_MS = 10_000
/** 当前真实 runtime smoke 已实现并由 CI 使用的平台。 */
const SUPPORTED_PLATFORMS: readonly NodeJS.Platform[] = ['darwin', 'win32']

/** Electron 子进程退出或启动失败的统一结果。 */
type ElectronExitOutcome =
  | { code: number | null; signal: NodeJS.Signals | null }
  | { error: Error }

/** 按日志追加顺序跟踪尚未验证退出的 utility process。 */
interface UtilityProcessTracker {
  /** 下一条待验证的日志下标。 */
  nextRecordIndex: number
  /** 最近一次读取到的完整 utility 记录。 */
  records: string[]
}

/** 本地假模型服务收到的单次 OpenAI Chat Completions 请求。 */
interface LocalModelRequest {
  /** 请求方法。 */
  method: string
  /** 请求路径。 */
  path: string
  /** Authorization 请求头。 */
  authorization?: string
  /** 解析后的 JSON 请求体。 */
  body: Record<string, unknown>
}

/** 本地假模型服务的可观察状态与关闭入口。 */
interface LocalModelServer {
  /** Pi runtime 使用的 OpenAI 兼容协议根地址。 */
  baseUrl: string
  /** 按到达顺序记录的真实 provider 请求。 */
  requests: LocalModelRequest[]
  /** 关闭监听与存量连接。 */
  close: () => Promise<void>
}

/** 单次真实 Pi query 的消息、会话与落盘结果。 */
interface AgentQueryProbe {
  /** Utility runtime 返回的完整 SDK 消息流。 */
  messages: SDKMessage[]
  /** Pi 创建或恢复后的 SDK session ID。 */
  sdkSessionId: string
  /** Pi SessionManager 使用的 JSONL 文件。 */
  sessionFile: string
  /** 最终 SDK result。 */
  result: SDKResultMessage
  /** 最终 assistant 文本。 */
  assistantText: string
}

/** 断言当前平台具备本 smoke 覆盖的真实 Electron utilityProcess 与 PTY 条件。 */
function assertSupportedPlatform(): void {
  assert.ok(
    SUPPORTED_PLATFORMS.includes(process.platform),
    `runtime smoke 当前不支持 ${process.platform}`,
  )
}

/** 根据平台选择 CI 必定可用且无需用户配置的终端 profile。 */
function getSmokeTerminalProfile(): TerminalProfile {
  return process.platform === 'win32' ? 'powershell' : 'default'
}

/** 生成当前 shell 可执行的纯输出命令，用于确认真实 PTY 输入输出链路。 */
function getSmokeTerminalCommand(marker: string): string {
  /** 将标记拆开，确保终端回显的命令原文不包含完整输出标记。 */
  const splitAt = Math.floor(marker.length / 2)
  /** shell 命令拼接的标记前半段。 */
  const prefix = marker.slice(0, splitAt)
  /** shell 命令拼接的标记后半段。 */
  const suffix = marker.slice(splitAt)
  return process.platform === 'win32'
    ? `Write-Output ('${prefix}' + '${suffix}')\r\n`
    : `printf '%s%s\\n' '${prefix}' '${suffix}'\n`
}

/** 将 fixture 进程内的 homedir 解析隔离到临时根，并同步给具名 ESM 导出。 */
function installFixtureHome(smokeRoot: string): void {
  os.homedir = () => smokeRoot
  syncBuiltinESMExports()
}

/** 解析 smoke 使用的真实 Electron 可执行文件；显式任务变量优先于已安装包入口。 */
async function resolveElectronExecutable(): Promise<string> {
  /** 调用方显式指定的 Electron 可执行文件。 */
  const explicitPath = process.env[ELECTRON_EXECUTABLE_ENV]?.trim()
  if (explicitPath) return realpath(explicitPath)
  /** electron 包在普通 Node/Bun 进程中公开的可执行文件路径。 */
  const electronPackage = await import('electron')
  const installedPath = electronPackage.default
  assert.equal(typeof installedPath, 'string', 'electron 包未返回可执行文件路径')
  return realpath(installedPath)
}

/** 为单个异步验收点设置有界超时，避免 utility process 异常时悬挂。 */
async function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = SMOKE_TIMEOUT_MS,
): Promise<T> {
  /** 当前验收点的超时定时器。 */
  let timer: ReturnType<typeof setTimeout> | undefined
  /** 超时后拒绝验收点的定时器 Promise。 */
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时`)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 读取本地假模型服务收到的完整请求体。 */
async function readRequestBody(request: import('node:http').IncomingMessage): Promise<string> {
  /** 按网络到达顺序保存的请求体片段。 */
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

/** 启动只监听回环地址的 OpenAI Chat Completions SSE 假服务。 */
async function startLocalModelServer(): Promise<LocalModelServer> {
  /** 服务收到的全部真实 provider 请求。 */
  const requests: LocalModelRequest[] = []
  /** 只为本次 smoke 提供两轮固定回答的 HTTP 服务。 */
  const server = createServer(async (request, response) => {
    try {
      /** 当前请求的原始正文。 */
      const rawBody = await readRequestBody(request)
      /** 当前请求解析后的 JSON 对象。 */
      const body = JSON.parse(rawBody) as Record<string, unknown>
      requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        authorization: request.headers.authorization,
        body,
      })
      /** 每轮唯一回复，用于验证恢复请求包含首轮 assistant 历史。 */
      const reply = requests.length === 1 ? 'SMOKE_FIRST_RESPONSE' : 'SMOKE_RESUMED_RESPONSE'
      /** 所有 chunk 共享的合成 completion ID。 */
      const completionId = `chatcmpl-smoke-${requests.length}`
      /** 固定时间戳，避免 smoke 产出不必要的时序差异。 */
      const created = 1_700_000_000 + requests.length
      /** 首个 SSE chunk 提供 assistant 文本。 */
      const contentChunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: 'smoke-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }],
      }
      /** 末尾 SSE chunk 同时提供完成原因与真实 usage。 */
      const terminalChunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: 'smoke-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11 + requests.length, completion_tokens: 7, total_tokens: 18 + requests.length },
      }
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'close',
      })
      response.end(`data: ${JSON.stringify(contentChunk)}\n\ndata: ${JSON.stringify(terminalChunk)}\n\ndata: [DONE]\n\n`)
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json', Connection: 'close' })
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  })
  await withTimeout(new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  }), '本地假模型服务启动')
  /** Node 在 listen 成功后返回的 TCP 地址。 */
  const address = server.address() as AddressInfo | null
  assert.ok(address && address.port > 0, '本地假模型服务未取得端口')
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
    },
  }
}

/** 从兼容 SDK assistant 消息中提取文本块。 */
function getAssistantText(message: SDKMessage): string {
  if (message.type !== 'assistant') return ''
  /** 宽松 SDK 联合类型收窄后的 assistant 消息。 */
  const assistant = message as SDKAssistantMessage
  /** SDK assistant 内容块。 */
  const content = assistant.message.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/** 通过真实 per-session utility runtime 执行一次 Pi query。 */
async function runPiUtilityQuery(input: PiAgentQueryOptions, queryToken: string): Promise<AgentQueryProbe> {
  const { PiUtilityAdapter } = await import('../src/main/lib/adapters/pi-utility-adapter')
  /** 本轮独占的 utility adapter。 */
  const adapter = new PiUtilityAdapter()
  /** Utility runtime 返回的完整消息流。 */
  const messages: SDKMessage[] = []
  /** onSessionId 返回的真实 Pi session ID。 */
  let sdkSessionId = ''
  /** onSessionId 返回的真实 JSONL 路径。 */
  let sessionFile = ''
  /** 带会话回调的最终 query 输入。 */
  const queryInput: PiAgentQueryOptions = {
    ...input,
    onSessionId: (nextSessionId, nextSessionFile) => {
      sdkSessionId = nextSessionId
      sessionFile = nextSessionFile ?? ''
    },
  }
  try {
    await withTimeout((async () => {
      for await (const message of adapter.query(queryInput, queryToken)) messages.push(message)
    })(), `Pi utility query ${queryToken}`)
  } finally {
    await adapter.forceCloseQuery(queryToken)
    adapter.dispose()
  }
  /** 本轮最后一条 result 消息。 */
  const result = messages.findLast((message): message is SDKResultMessage => message.type === 'result')
  /** 本轮最后一条非空 assistant 文本。 */
  const assistantText = messages.map(getAssistantText).filter(Boolean).at(-1) ?? ''
  assert.ok(sdkSessionId, `Pi utility query ${queryToken} 未回传 session ID`)
  assert.ok(sessionFile, `Pi utility query ${queryToken} 未回传 session file`)
  assert.ok(result, `Pi utility query ${queryToken} 未返回 result`)
  return { messages, sdkSessionId, sessionFile, result, assistantText }
}

/** 轮询真实 PTY 输出，直到出现目标标记。 */
async function waitForOutput(readOutput: () => string, marker: string): Promise<void> {
  /** 输出标记的最晚出现时间。 */
  const deadline = Date.now() + SMOKE_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (readOutput().includes(marker)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`终端输出未出现标记：${marker}`)
}

/** 等待指定子进程实际退出；只有 ESRCH 能证明 PID 已不存在。 */
async function waitForProcessExit(pid: number, label: string): Promise<void> {
  /** 进程退出的最晚确认时间。 */
  const deadline = Date.now() + SMOKE_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      /** Node 对不存在 PID 返回的标准错误码。 */
      const code = error && typeof error === 'object' && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined
      if (code === 'ESRCH') return
      throw error
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`${label} 未在 stop 后退出：${pid}`)
}

/** 读取当前已启动 utility 的 PID 与隔离 home 记录。 */
async function readUtilityHomeRecords(smokeRoot: string): Promise<string[]> {
  try {
    return (await readFile(join(smokeRoot, 'utility-homes.log'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
  } catch (error) {
    /** 启动在 preload 前取消时日志可能尚不存在。 */
    const code = error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined
    if (code === 'ENOENT') return []
    throw error
  }
}

/** 在下一代启动前验证本阶段新增 utility 已退出，避免历史 PID 复用造成假阳性。 */
async function waitForNewUtilityProcessExits(
  smokeRoot: string,
  tracker: UtilityProcessTracker,
  label: string,
): Promise<void> {
  /** 当前 preload 已落盘的全部 utility 记录。 */
  const records = await readUtilityHomeRecords(smokeRoot)
  /** 本阶段新增、尚未验证退出的记录。 */
  const pendingRecords = records.slice(tracker.nextRecordIndex)
  tracker.nextRecordIndex = records.length
  tracker.records = records
  await Promise.all(pendingRecords.map(async (record) => {
    /** preload 记录的当前 utility PID。 */
    const utilityPid = Number(record.split('\t')[0])
    assert.ok(Number.isInteger(utilityPid) && utilityPid > 0, 'utility PID 记录无效')
    await waitForProcessExit(utilityPid, label)
  }))
}

/** 使用真实 Electron utilityProcess 验证 Agent client 的停止与重启代次。 */
async function verifyAgentRuntime(
  smokeRoot: string,
  utilityTracker: UtilityProcessTracker,
): Promise<Record<string, unknown>> {
  const { AgentRuntimeClient } = await import('../src/main/lib/agent-runtime-client')
  /** 被测 Agent runtime client。 */
  const client = new AgentRuntimeClient({
    sessionId: 'upstream-runtime-smoke-agent',
    startupTimeoutMs: 10_000,
    requestTimeoutMs: 10_000,
  })
  try {
    /** 启动握手尚未完成时触发的竞态 Promise。 */
    const starting = client.start()
    /** 与启动并发执行的停止 Promise。 */
    const stopping = client.stop()
    /** 启动竞态的最终结果。 */
    const startOutcome = await withTimeout(
      starting.then(() => 'resolved' as const, () => 'rejected' as const),
      'Agent 启动中 stop',
    )
    await withTimeout(stopping, 'Agent stop')
    assert.equal(startOutcome, 'rejected', 'Agent 启动中 stop 未取消在途启动')
    assert.equal(client.currentState.status, 'stopped', 'Agent stop 后状态不是 stopped')
    await waitForNewUtilityProcessExits(smokeRoot, utilityTracker, 'Agent 启动取消后的 utility process')

    /** stop 后重新启动得到的真实 runtime 状态。 */
    const restarted = await withTimeout(client.start(), 'Agent restart')
    assert.equal(restarted.status, 'ready', 'Agent restart 未进入 ready')
    assert.ok(typeof restarted.pid === 'number' && restarted.pid > 0, 'Agent restart 未返回真实 PID')
    assert.equal(client.isReady, true, 'Agent restart 后 client 未 ready')
    await withTimeout(client.stop(), 'Agent restart 后 stop')
    await waitForProcessExit(restarted.pid, 'Agent runtime')
    await waitForNewUtilityProcessExits(smokeRoot, utilityTracker, 'Agent restart 后的 utility process')
    assert.equal(client.currentState.status, 'stopped', 'Agent restart 后 stop 未回到 stopped')

    /** 只监听 127.0.0.1 的本地假模型服务，不读取真实渠道或账号。 */
    const modelServer = await startLocalModelServer()
    try {
      /** Pi 的 Agent 配置与会话文件均落在 smoke 临时根。 */
      const piAgentDir = join(smokeRoot, 'pi-agent')
      /** Pi SessionManager 的隔离 JSONL 目录。 */
      const piSessionDir = join(smokeRoot, 'pi-sessions')
      await Promise.all([
        mkdir(piAgentDir, { recursive: true }),
        mkdir(piSessionDir, { recursive: true }),
      ])
      /** 两轮 query 共用的本地 provider 配置。 */
      const baseQueryInput: PiAgentQueryOptions = {
        sessionId: 'upstream-runtime-smoke-agent',
        prompt: '',
        model: 'smoke-model',
        cwd: smokeRoot,
        apiKey: 'smoke-local-key',
        baseUrl: modelServer.baseUrl,
        provider: 'custom',
        channelName: 'Runtime Smoke Local Provider',
        permissionMode: 'bypassPermissions',
        systemPrompt: '仅返回本地 smoke 服务提供的固定文本。',
        piAgentDir,
        piSessionDir,
        activeToolNames: [],
        thinkingLevel: 'off',
      }
      /** 首轮真实 provider query。 */
      const first = await runPiUtilityQuery({
        ...baseQueryInput,
        prompt: 'SMOKE_FIRST_PROMPT',
      }, 'upstream-runtime-smoke-query-first')
      assert.equal(first.assistantText, 'SMOKE_FIRST_RESPONSE', '首轮 assistant 文本与本地 provider 不一致')
      assert.equal(first.result.subtype, 'success', '首轮 SDK result 不是 success')
      assert.equal(first.result.usageStatus, 'known', '首轮 SDK result 未保留 provider usage')
      assert.deepEqual(first.result.usage, {
        input_tokens: 12,
        output_tokens: 7,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }, '首轮 SDK result usage 不正确')
      await waitForNewUtilityProcessExits(smokeRoot, utilityTracker, 'Agent 首轮 query utility process')

      /** 首轮写入的真实 Pi JSONL。 */
      const firstTranscript = await readFile(first.sessionFile, 'utf8')
      /** 逐行解析可证明文件是有效 JSONL，而非只存在同名文件。 */
      const firstEntries = firstTranscript.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown)
      assert.ok(firstEntries.length >= 3, '首轮 Pi JSONL 缺少会话头或消息记录')
      assert.ok(firstTranscript.includes('SMOKE_FIRST_PROMPT'), '首轮 Pi JSONL 未持久化 user prompt')
      assert.ok(firstTranscript.includes('SMOKE_FIRST_RESPONSE'), '首轮 Pi JSONL 未持久化 assistant 回复')

      /** 使用首轮 SDK session ID 重新打开 JSONL 的第二轮真实 query。 */
      const resumed = await runPiUtilityQuery({
        ...baseQueryInput,
        prompt: 'SMOKE_RESUME_PROMPT',
        resumeSessionId: first.sdkSessionId,
      }, 'upstream-runtime-smoke-query-resume')
      assert.equal(resumed.sdkSessionId, first.sdkSessionId, '恢复 query 未复用首轮 Pi session ID')
      assert.equal(resumed.sessionFile, first.sessionFile, '恢复 query 未复用首轮 Pi JSONL')
      assert.equal(resumed.assistantText, 'SMOKE_RESUMED_RESPONSE', '恢复轮 assistant 文本与本地 provider 不一致')
      assert.equal(resumed.result.subtype, 'success', '恢复轮 SDK result 不是 success')
      assert.equal(resumed.result.usageStatus, 'known', '恢复轮 SDK result 未保留 provider usage')
      await waitForNewUtilityProcessExits(smokeRoot, utilityTracker, 'Agent 恢复 query utility process')

      assert.equal(modelServer.requests.length, 2, 'Pi runtime 没有严格发出两次本地 provider 请求')
      /** 首轮 provider 请求。 */
      const firstRequest = modelServer.requests[0]!
      /** 恢复轮 provider 请求。 */
      const resumedRequest = modelServer.requests[1]!
      assert.equal(firstRequest.method, 'POST', '首轮 provider 请求方法不是 POST')
      assert.equal(firstRequest.path, '/v1/chat/completions', '首轮 provider 请求路径不正确')
      assert.equal(firstRequest.authorization, 'Bearer smoke-local-key', '首轮 provider 未使用隔离 API key')
      assert.equal(firstRequest.body.model, 'smoke-model', '首轮 provider 请求模型不正确')
      assert.equal(firstRequest.body.stream, true, '首轮 provider 请求未启用 SSE')
      assert.deepEqual(firstRequest.body.stream_options, { include_usage: true }, '首轮 provider 请求未要求 usage')
      assert.ok(JSON.stringify(firstRequest.body.messages).includes('SMOKE_FIRST_PROMPT'), '首轮 provider 请求缺少 user prompt')
      /** 恢复请求的消息上下文序列化结果。 */
      const resumedMessages = JSON.stringify(resumedRequest.body.messages)
      assert.ok(resumedMessages.includes('SMOKE_FIRST_PROMPT'), '恢复请求缺少首轮 user prompt')
      assert.ok(resumedMessages.includes('SMOKE_FIRST_RESPONSE'), '恢复请求缺少首轮 assistant 回复')
      assert.ok(resumedMessages.includes('SMOKE_RESUME_PROMPT'), '恢复请求缺少第二轮 user prompt')

      /** 第二轮完成后的完整持久化 transcript。 */
      const resumedTranscript = await readFile(resumed.sessionFile, 'utf8')
      assert.ok(resumedTranscript.includes('SMOKE_RESUME_PROMPT'), '恢复轮 Pi JSONL 未持久化 user prompt')
      assert.ok(resumedTranscript.includes('SMOKE_RESUMED_RESPONSE'), '恢复轮 Pi JSONL 未持久化 assistant 回复')
      for (const line of resumedTranscript.trim().split('\n').filter(Boolean)) JSON.parse(line)

      return {
        startOutcome,
        restartedPid: restarted.pid,
        restartedBootId: restarted.bootId,
        providerRequests: modelServer.requests.length,
        sdkSessionId: first.sdkSessionId,
        sessionFile: first.sessionFile,
        firstUsage: first.result.usage,
        resumedUsage: resumed.result.usage,
      }
    } finally {
      await modelServer.close()
    }
  } finally {
    await client.stop()
  }
}

/** 创建真实 PTY、写入标记并确认输出可从 utility process 返回。 */
async function createAndProbeTerminal(
  client: InstanceType<typeof import('../src/main/lib/terminal-runtime-client').TerminalRuntimeClient>,
  terminalId: string,
  cwd: string,
): Promise<TerminalState> {
  /** 当前终端累计收到的真实 PTY 输出。 */
  let output = ''
  /** 当前终端使用的唯一输出标记。 */
  const marker = `PROMA_RUNTIME_SMOKE_${terminalId.toUpperCase().replaceAll('-', '_')}`
  /** 输出监听清理函数。 */
  const unsubscribe = client.onOutput((event: TerminalOutputEvent) => {
    if (event.terminalId !== terminalId) return
    output += event.data
    client.acknowledgeOutput({ terminalId, sequence: event.sequence })
  })
  try {
    /** utility process 创建的真实 PTY 状态。 */
    const state = await withTimeout(client.create({
      terminalId,
      sessionId: 'upstream-runtime-smoke-terminal',
      cwd,
      profile: getSmokeTerminalProfile(),
      cols: 80,
      rows: 24,
    }, { strictCwd: true }), `Terminal create ${terminalId}`)
    assert.ok(state.pid > 0, `Terminal ${terminalId} 未返回真实 PTY PID`)
    assert.equal(state.cwd, cwd, `Terminal ${terminalId} 未使用隔离工作目录`)
    /** 输入命令不得含完整 marker，避免 PTY 命令回显被误判为真实输出。 */
    const command = getSmokeTerminalCommand(marker)
    assert.equal(command.includes(marker), false, 'PTY 探针命令包含完整输出标记')
    await client.input({ terminalId, data: command })
    await waitForOutput(() => output, marker)
    return state
  } finally {
    unsubscribe()
  }
}

/** 使用真实 Electron utilityProcess 验证 Terminal client 的创建、停止与重启。 */
async function verifyTerminalRuntime(
  smokeRoot: string,
  utilityTracker: UtilityProcessTracker,
): Promise<Record<string, unknown>> {
  const { TerminalRuntimeClient } = await import('../src/main/lib/terminal-runtime-client')
  /** 被测 Terminal runtime client。 */
  const client = new TerminalRuntimeClient()
  try {
    /** 第一代 utility process 创建的真实 PTY。 */
    const first = await createAndProbeTerminal(client, 'first', smokeRoot)
    await withTimeout(client.stop(), 'Terminal first stop')
    await waitForProcessExit(first.pid, 'Terminal first PTY')
    await waitForNewUtilityProcessExits(smokeRoot, utilityTracker, 'Terminal first utility process')

    /** 第二代启动过程中立即被 stop 的创建请求。 */
    const racingCreate = client.create({
      terminalId: 'racing',
      sessionId: 'upstream-runtime-smoke-terminal',
      cwd: smokeRoot,
      profile: getSmokeTerminalProfile(),
      cols: 80,
      rows: 24,
    }, { strictCwd: true })
    /** 与第二代创建并发执行的停止 Promise。 */
    const racingStop = client.stop()
    /** 第二代创建的最终结果。 */
    const raceOutcome = await withTimeout(
      racingCreate.then(() => 'resolved' as const, () => 'rejected' as const),
      'Terminal 启动中 stop',
    )
    await withTimeout(racingStop, 'Terminal race stop')
    assert.equal(raceOutcome, 'rejected', 'Terminal 启动中 stop 未拒绝 create')
    await waitForNewUtilityProcessExits(smokeRoot, utilityTracker, 'Terminal 启动取消后的 utility process')

    /** stop 竞态后第三代 utility process 创建的真实 PTY。 */
    const restarted = await createAndProbeTerminal(client, 'restarted', smokeRoot)
    await withTimeout(client.stop(), 'Terminal restart stop')
    await waitForProcessExit(restarted.pid, 'Terminal restarted PTY')
    await waitForNewUtilityProcessExits(smokeRoot, utilityTracker, 'Terminal restart 后的 utility process')
    return { firstPtyPid: first.pid, raceOutcome, restartedPtyPid: restarted.pid }
  } finally {
    await client.stop()
  }
}

/** Electron 子进程入口：隔离 userData 后运行两组真 utilityProcess 验收。 */
async function runElectronSmoke(): Promise<void> {
  const { app, utilityProcess } = await import('electron')
  /** 父进程创建并通过环境变量传入的隔离根目录。 */
  const smokeRoot = process.env[ROOT_ENV]
  assert.ok(smokeRoot, '缺少 runtime smoke 临时根目录')
  assertSupportedPlatform()
  assert.equal(process.versions.electron, '43.2.0', 'Electron 版本不是 43.2.0')
  installFixtureHome(smokeRoot)
  assert.equal(os.homedir(), smokeRoot, 'fixture homedir 未隔离到临时根')
  /** Electron appData 使用的隔离目录。 */
  const appDataPath = join(smokeRoot, 'electron-app-data')
  /** Electron 自身使用的隔离 userData 目录。 */
  const userDataPath = join(smokeRoot, 'electron-user-data')
  await Promise.all([
    mkdir(appDataPath, { recursive: true }),
    mkdir(userDataPath, { recursive: true }),
  ])
  app.setPath('home', smokeRoot)
  app.setPath('appData', appDataPath)
  app.setPath('userData', userDataPath)
  await app.whenReady()
  /** 仅在隔离验收中接管 utility 标准流，确保 Windows CI 保留原生加载失败原因。 */
  const nativeFork = utilityProcess.fork.bind(utilityProcess)
  utilityProcess.fork = (modulePath, args, options) => {
    /** 原始 fork 返回的真实子进程，生命周期行为保持由 Electron 实现。 */
    const child = nativeFork(modulePath, args, { ...options, stdio: 'pipe' })
    child.stdout?.on('data', (data: Buffer) => process.stdout.write(data))
    child.stderr?.on('data', (data: Buffer) => process.stderr.write(data))
    return child
  }
  /** 按生命周期阶段核验 utility 退出，防止后续 PID 复用污染旧记录。 */
  const utilityTracker: UtilityProcessTracker = {
    nextRecordIndex: 0,
    records: [],
  }
  /** Agent utilityProcess 实测结果。 */
  const agent = await verifyAgentRuntime(smokeRoot, utilityTracker)
  /** Terminal utilityProcess 与真实 PTY 实测结果。 */
  const terminal = await verifyTerminalRuntime(smokeRoot, utilityTracker)
  await waitForNewUtilityProcessExits(smokeRoot, utilityTracker, '最终迟到的 utility process')
  /** utility preload 记录的进程 PID 与隔离 home。 */
  const utilityHomeRecords = utilityTracker.records
  assert.ok(utilityHomeRecords.length >= 3, '没有足够 utility process 加载 fixture homedir preload')
  assert.equal(
    utilityHomeRecords.every((record) => record.split('\t')[1] === smokeRoot),
    true,
    '存在 utility process 未使用隔离 homedir',
  )
  console.log('[upstream runtime smoke] PASS', JSON.stringify({
    electron: process.versions.electron,
    smokeRoot,
    agent,
    terminal,
    utilityHomeRecords,
  }))
}

/** Bun 父进程构建隔离入口，并通过指定 Electron override 执行 smoke。 */
async function orchestrateSmoke(): Promise<void> {
  assertSupportedPlatform()
  /** 所有 bundle、配置与 PTY cwd 共用的临时隔离根。 */
  const smokeRoot = await mkdtemp(join(tmpdir(), 'proma-upstream-runtime-smoke-'))
  /** Electron 子进程 bundle 所在目录。 */
  const buildDir = join(smokeRoot, 'bundle')
  await mkdir(buildDir, { recursive: true })
  try {
    const { build } = await import('esbuild')
    /** esbuild 输出的 Electron 子进程入口。 */
    const outputPath = join(buildDir, 'upstream-runtime-smoke.cjs')
    /** 子进程入口的临时构建结果。 */
    await build({
      entryPoints: [join(process.cwd(), 'scripts/upstream-runtime-smoke.ts')],
      outfile: outputPath,
      bundle: true,
      target: 'node22',
      format: 'cjs',
      platform: 'node',
      external: ['electron', 'esbuild'],
    })
    await copyFile(join(process.cwd(), 'dist/agent-runtime.cjs'), join(buildDir, 'agent-runtime-actual.cjs'))
    await copyFile(join(process.cwd(), 'dist/terminal-runtime.cjs'), join(buildDir, 'terminal-runtime-actual.cjs'))
    /** utility process 启动前安装 fixture homedir 的临时 preload。 */
    const fixturePreloadPath = join(buildDir, 'fixture-home-preload.cjs')
    await writeFile(fixturePreloadPath, [
      "const os = require('node:os')",
      "const fs = require('node:fs')",
      "const { syncBuiltinESMExports } = require('node:module')",
      `os.homedir = () => ${JSON.stringify(smokeRoot)}`,
      'syncBuiltinESMExports()',
      `fs.appendFileSync(${JSON.stringify(join(smokeRoot, 'utility-homes.log'))}, process.pid + '\\t' + os.homedir() + '\\n')`,
      '',
    ].join('\n'))
    /** Agent runtime wrapper 只在当前临时 bundle 中生效。 */
    await writeFile(join(buildDir, 'agent-runtime.cjs'), [
      "require('./fixture-home-preload.cjs')",
      "require('./agent-runtime-actual.cjs')",
      '',
    ].join('\n'))
    /** Terminal runtime wrapper 只在当前临时 bundle 中生效。 */
    await writeFile(join(buildDir, 'terminal-runtime.cjs'), [
      "require('./fixture-home-preload.cjs')",
      "require('./terminal-runtime-actual.cjs')",
      '',
    ].join('\n'))
    /** 临时 runtime bundle 的独立依赖目录，避免 Windows junction 内再次解析 Bun 相对链接。 */
    const fixtureNodeModules = join(buildDir, 'node_modules')
    await mkdir(fixtureNodeModules, { recursive: true })
    /** 复用打包同步脚本的 external 清单；动态导入避免 Electron CJS 子入口初始化脚本路径。 */
    const runtimeDepsModulePath: string = './sync-runtime-deps'
    const { EXTERNAL_RUNTIME_PACKAGES } = await import(runtimeDepsModulePath) as typeof import('./sync-runtime-deps')
    /** Windows 使用无需开发者模式的 junction；macOS 保持普通目录符号链接。 */
    const packageLinkType = process.platform === 'win32' ? 'junction' : 'dir'
    for (const packageName of EXTERNAL_RUNTIME_PACKAGES) {
      /** 工作树中当前 external 包经 Bun 链接解析后的真实安装根。 */
      const packageSource = await realpath(join(process.cwd(), 'node_modules', ...packageName.split('/')))
      /** 临时 bundle 内保持标准 Node package 目录结构。 */
      const packageTarget = join(fixtureNodeModules, ...packageName.split('/'))
      await mkdir(dirname(packageTarget), { recursive: true })
      await symlink(packageSource, packageTarget, packageLinkType)
      assert.equal((await lstat(packageTarget)).isSymbolicLink(), true, `临时依赖链接创建失败：${packageName}`)
    }

    /** 显式任务变量或 electron 包入口解析出的真实 Electron 可执行文件。 */
    const electronExecutable = await resolveElectronExecutable()
    /** 直接使用 Electron.app 内二进制，避免符号链接路径影响 helper 定位。 */
    const electron = spawn(electronExecutable, [outputPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        [CHILD_FLAG]: '1',
        [ROOT_ENV]: smokeRoot,
      },
      stdio: 'inherit',
    })
    /** Electron smoke 子进程的退出或启动失败结果。 */
    const electronExit = new Promise<ElectronExitOutcome>((resolve) => {
      electron.once('error', (error) => resolve({ error }))
      electron.once('exit', (code, signal) => resolve({ code, signal }))
    })
    try {
      /** 将结构化退出结果转换为 smoke 的成功退出码。 */
      const exitCode = await withTimeout(electronExit.then((outcome) => {
        if ('error' in outcome) throw outcome.error
        if (outcome.signal) throw new Error(`runtime smoke 被信号 ${outcome.signal} 终止`)
        return outcome.code ?? 1
      }), 'Electron runtime smoke', ELECTRON_SMOKE_TIMEOUT_MS)
      assert.equal(exitCode, 0, `Electron runtime smoke 退出码为 ${exitCode}`)
    } catch (error) {
      if (electron.exitCode === null && electron.signalCode === null) electron.kill('SIGTERM')
      try {
        await withTimeout(electronExit, 'Electron runtime smoke 终止后退出', ELECTRON_EXIT_TIMEOUT_MS)
      } catch {
        if (electron.exitCode === null && electron.signalCode === null) electron.kill('SIGKILL')
        await withTimeout(electronExit, 'Electron runtime smoke 强制终止后退出', ELECTRON_EXIT_TIMEOUT_MS)
      }
      throw error
    }
  } finally {
    await rm(smokeRoot, { recursive: true, force: true })
  }
}

if (process.env[CHILD_FLAG] === '1') {
  void runElectronSmoke().then(async () => {
    const { app } = await import('electron')
    app.quit()
  }).catch(async (error: unknown) => {
    console.error('[upstream runtime smoke] FAIL', error)
    const { app } = await import('electron')
    app.exit(1)
  })
} else {
  void orchestrateSmoke().catch((error: unknown) => {
    console.error('[upstream runtime smoke] FAIL', error)
    process.exitCode = 1
  })
}
