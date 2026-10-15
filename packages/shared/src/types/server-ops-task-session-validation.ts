import { isServerOpsId } from './server-ops'
import type { ServerOpsTaskSummary, ServerOpsTaskTarget, ServerOpsTaskReadInput, ServerOpsTaskReadResult, ServerOpsTaskUserInput, ServerOpsTaskUserResize } from './server-ops-task-session'

/** DTO 非法时统一拒绝，避免伪造终态或把其他任务输出送入终端。 */
function invalid(): never { throw new Error('SERVER_OPS_TASK_RESULT_INVALID') }
/** 读取普通对象，拒绝数组和空值。 */
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
/** 拒绝额外字段，防止静默吞掉错误身份或凭据参数。 */
function keys(input: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some((key) => !(key in input)) || Object.keys(input).some((key) => !required.includes(key) && !optional.includes(key))) invalid()
}
/** 内部身份投影；外部解析器先执行完整字段检查。 */
function identity(input: Record<string, unknown>): ServerOpsTaskTarget { return { sessionId: identifier(input.sessionId), taskId: identifier(input.taskId) } }
/** 必填身份必须非空且有界。 */
function identifier(value: unknown): string {
  if (!isServerOpsId(value)) return invalid()
  return value
}
/** 非负整数游标。 */
function offset(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return invalid()
  return value
}
/** 校验并投影任务元数据；不透传额外字段。 */
export function parseServerOpsTaskSummary(value: unknown): ServerOpsTaskSummary {
  const item = record(value)
  keys(item, ['taskId', 'sessionId', 'hostId', 'connectionId', 'command', 'state', 'createdAt'], ['exitCode', 'signal', 'message', 'warnings'])
  if (!['starting', 'running', 'exited', 'unknown', 'interrupted'].includes(String(item.state)) || typeof item.command !== 'string' || !item.command.trim() || item.command.length > 8192 || item.command.includes('\0')) return invalid()
  if (item.exitCode !== undefined && (typeof item.exitCode !== 'number' || !Number.isSafeInteger(item.exitCode))) return invalid()
  if (item.signal !== undefined && (typeof item.signal !== 'string' || !item.signal || item.signal.length > 64)) return invalid()
  if (item.message !== undefined && (typeof item.message !== 'string' || item.message.length > 4096)) return invalid()
  if (item.warnings !== undefined && (!Array.isArray(item.warnings) || item.warnings.length > 32 || !item.warnings.every((warning) => typeof warning === 'string' && warning.length <= 4096))) return invalid()
  if (item.state === 'exited' ? item.exitCode === undefined && item.signal === undefined : item.exitCode !== undefined || item.signal !== undefined) return invalid()
  return { taskId: identifier(item.taskId), sessionId: identifier(item.sessionId), hostId: identifier(item.hostId), connectionId: identifier(item.connectionId), command: item.command,
    state: item.state as ServerOpsTaskSummary['state'], createdAt: offset(item.createdAt),
    ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode as number }),
    ...(item.signal === undefined ? {} : { signal: item.signal as string }),
    ...(item.message === undefined ? {} : { message: item.message as string }),
    ...(item.warnings === undefined ? {} : { warnings: [...item.warnings as string[]] }) }
}
/** 任务目标只保留授权边界需要的两个字段。 */
export function parseServerOpsTaskTarget(value: unknown): ServerOpsTaskTarget { const input = record(value); keys(input, ['sessionId', 'taskId']); return identity(input) }
/** 校验可选的读取游标和最长等待。 */
export function parseServerOpsTaskReadInput(value: unknown): ServerOpsTaskReadInput {
  const input = record(value)
  keys(input, ['sessionId', 'taskId'], ['offset', 'waitMs'])
  if (input.waitMs !== undefined && offset(input.waitMs) > 30000) return invalid()
  return { ...identity(input),
    ...(input.offset === undefined ? {} : { offset: offset(input.offset) }),
    ...(input.waitMs === undefined ? {} : { waitMs: offset(input.waitMs) }) }
}
/** 用户键盘输入仅保留身份和有界原始数据。 */
export function parseServerOpsTaskUserInput(value: unknown): ServerOpsTaskUserInput {
  const input = record(value)
  keys(input, ['sessionId', 'taskId', 'data'])
  if (typeof input.data !== 'string' || input.data.length < 1 || input.data.length > 65536) return invalid()
  return { ...identity(input), data: input.data }
}
/** 用户终端尺寸必须是合理的正整数。 */
export function parseServerOpsTaskUserResize(value: unknown): ServerOpsTaskUserResize {
  const input = record(value)
  keys(input, ['sessionId', 'taskId', 'cols', 'rows'])
  const cols = offset(input.cols); const rows = offset(input.rows)
  if (cols < 1 || rows < 1 || cols > 1000 || rows > 1000) return invalid()
  return { ...identity(input), cols, rows }
}
/** 验证分页窗口与正文长度，避免游标错位造成重复或跳读。 */
export function parseServerOpsTaskReadResult(value: unknown): ServerOpsTaskReadResult {
  const result = record(value)
  keys(result, ['task', 'output', 'offset', 'nextOffset', 'availableStartOffset', 'availableEndOffset', 'truncatedBefore', 'truncatedAfter'])
  const task = parseServerOpsTaskSummary(result.task)
  const start = offset(result.offset); const next = offset(result.nextOffset)
  const availableStart = offset(result.availableStartOffset); const availableEnd = offset(result.availableEndOffset)
  if (typeof result.output !== 'string' || result.output.length > 12000 || typeof result.truncatedBefore !== 'boolean' || typeof result.truncatedAfter !== 'boolean'
    || next - start !== result.output.length || start < availableStart || next > availableEnd || next < start
    || result.truncatedAfter !== (next < availableEnd)) return invalid()
  return { task, output: result.output, offset: start, nextOffset: next, availableStartOffset: availableStart, availableEndOffset: availableEnd,
    truncatedBefore: result.truncatedBefore, truncatedAfter: result.truncatedAfter }
}
