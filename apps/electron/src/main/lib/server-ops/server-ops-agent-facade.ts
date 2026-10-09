import { randomUUID } from 'node:crypto'
import { isServerOpsId, parseServerOpsDockerResourcesInput, parseServerOpsDockerContainerDetailInput, parseServerOpsDockerActionPrepareInput } from '@proma/shared'
import { parseServerOpsFilePreviewInput, parseServerOpsFileMutationInput } from '@proma/shared'
import type {
  AgentSessionMeta,
  ServerOpsAuditAppendInput,
  ServerOpsAuditOperation,
  ServerOpsAuthMethod,
  ServerOpsConnectionPhase,
  ServerOpsConnectionState,
  ServerOpsHost,
  ServerOpsHostKey,
  ServerOpsDockerResourcesInput,
  ServerOpsDockerResourcesResult,
  ServerOpsDockerContainerDetailInput,
  ServerOpsDockerContainerDetailResult,
  ServerOpsDockerActionPrepareInput,
  ServerOpsDockerActionResult,
  ServerOpsFilePreviewInput,
  ServerOpsFilePreviewResult,
  ServerOpsFileListResult,
  ServerOpsFileMutationInput,
  ServerOpsFileMutationResult,
} from '@proma/shared'
import { isOrdinaryTopLevelAgentSession } from '../agent-session-visibility'
import { getServerOpsServiceContext } from './server-ops-service-context'
import type { ServerOpsRuntimeExecResult } from '../../../utility/server-ops/server-ops-runtime-protocol'
import { getServerOpsAuditErrorCode } from './server-ops-audit-store'
import { captureServerOpsReadBindings } from './server-ops-agent-read-identity'
import type { ServerOpsAgentReadBinding } from './server-ops-agent-access-store'

/** Agent 可见的审计降级警告。 */
export type ServerOpsAgentWarning = 'SERVER_OPS_AUDIT_RESULT_WRITE_FAILED'

/** Agent 可读取的服务器公开资产，不包含凭据引用与时间元数据。 */
export interface ServerOpsAgentHost {
  id: string
  name: string
  address: string
  port: number
  username: string
  authMethod: ServerOpsAuthMethod
  tags: string[]
  phase: ServerOpsConnectionPhase
}

/** Agent 可读取的连接状态白名单，不包含 connectionId 或 Host Key candidateId。 */
export interface ServerOpsAgentStatus {
  hostId: string
  phase: ServerOpsConnectionPhase
  hostKey?: ServerOpsHostKey
  previousHostKey?: ServerOpsHostKey
  errorCode?: string
  message?: string
  warnings?: ServerOpsAgentWarning[]
}

/** Agent 命令结果允许附加审计后写失败警告。 */
export interface ServerOpsAgentExecResult extends ServerOpsRuntimeExecResult {
  warnings?: ServerOpsAgentWarning[]
}

/** 远程失败且结果审计失败时供 Pi 序列化的公开错误合同。 */
interface ServerOpsAgentOperationError extends Error {
  code: string
  cause: unknown
  warnings: ServerOpsAgentWarning[]
}

/** Facade 使用的最小服务边界，防止意外取得凭据或 Host Key 确认能力。 */
export interface ServerOpsAgentFacadeServices {
  hosts: Pick<import('./server-ops-ipc').ServerOpsHostStoreContract, 'list' | 'get'>
  /** 只读取不可逆凭据版本，用于每次操作确认仍绑定同一连接身份。 */
  credentials?: { getVersion?: (hostId: string, credentialRef?: string) => string | null }
  connections: Pick<import('./server-ops-ipc').ServerOpsConnectionContract, 'getState' | 'exec' | 'disconnect'>
  audit: Pick<import('./server-ops-audit-store').ServerOpsAuditStore, 'append'>
    & { prepareForWrites?: () => Promise<void> }
  docker?: Pick<import('./server-ops-docker-service').ServerOpsDockerService, 'listResources' | 'getContainerDetail' | 'runAgentAction'>
  files?: Pick<import('./server-ops-file-service').ServerOpsFileService, 'list' | 'preview' | 'mutateForAgent' | 'releaseReader'>
}

/** Facade 可替换依赖，仅用于隔离会话事实与主进程服务实例。 */
export interface ServerOpsAgentFacadeDependencies {
  getSession: (sessionId: string) => AgentSessionMeta | undefined
  services: ServerOpsAgentFacadeServices
  /** 为每次远程操作生成可审计的唯一身份。 */
  uuid?: () => string
}

/** 贯穿一次远程操作开始与结果审计的稳定上下文。 */
interface ServerOpsAgentAuditContext {
  operationId: string
  startedAt: number
}

/** 创建 Facade 时由 Orchestrator 闭包捕获的真实运行身份。 */
export interface CreateServerOpsAgentFacadeInput {
  sessionId: string
  triggeredBy?: 'user' | 'automation' | 'delegation' | 'external'
  /** Orchestrator 提供的权威会话读取器；避免 Facade 隐式发现运行上下文。 */
  getSession?: (sessionId: string) => AgentSessionMeta | undefined
  dependencies?: ServerOpsAgentFacadeDependencies
  /** 由编排器提供的本轮取消，不改变已保存服务器和连接。 */
  runSignal?: AbortSignal
  /** 主进程复核运行代次；旧工具闭包不能跨运行继续使用。 */
  assertRunActive?: () => void
}

/** Facade 创建时冻结的已保存主机、配置指纹与活跃连接。 */
interface ServerOpsAgentConnectedHostSnapshot {
  hostId: string
  connectionId: string
  binding: ServerOpsAgentReadBinding
}

/** 模型可调用的服务器运维能力。 */
export interface ServerOpsAgentFacade {
  list: () => ServerOpsAgentHost[]
  status: (input: { hostId: string }) => ServerOpsAgentStatus
  connect: (input: { hostId: string }) => Promise<ServerOpsAgentStatus>
  exec: (input: { hostId: string; command: string; timeoutMs?: number }) => Promise<ServerOpsAgentExecResult>
  disconnect: (input: { hostId: string }) => Promise<ServerOpsAgentStatus>
  dockerResources?: (input: ServerOpsDockerResourcesInput) => Promise<ServerOpsDockerResourcesResult>
  dockerDetail?: (input: ServerOpsDockerContainerDetailInput) => Promise<ServerOpsDockerContainerDetailResult>
  dockerAction?: (input: ServerOpsDockerActionPrepareInput) => Promise<ServerOpsDockerActionResult>
  filesList?: (input: ServerOpsFilePreviewInput) => Promise<ServerOpsFileListResult>
  filesRead?: (input: ServerOpsFilePreviewInput) => Promise<ServerOpsFilePreviewResult>
  filesMutate?: (input: ServerOpsFileMutationInput) => Promise<ServerOpsFileMutationResult>
}

/** 仅普通用户交互运行可以注册并执行服务器工具。 */
function isInteractiveRunSource(triggeredBy: CreateServerOpsAgentFacadeInput['triggeredBy']): boolean {
  return triggeredBy === undefined || triggeredBy === 'user'
}

/** 校验模型提供的公开服务器 ID。 */
function requireHostId(hostId: string): string {
  if (!isServerOpsId(hostId)) throw new Error('SERVER_OPS_HOST_ID_INVALID')
  return hostId
}

/** 将内部连接状态投影为 Agent 白名单 DTO。 */
function publicStatus(state: ServerOpsConnectionState): ServerOpsAgentStatus {
  /** 首次未知 Host Key 只返回算法与指纹，确认动作仍归 UI。 */
  const hostKey = state.phase === 'host-key-required' ? state.candidate : state.hostKey
  return {
    hostId: state.hostId,
    phase: state.phase,
    ...(hostKey ? { hostKey: { algorithm: hostKey.algorithm, fingerprint: hostKey.fingerprint } } : {}),
    ...(state.previousHostKey ? {
      previousHostKey: {
        algorithm: state.previousHostKey.algorithm,
        fingerprint: state.previousHostKey.fingerprint,
      },
    } : {}),
    ...(state.errorCode ? { errorCode: state.errorCode } : {}),
    ...(state.phase === 'host-key-required'
      ? { message: '请在服务器运维界面确认服务器指纹后重新连接。' }
      : state.message ? { message: state.message } : {}),
  }
}

/** 保留远程错误原因，同时让 Pi 的错误文本和结构字段都携带审计降级警告。 */
function attachAuditResultWarning(error: unknown): ServerOpsAgentOperationError {
  /** 生产远程边界已把内部异常收敛为公开文本；未知值只使用稳定错误码。 */
  const reason = error instanceof Error ? error.message : 'SERVER_OPS_REMOTE_OPERATION_FAILED'
  /** 公开错误同时保留稳定远程错误码、原始 cause 与固定 warning。 */
  const wrapped = new Error(`${reason}\nSERVER_OPS_AUDIT_RESULT_WRITE_FAILED`) as ServerOpsAgentOperationError
  wrapped.code = getServerOpsAuditErrorCode(error)
  wrapped.cause = error
  wrapped.warnings = ['SERVER_OPS_AUDIT_RESULT_WRITE_FAILED']
  return wrapped
}

/** 创建仅持有公开主机、已连接快照与受控操作能力的会话级 Facade。 */
export function createServerOpsAgentFacade(input: CreateServerOpsAgentFacadeInput): ServerOpsAgentFacade | null {
  if (!isInteractiveRunSource(input.triggeredBy)) return null
  /** 未显式注入时只读取已初始化的全局上下文，不创建 fallback。 */
  const context = input.dependencies ? null : getServerOpsServiceContext()
  const dependencies = input.dependencies ?? (context && input.getSession ? {
    getSession: input.getSession,
    services: {
      hosts: context.hosts,
      credentials: context.credentials,
      connections: context.connections,
      audit: context.audit,
      docker: context.docker,
      files: context.files,
    },
  } : null)
  if (!dependencies) return null

  /** 普通未归档顶层会话与运行闭包每次调用都重新核验。 */
  const requireRunActive = (): void => {
    if (input.runSignal?.aborted) throw new Error('SERVER_OPS_AGENT_RUN_CANCELLED')
    input.assertRunActive?.()
    if (context && getServerOpsServiceContext() !== context) throw new Error('SERVER_OPS_AGENT_CONTEXT_CHANGED')
    if (!isInteractiveRunSource(input.triggeredBy)
      || !isOrdinaryTopLevelAgentSession(dependencies.getSession(input.sessionId))
      || dependencies.getSession(input.sessionId)?.archived) {
      throw new Error('SERVER_OPS_AGENT_SESSION_NOT_ALLOWED')
    }
  }

  /** 本轮仅冻结创建时已经连接的已保存主机；未连接资源不能靠 Agent connect 扩权。 */
  const connectedHosts = new Map<string, ServerOpsAgentConnectedHostSnapshot>()
  try {
    requireRunActive()
    for (const host of dependencies.services.hosts.list()) {
      try {
        const state = dependencies.services.connections.getState(host.id)
        if (state.phase !== 'connected' || !state.connectionId) continue
        const binding = captureServerOpsReadBindings([{ kind: 'ssh', hostId: host.id }], {
          hosts: dependencies.services.hosts,
          credentials: dependencies.services.credentials,
        })[0]
        if (binding) connectedHosts.set(host.id, { hostId: host.id, connectionId: state.connectionId, binding })
      } catch { /* 单条损坏配置不应隐藏其它已连接且身份完整的资源。 */ }
    }
  } catch {
    connectedHosts.clear()
  }

  /** 每次调用 fresh-check 配置、凭据与原 connectionId，变化后旧闭包立即失效。 */
  const requireAvailableHost = (hostId: string): ServerOpsHost => {
    requireRunActive()
    const normalizedHostId = requireHostId(hostId)
    const snapshot = connectedHosts.get(normalizedHostId)
    if (!snapshot) throw new Error('SERVER_OPS_CONNECTION_NOT_ACTIVE')
    const host = dependencies.services.hosts.get(normalizedHostId)
    if (!host) throw new Error('SERVER_OPS_AGENT_RESOURCE_CHANGED')
    let currentBinding: ServerOpsAgentReadBinding | undefined
    try {
      currentBinding = captureServerOpsReadBindings([{ kind: 'ssh', hostId: normalizedHostId }], {
        hosts: dependencies.services.hosts,
        credentials: dependencies.services.credentials,
      })[0]
    } catch { throw new Error('SERVER_OPS_AGENT_RESOURCE_CHANGED') }
    if (!currentBinding || currentBinding.key !== snapshot.binding.key
      || currentBinding.hostId !== snapshot.binding.hostId
      || currentBinding.fingerprint !== snapshot.binding.fingerprint) {
      throw new Error('SERVER_OPS_AGENT_RESOURCE_CHANGED')
    }
    const state = dependencies.services.connections.getState(normalizedHostId)
    if (state.phase !== 'connected' || state.connectionId !== snapshot.connectionId) {
      throw new Error('SERVER_OPS_CONNECTION_CHANGED')
    }
    return host
  }

  /** 远程动作开始前同步写审计；失败必须用稳定错误阻断真实调用。 */
  const appendAuditStart = (
    operation: ServerOpsAuditOperation,
    hostId: string,
    command?: string,
  ): ServerOpsAgentAuditContext => {
    try {
      /** 同一次远程操作的开始与结果共享该唯一身份。 */
      const operationId = (dependencies.uuid ?? randomUUID)()
      /** Store 返回的持久化时间戳是 duration 的统一起点。 */
      const startedAt = dependencies.services.audit.append({
        actor: 'agent',
        operationId,
        sessionId: input.sessionId,
        hostId,
        operation,
        phase: 'start',
        outcome: 'pending',
        ...(command === undefined ? {} : { command }),
      }).timestamp
      return { operationId, startedAt }
    } catch {
      throw new Error('SERVER_OPS_AUDIT_START_WRITE_FAILED')
    }
  }

  /** 远程动作结束后 best-effort 写结果，返回是否需要公开降级警告。 */
  const appendAuditResult = (
    operation: ServerOpsAuditOperation,
    hostId: string,
    context: ServerOpsAgentAuditContext,
    outcome: 'success' | 'error' | 'unknown',
    options: Pick<ServerOpsAuditAppendInput, 'command' | 'exitCode' | 'signal' | 'errorCode'> = {},
  ): boolean => {
    try {
      dependencies.services.audit.append({
        actor: 'agent',
        operationId: context.operationId,
        sessionId: input.sessionId,
        hostId,
        operation,
        phase: 'result',
        outcome,
        durationMs: Math.max(0, Date.now() - context.startedAt),
        ...options,
      })
      return false
    } catch {
      return true
    }
  }

  /** 按 Pi 工具实际发送的双空格 JSON 正文计算 UTF-8 预算，包含缩进开销。 */
  const boundedResult = <T>(value: T): T => {
    if (Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8') > 65_536) throw new Error('SERVER_OPS_AGENT_RESULT_TOO_LARGE')
    return value
  }

  return {
    ...(dependencies.services.files ? {
      async filesList(raw: ServerOpsFilePreviewInput) {
        const parsed = parseServerOpsFilePreviewInput(raw)
        requireAvailableHost(parsed.hostId)
        /** 单次读取独占 owner，结束后不留下不可再使用的分页句柄。 */
        const ownerKey = `agent-read:${input.sessionId}:${randomUUID()}`
        try {
          const result = await dependencies.services.files!.list(ownerKey, parsed)
          requireAvailableHost(parsed.hostId)
          const { cursor, ...page } = result
          return boundedResult({ ...page, ...(cursor && !page.truncatedReason ? { truncatedReason: 'item-limit' as const } : {}) })
        } finally { dependencies.services.files!.releaseReader(ownerKey) }
      },
      async filesRead(raw: ServerOpsFilePreviewInput) {
        const parsed = parseServerOpsFilePreviewInput(raw)
        requireAvailableHost(parsed.hostId)
        const ownerKey = `agent-read:${input.sessionId}:${randomUUID()}`
        try {
          const result = await dependencies.services.files!.preview(ownerKey, parsed)
          requireAvailableHost(parsed.hostId)
          return boundedResult(result)
        } finally { dependencies.services.files!.releaseReader(ownerKey) }
      },
      async filesMutate(raw: ServerOpsFileMutationInput) {
        const parsed = parseServerOpsFileMutationInput(raw)
        requireAvailableHost(parsed.hostId)
        const result = await dependencies.services.files!.mutateForAgent(input.sessionId, parsed, () => { requireAvailableHost(parsed.hostId) })
        requireAvailableHost(parsed.hostId)
        return boundedResult(result)
      },
    } : {}),
    ...(dependencies.services.docker ? {
      async dockerResources(raw: ServerOpsDockerResourcesInput) {
        const parsed = parseServerOpsDockerResourcesInput(raw)
        requireAvailableHost(parsed.hostId)
        const result = await dependencies.services.docker!.listResources(parsed)
        requireAvailableHost(parsed.hostId)
        return boundedResult(result)
      },
      async dockerDetail(raw: ServerOpsDockerContainerDetailInput) {
        const parsed = parseServerOpsDockerContainerDetailInput(raw)
        requireAvailableHost(parsed.hostId)
        const result = await dependencies.services.docker!.getContainerDetail(parsed)
        requireAvailableHost(parsed.hostId)
        return boundedResult(result)
      },
      async dockerAction(raw: ServerOpsDockerActionPrepareInput) {
        const parsed = parseServerOpsDockerActionPrepareInput(raw)
        requireAvailableHost(parsed.hostId)
        const result = await dependencies.services.docker!.runAgentAction(input.sessionId, parsed, () => { requireAvailableHost(parsed.hostId) })
        requireAvailableHost(parsed.hostId)
        return boundedResult(result)
      },
    } : {}),
    list() {
      requireRunActive()
      return [...connectedHosts.keys()].flatMap((hostId) => {
        try {
          const host = requireAvailableHost(hostId)
          return [{
            id: host.id,
            name: host.name,
            address: host.address,
            port: host.port,
            username: host.username,
            authMethod: host.authMethod,
            tags: [...host.tags],
            phase: dependencies.services.connections.getState(host.id).phase,
          }]
        } catch { return [] }
      })
    },
    status({ hostId }) {
      const host = requireAvailableHost(hostId)
      return publicStatus(dependencies.services.connections.getState(host.id))
    },
    async connect({ hostId }) {
      /** Agent 不建立新连接；仅回显创建本轮时已经连接且身份未变化的状态。 */
      const host = requireAvailableHost(hostId)
      return publicStatus(dependencies.services.connections.getState(host.id))
    },
    async exec({ hostId, command, timeoutMs = 30_000 }) {
      const initialHost = requireAvailableHost(hostId)
      if (typeof command !== 'string' || command.length < 1 || command.length > 8192 || command.includes('\0')) {
        throw new Error('SERVER_OPS_EXEC_COMMAND_INVALID')
      }
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) {
        throw new Error('SERVER_OPS_EXEC_TIMEOUT_INVALID')
      }
      if (dependencies.services.audit.prepareForWrites) await dependencies.services.audit.prepareForWrites()
      /** schema guard 等待后重新验证运行、配置与原连接身份。 */
      const host = requireAvailableHost(initialHost.id)
      const state = dependencies.services.connections.getState(host.id)
      if (state.phase !== 'connected' || !state.connectionId) throw new Error('SERVER_OPS_CONNECTION_NOT_ACTIVE')
      const auditContext = appendAuditStart('exec', host.id, command)
      /** 开始审计回调可能同步改变运行或连接事实；发出远程命令前最后复核一次。 */
      requireAvailableHost(host.id)
      let result: ServerOpsRuntimeExecResult
      try {
        result = await dependencies.services.connections.exec(host.id, state.connectionId, command, timeoutMs)
      } catch (error) {
        const warning = appendAuditResult('exec', host.id, auditContext, 'error', { command, errorCode: getServerOpsAuditErrorCode(error) })
        if (warning) throw attachAuditResultWarning(error)
        throw error
      }
      try {
        requireAvailableHost(host.id)
      } catch {
        /** 命令已经发出但运行身份失效，不能把远端事实误报成普通失败或自动重试。 */
        const outcomeError = new Error('SERVER_OPS_REMOTE_OUTCOME_UNKNOWN')
        const warning = appendAuditResult('exec', host.id, auditContext, 'unknown', {
          command, errorCode: 'SERVER_OPS_REMOTE_OUTCOME_UNKNOWN',
        })
        if (warning) throw attachAuditResultWarning(outcomeError)
        throw outcomeError
      }
      /** 非零退出码或 signal 都代表远程命令失败，但真实输出仍原样返回给 Agent。 */
      const outcome = result.signal !== undefined || (result.exitCode !== undefined && result.exitCode !== 0) ? 'error' : 'success'
      const warning = appendAuditResult('exec', host.id, auditContext, outcome, {
        command,
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        ...(result.signal === undefined ? {} : { signal: result.signal }),
      })
      /** 结果审计回调也可能同步结束运行；旧结果不能在失效后发布。 */
      requireAvailableHost(host.id)
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        ...(result.signal === undefined ? {} : { signal: result.signal }),
        truncated: result.truncated,
        ...(warning ? { warnings: ['SERVER_OPS_AUDIT_RESULT_WRITE_FAILED'] } : {}),
      }
    },
    async disconnect({ hostId }) {
      const initialHost = requireAvailableHost(hostId)
      if (dependencies.services.audit.prepareForWrites) await dependencies.services.audit.prepareForWrites()
      /** schema guard 等待后重新验证运行、配置与原连接身份。 */
      const host = requireAvailableHost(initialHost.id)
      const auditContext = appendAuditStart('disconnect', host.id)
      try {
        const state = dependencies.services.connections.disconnect(host.id)
        const warning = appendAuditResult('disconnect', host.id, auditContext, 'success')
        return { ...publicStatus(state), ...(warning ? { warnings: ['SERVER_OPS_AUDIT_RESULT_WRITE_FAILED'] } : {}) }
      } catch (error) {
        const warning = appendAuditResult('disconnect', host.id, auditContext, 'error', { errorCode: getServerOpsAuditErrorCode(error) })
        if (warning) throw attachAuditResultWarning(error)
        throw error
      }
    },
  }
}
