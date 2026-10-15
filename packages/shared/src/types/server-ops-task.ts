/** 已连接 SSH 上的独立任务 PTY 合同。 */
export interface ServerOpsTaskIdentity { taskId: string; hostId: string; connectionId: string }
export interface ServerOpsTaskStartInput extends ServerOpsTaskIdentity { command: string; cols: number; rows: number }
export interface ServerOpsTaskInput extends ServerOpsTaskIdentity { data: string }
export interface ServerOpsTaskResizeInput extends ServerOpsTaskIdentity { cols: number; rows: number }
export interface ServerOpsTaskAck extends ServerOpsTaskIdentity { sequence: number }
export interface ServerOpsTaskOutputEvent extends ServerOpsTaskIdentity { sequence: number; data: string }
export interface ServerOpsTaskExitEvent extends ServerOpsTaskIdentity { exitCode?: number; signal?: string; message: string }

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 校验对象字段与合同完全一致。 */
function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

/** 校验可安全作为 Map key 的公开 ID。 */
function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9_-]+$/u.test(value)
}

/** 校验 PTY 行列边界。 */
function isDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1_000
}

/** 严格重建 Task 完整身份。 */
export function parseServerOpsTaskIdentity(value: unknown): ServerOpsTaskIdentity {
  if (!hasExactKeys(value, ['taskId', 'hostId', 'connectionId'])
    || !isId(value.taskId) || !isId(value.hostId) || !isId(value.connectionId)) {
    throw new Error('SERVER_OPS_TASK_IDENTITY_INVALID')
  }
  return { taskId: value.taskId, hostId: value.hostId, connectionId: value.connectionId }
}

/** 校验任务命令与 PTY 尺寸，返回完整启动身份。 */
export function parseServerOpsTaskStartInput(value: unknown): ServerOpsTaskStartInput {
  if (!hasExactKeys(value, ['taskId', 'hostId', 'connectionId', 'command', 'cols', 'rows'])
    || typeof value.command !== 'string' || value.command.trim().length < 1 || value.command.length > 65_536
    || value.command.includes('\0') || !isDimension(value.cols) || !isDimension(value.rows)) throw new Error('SERVER_OPS_TASK_START_INPUT_INVALID')
  return { ...parseServerOpsTaskIdentity({ taskId: value.taskId, hostId: value.hostId, connectionId: value.connectionId }), command: value.command, cols: value.cols, rows: value.rows }
}

/** 严格校验用户终端输入，拒绝未知字段。 */
export function parseServerOpsTaskInput(value: unknown): ServerOpsTaskInput {
  if (!hasExactKeys(value, ['taskId', 'hostId', 'connectionId', 'data'])
    || typeof value.data !== 'string' || value.data.length < 1 || value.data.length > 65_536) {
    throw new Error('SERVER_OPS_TASK_INPUT_INVALID')
  }
  return { ...parseServerOpsTaskIdentity({ taskId: value.taskId, hostId: value.hostId,
    connectionId: value.connectionId }), data: value.data }
}

/** 严格校验任务窗口尺寸。 */
export function parseServerOpsTaskResizeInput(value: unknown): ServerOpsTaskResizeInput {
  if (!hasExactKeys(value, ['taskId', 'hostId', 'connectionId', 'cols', 'rows'])
    || !isDimension(value.cols) || !isDimension(value.rows)) throw new Error('SERVER_OPS_TASK_RESIZE_INPUT_INVALID')
  return { ...parseServerOpsTaskIdentity({ taskId: value.taskId, hostId: value.hostId,
    connectionId: value.connectionId }), cols: value.cols, rows: value.rows }
}

/** 确认序号必须是安全正整数。 */
export function parseServerOpsTaskAck(value: unknown): ServerOpsTaskAck {
  if (!hasExactKeys(value, ['taskId', 'hostId', 'connectionId', 'sequence'])
    || typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    throw new Error('SERVER_OPS_TASK_ACK_INVALID')
  }
  return { ...parseServerOpsTaskIdentity({ taskId: value.taskId, hostId: value.hostId,
    connectionId: value.connectionId }), sequence: value.sequence }
}

/** 输出批次限制为运行时有界缓冲及截断标记。 */
export function parseServerOpsTaskOutputEvent(value: unknown): ServerOpsTaskOutputEvent {
  if (!hasExactKeys(value, ['taskId', 'hostId', 'connectionId', 'sequence', 'data'])
    || typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence < 1
    || typeof value.data !== 'string' || value.data.length > 65_792) throw new Error('SERVER_OPS_TASK_OUTPUT_INVALID')
  return { ...parseServerOpsTaskIdentity({ taskId: value.taskId, hostId: value.hostId,
    connectionId: value.connectionId }), sequence: value.sequence, data: value.data }
}

/** 仅真实退出状态可携带退出码，未知状态不得补零。 */
export function parseServerOpsTaskExitEvent(value: unknown): ServerOpsTaskExitEvent {
  const keys = ['taskId', 'hostId', 'connectionId', 'message']
  if (!hasExactKeys(value, isRecord(value)
    ? [...keys, ...(value.exitCode === undefined ? [] : ['exitCode']), ...(value.signal === undefined ? [] : ['signal'])] : keys)
    || typeof value.message !== 'string' || value.message.length < 1 || value.message.length > 256 || value.message.includes('\0')
    || (value.exitCode !== undefined && (typeof value.exitCode !== 'number' || !Number.isSafeInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 2_147_483_647))
    || (value.signal !== undefined && (typeof value.signal !== 'string' || value.signal.length < 1 || value.signal.length > 64 || !/^[A-Za-z0-9_.:+-]+$/u.test(value.signal)))) {
    throw new Error('SERVER_OPS_TASK_EXIT_INVALID')
  }
  return { ...parseServerOpsTaskIdentity({ taskId: value.taskId, hostId: value.hostId,
    connectionId: value.connectionId }),
    ...(typeof value.exitCode === 'number' ? { exitCode: value.exitCode } : {}),
    ...(typeof value.signal === 'string' ? { signal: value.signal } : {}), message: value.message }
}
