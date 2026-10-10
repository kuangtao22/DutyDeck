import { createHash, randomUUID } from 'node:crypto'
import {
  isServerOpsSqlSensitiveColumn,
  isServerOpsId,
  parseServerOpsDataDiagnosticsResult,
  parseServerOpsDataProbeResult,
  parseServerOpsDataSourceRowsResult,
  parseServerOpsDataSourceTableResult,
  parseServerOpsDataSourceTablesResult,
  parseServerOpsOverviewResult,
  parseServerOpsAgentLogsInput,
  parseServerOpsServiceListResult,
  serverOpsReadResourceKey,
  isServerOpsAgentTableAllowed,
  analyzeServerOpsSqlQuery,
  analyzeServerOpsSqlWriteScope,
  parseServerOpsDataQueryInput,
  parseServerOpsDataQueryResult,
  parseServerOpsDataWriteInput,
  parseServerOpsDataWriteResult,
  parseServerOpsPostgresTable,
  parseServerOpsRedisCommandInput,
  parseServerOpsRedisCommandResult,
} from '@proma/shared'
import type {
  AgentSessionMeta,
  ServerOpsAgentDatabaseScope,
  ServerOpsAgentReadAccess,
  ServerOpsAgentReadResource,
  ServerOpsAuditAppendInput,
  ServerOpsAuditReadAction,
  ServerOpsAuditReadScope,
  ServerOpsDataDiagnosticSection,
  ServerOpsDataDiagnosticsResult,
  ServerOpsDataProbeResult,
  ServerOpsDataSourceRowsResult,
  ServerOpsDataSourceTableResult,
  ServerOpsDataSourceTablesResult,
  ServerOpsOverviewResult,
  ServerOpsServiceListResult,
  ServerOpsDataQueryInput,
  ServerOpsDataQueryResult,
  ServerOpsDataSource,
  ServerOpsDataWriteResult,
  ServerOpsAgentReadChanged,
  ServerOpsAgentDiscoveryResult,
  ServerOpsAgentLogsInput,
  ServerOpsAgentLogsResult,
  ServerOpsDatabaseAgentPolicy,
  ServerOpsRedisCommandInput,
  ServerOpsRedisCommandResult,
} from '@proma/shared'
import { isOrdinaryTopLevelAgentSession } from '../agent-session-visibility'
import { getServerOpsServiceContext } from './server-ops-service-context'
import { captureServerOpsReadBindings } from './server-ops-agent-read-identity'
import type { ServerOpsAgentReadBinding } from './server-ops-agent-access-store'
import type { ServerOpsDataService, ServerOpsReadContext } from './server-ops-data-service'
import type { ServerOpsHostStoreContract } from './server-ops-ipc'
import type { ServerOpsOverviewService } from './server-ops-overview-service'
import type { ServerOpsSystemdService } from './server-ops-systemd-service'
import type { ServerOpsDockerService } from './server-ops-docker-service'
import type { ServerOpsLogService } from './server-ops-log-service'
import { discoverServerOpsServices } from './server-ops-agent-diagnostics'
import type { ServerOpsAuditStore } from './server-ops-audit-store'
import { runAuditedServerOpsDataWrite, runAuditedServerOpsQuery } from './server-ops-query-audit'

/** Agent 工具最终 JSON 正文预算，按 Pi 实际双空格缩进后的 UTF-8 字节计算。 */
const SERVER_OPS_AGENT_READ_RESULT_BYTES = 32_768
/** 给结果审计降级 warning 预留固定空间，保证追加后仍不越过最终预算。 */
const SERVER_OPS_AGENT_READ_PROJECTED_BYTES = 32_256
/** 行读取比界面更窄，防止一次工具调用携带过多业务数据。 */
const SERVER_OPS_AGENT_READ_ROW_LIMIT = 50
/** 诊断表中的原始语句、命令和参数列不会交给模型。 */
const RAW_STATEMENT_COLUMN = /(sql|query|statement|digest|command|args?|argument|text)/iu
/** 系统库可能包含凭据、运行语句或性能侧信道，不属于默认业务库读取范围。 */
const MYSQL_SYSTEM_DATABASES = new Set(['mysql', 'sys', 'performance_schema', 'information_schema'])
/** PostgreSQL 系统 schema 不属于默认业务表读取范围。 */
const POSTGRESQL_SYSTEM_SCHEMAS = new Set(['information_schema'])

/** 默认只读开放的数据库引擎。 */
type ServerOpsDatabaseEngine = 'mysql' | 'postgresql' | 'sqlite'
/** 默认只读数据库资源。 */
type ServerOpsDatabaseResource = Extract<ServerOpsAgentReadResource, { kind: ServerOpsDatabaseEngine }>

/** Facade 服务边界不包含密码读取、任意命令或连接建立能力。 */
export interface ServerOpsAgentReadFacadeServices {
  hosts: Pick<ServerOpsHostStoreContract, 'get'> & Partial<Pick<ServerOpsHostStoreContract, 'list'>>
  /** 已建立连接的权威身份，断开或重连都会使本轮工具失效。 */
  connections?: Pick<import('./server-ops-ipc').ServerOpsConnectionContract, 'getState' | 'onState'>
  /** 仅允许读取不可逆凭据版本，禁止 Facade 解密。 */
  credentials?: { getVersion?: (hostId: string, credentialRef?: string) => string | null }
  access: {
    getReadAccess(sessionId: string): ServerOpsAgentReadAccess | undefined
    getReadBinding(sessionId: string, key: string): ServerOpsAgentReadBinding | undefined
    revokeReadResource?(sessionId: string, key: string, expectedRevision: number): boolean
    revokeHost?(hostId: string): boolean
    revokeSource?(sourceId: string): boolean
    onReadChanged?(listener: (event: ServerOpsAgentReadChanged) => void): () => void
  }
  /** 数据库禁用表名单为持久权威来源；缺失时数据库读取关闭。 */
  databasePolicy?: { get(): ServerOpsDatabaseAgentPolicy; onChanged?(listener: (policy: ServerOpsDatabaseAgentPolicy) => void): () => void }
  overview: Pick<ServerOpsOverviewService, 'getOverview'>
  systemd: Pick<ServerOpsSystemdService, 'listServices'>
  docker?: Pick<ServerOpsDockerService, 'listContainers'>
  logs?: Pick<ServerOpsLogService, 'snapshot'>
  data?: Pick<ServerOpsDataService, 'listSources' | 'probeSource' | 'diagnoseSource' | 'listSchemaTables' | 'describeSchemaTable' | 'readSchemaRows'>
    & Partial<Pick<ServerOpsDataService, 'querySource' | 'getReadCredentialVersion' | 'writeSource' | 'redisSource'>>
  audit: Pick<ServerOpsAuditStore, 'append'> & { prepareForWrites?: () => Promise<void> }
}

/** 可替换依赖让测试直接控制会话、授权代次与配置身份变化。 */
export interface ServerOpsAgentReadFacadeDependencies {
  getSession: (sessionId: string) => AgentSessionMeta | undefined
  services: ServerOpsAgentReadFacadeServices
  captureBindings?: (resources: ServerOpsAgentReadResource[]) => ServerOpsAgentReadBinding[]
  uuid?: () => string
  now?: () => number
}

/** 创建 Facade 时由编排闭包捕获的权威运行身份。 */
export interface CreateServerOpsAgentReadFacadeInput {
  sessionId: string
  triggeredBy?: 'user' | 'automation' | 'delegation' | 'external'
  getSession?: (sessionId: string) => AgentSessionMeta | undefined
  dependencies?: ServerOpsAgentReadFacadeDependencies
  /** 由编排器提供的本轮取消，不改变会话租约。 */
  runSignal?: AbortSignal
  /** 主进程复核运行代次；模型与 Renderer 无法提交该闭包。 */
  assertRunActive?: () => void
  /** 普通用户或兼容读写模式注册数据库与 Redis 写工具；只读模式不暴露写方法。 */
  allowDatabaseWrite?: boolean
}

/** Agent 可见的连接目录，不公开端点、用户、凭据状态或内部配置摘要。 */
export type ServerOpsAgentReadResourceSummary =
  | { kind: 'ssh'; hostId: string; projectId?: string; name: string; readLogs?: boolean }
  | {
      kind: ServerOpsDatabaseEngine
      sourceId: string
      projectId?: string
      name: string
      instance: boolean
      databases: ServerOpsAgentDatabaseScope[]
    }
  | { kind: 'redis'; sourceId: string; projectId?: string; name: string }

/** 服务器服务列表可能因 Agent 输出预算被显式截断。 */
export interface ServerOpsAgentServiceListResult extends ServerOpsServiceListResult {
  truncated?: boolean
}

/** 表行返回会附带被遮罩的列名，提醒模型这些值并非原文。 */
export interface ServerOpsAgentRowsResult extends ServerOpsDataSourceRowsResult {
  maskedColumns: string[]
  continuation?: { nextOffset: number; recommendedLimit: 1 }
}

/** 模型可调用的运维数据能力。 */
export interface ServerOpsAgentReadFacade {
  resources(): { resources: ServerOpsAgentReadResourceSummary[]; revision: number; expiresAt?: number; status?: string; nextStep?: string; truncated?: boolean }
  /** 内部组合工具精确校验全部目标；不向模型暴露授权快照。 */
  checkDatabaseTables(input: { sourceId: string; database: string; tables: string[]; revision?: number }): { engine: ServerOpsDatabaseEngine; revision: number }
  serverOverview(input: { hostId: string }, signal?: AbortSignal): Promise<ServerOpsOverviewResult>
  serverServices(input: { hostId: string }, signal?: AbortSignal): Promise<ServerOpsAgentServiceListResult>
  serverDiscover(input: { hostId: string }, signal?: AbortSignal): Promise<ServerOpsAgentDiscoveryResult>
  serverLogs(input: ServerOpsAgentLogsInput, signal?: AbortSignal): Promise<ServerOpsAgentLogsResult>
  dataProbe(input: { sourceId: string }, signal?: AbortSignal): Promise<ServerOpsDataProbeResult>
  dataDiagnose(input: {
    sourceId: string
    scope: ServerOpsAuditReadScope
    database?: string
    section?: ServerOpsDataDiagnosticSection
  }, signal?: AbortSignal): Promise<ServerOpsDataDiagnosticsResult>
  databaseTables(input: { sourceId: string; database?: string }, signal?: AbortSignal): Promise<ServerOpsDataSourceTablesResult & { truncated?: boolean }>
  databaseDescribe(input: { sourceId: string; database: string; table: string }, signal?: AbortSignal): Promise<ServerOpsDataSourceTableResult & { truncated?: boolean }>
  databaseRows(input: { sourceId: string; database: string; table: string; offset: number; limit: number }, signal?: AbortSignal): Promise<ServerOpsAgentRowsResult>
  /** Redis 读取只接受固定只读命令，连接配置来自已保存资源。 */
  redisRead?: (input: ServerOpsRedisCommandInput, signal?: AbortSignal) => Promise<ServerOpsRedisCommandResult>
  /** Redis 修改仅在本轮允许写入时暴露，原生审批在宿主执行前完成。 */
  redisWrite?: (input: ServerOpsRedisCommandInput, signal?: AbortSignal) => Promise<ServerOpsRedisCommandResult>
  /** SQL 查询没有模型可控会话或查询 ID，取消来自本次真实工具调用。 */
  databaseQuery(input: Omit<ServerOpsDataQueryInput, 'queryId'>, signal?: AbortSignal): Promise<ServerOpsDataQueryResult>
  /** 受控 SQL 写入；只在允许逐次审批写入的运行中暴露，结果可能为 unknown/partial。 */
  databaseWrite?: (input: { sourceId: string; database: string; sql: string; timeoutMs?: number }, signal?: AbortSignal) => Promise<ServerOpsDataWriteResult>
  /** 生成写入审批快照；快照只用于宿主确认展示，不会改变工具执行。 */
  prepareWriteApproval?: (toolName: 'ops_database_write' | 'ops_redis_write', input: Record<string, unknown>) => Promise<ServerOpsWriteApprovalSnapshot>
  /** 用户批准后复核审批快照，任何目标或正文变化都拒绝执行。 */
  revalidateWriteApproval?: (snapshot: ServerOpsWriteApprovalSnapshot, input: Record<string, unknown>) => Promise<void>
}

/** 写入确认卡使用的主进程快照；不包含密码、凭据值或不可展示的连接秘密。 */
export interface ServerOpsWriteApprovalSnapshot {
  toolName: 'ops_database_write' | 'ops_redis_write'
  sourceId: string
  target: string
  database: string
  operation: string
  fingerprint: string
  title: string
  description: string
}

/** 一次读取开始时冻结的权限代次和精确资源。 */
interface AuthorizedRead {
  revision: number
  resource: ServerOpsAgentReadResource
}

/** 同一次读取的审计关联信息。 */
interface ReadAuditContext {
  operationId: string
  startedAt: number
}

/** exact-key 对象解析，模型不能夹带密码、地址、SQL 或会话身份。 */
function exactRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('SERVER_OPS_AGENT_READ_INPUT_INVALID')
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (required.some((key) => !keys.includes(key)) || keys.some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new Error('SERVER_OPS_AGENT_READ_INPUT_INVALID')
  }
  return record
}

/** 校验有界数据库标识，不把空值解释为默认库。 */
function readIdentifier(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('SERVER_OPS_AGENT_READ_INPUT_INVALID')
  }
  return value
}

/** 校验模型提交的稳定资源 ID。 */
function readId(value: unknown): string {
  if (!isServerOpsId(value)) throw new Error('SERVER_OPS_AGENT_READ_INPUT_INVALID')
  return value
}

/** 输入来源只允许当前普通用户交互运行。 */
function isInteractiveSource(source: CreateServerOpsAgentReadFacadeInput['triggeredBy']): boolean {
  return source === undefined || source === 'user'
}

/** 只保留稳定领域错误码，底层数据库和网络原文不会进入模型上下文。 */
function stableErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  return /^[A-Z][A-Z0-9_]{2,100}$/u.test(message) ? message : 'SERVER_OPS_AGENT_READ_FAILED'
}

/** 生成不包含凭据的公开数据源目标描述，供审批卡直接展示。 */
function formatWriteTarget(source: ServerOpsDataSource, database: string): string {
  const endpoint = source.engine === 'sqlite'
    ? source.filePath ?? '文件路径未知'
    : `${source.address ?? '地址未知'}:${source.port ?? '端口未知'}`
  return `${source.label} · ${endpoint} · 数据库 ${database}`
}

/** 判断最终 Pi 文本是否仍在固定预算内。 */
function resultBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8')
}

/** 从指定数组尾部裁剪，直到最终漂亮 JSON 满足预算并显式标记截断。 */
function boundArrays<T extends object>(value: T, fields: readonly string[]): T & { truncated?: boolean } {
  const output = structuredClone(value) as T & Record<string, unknown> & { truncated?: boolean }
  if (resultBytes(output) <= SERVER_OPS_AGENT_READ_PROJECTED_BYTES) return output
  output.truncated = true
  while (resultBytes(output) > SERVER_OPS_AGENT_READ_PROJECTED_BYTES) {
    /** 每轮裁剪当前最长数组，尽量均衡保留多区块诊断内容。 */
    const candidate = fields
      .map((field) => ({ field, value: output[field] }))
      .filter((entry): entry is { field: string; value: unknown[] } => Array.isArray(entry.value) && entry.value.length > 0)
      .sort((left, right) => right.value.length - left.value.length)[0]
    if (!candidate) throw new Error('SERVER_OPS_AGENT_RESULT_TOO_LARGE')
    candidate.value.pop()
  }
  return output
}

/** 把共享 parser 的具体错误收敛为 Facade 统一结果错误，避免暴露内部解析细节。 */
function validateResult<T>(parse: (value: unknown) => T, value: unknown): T {
  try { return parse(value) } catch { throw new Error('SERVER_OPS_AGENT_READ_RESULT_INVALID') }
}

/** 为失败结果附加固定审计警告，不拼接底层异常正文。 */
function createReadError(code: string, auditFailed: boolean): Error & { warnings?: string[] } {
  const error = new Error(code) as Error & { warnings?: string[] }
  if (auditFailed) error.warnings = ['SERVER_OPS_AUDIT_RESULT_WRITE_FAILED']
  return error
}

/** 给成功结果追加固定审计降级警告，同时保留领域自身 warnings。 */
function appendAuditWarning<T extends object>(value: T): T {
  const output = structuredClone(value)
  /** 独立可变视图只用于追加公开 warnings，不改变其它泛型字段。 */
  const mutable = output as Record<string, unknown>
  const warnings = Array.isArray(mutable.warnings) ? mutable.warnings.filter((entry): entry is string => typeof entry === 'string') : []
  mutable.warnings = [...warnings, 'SERVER_OPS_AUDIT_RESULT_WRITE_FAILED']
  return output
}

/** 删除诊断表里的 SQL、Redis 命令和参数列，避免把业务语句正文送给模型。 */
function sanitizeDiagnostics(value: ServerOpsDataDiagnosticsResult): ServerOpsDataDiagnosticsResult {
  return {
    ...value,
    ...(value.parameters ? {
      parameters: value.parameters.map((parameter) => isServerOpsSqlSensitiveColumn(parameter.name)
        ? { ...parameter, value: '[MASKED]' }
        : parameter),
    } : {}),
    tables: value.tables.map((table) => {
      /** 仅保留不是原始命令/语句的列，并用同一索引投影每一行。 */
      const kept = table.columns
        .map((column, index) => ({ column, index }))
        .filter(({ column }) => !RAW_STATEMENT_COLUMN.test(`${column.id} ${column.label}`))
      return {
        ...table,
        columns: kept.map(({ column }) => column),
        rows: table.rows.map((row) => kept.map(({ index }) => row[index] ?? '')),
      }
    }),
  }
}

/** 敏感列的默认值和注释可能直接包含秘密，结构读取时一并遮罩。 */
function sanitizeTableDescription(value: ServerOpsDataSourceTableResult): ServerOpsDataSourceTableResult {
  return {
    ...value,
    columns: value.columns.map((column) => isServerOpsSqlSensitiveColumn(column.name)
      ? {
          ...column,
          ...(column.defaultText === undefined ? {} : { defaultText: '[MASKED]' }),
          ...(column.comment === undefined ? {} : { comment: '[MASKED]' }),
        }
      : column),
  }
}

/** 授权目录按嵌套表、库、资源顺序裁剪，并明确告诉模型范围未完整展示。 */
function boundResourceDirectory(value: { resources: ServerOpsAgentReadResourceSummary[]; revision: number; expiresAt?: number }): {
  resources: ServerOpsAgentReadResourceSummary[]
  revision: number
  truncated?: boolean
} {
  const output = structuredClone(value) as {
    resources: ServerOpsAgentReadResourceSummary[]
    revision: number
    truncated?: boolean
  }
  if (resultBytes(output) <= SERVER_OPS_AGENT_READ_RESULT_BYTES) return output
  output.truncated = true
  while (resultBytes(output) > SERVER_OPS_AGENT_READ_RESULT_BYTES) {
    /** 只裁剪白名单；排除名单必须完整保留，否则目录会暗示更宽的权限。 */
    const scopes = output.resources
      .filter((resource): resource is Extract<ServerOpsAgentReadResourceSummary, { kind: ServerOpsDatabaseEngine }> => (
        resource.kind === 'mysql' || resource.kind === 'postgresql' || resource.kind === 'sqlite'
      ))
      .flatMap((resource) => resource.databases.filter((scope) => scope.tables !== null)
        .map((scope) => ({ resource, scope, size: scope.tables?.length ?? 0 })))
      .filter((entry) => entry.size > 0)
      .sort((left, right) => right.size - left.size)
    if (scopes[0]?.scope.tables?.length) {
      scopes[0].scope.tables.pop()
      continue
    }
    const database = output.resources.find((resource): resource is Extract<ServerOpsAgentReadResourceSummary, { kind: ServerOpsDatabaseEngine }> =>
      (resource.kind === 'mysql' || resource.kind === 'postgresql' || resource.kind === 'sqlite') && resource.databases.length > 0)
    if (database) {
      database.databases.pop()
      continue
    }
    if (output.resources.length > 0) {
      output.resources.pop()
      continue
    }
    throw new Error('SERVER_OPS_AGENT_RESULT_TOO_LARGE')
  }
  return output
}

/** 行页预算裁剪保留连续前缀，并给出用 limit=1 从下一行续读的无跳行策略。 */
function boundRows(value: ServerOpsAgentRowsResult): ServerOpsAgentRowsResult {
  const output = structuredClone(value)
  if (resultBytes(output) <= SERVER_OPS_AGENT_READ_PROJECTED_BYTES) return output
  while (output.rows.length > 0 && resultBytes(output) > SERVER_OPS_AGENT_READ_PROJECTED_BYTES) output.rows.pop()
  if (resultBytes(output) > SERVER_OPS_AGENT_READ_PROJECTED_BYTES) throw new Error('SERVER_OPS_AGENT_RESULT_TOO_LARGE')
  output.truncated = true
  output.hasMore = true
  output.continuation = { nextOffset: output.offset + output.rows.length, recommendedLimit: 1 }
  return output
}

/** Redis 标量按最终 JSON 字节裁剪，控制字符转义也计入模型结果预算。 */
function boundRedisResult(value: ServerOpsRedisCommandResult, command: string): ServerOpsRedisCommandResult {
  const output = parseServerOpsRedisCommandResult(value)
  if (output.command !== command) throw new Error('SERVER_OPS_REDIS_RESULT_INVALID')
  while (resultBytes(output) > SERVER_OPS_AGENT_READ_PROJECTED_BYTES && typeof output.value === 'string' && output.value.length > 0) {
    output.value = output.value.slice(0, Math.floor(output.value.length / 2))
    output.truncated = true
  }
  if (resultBytes(output) > SERVER_OPS_AGENT_READ_PROJECTED_BYTES) throw new Error('SERVER_OPS_AGENT_RESULT_TOO_LARGE')
  return output
}

/** 创建多资源只读 Facade；没有服务上下文时不注册半成品能力。 */
export function createServerOpsAgentReadFacade(input: CreateServerOpsAgentReadFacadeInput): ServerOpsAgentReadFacade | null {
  if (!isInteractiveSource(input.triggeredBy)) return null
  const context = input.dependencies ? null : getServerOpsServiceContext()
  const dependencies = input.dependencies ?? (context && input.getSession ? {
    getSession: input.getSession,
    services: {
      hosts: context.hosts,
      connections: context.connections,
      credentials: context.credentials,
      access: context.access,
      databasePolicy: context.databasePolicy,
      overview: context.overview,
      systemd: context.systemd,
      docker: context.docker,
      logs: context.logs,
      data: context.data,
      audit: context.audit,
    },
  } satisfies ServerOpsAgentReadFacadeDependencies : null)
  if (!dependencies) return null
  if (!isOrdinaryTopLevelAgentSession(dependencies.getSession(input.sessionId)) || dependencies.getSession(input.sessionId)?.archived) return null

  /** 捕获当前配置事实；测试可替换，生产只读取主进程已保存的公开元数据。 */
  const captureBindings = dependencies.captureBindings ?? ((resources: ServerOpsAgentReadResource[]) =>
    captureServerOpsReadBindings(resources, dependencies.services))

  /** 已连接服务器和已保存 Redis 的本轮快照；不读取历史 Agent 授权。 */
  const connectedResources = new Map<string, { resource: ServerOpsAgentReadResource; binding: ServerOpsAgentReadBinding; connectionId?: string }>()
  /** 单个失效配置不阻断其它资源；短连接 Redis 在实际请求时建立连接。 */
  const candidates: ServerOpsAgentReadResource[] = [
    ...(dependencies.services.hosts.list?.() ?? []).map((host): ServerOpsAgentReadResource => ({ kind: 'ssh', hostId: host.id, readLogs: true })),
    ...(dependencies.services.data?.listSources().sources ?? []).filter((source) => source.engine === 'redis')
      .map((source): ServerOpsAgentReadResource => ({ kind: 'redis', sourceId: source.id })),
  ]
  for (const resource of candidates) {
    try {
      const binding = captureBindings([resource])[0]
      if (!binding) continue
      const state = binding.hostId ? dependencies.services.connections?.getState(binding.hostId) : undefined
      if (binding.hostId && (state?.phase !== 'connected' || !state.connectionId)) continue
      connectedResources.set(binding.key, { resource, binding, connectionId: state?.connectionId })
    } catch { /* 缺失或不可验证的连接不向本轮 Agent 暴露。 */ }
  }
  /** 每轮一次性冻结数据库策略与现有数据源身份，新连接需要新一轮才能暴露给 Agent。 */
  let databasePolicy: ServerOpsDatabaseAgentPolicy | undefined
  let databaseBindings = new Map<string, ServerOpsAgentReadBinding>()
  try {
    databasePolicy = dependencies.services.databasePolicy?.get()
    if (databasePolicy) {
      const sources = dependencies.services.data?.listSources().sources.filter((source) => (
        source.engine === 'mysql' || source.engine === 'postgresql' || source.engine === 'sqlite'
      )) ?? []
      const bindings = captureBindings(sources.map((source) => ({ kind: source.engine as ServerOpsDatabaseEngine, sourceId: source.id, instance: false, databases: [] })))
      databaseBindings = new Map(bindings.map((binding) => [binding.key, binding]))
    }
  } catch { databasePolicy = undefined }
  /** 终止后所有旧工具闭包均失效，即使会话租约仍有效。 */
  const checkRun = (): void => {
    if (input.runSignal?.aborted) throw new Error('SERVER_OPS_AGENT_RUN_CANCELLED')
    input.assertRunActive?.()
  }

  /** 数据库资源独立于会话租约；逐次复核持久策略与本轮冻结的连接身份。 */
  const requireDatabaseResource = (kind: ServerOpsDatabaseEngine, sourceId: string, expectedRevision?: number): AuthorizedRead & {
    resource: ServerOpsDatabaseResource
  } => {
    checkRun()
    if (context && getServerOpsServiceContext() !== context) throw new Error('SERVER_OPS_AGENT_CONTEXT_CHANGED')
    if (!isOrdinaryTopLevelAgentSession(dependencies.getSession(input.sessionId)) || dependencies.getSession(input.sessionId)?.archived) {
      throw new Error('SERVER_OPS_AGENT_SESSION_NOT_ALLOWED')
    }
    if (!databasePolicy || !dependencies.services.databasePolicy) throw new Error('SERVER_OPS_AGENT_ACCESS_REQUIRED')
    let current: ServerOpsDatabaseAgentPolicy
    try { current = dependencies.services.databasePolicy.get() } catch { throw new Error('SERVER_OPS_AGENT_ACCESS_CHANGED') }
    if (current.revision !== databasePolicy.revision || expectedRevision !== undefined && expectedRevision !== current.revision) {
      throw new Error('SERVER_OPS_AGENT_ACCESS_CHANGED')
    }
    const resource: ServerOpsDatabaseResource = { kind, sourceId, instance: false, databases: [] }
    const key = serverOpsReadResourceKey(resource)
    const original = databaseBindings.get(key)
    if (!original) throw new Error('SERVER_OPS_AGENT_ACCESS_REQUIRED')
    let actual: ServerOpsAgentReadBinding | undefined
    try { actual = captureBindings([resource])[0] } catch { throw new Error('SERVER_OPS_AGENT_RESOURCE_CHANGED') }
    if (!actual || original.fingerprint !== actual.fingerprint || original.hostId !== actual.hostId || original.key !== actual.key) {
      throw new Error('SERVER_OPS_AGENT_RESOURCE_CHANGED')
    }
    return { revision: current.revision, resource }
  }

  /** 每个异步边界前后都复核会话、授权代次、连接范围和配置身份。 */
  const requireAuthorized = (
    kind: ServerOpsAgentReadResource['kind'],
    id: string,
    expectedRevision?: number,
  ): AuthorizedRead => {
    if (kind === 'mysql' || kind === 'postgresql' || kind === 'sqlite') return requireDatabaseResource(kind, id, expectedRevision)
    checkRun()
    if (context && getServerOpsServiceContext() !== context) throw new Error('SERVER_OPS_AGENT_CONTEXT_CHANGED')
    if (!isInteractiveSource(input.triggeredBy)
      || !isOrdinaryTopLevelAgentSession(dependencies.getSession(input.sessionId)) || dependencies.getSession(input.sessionId)?.archived) {
      throw new Error('SERVER_OPS_AGENT_SESSION_NOT_ALLOWED')
    }
    /** 资源身份来自运行开始时的配置快照，审批后不得换用新端点或新连接。 */
    const key = kind === 'ssh' ? `ssh:${id}` : `data:${id}`
    const original = connectedResources.get(key)
    if (!original || original.resource.kind !== kind) throw new Error('SERVER_OPS_AGENT_CONNECTION_REQUIRED')
    let actual: ServerOpsAgentReadBinding | undefined
    try { actual = captureBindings([original.resource])[0] } catch { throw new Error('SERVER_OPS_AGENT_RESOURCE_CHANGED') }
    if (!actual || original.binding.fingerprint !== actual.fingerprint || original.binding.hostId !== actual.hostId || actual.key !== key) {
      throw new Error('SERVER_OPS_AGENT_RESOURCE_CHANGED')
    }
    if (original.binding.hostId) {
      const state = dependencies.services.connections?.getState(original.binding.hostId)
      if (state?.phase !== 'connected' || !state.connectionId || state.connectionId !== original.connectionId) {
        throw new Error('SERVER_OPS_CONNECTION_NOT_ACTIVE')
      }
    }
    return { revision: 0, resource: original.resource }
  }

  /** 写入读取审计；开始阶段失败会阻断真实服务，结果阶段失败只返回固定 warning。 */
  const appendAudit = (entry: ServerOpsAuditAppendInput): number | undefined => {
    try { return dependencies.services.audit.append(entry).timestamp } catch { return undefined }
  }

  /** 汇合工具/运行取消与连接变化，返回检查及清理函数；不订阅其它会话的状态。 */
  const readLifetime = (kind: ServerOpsAgentReadResource['kind'], id: string, revision: number, signal?: AbortSignal, sql = false) => {
    /** 真实服务只接收这一条合并后的取消信号。 */
    const controller = new AbortController()
    /** Abort listener 必须在所有退出路径移除。 */
    const abort = (): void => controller.abort()
    const signals = [signal, input.runSignal].filter((entry): entry is AbortSignal => entry !== undefined)
    for (const entry of signals) {
      entry.addEventListener('abort', abort, { once: true })
      if (entry.aborted) abort()
    }
    const unsubscribe = dependencies.services.connections?.onState(() => {
      try { requireAuthorized(kind, id, revision) } catch { abort() }
    })
    const unsubscribePolicy = (kind === 'mysql' || kind === 'postgresql' || kind === 'sqlite') ? dependencies.services.databasePolicy?.onChanged?.(() => {
      try { requireAuthorized(kind, id, revision) } catch { abort() }
    }) : undefined
    return {
      signal: controller.signal,
      /** 权限原因优先于 runtime 的通用取消，审计与用户看到相同原因。 */
      check: (): void => {
        requireAuthorized(kind, id, revision)
        if (controller.signal.aborted) throw new Error(sql ? 'SERVER_OPS_SQL_CANCELLED' : 'SERVER_OPS_AGENT_READ_CANCELLED')
      },
      dispose: (): void => {
        unsubscribe?.()
        unsubscribePolicy?.()
        for (const entry of signals) entry.removeEventListener('abort', abort)
      },
    }
  }

  /** 所有远程读取共享同一执行次序和撤销竞态保护。 */
  const executeRead = async <T extends object, R extends object = T>(options: {
    kind: ServerOpsAgentReadResource['kind']
    id: string
    readAction: ServerOpsAuditReadAction
    scope?: ServerOpsAuditReadScope
    database?: string
    table?: string
    signal?: AbortSignal
    read: (signal: AbortSignal, context: ServerOpsReadContext) => Promise<T>
    project?: (value: T) => R
  }): Promise<R> => {
    const initial = requireAuthorized(options.kind, options.id)
    /** 在审计准备之前接通取消，保证等待阶段也能及时失效。 */
    const lifetime = readLifetime(options.kind, options.id, initial.revision, options.signal)
    try {
      lifetime.check()
      try { await dependencies.services.audit.prepareForWrites?.() } catch { throw new Error('SERVER_OPS_AUDIT_START_WRITE_FAILED') }
      lifetime.check()
      const operationId = (dependencies.uuid ?? randomUUID)()
      const target = options.kind === 'ssh' ? { hostId: options.id } : { sourceId: options.id }
      const startedAt = appendAudit({
        actor: 'agent', sessionId: input.sessionId, operationId, operation: 'agent-read', resourceType: 'ops-resource',
        readAction: options.readAction, phase: 'start', outcome: 'pending', ...target,
        ...(options.scope ? { scope: options.scope } : {}),
        ...(options.database ? { database: options.database } : {}),
        ...(options.table ? { table: options.table } : {}),
      })
      if (startedAt === undefined) throw new Error('SERVER_OPS_AUDIT_START_WRITE_FAILED')
      lifetime.check()
      let projected: R
      try {
        const raw = await options.read(lifetime.signal, { ownerSessionId: input.sessionId, check: lifetime.check })
        lifetime.check()
        projected = options.project ? options.project(raw) : raw as unknown as R
      } catch (error) {
        /** 授权或配置变化错误也只记录稳定码，不恢复或重试旧请求。 */
        let failure = error
        try { lifetime.check() } catch (changed) { failure = changed }
        const errorCode = stableErrorCode(failure)
        const auditWritten = appendAudit({
          actor: 'agent', sessionId: input.sessionId, operationId, operation: 'agent-read', resourceType: 'ops-resource',
          readAction: options.readAction, phase: 'result', outcome: 'error', errorCode, ...target,
          durationMs: Math.max(0, (dependencies.now ?? Date.now)() - startedAt),
          ...(options.scope ? { scope: options.scope } : {}),
          ...(options.database ? { database: options.database } : {}),
          ...(options.table ? { table: options.table } : {}),
        })
        throw createReadError(errorCode, auditWritten === undefined)
      }
      const auditWritten = appendAudit({
          actor: 'agent', sessionId: input.sessionId, operationId, operation: 'agent-read', resourceType: 'ops-resource',
          readAction: options.readAction, phase: 'result', outcome: 'success', ...target,
          durationMs: Math.max(0, (dependencies.now ?? Date.now)() - startedAt),
          ...(options.scope ? { scope: options.scope } : {}),
          ...(options.database ? { database: options.database } : {}),
          ...(options.table ? { table: options.table } : {}),
        })
      /** 结果审计回调也可能触发同步撤权；返回前必须做最后一次复核。 */
      lifetime.check()
      const result = auditWritten === undefined ? appendAuditWarning(projected) : projected
      if (resultBytes(result) > SERVER_OPS_AGENT_READ_RESULT_BYTES) throw new Error('SERVER_OPS_AGENT_RESULT_TOO_LARGE')
      return result
    } finally { lifetime.dispose() }
  }

  /** 读取已保存数据源；不存在与引擎不匹配都使用稳定权限错误。 */
  const requireDataSource = (sourceId: string, engine: ServerOpsDatabaseEngine | 'redis') => {
    const data = dependencies.services.data
    if (!data) throw new Error('SERVER_OPS_DATA_UNAVAILABLE')
    const found = data.listSources().sources.find((entry) => entry.id === sourceId && entry.engine === engine)
    if (!found) throw new Error('SERVER_OPS_AGENT_ACCESS_REQUIRED')
    return { data, source: found }
  }

  /** 已保存的关系数据库由冻结资源身份选择引擎，Redis 仍走临时会话授权。 */
  const requireDatabaseAuthorized = (sourceId: string): AuthorizedRead & {
    resource: ServerOpsDatabaseResource
  } => {
    const source = dependencies.services.data?.listSources().sources.find((entry) => entry.id === sourceId)
    if (!source || source.engine !== 'mysql' && source.engine !== 'postgresql' && source.engine !== 'sqlite') {
      throw new Error('SERVER_OPS_AGENT_ACCESS_REQUIRED')
    }
    return requireDatabaseResource(source.engine, sourceId)
  }

  /** 解析数据库表身份；PostgreSQL 仅接受 canonical schema/table 且拒绝系统 schema。 */
  const requireTableIdentity = (resource: ServerOpsDatabaseResource, value: unknown): string => {
    if (resource.kind !== 'postgresql') return readIdentifier(value, 128)
    if (typeof value !== 'string') throw new Error('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    try {
      const table = parseServerOpsPostgresTable(value)
      if (POSTGRESQL_SYSTEM_SCHEMAS.has(table.schema.toLowerCase()) || table.schema.toLowerCase().startsWith('pg_')) {
        throw new Error('SERVER_OPS_AGENT_SCOPE_REQUIRED')
      }
      return value
    } catch {
      throw new Error('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    }
  }

  /** 禁用表唯一缩权规则；SQLite 只开放 main，MySQL 系统库与 PostgreSQL 系统 schema 始终关闭。 */
  const requireDatabaseScope = (
    resource: ServerOpsDatabaseResource,
    database: string,
    table?: string,
    readRows = false,
  ): ServerOpsAgentDatabaseScope => {
    if (resource.kind === 'sqlite' ? database !== 'main' : resource.kind === 'mysql' && MYSQL_SYSTEM_DATABASES.has(database.toLowerCase())) {
      throw new Error('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    }
    const excludedTables = databasePolicy?.exclusions
      .filter((entry) => entry.sourceId === resource.sourceId && (resource.kind === 'postgresql'
        ? entry.database === database
        : entry.database.toLowerCase() === database.toLowerCase()))
      .flatMap((entry) => entry.excludedTables) ?? []
    if (resource.kind === 'postgresql') {
      for (const excluded of excludedTables) requireTableIdentity(resource, excluded)
    }
    const scope: ServerOpsAgentDatabaseScope = { database, tables: null, excludedTables, readRows: true, query: true }
    if (table !== undefined) {
      const identity = requireTableIdentity(resource, table)
      if (!isServerOpsAgentTableAllowed(resource.kind, scope, identity)) throw new Error('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    }
    return scope
  }

  /** 校验数据库写入目标并返回不含凭据的审批快照。 */
  const prepareDatabaseWriteApproval = async (raw: Record<string, unknown>): Promise<ServerOpsWriteApprovalSnapshot> => {
    const record = exactRecord(raw, ['sourceId', 'database', 'sql'], ['timeoutMs'])
    const sourceId = readId(record.sourceId)
    const database = readIdentifier(record.database, 64)
    const sql = record.sql
    if (typeof sql !== 'string' || sql.trim().length === 0 || sql.length > 16_384 || sql.includes('\u0000')) {
      throw new Error('SERVER_OPS_AGENT_WRITE_INPUT_INVALID')
    }
    if (record.timeoutMs !== undefined
      && (typeof record.timeoutMs !== 'number' || !Number.isSafeInteger(record.timeoutMs)
        || record.timeoutMs < 1_000 || record.timeoutMs > 300_000)) {
      throw new Error('SERVER_OPS_AGENT_WRITE_INPUT_INVALID')
    }
    const authorized = requireDatabaseAuthorized(sourceId)
    const resource = authorized.resource as ServerOpsDatabaseResource
    if (resource.kind !== 'mysql' && resource.kind !== 'sqlite') throw new Error('SERVER_OPS_DATA_WRITE_ENGINE_UNSUPPORTED')
    let scope: ReturnType<typeof analyzeServerOpsSqlWriteScope>
    try { scope = analyzeServerOpsSqlWriteScope(sql, database, resource.kind) } catch { throw new Error('SERVER_OPS_AGENT_WRITE_INPUT_INVALID') }
    requireDatabaseScope(resource, database)
    for (const table of scope.tables) requireDatabaseScope(resource, database, table)
    const { data, source } = requireDataSource(sourceId, resource.kind)
    let schema: Awaited<ReturnType<NonNullable<ServerOpsAgentReadFacadeServices['data']>['listSchemaTables']>>
    try {
      schema = await data.listSchemaTables({ sourceId, database })
    } catch {
      throw new Error('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    }
    const isSameTable = (left: string, right: string): boolean => resource.kind === 'mysql'
      ? left.toLowerCase() === right.toLowerCase()
      : left === right
    if (scope.tables.some((table) => schema.tables.some((entry) => entry.type === 'view' && isSameTable(entry.name, table)))) {
      throw new Error('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    }
    if (source.transport !== 'direct' && !(source.transport === 'ssh' && source.engine === 'sqlite')) {
      throw new Error('SERVER_OPS_DATA_WRITE_SSH_UNSUPPORTED')
    }
    if (!data.writeSource) throw new Error('SERVER_OPS_DATA_UNAVAILABLE')
    const binding = captureBindings([resource])[0]
    if (!binding) throw new Error('SERVER_OPS_AGENT_RESOURCE_CHANGED')
    const fingerprint = createHash('sha256').update(JSON.stringify({
      binding: binding.fingerprint, revision: authorized.revision, sourceId, database, sql,
      timeoutMs: record.timeoutMs ?? null,
    })).digest('hex')
    const target = formatWriteTarget(source, database)
    return {
      toolName: 'ops_database_write', sourceId, database, target, operation: sql, fingerprint,
      title: '数据库写入需要确认',
      description: `目标：${target}\n风险：这段 SQL 会直接修改数据库数据；远程 SQLite 将通过当前 SSH 连接修改服务器文件。目标、数据库、SQL 或连接配置发生变化时会重新确认。\n注意：请确认已有备份或可恢复手段，执行结果未知时不会自动重试。`,
    }
  }

  /** 校验 Redis 写入目标并返回不含凭据的审批快照。 */
  const prepareRedisWriteApproval = async (raw: Record<string, unknown>): Promise<ServerOpsWriteApprovalSnapshot> => {
    const request = parseServerOpsRedisCommandInput(raw, 'write')
    const authorized = requireAuthorized('redis', request.sourceId)
    const { source } = requireDataSource(request.sourceId, 'redis')
    const binding = captureBindings([authorized.resource])[0]
    if (!binding) throw new Error('SERVER_OPS_AGENT_RESOURCE_CHANGED')
    const database = source.database ?? '0'
    const fingerprint = createHash('sha256').update(JSON.stringify({
      binding: binding.fingerprint, sourceId: request.sourceId, database, command: request.command, args: request.args,
    })).digest('hex')
    const target = formatWriteTarget(source, database)
    return {
      toolName: 'ops_redis_write', sourceId: request.sourceId, database, target,
      operation: [request.command, ...request.args].join(' '), fingerprint,
      title: 'Redis 写入需要确认',
      description: `目标：${target}\n风险：本次命令会修改 Redis 数据；命令、参数、逻辑库或连接配置发生变化时会重新确认。\n注意：结果未知时必须先读取核对，不能自动重试。`,
    }
  }

  /** 复用同一套主进程校验，确保批准后目标和正文仍与展示快照完全一致。 */
  const revalidateWriteApproval = async (snapshot: ServerOpsWriteApprovalSnapshot, raw: Record<string, unknown>): Promise<void> => {
    const current = snapshot.toolName === 'ops_database_write'
      ? await prepareDatabaseWriteApproval(raw)
      : await prepareRedisWriteApproval(raw)
    if (current.toolName !== snapshot.toolName || current.fingerprint !== snapshot.fingerprint
      || current.operation !== snapshot.operation || current.target !== snapshot.target || current.database !== snapshot.database) {
      throw new Error('SERVER_OPS_AGENT_WRITE_APPROVAL_EXPIRED')
    }
  }

  return {
    checkDatabaseTables(raw) {
      /** 结构组合始终使用持久禁用规则的精确目标，目录裁剪不参与权限判断。 */
      const sourceId = readId(raw.sourceId)
      const database = readIdentifier(raw.database, 64)
      if (!Array.isArray(raw.tables) || raw.tables.length < 1 || raw.tables.length > 4) throw new Error('SERVER_OPS_AGENT_READ_INPUT_INVALID')
      const initial = requireDatabaseAuthorized(sourceId)
      if (raw.revision !== undefined && raw.revision !== initial.revision) throw new Error('SERVER_OPS_AGENT_ACCESS_CHANGED')
      const resource = initial.resource as ServerOpsDatabaseResource
      for (const table of raw.tables) requireDatabaseScope(resource, database, requireTableIdentity(resource, table))
      requireDataSource(sourceId, resource.kind)
      return { engine: resource.kind, revision: initial.revision }
    },

    async databaseQuery(raw, signal) {
      /** 使用模型输入的精确合同，再由可信闭包分配不可伪造的查询身份。 */
      const record = exactRecord(raw, ['sourceId', 'database', 'sql', 'maxRows'])
      const request = parseServerOpsDataQueryInput({ ...record, queryId: randomUUID() })
      if (request.maxRows > SERVER_OPS_AGENT_READ_ROW_LIMIT) throw new Error('SERVER_OPS_AGENT_READ_INPUT_INVALID')
      const initial = requireDatabaseAuthorized(request.sourceId)
      const resource = initial.resource as ServerOpsDatabaseResource
      const scope = requireDatabaseScope(resource, request.database, undefined, true)
      if (scope.query !== true) throw new Error('SERVER_OPS_AGENT_SCOPE_REQUIRED')
      const plan = analyzeServerOpsSqlQuery(request.sql, request.database, resource.kind)
      for (const table of plan.tables) requireDatabaseScope(resource, request.database, table, true)
      const { data } = requireDataSource(request.sourceId, resource.kind)
      if (!data.querySource) throw new Error('SERVER_OPS_DATA_UNAVAILABLE')
      /** SQL 与其它读取共用运行取消及持久规则变更边界。 */
      const lifetime = readLifetime(resource.kind, request.sourceId, initial.revision, signal, true)
      const check = lifetime.check
      try {
        return await runAuditedServerOpsQuery({
          summary: { sourceId: request.sourceId, database: request.database, tables: plan.tables,
            queryHash: `sha256:${createHash('sha256').update(plan.fingerprint).digest('hex')}` },
          actor: { actor: 'agent', sessionId: input.sessionId }, audit: dependencies.services.audit, check,
          execute: async () => {
            const result = parseServerOpsDataQueryResult(await data.querySource!(request, lifetime.signal, { ownerSessionId: input.sessionId, check }))
            if (result.queryId !== request.queryId || result.database !== request.database || result.rowCount > request.maxRows) {
              throw new Error('SERVER_OPS_AGENT_READ_RESULT_INVALID')
            }
            return result
          },
        })
      } finally {
        lifetime.dispose()
      }
    },

    ...(input.allowDatabaseWrite ? {
      prepareWriteApproval: async (toolName: 'ops_database_write' | 'ops_redis_write', raw: Record<string, unknown>): Promise<ServerOpsWriteApprovalSnapshot> => {
        checkRun()
        return toolName === 'ops_database_write' ? prepareDatabaseWriteApproval(raw) : prepareRedisWriteApproval(raw)
      },
      revalidateWriteApproval: async (snapshot: ServerOpsWriteApprovalSnapshot, raw: Record<string, unknown>): Promise<void> => {
        checkRun()
        await revalidateWriteApproval(snapshot, raw)
      },
      async databaseWrite(raw: { sourceId: string; database: string; sql: string; timeoutMs?: number }, signal?: AbortSignal): Promise<ServerOpsDataWriteResult> {
        /** 写入入口只接受有限字段，来源快照与 writeId 由主进程生成。 */
        const record = exactRecord(raw, ['sourceId', 'database', 'sql'], ['timeoutMs'])
        const sourceId = readId(record.sourceId)
        const database = readIdentifier(record.database, 64)
        const sql = record.sql
        if (typeof sql !== 'string' || sql.trim().length === 0 || sql.length > 16_384 || sql.includes('\u0000')) {
          throw new Error('SERVER_OPS_AGENT_WRITE_INPUT_INVALID')
        }
        if (record.timeoutMs !== undefined
          && (typeof record.timeoutMs !== 'number' || !Number.isSafeInteger(record.timeoutMs)
            || record.timeoutMs < 1_000 || record.timeoutMs > 300_000)) {
          throw new Error('SERVER_OPS_AGENT_WRITE_INPUT_INVALID')
        }
        const authorized = requireDatabaseAuthorized(sourceId)
        const resource = authorized.resource as ServerOpsDatabaseResource
        if (resource.kind !== 'mysql' && resource.kind !== 'sqlite') throw new Error('SERVER_OPS_DATA_WRITE_ENGINE_UNSUPPORTED')
        let scope: ReturnType<typeof analyzeServerOpsSqlWriteScope>
        try { scope = analyzeServerOpsSqlWriteScope(sql, database, resource.kind) } catch { throw new Error('SERVER_OPS_AGENT_WRITE_INPUT_INVALID') }
        /** Agent 写入逐表复用持久禁用规则；解析器无法完整确定作用域时已按输入无效拒绝。 */
        requireDatabaseScope(resource, database)
        for (const table of scope.tables) requireDatabaseScope(resource, database, table)
        const { data, source } = requireDataSource(sourceId, resource.kind)
        /** 视图可能由触发器或定义间接触达其它表；目录明确标记为 view 时保守拒绝 Agent 写入。 */
        let schema: Awaited<ReturnType<NonNullable<ServerOpsAgentReadFacadeServices['data']>['listSchemaTables']>>
        try {
          schema = await data.listSchemaTables({ sourceId, database })
        } catch {
          /** 无法确认视图/表身份时拒绝写入，避免元数据盲区绕过禁用策略。 */
          throw new Error('SERVER_OPS_AGENT_SCOPE_REQUIRED')
        }
        const isSameTable = (left: string, right: string): boolean => resource.kind === 'mysql'
          ? left.toLowerCase() === right.toLowerCase()
          : left === right
        if (scope.tables.some((table) => schema.tables.some((entry) => entry.type === 'view' && isSameTable(entry.name, table)))) {
          throw new Error('SERVER_OPS_AGENT_SCOPE_REQUIRED')
        }
        /** Agent 允许直连数据库与已连接 SSH 主机上的 SQLite 文件，其他 SSH 引擎仍拒绝。 */
        if (source.transport !== 'direct' && !(source.transport === 'ssh' && source.engine === 'sqlite')) {
          throw new Error('SERVER_OPS_DATA_WRITE_SSH_UNSUPPORTED')
        }
        if (!data.writeSource) throw new Error('SERVER_OPS_DATA_UNAVAILABLE')
        const request = parseServerOpsDataWriteInput({
          sourceId, source, database, writeId: randomUUID(), sql,
          ...(record.timeoutMs === undefined ? {} : { timeoutMs: record.timeoutMs }),
        })
        const lifetime = readLifetime(resource.kind, sourceId, authorized.revision, signal)
        try {
          return await runAuditedServerOpsDataWrite({
            summary: { sourceId, database },
            actor: { actor: 'agent', sessionId: input.sessionId },
            audit: dependencies.services.audit,
            check: lifetime.check,
            execute: async () => parseServerOpsDataWriteResult(await data.writeSource!(request, lifetime.signal, {
              ownerSessionId: input.sessionId,
              actor: 'agent',
              check: lifetime.check,
            })),
          })
        } finally { lifetime.dispose() }
      },
    } : {}),

    ...(dependencies.services.data?.redisSource ? {
      async redisRead(raw: ServerOpsRedisCommandInput, signal?: AbortSignal) {
        /** 固定读取白名单，不能把写命令藏入只读入口。 */
        const request = parseServerOpsRedisCommandInput(raw, 'read')
        return executeRead({ kind: 'redis', id: request.sourceId, readAction: 'redis-read', signal,
          read: async (readSignal, readContext) => boundRedisResult(await dependencies.services.data!.redisSource!(request, readSignal, readContext), request.command),
        })
      },
      ...(input.allowDatabaseWrite ? {
        async redisWrite(raw: ServerOpsRedisCommandInput, signal?: AbortSignal) {
          /** 请求只携带资源 ID、命令和有界参数；不接受临时地址或密码。 */
          const request = parseServerOpsRedisCommandInput(raw, 'write')
          const authorized = requireAuthorized('redis', request.sourceId)
          const lifetime = readLifetime('redis', request.sourceId, authorized.revision, signal)
          /** Redis 是数据源写入；审计只记录目标逻辑库，不保存键名、参数或值。 */
          const saved = dependencies.services.data!.listSources().sources.find((source) => source.id === request.sourceId)!
          const common = { actor: 'agent' as const, sessionId: input.sessionId, sourceId: saved.id,
            database: saved.database ?? '0', operation: 'data-write' as const, resourceType: 'data-write' as const,
            operationId: (dependencies.uuid ?? randomUUID)() }
          const startedAt = (dependencies.now ?? Date.now)()
          try {
            lifetime.check()
            try { await dependencies.services.audit.prepareForWrites?.() } catch { throw new Error('SERVER_OPS_AUDIT_START_WRITE_FAILED') }
            lifetime.check()
            if (appendAudit({ ...common, phase: 'start', outcome: 'pending' }) === undefined) throw new Error('SERVER_OPS_AUDIT_START_WRITE_FAILED')
            let result: ServerOpsRedisCommandResult
            try {
              lifetime.check()
              result = boundRedisResult(await dependencies.services.data!.redisSource!(request, lifetime.signal, {
                ownerSessionId: input.sessionId, actor: 'agent', check: lifetime.check,
              }), request.command)
            } catch (error) {
              /** 发出后没有回执不能断言未写入；不重试且保留结果未知的审计。 */
              const errorCode = stableErrorCode(error)
              appendAudit({ ...common, phase: 'result', outcome: 'unknown', errorCode })
              throw new Error(errorCode)
            }
            /** 已执行的写入事实不能被迟到取消覆盖；过期时仅丢弃可能敏感的返回值。 */
            try { lifetime.check() } catch { if (result.value !== null) result = { ...result, value: null, truncated: true } }
            const recorded = appendAudit({ ...common, phase: 'result',
              outcome: result.outcome === 'completed' ? 'success' : result.outcome === 'unknown' ? 'unknown' : 'error',
              ...(result.errorCode ? { errorCode: result.errorCode } : {}),
              durationMs: Math.min(86_400_000, Math.max(0, (dependencies.now ?? Date.now)() - startedAt)),
            })
            return recorded === undefined ? { ...result, warnings: ['SERVER_OPS_AUDIT_RESULT_WRITE_FAILED'] } : result
          } finally { lifetime.dispose() }
        },
      } : {}),
    } : {}),

    resources() {
      checkRun()
      if (!isOrdinaryTopLevelAgentSession(dependencies.getSession(input.sessionId)) || dependencies.getSession(input.sessionId)?.archived) {
        throw new Error('SERVER_OPS_AGENT_SESSION_NOT_ALLOWED')
      }
      /** 目录只投影仍有效的资源，一个断连不影响其它可用目标。 */
      const summaries: ServerOpsAgentReadResourceSummary[] = []
      for (const { resource } of connectedResources.values()) {
        try { requireAuthorized(resource.kind, resource.kind === 'ssh' ? resource.hostId : resource.sourceId) } catch { continue }
        if (resource.kind === 'ssh') {
          const saved = dependencies.services.hosts.get(resource.hostId)!
          summaries.push({ kind: 'ssh', hostId: saved.id, ...(saved.projectId ? { projectId: saved.projectId } : {}), name: saved.name, readLogs: true })
        } else if (resource.kind === 'redis') {
          const saved = dependencies.services.data!.listSources().sources.find((entry) => entry.id === resource.sourceId)!
          summaries.push({ kind: 'redis', sourceId: saved.id, ...(saved.projectId ? { projectId: saved.projectId } : {}), name: saved.label })
        }
      }
      if (databasePolicy) {
        const sources = dependencies.services.data?.listSources().sources ?? []
        for (const saved of sources) {
          if (saved.engine !== 'mysql' && saved.engine !== 'postgresql' && saved.engine !== 'sqlite') continue
          if (!databaseBindings.has(`data:${saved.id}`)) continue
          requireDatabaseResource(saved.engine, saved.id)
          /** 仅展示配置的默认库；其他可见库由用户按需调用表目录发现，不远程扫描。 */
          const database = saved.engine === 'sqlite' ? 'main' : saved.database
          const databases = database && !MYSQL_SYSTEM_DATABASES.has(database.toLowerCase())
            ? [requireDatabaseScope({ kind: saved.engine, sourceId: saved.id, instance: false, databases: [] }, database)] : []
          summaries.push({ kind: saved.engine, sourceId: saved.id, ...(saved.projectId ? { projectId: saved.projectId } : {}),
            name: saved.label, instance: false, databases })
        }
      }
      return boundResourceDirectory({ resources: summaries, revision: databasePolicy?.revision ?? 0 })
    },

    async serverOverview(raw, signal) {
      const record = exactRecord(raw, ['hostId'])
      const hostId = readId(record.hostId)
      return executeRead({
        signal,
        kind: 'ssh', id: hostId, readAction: 'server-overview', read: (readSignal) => dependencies.services.overview.getOverview({ hostId }, readSignal),
        project: (value) => {
          const parsed = validateResult(parseServerOpsOverviewResult, value)
          if (parsed.hostId !== hostId) throw new Error('SERVER_OPS_AGENT_READ_RESULT_INVALID')
          return boundArrays(parsed, ['filesystems', 'processes'])
        },
      })
    },

    async serverServices(raw, signal) {
      const record = exactRecord(raw, ['hostId'])
      const hostId = readId(record.hostId)
      return executeRead({
        signal,
        kind: 'ssh', id: hostId, readAction: 'server-services', read: (readSignal) => dependencies.services.systemd.listServices({ hostId }, readSignal),
        project: (value) => {
          const parsed = validateResult(parseServerOpsServiceListResult, value)
          if (parsed.hostId !== hostId) throw new Error('SERVER_OPS_AGENT_READ_RESULT_INVALID')
          return boundArrays(parsed, ['services'])
        },
      })
    },

    async serverDiscover(raw, signal) {
      const record = exactRecord(raw, ['hostId'])
      const hostId = readId(record.hostId)
      return executeRead({ signal, kind: 'ssh', id: hostId, readAction: 'server-discover',
        read: (readSignal) => discoverServerOpsServices(hostId, dependencies.services, readSignal),
      })
    },

    async serverLogs(raw, signal) {
      let request: ServerOpsAgentLogsInput
      try { request = parseServerOpsAgentLogsInput(raw) } catch { throw new Error('SERVER_OPS_AGENT_READ_INPUT_INVALID') }
      requireAuthorized('ssh', request.hostId)
      const logs = dependencies.services.logs
      if (!logs) throw new Error('SERVER_OPS_AGENT_LOGS_UNAVAILABLE')
      return executeRead({ signal, kind: 'ssh', id: request.hostId, readAction: 'server-logs',
        read: (readSignal) => logs.snapshot(request, readSignal),
      })
    },

    async dataProbe(raw, signal) {
      const record = exactRecord(raw, ['sourceId'])
      const sourceId = readId(record.sourceId)
      /** 资源按已保存配置发现，Redis 无额外会话授权。 */
      const saved = dependencies.services.data?.listSources().sources.find((entry) => entry.id === sourceId)
      if (!saved) throw new Error('SERVER_OPS_DATA_SOURCE_NOT_FOUND')
      const resource = requireAuthorized(saved.engine, sourceId).resource
      if (resource.kind === 'ssh') throw new Error('SERVER_OPS_AGENT_READ_INPUT_INVALID')
      const kind = resource.kind
      requireAuthorized(kind, sourceId)
      const { data } = requireDataSource(sourceId, kind)
      return executeRead({
        signal,
        kind, id: sourceId, readAction: 'data-probe', read: (readSignal, readContext) => data.probeSource({ sourceId }, readSignal, readContext),
        project: (value) => {
          const parsed = validateResult(parseServerOpsDataProbeResult, value)
          if (parsed.sourceId !== sourceId || parsed.engine !== kind) throw new Error('SERVER_OPS_AGENT_READ_RESULT_INVALID')
          return parsed
        },
      })
    },

    async dataDiagnose(raw, signal) {
      const record = exactRecord(raw, ['sourceId', 'scope'], ['database', 'section'])
      const sourceId = readId(record.sourceId)
      if (record.scope !== 'instance' && record.scope !== 'database') throw new Error('SERVER_OPS_AGENT_READ_INPUT_INVALID')
      const scope = record.scope
      const database = record.database === undefined ? undefined : readIdentifier(record.database, 64)
      const section = record.section
      if (section !== undefined && section !== 'overview' && section !== 'sessions' && section !== 'statements' && section !== 'parameters') {
        throw new Error('SERVER_OPS_AGENT_READ_INPUT_INVALID')
      }
      const saved = dependencies.services.data?.listSources().sources.find((entry) => entry.id === sourceId)
      if (!saved) throw new Error('SERVER_OPS_DATA_SOURCE_NOT_FOUND')
      const resource = requireAuthorized(saved.engine, sourceId).resource
      if (resource.kind === 'ssh') throw new Error('SERVER_OPS_AGENT_READ_INPUT_INVALID')
      const { data } = requireDataSource(sourceId, resource.kind)
      if (resource.kind === 'redis') {
        if (scope !== 'instance' || database !== undefined || section !== undefined) throw new Error('SERVER_OPS_AGENT_READ_INPUT_INVALID')
      } else if (resource.kind === 'sqlite') {
        if (scope !== 'database' || database !== 'main' || (section !== undefined && section !== 'overview')) throw new Error('SERVER_OPS_AGENT_READ_INPUT_INVALID')
        const databaseScope = requireDatabaseScope(resource, database)
        if (databaseScope.excludedTables?.length) throw new Error('SERVER_OPS_AGENT_SCOPE_REQUIRED')
      } else if (resource.kind === 'postgresql') {
        /** Agent 只开放能把已授权数据库原样下发到底层的会话诊断，避免回落到默认库或实例范围。 */
        if (scope !== 'database' || !database || section !== 'sessions') {
          throw new Error('SERVER_OPS_AGENT_READ_INPUT_INVALID')
        }
        const databaseScope = requireDatabaseScope(resource, database)
        if (databaseScope.excludedTables?.length) throw new Error('SERVER_OPS_AGENT_SCOPE_REQUIRED')
      } else if (scope === 'instance') {
        /** 默认业务表只读不包含全局变量或全实例汇总，避免隐式扩大访问范围。 */
        throw new Error('SERVER_OPS_AGENT_SCOPE_REQUIRED')
      } else {
        if (!database || (section !== 'sessions' && section !== 'statements')) throw new Error('SERVER_OPS_AGENT_READ_INPUT_INVALID')
        const databaseScope = requireDatabaseScope(resource, database)
        if (databaseScope.excludedTables?.length) throw new Error('SERVER_OPS_AGENT_SCOPE_REQUIRED')
      }
      return executeRead({
        signal,
        kind: resource.kind, id: sourceId, readAction: 'data-diagnose', scope,
        ...(database ? { database } : {}),
        read: (readSignal, readContext) => data.diagnoseSource({
          sourceId,
          ...(section ? { section } : {}),
          ...(database && resource.kind !== 'sqlite' ? { database } : {}),
        }, readSignal, readContext),
        project: (value) => {
          const parsed = validateResult(parseServerOpsDataDiagnosticsResult, value)
          if (parsed.sourceId !== sourceId || parsed.engine !== resource.kind) throw new Error('SERVER_OPS_AGENT_READ_RESULT_INVALID')
          return boundArrays(sanitizeDiagnostics(parsed), ['metrics', 'tables', 'parameters'])
        },
      })
    },

    async databaseTables(raw, signal) {
      const record = exactRecord(raw, ['sourceId'], ['database'])
      const sourceId = readId(record.sourceId)
      const database = record.database === undefined ? undefined : readIdentifier(record.database, 64)
      const authorized = requireDatabaseAuthorized(sourceId)
      const resource = authorized.resource as ServerOpsDatabaseResource
      if (resource.kind === 'sqlite' && database !== undefined && database !== 'main') throw new Error('SERVER_OPS_AGENT_SCOPE_REQUIRED')
      if (database) requireDatabaseScope(resource, database)
      const { data } = requireDataSource(sourceId, authorized.resource.kind as ServerOpsDatabaseEngine)
      return executeRead({
        signal,
        kind: authorized.resource.kind, id: sourceId, readAction: 'schema-list', scope: 'database', ...(database ? { database } : {}),
        read: (readSignal, readContext) => data.listSchemaTables({ sourceId, ...(database ? { database } : {}) }, readSignal, readContext),
        project: (value) => {
          const parsed = validateResult(parseServerOpsDataSourceTablesResult, value)
          if (database && parsed.database !== database) throw new Error('SERVER_OPS_AGENT_READ_RESULT_INVALID')
          /** 未指定库时服务可能选用连接默认库；结果表仍必须应用该库的禁用项。 */
          const returnedScope = parsed.database ? requireDatabaseScope(resource, readIdentifier(parsed.database, 64)) : undefined
          if (parsed.tables.length && !returnedScope) throw new Error('SERVER_OPS_AGENT_READ_RESULT_INVALID')
          const visibleTables = returnedScope ? parsed.tables.flatMap((entry) => {
            if (entry.type === 'view') return []
            let identity = entry.name
            if (resource.kind === 'postgresql') {
              let parsedIdentity: { schema: string; table: string }
              try { parsedIdentity = parseServerOpsPostgresTable(entry.name) }
              catch { throw new Error('SERVER_OPS_AGENT_READ_RESULT_INVALID') }
              if (POSTGRESQL_SYSTEM_SCHEMAS.has(parsedIdentity.schema.toLowerCase())
                || parsedIdentity.schema.toLowerCase().startsWith('pg_')) return []
              identity = entry.name
            }
            return isServerOpsAgentTableAllowed(resource.kind, returnedScope, identity) ? [{ ...entry, name: identity }] : []
          }) : []
          return boundArrays({
            ...parsed,
            databases: parsed.databases.filter((entry) => resource.kind === 'sqlite'
              ? entry === 'main'
              : resource.kind !== 'mysql' || !MYSQL_SYSTEM_DATABASES.has(entry.toLowerCase())),
            tables: visibleTables,
          }, ['tables', 'databases'])
        },
      })
    },

    async databaseDescribe(raw, signal) {
      const record = exactRecord(raw, ['sourceId', 'database', 'table'])
      const sourceId = readId(record.sourceId)
      const database = readIdentifier(record.database, 64)
      const authorized = requireDatabaseAuthorized(sourceId)
      const resource = authorized.resource as ServerOpsDatabaseResource
      const table = requireTableIdentity(resource, record.table)
      requireDatabaseScope(resource, database, table)
      const { data } = requireDataSource(sourceId, authorized.resource.kind as ServerOpsDatabaseEngine)
      return executeRead({
        signal,
        kind: authorized.resource.kind, id: sourceId, readAction: 'schema-describe', scope: 'database', database, table,
        read: (readSignal, readContext) => data.describeSchemaTable({ sourceId, database, table }, readSignal, readContext),
        project: (value) => boundArrays(sanitizeTableDescription(
          validateResult(parseServerOpsDataSourceTableResult, value),
        ), ['columns', 'indexes']),
      })
    },

    async databaseRows(raw, signal) {
      const record = exactRecord(raw, ['sourceId', 'database', 'table', 'offset', 'limit'])
      const sourceId = readId(record.sourceId)
      const database = readIdentifier(record.database, 64)
      const authorized = requireDatabaseAuthorized(sourceId)
      const resource = authorized.resource as ServerOpsDatabaseResource
      const table = requireTableIdentity(resource, record.table)
      if (typeof record.offset !== 'number' || !Number.isSafeInteger(record.offset) || record.offset < 0 || record.offset > 1_000_000
        || typeof record.limit !== 'number' || !Number.isSafeInteger(record.limit) || record.limit < 1 || record.limit > SERVER_OPS_AGENT_READ_ROW_LIMIT
        || record.offset % record.limit !== 0) throw new Error('SERVER_OPS_AGENT_READ_INPUT_INVALID')
      const offset = record.offset
      const limit = record.limit
      requireDatabaseScope(resource, database, table, true)
      const { data } = requireDataSource(sourceId, authorized.resource.kind as ServerOpsDatabaseEngine)
      return executeRead({
        signal,
        kind: authorized.resource.kind, id: sourceId, readAction: 'rows-read', scope: 'database', database, table,
        read: (readSignal, readContext) => data.readSchemaRows({ sourceId, database, table, offset, limit }, readSignal, readContext),
        project: (value) => {
          const parsed = validateResult(parseServerOpsDataSourceRowsResult, value)
          if (parsed.offset !== offset || parsed.limit !== limit) throw new Error('SERVER_OPS_AGENT_READ_RESULT_INVALID')
          /** 列索引只计算一次，所有行保持原列顺序与分页语义。 */
          const maskedIndexes = parsed.columns
            .map((column, index) => ({ column, index }))
            .filter(({ column }) => isServerOpsSqlSensitiveColumn(column))
          const masked = {
            ...parsed,
            rows: parsed.rows.map((row) => row.map((cell, index) => maskedIndexes.some((entry) => entry.index === index) ? '[MASKED]' : cell)),
            maskedColumns: maskedIndexes.map(({ column }) => column),
          }
          return boundRows(masked)
        },
      })
    },
  }
}
