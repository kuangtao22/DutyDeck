import { isServerOpsId } from './server-ops'

/**
 * 运维脚本库合同。
 *
 * 脚本是运维项目下的可复用资产，绑定唯一的执行目标（SSH 主机或数据库数据源）。
 * 本文件只定义数据形态、严格解析与纯函数（参数渲染与单次/通用信号），
 * 不定义执行链路：SSH 与 SQL 的真实执行分别在主进程领域服务里收口。
 */
export const SERVER_OPS_SCRIPT_CHANNELS = {
  LIST: 'server-ops:list-scripts',
  SAVE: 'server-ops:save-script',
  DELETE: 'server-ops:delete-script',
  RUN: 'server-ops:run-script',
  CANCEL_RUN: 'server-ops:cancel-script-run',
  LIST_RUNS: 'server-ops:list-script-runs',
} as const

/** Agent 提议的脚本草稿通道；草稿只在内存里短暂保留，重启即失效。 */
export const SERVER_OPS_SCRIPT_DRAFT_CHANNELS = {
  LIST: 'server-ops:list-script-drafts',
  DISMISS: 'server-ops:dismiss-script-draft',
  CHANGED: 'server-ops:script-draft-changed',
} as const

/** 脚本正文（UTF-8）上限；与工具结果预算同一量级，避免单条脚本撑爆配置文件。 */
export const SERVER_OPS_SCRIPT_BODY_MAX_BYTES = 32_768
/** 单个脚本允许声明的参数上限。 */
export const SERVER_OPS_SCRIPT_PARAMETER_LIMIT = 16
/** 单个项目允许保留的脚本上限。 */
export const SERVER_OPS_SCRIPT_PROJECT_LIMIT = 200
/** 全局允许保留的脚本上限。 */
export const SERVER_OPS_SCRIPT_GLOBAL_LIMIT = 500
/** 通用脚本必要说明文本的上限。 */
export const SERVER_OPS_SCRIPT_NOTE_MAX_LENGTH = 2_000

/** 脚本类别：SSH 命令或数据库 SQL。 */
export type ServerOpsScriptKind = 'ssh-command' | 'sql'

/** 使用频度：单次用完即弃，或长期复用的通用脚本。 */
export type ServerOpsScriptUsage = 'one-off' | 'reusable'

/** 变更风险：只读脚本或会改变远端状态的脚本。 */
export type ServerOpsScriptRisk = 'read-only' | 'mutating'

/** 参数值类型；决定了渲染时的转义方式，是防注入的唯一依据。 */
export type ServerOpsScriptParameterType = 'text' | 'number' | 'identifier' | 'date'

/** 脚本参数定义；通用脚本的全部输入都必须在这里显式声明。 */
export interface ServerOpsScriptParameter {
  name: string
  label: string
  type: ServerOpsScriptParameterType
  required: boolean
  /** 为 true 时运行记录里以 `[REDACTED]` 记名，不保存取值。 */
  sensitive: boolean
  default?: string
  description?: string
}

/** 已落盘的运维脚本。 */
export interface ServerOpsScript {
  id: string
  projectId: string
  name: string
  description?: string
  kind: ServerOpsScriptKind
  usage: ServerOpsScriptUsage
  risk: ServerOpsScriptRisk
  /** SSH 脚本的执行主机；`kind='ssh-command'` 时必填。 */
  hostId?: string
  /** SSH 脚本超时；缺省由执行器取默认值。 */
  timeoutMs?: number
  /** SQL 脚本的数据源；`kind='sql'` 时必填。 */
  sourceId?: string
  /** SQL 脚本的目标库；`kind='sql'` 时必填。 */
  database?: string
  /** 脚本正文，可含 `{{参数名}}` 占位符。 */
  body: string
  parameters: ServerOpsScriptParameter[]
  preconditions?: string
  expectedImpact?: string
  rollbackPlan?: string
  /** 来源由宿主盖章；模型与渲染层都不能自报。 */
  origin: 'agent' | 'user'
  /** Agent 建议的使用频度，仅作为界面默认值。 */
  suggestedUsage?: ServerOpsScriptUsage
  suggestedUsageReason?: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

/** 渲染后可直接交执行器的脚本文本。 */
export interface ServerOpsScriptRenderedBody {
  /** 占位符已全部替换的正文。 */
  text: string
  /** 本次渲染实际用到的参数名与取值，用于运行记录。 */
  values: { name: string; value: string }[]
}

/** 列表输入；省略项目表示返回全部项目。 */
export interface ServerOpsScriptListInput { projectId?: string }

/** 列表结果；按更新时间倒序，容量有界。 */
export interface ServerOpsScriptListResult { scripts: ServerOpsScript[] }

/** 新建或更新脚本；`scriptId` 省略表示新建。 */
export interface ServerOpsScriptSaveInput {
  scriptId?: string
  projectId: string
  name: string
  description?: string
  kind: ServerOpsScriptKind
  usage: ServerOpsScriptUsage
  risk: ServerOpsScriptRisk
  hostId?: string
  timeoutMs?: number
  sourceId?: string
  database?: string
  body: string
  parameters: ServerOpsScriptParameter[]
  preconditions?: string
  expectedImpact?: string
  rollbackPlan?: string
  enabled: boolean
  /** 编辑时的乐观并发基线；不等于现存记录时拒绝覆盖。 */
  expectedUpdatedAt?: number
  /** 存在时表示由该草稿转为正式脚本；只会由所属会话消费，并据此标记来源。 */
  draftId?: string
  /** 草稿所属会话；与 `draftId` 同时出现，用来复核领取资格。 */
  draftSessionId?: string
}

/** 保存回执。 */
export interface ServerOpsScriptSaveResult { script: ServerOpsScript }

/** 删除输入与回执。 */
export interface ServerOpsScriptDeleteInput { scriptId: string }
export interface ServerOpsScriptDeleteResult { deleted: boolean }

/** 严格解析保存回执。 */
export function parseServerOpsScriptSaveResult(value: unknown): ServerOpsScriptSaveResult {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['script']))) throw new Error('SERVER_OPS_SCRIPT_SAVE_RESULT_INVALID')
  return { script: parseServerOpsScript(value.script) }
}

/** 严格解析删除回执。 */
export function parseServerOpsScriptDeleteResult(value: unknown): ServerOpsScriptDeleteResult {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['deleted'])) || typeof value.deleted !== 'boolean') {
    throw new Error('SERVER_OPS_SCRIPT_DELETE_RESULT_INVALID')
  }
  return { deleted: value.deleted }
}

/** 运行输入；`runId` 由渲染层生成，便于运行中取消。 */
export interface ServerOpsScriptRunInput {
  scriptId: string
  runId: string
  /** 界面已显式确认；变更类脚本还会额外弹确认卡。 */
  confirmed: true
  parameters: { name: string; value: string }[]
}

/** 取消在途运行。 */
export interface ServerOpsScriptCancelRunInput { runId: string }

/** 一次脚本运行的终态或进行态。 */
export type ServerOpsScriptRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'

/** 运行记录；只保存有界摘要，不保存结果集正文。 */
export interface ServerOpsScriptRun {
  id: string
  scriptId: string
  projectId: string
  status: ServerOpsScriptRunStatus
  startedAt: number
  finishedAt?: number
  durationMs?: number
  /** 本次实际使用的参数；`sensitive` 参数记 `[REDACTED]`。 */
  parameters: { name: string; value: string }[]
  /** SSH 脚本的退出码。 */
  exitCode?: number
  /** SQL 脚本实际执行的语句条数。 */
  statementCount?: number
  /** SQL 脚本累计受影响行数。 */
  affectedRows?: number
  /** 语句是否已提交；失败回滚时为 false。 */
  committed?: boolean
  errorCode?: string
  /** 已归一化的公开错误说明，不含凭据与 SQL 正文。 */
  errorMessage?: string
  /** 有界的输出摘要（stdout 或语句结果概览）。 */
  outputPreview?: string
}

/** 运行记录查询输入与结果，结果按开始时间倒序。 */
export interface ServerOpsScriptRunListInput {
  scriptId?: string
  projectId?: string
  limit?: number
}
export interface ServerOpsScriptRunListResult { runs: ServerOpsScriptRun[] }

/** Agent 提议的脚本草稿内容；不含凭据与绝对路径。 */
export interface ServerOpsScriptDraftInput {
  projectId?: string
  name: string
  description?: string
  kind: ServerOpsScriptKind
  usage: ServerOpsScriptUsage
  risk: ServerOpsScriptRisk
  hostId?: string
  timeoutMs?: number
  sourceId?: string
  database?: string
  body: string
  parameters: ServerOpsScriptParameter[]
  preconditions?: string
  expectedImpact?: string
  rollbackPlan?: string
  suggestedUsageReason?: string
}

/** 主进程签发的会话内草稿；不代表脚本已保存。 */
export interface ServerOpsScriptDraft {
  id: string
  sessionId: string
  createdAt: number
  expiresAt: number
  input: ServerOpsScriptDraftInput
}

/** 草稿新增或移除只广播身份提示；内容由所属会话按需读取。 */
export interface ServerOpsScriptDraftChanged { sessionId: string; id: string }

/** 草稿列表结果；容量有界，按创建时间升序。 */
export interface ServerOpsScriptDraftListResult { drafts: ServerOpsScriptDraft[] }

/** 草稿读取或消费的会话身份。 */
export type ServerOpsScriptDraftSession = { sessionId: string }

/** 草稿忽略输入；只允许所属会话删除自己的草稿。 */
export interface ServerOpsScriptDraftDismiss { sessionId: string; id: string }

/** 严格解析草稿会话身份；只接受会话 ID 本身。 */
export function parseServerOpsScriptDraftSession(value: unknown): string {
  if (!isServerOpsId(value)) throw new Error('SERVER_OPS_SCRIPT_DRAFT_SESSION_INVALID')
  return value
}

/** 严格解析草稿忽略输入。 */
export function parseServerOpsScriptDraftDismiss(value: unknown): ServerOpsScriptDraftDismiss {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['sessionId', 'id']))
    || !isServerOpsId(value.sessionId) || !isServerOpsId(value.id)) {
    throw new Error('SERVER_OPS_SCRIPT_DRAFT_DISMISS_INVALID')
  }
  return { sessionId: value.sessionId, id: value.id }
}

/** 判断未知值是否为普通可枚举对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 拒绝公开 DTO 中的未知字段。 */
function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key))
}

/** 判断时间戳是否位于可安全持久化范围。 */
function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000
}

/** 校验有界文本；允许换行，拒绝 NUL 与其它控制字符。 */
function isBoundedText(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === 'string'
    && (allowEmpty || value.length > 0)
    && value.length <= maximum
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
}

/** 统计文本的 UTF-8 字节数。 */
function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

/** 校验脚本名称：非空、最多 60 字符、无控制字符。 */
function isScriptName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 60 && !/[\u0000-\u001f\u007f]/u.test(value)
}

/** 校验脚本正文：非空白、字节数有界、无 NUL。 */
function isScriptBody(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\u0000')
    && utf8Bytes(value) <= SERVER_OPS_SCRIPT_BODY_MAX_BYTES
}

/** 校验数据库名；边界与 SQL 查询执行合同保持一致。 */
function isDatabaseName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && !/[\u0000-\u001f\u007f]/u.test(value)
}

/** 校验 SSH 超时；与既有 exec 合同保持同一区间。 */
function isScriptTimeout(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1_000 && value <= 120_000
}

/** 参数名规则；与正文占位符使用同一套字符集。 */
const PARAMETER_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/

/** 判断参数名是否合法。 */
export function isServerOpsScriptParameterName(value: unknown): value is string {
  return typeof value === 'string' && PARAMETER_NAME_PATTERN.test(value)
}

/** 严格解析单个参数定义。 */
export function parseServerOpsScriptParameter(value: unknown): ServerOpsScriptParameter {
  const errorCode = 'SERVER_OPS_SCRIPT_INVALID'
  if (!isRecord(value)
    || !hasOnlyKeys(value, new Set(['name', 'label', 'type', 'required', 'sensitive', 'default', 'description']))
    || !isServerOpsScriptParameterName(value.name)
    || typeof value.label !== 'string' || value.label.length === 0 || value.label.length > 60 || /[\u0000-\u001f\u007f]/u.test(value.label)
    || !['text', 'number', 'identifier', 'date'].includes(value.type as string)
    || typeof value.required !== 'boolean' || typeof value.sensitive !== 'boolean'
    || (value.default !== undefined && !isBoundedText(value.default, 4_096, true))
    || (value.description !== undefined && !isBoundedText(value.description, 200, true))) {
    throw new Error(errorCode)
  }
  const parameter: ServerOpsScriptParameter = {
    name: value.name,
    label: value.label,
    type: value.type as ServerOpsScriptParameterType,
    required: value.required,
    sensitive: value.sensitive,
    ...(value.default === undefined ? {} : { default: value.default }),
    ...(value.description === undefined ? {} : { description: value.description }),
  }
  /**
   * 可选参数必须自带默认值。
   *
   * 否则「用户没填」只能渲染成空串，在 SQL 里恰好是「等于空串」而不是「省略条件」，
   * 作者会在毫不知情的情况下执行 `WHERE a = ''`。要表达空值就显式写 `default: ''`。
   */
  if (!parameter.required && parameter.default === undefined) throw new Error('SERVER_OPS_SCRIPT_PARAMETER_DEFAULT_REQUIRED')
  /** 默认值同样要过类型校验，避免落盘一个运行时必然被拒的定义。 */
  if (parameter.default !== undefined && !isParameterValue(parameter.type, parameter.default)) {
    throw new Error('SERVER_OPS_SCRIPT_PARAMETER_DEFAULT_INVALID')
  }
  return parameter
}

/** 严格解析参数定义列表：去重、有界、拒绝未知字段。 */
export function parseServerOpsScriptParameters(value: unknown): ServerOpsScriptParameter[] {
  if (!Array.isArray(value) || value.length > SERVER_OPS_SCRIPT_PARAMETER_LIMIT) throw new Error('SERVER_OPS_SCRIPT_INVALID')
  const parameters = value.map(parseServerOpsScriptParameter)
  if (new Set(parameters.map((entry) => entry.name)).size !== parameters.length) throw new Error('SERVER_OPS_SCRIPT_INVALID')
  return parameters
}

/** 严格解析已落盘脚本的公开投影。 */
export function parseServerOpsScript(value: unknown): ServerOpsScript {
  const errorCode = 'SERVER_OPS_SCRIPT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set([
    'id', 'projectId', 'name', 'description', 'kind', 'usage', 'risk', 'hostId', 'timeoutMs',
    'sourceId', 'database', 'body', 'parameters', 'preconditions', 'expectedImpact', 'rollbackPlan',
    'origin', 'suggestedUsage', 'suggestedUsageReason', 'enabled', 'createdAt', 'updatedAt',
  ])) || !isServerOpsId(value.id) || !isServerOpsId(value.projectId) || !isScriptName(value.name)
    || !['ssh-command', 'sql'].includes(value.kind as string)
    || !['one-off', 'reusable'].includes(value.usage as string)
    || !['read-only', 'mutating'].includes(value.risk as string)
    || !isScriptBody(value.body) || typeof value.enabled !== 'boolean'
    || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)
    || (value.origin !== 'agent' && value.origin !== 'user')
    || (value.description !== undefined && !isBoundedText(value.description, 500, true))) {
    throw new Error(errorCode)
  }
  const parameters = parseServerOpsScriptParameters(value.parameters)
  const script: ServerOpsScript = {
    id: value.id, projectId: value.projectId, name: value.name, kind: value.kind as ServerOpsScriptKind,
    usage: value.usage as ServerOpsScriptUsage, risk: value.risk as ServerOpsScriptRisk,
    body: value.body, parameters, origin: value.origin, enabled: value.enabled,
    createdAt: value.createdAt, updatedAt: value.updatedAt,
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(value.preconditions === undefined ? {} : { preconditions: value.preconditions as string }),
    ...(value.expectedImpact === undefined ? {} : { expectedImpact: value.expectedImpact as string }),
    ...(value.rollbackPlan === undefined ? {} : { rollbackPlan: value.rollbackPlan as string }),
    ...(value.suggestedUsageReason === undefined ? {} : { suggestedUsageReason: value.suggestedUsageReason as string }),
  }
  /** 四份可选说明先集中校验成已窄化的局部值，避免后续继续依赖 unknown 字段。 */
  const notes: { preconditions?: string; expectedImpact?: string; rollbackPlan?: string; suggestedUsageReason?: string } = {}
  for (const key of ['preconditions', 'expectedImpact', 'rollbackPlan', 'suggestedUsageReason'] as const) {
    const text = value[key]
    if (text !== undefined && !isBoundedText(text, SERVER_OPS_SCRIPT_NOTE_MAX_LENGTH, true)) throw new Error(errorCode)
    if (text !== undefined) notes[key] = text
  }
  if (value.suggestedUsage !== undefined && value.suggestedUsage !== 'one-off' && value.suggestedUsage !== 'reusable') throw new Error(errorCode)
  if (value.suggestedUsage !== undefined) script.suggestedUsage = value.suggestedUsage
  if (script.kind === 'ssh-command') {
    if (!isServerOpsId(value.hostId) || value.sourceId !== undefined || value.database !== undefined
      || (value.timeoutMs !== undefined && !isScriptTimeout(value.timeoutMs))) {
      throw new Error(errorCode)
    }
    script.hostId = value.hostId
    if (value.timeoutMs !== undefined) script.timeoutMs = value.timeoutMs
  } else {
    if (!isServerOpsId(value.sourceId) || !isDatabaseName(value.database) || value.hostId !== undefined || value.timeoutMs !== undefined) {
      throw new Error(errorCode)
    }
    script.sourceId = value.sourceId
    script.database = value.database
  }
  /** 使用频度与参数形态必须自洽，避免落盘出语义矛盾的脚本。 */
  if (script.usage === 'one-off' && script.parameters.length > 0) throw new Error(errorCode)
  return script
}

/** 严格解析列表输入。 */
export function parseServerOpsScriptListInput(value: unknown): ServerOpsScriptListInput {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['projectId']))) throw new Error('SERVER_OPS_SCRIPT_LIST_INPUT_INVALID')
  if (value.projectId !== undefined && !isServerOpsId(value.projectId)) throw new Error('SERVER_OPS_SCRIPT_LIST_INPUT_INVALID')
  return value.projectId === undefined ? {} : { projectId: value.projectId }
}

/** 严格解析列表结果。 */
export function parseServerOpsScriptListResult(value: unknown): ServerOpsScriptListResult {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['scripts'])) || !Array.isArray(value.scripts)
    || value.scripts.length > SERVER_OPS_SCRIPT_GLOBAL_LIMIT) {
    throw new Error('SERVER_OPS_SCRIPT_LIST_RESULT_INVALID')
  }
  return { scripts: value.scripts.map(parseServerOpsScript) }
}

/**
 * 严格解析保存输入。
 *
 * 来源与建议频度不在这里决定：`origin` 由主进程按草稿消费情况盖章，
 * 解析器只接受公开字段，凭据、绝对路径与运行身份都进不来。
 */
export function parseServerOpsScriptSaveInput(value: unknown): ServerOpsScriptSaveInput {
  const errorCode = 'SERVER_OPS_SCRIPT_SAVE_INPUT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set([
    'scriptId', 'projectId', 'name', 'description', 'kind', 'usage', 'risk', 'hostId', 'timeoutMs',
    'sourceId', 'database', 'body', 'parameters', 'preconditions', 'expectedImpact', 'rollbackPlan',
    'enabled', 'expectedUpdatedAt', 'draftId', 'draftSessionId',
  ]))
    || (value.scriptId !== undefined && !isServerOpsId(value.scriptId))
    || !isServerOpsId(value.projectId) || !isScriptName(value.name)
    || !['ssh-command', 'sql'].includes(value.kind as string)
    || !['one-off', 'reusable'].includes(value.usage as string)
    || !['read-only', 'mutating'].includes(value.risk as string)
    || !isScriptBody(value.body) || typeof value.enabled !== 'boolean'
    || (value.expectedUpdatedAt !== undefined && !isTimestamp(value.expectedUpdatedAt))
    || (value.draftId !== undefined && !isServerOpsId(value.draftId))
    || (value.draftSessionId !== undefined && !isServerOpsId(value.draftSessionId))
    /** 草稿身份必须成对出现：只给其一无法复核领取资格。 */
    || ((value.draftId === undefined) !== (value.draftSessionId === undefined))
    || (value.description !== undefined && !isBoundedText(value.description, 500, true))) {
    throw new Error(errorCode)
  }
  /** 三份可选说明先集中校验成已窄化的局部值，避免后续继续依赖 unknown 字段。 */
  const notes: { preconditions?: string; expectedImpact?: string; rollbackPlan?: string } = {}
  for (const key of ['preconditions', 'expectedImpact', 'rollbackPlan'] as const) {
    const text = value[key]
    if (text !== undefined && !isBoundedText(text, SERVER_OPS_SCRIPT_NOTE_MAX_LENGTH, true)) throw new Error(errorCode)
    if (text !== undefined) notes[key] = text
  }
  const input: ServerOpsScriptSaveInput = {
    projectId: value.projectId, name: value.name, kind: value.kind as ServerOpsScriptKind,
    usage: value.usage as ServerOpsScriptUsage, risk: value.risk as ServerOpsScriptRisk,
    body: value.body, parameters: parseServerOpsScriptParameters(value.parameters), enabled: value.enabled,
    ...(value.scriptId === undefined ? {} : { scriptId: value.scriptId }),
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(notes.preconditions === undefined ? {} : { preconditions: notes.preconditions }),
    ...(notes.expectedImpact === undefined ? {} : { expectedImpact: notes.expectedImpact }),
    ...(notes.rollbackPlan === undefined ? {} : { rollbackPlan: notes.rollbackPlan }),
    ...(value.expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt: value.expectedUpdatedAt }),
    ...(value.draftId === undefined ? {} : { draftId: value.draftId }),
    ...(value.draftSessionId === undefined ? {} : { draftSessionId: value.draftSessionId }),
  }
  if (input.kind === 'ssh-command') {
    if (!isServerOpsId(value.hostId) || value.sourceId !== undefined || value.database !== undefined
      || (value.timeoutMs !== undefined && !isScriptTimeout(value.timeoutMs))) {
      throw new Error(errorCode)
    }
    input.hostId = value.hostId
    if (value.timeoutMs !== undefined) input.timeoutMs = value.timeoutMs
  } else {
    if (!isServerOpsId(value.sourceId) || !isDatabaseName(value.database) || value.hostId !== undefined || value.timeoutMs !== undefined) {
      throw new Error(errorCode)
    }
    input.sourceId = value.sourceId
    input.database = value.database
  }
  /** 单次脚本不允许参数化；通用脚本必须自带前置条件与变更说明。 */
  if (input.usage === 'one-off' && input.parameters.length > 0) throw new Error(errorCode)
  if (input.usage === 'reusable' && !input.preconditions?.trim()) throw new Error('SERVER_OPS_SCRIPT_PRECONDITION_REQUIRED')
  if (input.usage === 'reusable' && input.risk === 'mutating' && (!input.expectedImpact?.trim() || !input.rollbackPlan?.trim())) {
    throw new Error('SERVER_OPS_SCRIPT_IMPACT_REQUIRED')
  }
  return input
}

/** 严格解析删除输入。 */
export function parseServerOpsScriptDeleteInput(value: unknown): ServerOpsScriptDeleteInput {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['scriptId'])) || !isServerOpsId(value.scriptId)) {
    throw new Error('SERVER_OPS_SCRIPT_DELETE_INPUT_INVALID')
  }
  return { scriptId: value.scriptId }
}

/** 严格解析运行输入；`confirmed` 必须是字面量 true，防止别的入口误调。 */
export function parseServerOpsScriptRunInput(value: unknown): ServerOpsScriptRunInput {
  const errorCode = 'SERVER_OPS_SCRIPT_RUN_INPUT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['scriptId', 'runId', 'confirmed', 'parameters']))
    || !isServerOpsId(value.scriptId) || !isServerOpsId(value.runId) || value.confirmed !== true
    || !Array.isArray(value.parameters) || value.parameters.length > SERVER_OPS_SCRIPT_PARAMETER_LIMIT) {
    throw new Error(errorCode)
  }
  const parameters = value.parameters.map((entry) => {
    if (!isRecord(entry) || !hasOnlyKeys(entry, new Set(['name', 'value']))
      || !isServerOpsScriptParameterName(entry.name) || !isBoundedText(entry.value, 4_096, true)) {
      throw new Error(errorCode)
    }
    return { name: entry.name, value: entry.value }
  })
  if (new Set(parameters.map((entry) => entry.name)).size !== parameters.length) throw new Error(errorCode)
  return { scriptId: value.scriptId, runId: value.runId, confirmed: true, parameters }
}

/** 严格解析取消运行输入。 */
export function parseServerOpsScriptCancelRunInput(value: unknown): ServerOpsScriptCancelRunInput {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['runId'])) || !isServerOpsId(value.runId)) {
    throw new Error('SERVER_OPS_SCRIPT_CANCEL_INPUT_INVALID')
  }
  return { runId: value.runId }
}

/** 严格解析运行记录。 */
export function parseServerOpsScriptRun(value: unknown): ServerOpsScriptRun {
  const errorCode = 'SERVER_OPS_SCRIPT_RUN_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set([
    'id', 'scriptId', 'projectId', 'status', 'startedAt', 'finishedAt', 'durationMs', 'parameters',
    'exitCode', 'statementCount', 'affectedRows', 'committed', 'errorCode', 'errorMessage', 'outputPreview',
  ])) || !isServerOpsId(value.id) || !isServerOpsId(value.scriptId) || !isServerOpsId(value.projectId)
    || !['running', 'succeeded', 'failed', 'cancelled', 'unknown'].includes(value.status as string)
    || !isTimestamp(value.startedAt)
    || (value.finishedAt !== undefined && !isTimestamp(value.finishedAt))
    || (value.durationMs !== undefined && !isNonNegativeInteger(value.durationMs))
    || (value.exitCode !== undefined && (typeof value.exitCode !== 'number' || !Number.isSafeInteger(value.exitCode)))
    || (value.statementCount !== undefined && !isNonNegativeInteger(value.statementCount))
    || (value.affectedRows !== undefined && !isNonNegativeInteger(value.affectedRows))
    || (value.committed !== undefined && typeof value.committed !== 'boolean')
    || (value.errorCode !== undefined && !isBoundedText(value.errorCode, 128, true))
    || (value.errorMessage !== undefined && !isBoundedText(value.errorMessage, 500, true))
    || (value.outputPreview !== undefined && !isBoundedText(value.outputPreview, 4_096, true))
    || !Array.isArray(value.parameters) || value.parameters.length > SERVER_OPS_SCRIPT_PARAMETER_LIMIT) {
    throw new Error(errorCode)
  }
  const parameters = value.parameters.map((entry) => {
    if (!isRecord(entry) || !hasOnlyKeys(entry, new Set(['name', 'value']))
      || !isServerOpsScriptParameterName(entry.name) || !isBoundedText(entry.value, 4_096, true)) {
      throw new Error(errorCode)
    }
    return { name: entry.name, value: entry.value }
  })
  return {
    id: value.id, scriptId: value.scriptId, projectId: value.projectId,
    status: value.status as ServerOpsScriptRunStatus, startedAt: value.startedAt, parameters,
    ...(value.finishedAt === undefined ? {} : { finishedAt: value.finishedAt }),
    ...(value.durationMs === undefined ? {} : { durationMs: value.durationMs as number }),
    ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode as number }),
    ...(value.statementCount === undefined ? {} : { statementCount: value.statementCount as number }),
    ...(value.affectedRows === undefined ? {} : { affectedRows: value.affectedRows as number }),
    ...(value.committed === undefined ? {} : { committed: value.committed as boolean }),
    ...(value.errorCode === undefined ? {} : { errorCode: value.errorCode as string }),
    ...(value.errorMessage === undefined ? {} : { errorMessage: value.errorMessage as string }),
    ...(value.outputPreview === undefined ? {} : { outputPreview: value.outputPreview as string }),
  }
}

/** 判断未知值是否为非负安全整数。 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** 严格解析运行记录查询输入。 */
export function parseServerOpsScriptRunListInput(value: unknown): ServerOpsScriptRunListInput {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['scriptId', 'projectId', 'limit']))) {
    throw new Error('SERVER_OPS_SCRIPT_RUN_LIST_INPUT_INVALID')
  }
  if (value.scriptId !== undefined && !isServerOpsId(value.scriptId)) throw new Error('SERVER_OPS_SCRIPT_RUN_LIST_INPUT_INVALID')
  if (value.projectId !== undefined && !isServerOpsId(value.projectId)) throw new Error('SERVER_OPS_SCRIPT_RUN_LIST_INPUT_INVALID')
  if (value.limit !== undefined && (typeof value.limit !== 'number' || !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 200)) {
    throw new Error('SERVER_OPS_SCRIPT_RUN_LIST_INPUT_INVALID')
  }
  return {
    ...(value.scriptId === undefined ? {} : { scriptId: value.scriptId }),
    ...(value.projectId === undefined ? {} : { projectId: value.projectId }),
    ...(value.limit === undefined ? {} : { limit: value.limit as number }),
  }
}

/** 严格解析运行记录查询结果。 */
export function parseServerOpsScriptRunListResult(value: unknown): ServerOpsScriptRunListResult {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['runs'])) || !Array.isArray(value.runs) || value.runs.length > 200) {
    throw new Error('SERVER_OPS_SCRIPT_RUN_LIST_RESULT_INVALID')
  }
  return { runs: value.runs.map(parseServerOpsScriptRun) }
}

/** 严格解析 Agent 草稿内容。 */
export function parseServerOpsScriptDraftInput(value: unknown): ServerOpsScriptDraftInput {
  const errorCode = 'SERVER_OPS_SCRIPT_DRAFT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set([
    'projectId', 'name', 'description', 'kind', 'usage', 'risk', 'hostId', 'timeoutMs',
    'sourceId', 'database', 'body', 'parameters', 'preconditions', 'expectedImpact',
    'rollbackPlan', 'suggestedUsageReason',
  ]))
    || !isScriptName(value.name) || !['ssh-command', 'sql'].includes(value.kind as string)
    || !['one-off', 'reusable'].includes(value.usage as string)
    || !['read-only', 'mutating'].includes(value.risk as string)
    || !isScriptBody(value.body)
    || (value.projectId !== undefined && !isServerOpsId(value.projectId))
    || (value.description !== undefined && !isBoundedText(value.description, 500, true))) {
    throw new Error(errorCode)
  }
  /** 四份可选说明先集中校验成已窄化的局部值，避免后续继续依赖 unknown 字段。 */
  const notes: { preconditions?: string; expectedImpact?: string; rollbackPlan?: string; suggestedUsageReason?: string } = {}
  for (const key of ['preconditions', 'expectedImpact', 'rollbackPlan', 'suggestedUsageReason'] as const) {
    const text = value[key]
    if (text !== undefined && !isBoundedText(text, SERVER_OPS_SCRIPT_NOTE_MAX_LENGTH, true)) throw new Error(errorCode)
    if (text !== undefined) notes[key] = text
  }
  const input: ServerOpsScriptDraftInput = {
    name: value.name, kind: value.kind as ServerOpsScriptKind, usage: value.usage as ServerOpsScriptUsage,
    risk: value.risk as ServerOpsScriptRisk, body: value.body, parameters: parseServerOpsScriptParameters(value.parameters),
    ...(value.projectId === undefined ? {} : { projectId: value.projectId }),
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(notes.preconditions === undefined ? {} : { preconditions: notes.preconditions }),
    ...(notes.expectedImpact === undefined ? {} : { expectedImpact: notes.expectedImpact }),
    ...(notes.rollbackPlan === undefined ? {} : { rollbackPlan: notes.rollbackPlan }),
    ...(notes.suggestedUsageReason === undefined ? {} : { suggestedUsageReason: notes.suggestedUsageReason }),
  }
  if (input.kind === 'ssh-command') {
    if (!isServerOpsId(value.hostId) || value.sourceId !== undefined || value.database !== undefined
      || (value.timeoutMs !== undefined && !isScriptTimeout(value.timeoutMs))) {
      throw new Error(errorCode)
    }
    input.hostId = value.hostId
    if (value.timeoutMs !== undefined) input.timeoutMs = value.timeoutMs
  } else {
    if (!isServerOpsId(value.sourceId) || !isDatabaseName(value.database) || value.hostId !== undefined || value.timeoutMs !== undefined) {
      throw new Error(errorCode)
    }
    input.sourceId = value.sourceId
    input.database = value.database
  }
  if (input.usage === 'one-off' && input.parameters.length > 0) throw new Error(errorCode)
  return input
}

/** 严格解析草稿投影。 */
export function parseServerOpsScriptDraft(value: unknown): ServerOpsScriptDraft {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['id', 'sessionId', 'createdAt', 'expiresAt', 'input']))
    || !isServerOpsId(value.id) || !isServerOpsId(value.sessionId)
    || !isTimestamp(value.createdAt) || !isTimestamp(value.expiresAt) || value.expiresAt <= value.createdAt) {
    throw new Error('SERVER_OPS_SCRIPT_DRAFT_INVALID')
  }
  return {
    id: value.id, sessionId: value.sessionId, createdAt: value.createdAt, expiresAt: value.expiresAt,
    input: parseServerOpsScriptDraftInput(value.input),
  }
}

/** 严格解析草稿列表结果。 */
export function parseServerOpsScriptDraftListResult(value: unknown): ServerOpsScriptDraftListResult {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['drafts'])) || !Array.isArray(value.drafts) || value.drafts.length > 64) {
    throw new Error('SERVER_OPS_SCRIPT_DRAFT_INVALID')
  }
  return { drafts: value.drafts.map(parseServerOpsScriptDraft) }
}

/** 占位符语法：`{{参数名}}`，允许两侧空白，禁止嵌套花括号。 */
const PLACEHOLDER_SOURCE = '\\{\\{\\s*([^{}]*?)\\s*\\}\\}'

/** 每次新建正则实例，避免全局正则的 lastIndex 在多次调用之间串状态。 */
function createPlaceholderPattern(): RegExp {
  return new RegExp(PLACEHOLDER_SOURCE, 'gu')
}

/**
 * 抽取正文引用的参数名。
 *
 * 空占位符、嵌套花括号、三花括号与非法名称一律抛错，
 * 不允许把无法无歧义解析的模板交给执行器去猜。
 *
 * @param body 脚本正文
 * @returns 按首次出现顺序去重的参数名
 */
export function extractServerOpsScriptParameterNames(body: string): string[] {
  /** 三花括号无法无歧义切分：`{{{a}}}` 会被误读成带一个多余括号的合法占位符，必须先拒绝。 */
  if (body.includes('{{{') || body.includes('}}}')) throw new Error('SERVER_OPS_SCRIPT_PLACEHOLDER_INVALID')
  const names: string[] = []
  for (const match of body.matchAll(createPlaceholderPattern())) {
    const name = match[1] ?? ''
    if (!isServerOpsScriptParameterName(name)) throw new Error('SERVER_OPS_SCRIPT_PLACEHOLDER_INVALID')
    if (!names.includes(name)) names.push(name)
  }
  /** 去掉全部合法占位符后仍残留花括号，说明写法本身不完整。 */
  const stripped = body.replace(createPlaceholderPattern(), '')
  if (stripped.includes('{{') || stripped.includes('}}')) throw new Error('SERVER_OPS_SCRIPT_PLACEHOLDER_INVALID')
  return names
}

/** 按参数类型校验单个取值。 */
function isParameterValue(type: ServerOpsScriptParameterType, value: string): boolean {
  if (type === 'number') return /^-?\d{1,18}(\.\d{1,6})?$/u.test(value)
  if (type === 'identifier') return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(value)
  if (type === 'date') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
    if (!match) return false
    const month = Number(match[2])
    const day = Number(match[3])
    return month >= 1 && month <= 12 && day >= 1 && day <= 31
  }
  return true
}

/** 按类别渲染参数值；这是唯一的防注入转义点。 */
function renderParameterValue(kind: ServerOpsScriptKind, type: ServerOpsScriptParameterType, value: string): string {
  if (type === 'number' || type === 'identifier') return value
  if (kind === 'ssh-command') return `'${value.split("'").join("'\\''")}'`
  return `'${value.split("'").join("''")}'`
}

/**
 * 渲染脚本正文：把声明过的占位符替换成转义后的取值。
 *
 * 未声明的占位符、声明了但正文没引用的参数、缺失的必填参数、类型不符的取值
 * 都会整脚本拒绝，不做局部替换，也不回退到原样输出。
 *
 * @param script 脚本类别、正文与参数定义
 * @param values 用户填写或默认的取值
 * @returns 可直接交执行器的正文与实际使用到的参数
 */
export function renderServerOpsScriptBody(
  script: Pick<ServerOpsScript, 'kind' | 'body' | 'parameters'>,
  values: readonly { name: string; value: string }[],
): ServerOpsScriptRenderedBody {
  const referenced = extractServerOpsScriptParameterNames(script.body)
  const declared = new Map(script.parameters.map((entry) => [entry.name, entry]))
  for (const name of referenced) {
    if (!declared.has(name)) throw new Error('SERVER_OPS_SCRIPT_PLACEHOLDER_UNKNOWN')
  }
  for (const entry of script.parameters) {
    if (!referenced.includes(entry.name)) throw new Error('SERVER_OPS_SCRIPT_PARAMETER_UNUSED')
  }
  const provided = new Map(values.map((entry) => [entry.name, entry.value]))
  const resolved = new Map<string, string>()
  const used: { name: string; value: string }[] = []
  for (const name of referenced) {
    const definition = declared.get(name)
    if (!definition) throw new Error('SERVER_OPS_SCRIPT_PLACEHOLDER_UNKNOWN')
    const raw = provided.get(name) ?? definition.default
    if (raw === undefined) {
      /** 解析器已保证可选参数必有默认值，因此走到这里只可能是调用方漏填了必填参数。 */
      throw new Error('SERVER_OPS_SCRIPT_PARAMETER_REQUIRED')
    }
    if (!isBoundedText(raw, 4_096, true) || !isParameterValue(definition.type, raw)) {
      throw new Error('SERVER_OPS_SCRIPT_PARAMETER_INVALID')
    }
    resolved.set(name, renderParameterValue(script.kind, definition.type, raw))
    /** 运行记录保留原始取值；敏感参数由调用方替换成 [REDACTED]。 */
    used.push({ name, value: raw })
  }
  const text = script.body.replace(createPlaceholderPattern(), (_match, rawName: string) => {
    const rendered = resolved.get(rawName.trim())
    if (rendered === undefined) throw new Error('SERVER_OPS_SCRIPT_PLACEHOLDER_UNKNOWN')
    return rendered
  })
  return { text, values: used }
}

/** 单次/通用判定的确定性信号；只用于提示，不替用户决定。 */
export interface ServerOpsScriptUsageSignals {
  /** 建议的频度，仅作为界面默认值。 */
  suggestedUsage: ServerOpsScriptUsage
  /** 决定建议的强信号：命中任意一条才建议单次。 */
  strongSignals: string[]
  /** 只作提示的弱信号：不参与建议，避免把可复用脚本集体判错。 */
  weakSignals: string[]
}

/** SQL 里出现写操作的保守判据；仅用于风险提示。 */
const SQL_MUTATING_PATTERN = /\b(insert|update|delete|replace|merge|alter|drop|create|truncate|rename|grant|revoke|call)\b/iu

/** SSH 只读探测命令白名单；不命中即按变更处理。 */
const SSH_READ_ONLY_PATTERN = /^(uname|uptime|df|free|ps|ss|netstat|ls|cat|head|tail|wc|date|whoami|hostname|systemctl\s+(status|show|is-active|list-units)|journalctl|docker\s+(ps|inspect|logs|stats))\b/u

/**
 * 推断脚本更像单次还是通用。
 *
 * 判别依据是意图而不是文本，因此这里只产出**信号与建议**，最终频度由用户在保存对话框里拍板。
 *
 * 强弱信号必须分开：只有当正文里出现**写死的单次证据**（主键等值、字面日期、
 * 绝对路径、无 WHERE 的 UPDATE/DELETE）才建议单次。像「没有参数占位符」这种
 * 弱信号不能驱动建议——`systemctl restart nginx` 天生不需要参数，却是典型可复用脚本，
 * 早期版本把它一律建议成单次，等于让用户学会忽略这个建议。
 *
 * @param kind 脚本类别
 * @param body 脚本正文
 * @returns 建议频度与强弱信号列表
 */
export function inferServerOpsScriptUsageSignals(kind: ServerOpsScriptKind, body: string): ServerOpsScriptUsageSignals {
  const strongSignals: string[] = []
  const weakSignals: string[] = []
  /** 主键等值写死，是最可靠的「只针对某一条记录」证据。 */
  if (/\b(id|_id)\s*=\s*\d+/iu.test(body)) strongSignals.push('正文里写死了具体记录标识，换一条记录就要改脚本')
  if (/\b\d{4}-\d{2}-\d{2}\b/u.test(body)) strongSignals.push('正文里写死了日期，换一天就要改脚本')
  if (/(\/Users\/|\/home\/|\/var\/|\/etc\/)/u.test(body)) strongSignals.push('正文里写死了绝对路径')
  if (kind === 'sql' && /\b(update|delete)\b(?![^;]*\bwhere\b)/iu.test(body)) strongSignals.push('UPDATE/DELETE 没有 WHERE 条件，影响范围无法预估')
  /** 弱信号只提示，不改变建议：它们在有参数的脚本里同样常见。 */
  if (/\b\d{1,3}(\.\d{1,3}){3}\b/u.test(body)) weakSignals.push('正文里出现了具体 IP 地址，确认它该不该参数化')
  if (/\blimit\s+1\b/iu.test(body)) weakSignals.push('带 LIMIT 1，确认是否只针对某一条记录')
  const placeholders = extractServerOpsScriptParameterNames(body)
  if (placeholders.length === 0) weakSignals.push('正文没有参数占位符，复用时要手改正文')
  return { suggestedUsage: strongSignals.length > 0 ? 'one-off' : 'reusable', strongSignals, weakSignals }
}

/**
 * 推断脚本的变更风险；只作为界面默认值与审计标注。
 *
 * 执行器不依赖这个结果做安全判定：SQL 写执行链会自行解析语句，
 * SSH 执行仍走既有的命令分类与逐次审批。
 *
 * @param kind 脚本类别
 * @param body 脚本正文
 * @returns 风险分类
 */
export function inferServerOpsScriptRisk(kind: ServerOpsScriptKind, body: string): ServerOpsScriptRisk {
  if (kind === 'sql') return SQL_MUTATING_PATTERN.test(body) ? 'mutating' : 'read-only'
  return SSH_READ_ONLY_PATTERN.test(body.trim()) ? 'read-only' : 'mutating'
}
