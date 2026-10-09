/** 单次请求最多传输 32 KiB 参数、返回 16 KiB 文本，避免大键压垮工具上下文。 */
export const SERVER_OPS_REDIS_MAX_ARGUMENT_BYTES = 32_768
export const SERVER_OPS_REDIS_MAX_RESULT_BYTES = 16_384
/** 允许读取的单键标量命令；不含遍历、脚本或无限集合返回。 */
export const SERVER_OPS_REDIS_READ_COMMANDS = ['GET', 'TYPE', 'TTL', 'PTTL', 'EXISTS', 'STRLEN', 'HLEN', 'LLEN', 'SCARD', 'ZCARD', 'HGET', 'HEXISTS', 'SISMEMBER', 'ZSCORE', 'GETRANGE'] as const
/** 每次只修改一个键；集合参数的数量由解析器限制。 */
export const SERVER_OPS_REDIS_WRITE_COMMANDS = ['SET', 'DEL', 'UNLINK', 'EXPIRE', 'PEXPIRE', 'PERSIST', 'INCR', 'DECR', 'HSET', 'HDEL', 'LPUSH', 'RPUSH', 'SADD', 'SREM', 'ZADD', 'ZREM'] as const
/** 公开命令输入不接收连接、认证或逻辑库覆盖字段。 */
export interface ServerOpsRedisCommandInput { sourceId: string; command: string; args: string[] }
/** 回执保留已执行事实；unknown 表示必须先核对数据，不能自动重试。 */
export interface ServerOpsRedisCommandResult {
  command: string
  outcome: 'completed' | 'not-started' | 'unknown'
  value: string | number | null
  truncated: boolean
  durationMs: number
  errorCode?: string
}

/** 根据已规范化命令名判断是否需要原生逐次审批。 */
export function isServerOpsRedisWriteCommand(command: string): boolean {
  return (SERVER_OPS_REDIS_WRITE_COMMANDS as readonly string[]).includes(command.toUpperCase())
}

/** 严格解析单键命令与有限参数；access 绑定工具的读写能力。 */
export function parseServerOpsRedisCommandInput(value: unknown, access?: 'read' | 'write'): ServerOpsRedisCommandInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('SERVER_OPS_REDIS_INPUT_INVALID')
  /** 在验证所有字段后重建对象，拒绝偷偷夹带逻辑库和连接信息。 */
  const input = value as Record<string, unknown>
  if (Object.keys(input).length !== 3 || !['sourceId', 'command', 'args'].every((key) => Object.hasOwn(input, key))
    || typeof input.sourceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(input.sourceId)
    || typeof input.command !== 'string' || !/^[A-Za-z]+$/u.test(input.command)
    || !Array.isArray(input.args) || input.args.length < 1 || input.args.length > 65
    || !input.args.every((arg): arg is string => typeof arg === 'string' && !arg.includes('\0'))
    || input.args[0]!.length === 0 || new TextEncoder().encode(input.args[0]!).length > 1_024
    || input.args.reduce((sum, arg) => sum + new TextEncoder().encode(arg).length, 0) > SERVER_OPS_REDIS_MAX_ARGUMENT_BYTES) {
    throw new Error('SERVER_OPS_REDIS_INPUT_INVALID')
  }
  /** 规范化只影响动词，键名和参数正文按原字节执行。 */
  const command = input.command.toUpperCase()
  const args = [...input.args]
  const write = isServerOpsRedisWriteCommand(command)
  if ((!write && !(SERVER_OPS_REDIS_READ_COMMANDS as readonly string[]).includes(command))
    || (access === 'read' && write) || (access === 'write' && !write)) throw new Error('SERVER_OPS_REDIS_COMMAND_FORBIDDEN')
  /** Redis 的过期与索引参数仅接收非负安全整数；负数删除/无界区间不作为隐式选项。 */
  const integer = (text: string | undefined): number => text !== undefined && /^(0|[1-9]\d{0,14})$/u.test(text) ? Number(text) : -1
  let valid: boolean
  if (command === 'SET') {
    valid = args.length === 2 || (args.length === 4 && (args[2] === 'EX' || args[2] === 'PX') && integer(args[3]) > 0)
  } else if (command === 'GETRANGE') {
    valid = args.length === 3 && integer(args[1]) >= 0 && integer(args[2]) >= integer(args[1])
      && integer(args[2]) - integer(args[1]) < SERVER_OPS_REDIS_MAX_RESULT_BYTES
  } else if (command === 'EXPIRE' || command === 'PEXPIRE') {
    valid = args.length === 2 && integer(args[1]) > 0
  } else if (command === 'HSET') {
    valid = args.length >= 3 && args.length % 2 === 1
  } else if (command === 'ZADD') {
    valid = args.length >= 3 && args.length % 2 === 1 && args.filter((_arg, index) => index % 2 === 1)
      .every((score) => score.trim() === score && score.length > 0 && Number.isFinite(Number(score)))
  } else if (['HDEL', 'LPUSH', 'RPUSH', 'SADD', 'SREM', 'ZREM'].includes(command)) {
    valid = args.length >= 2
  } else if (['HGET', 'HEXISTS', 'SISMEMBER', 'ZSCORE'].includes(command)) {
    valid = args.length === 2
  } else valid = args.length === 1
  if (!valid) throw new Error('SERVER_OPS_REDIS_INPUT_INVALID')
  return { sourceId: input.sourceId, command, args }
}

/** 校验跨进程回执，阻止错误正文泄密及不确定结果伪装成成功。 */
export function parseServerOpsRedisCommandResult(value: unknown): ServerOpsRedisCommandResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('SERVER_OPS_REDIS_RESULT_INVALID')
  const result = value as Record<string, unknown>
  const keys = ['command', 'outcome', 'value', 'truncated', 'durationMs', ...(result.errorCode === undefined ? [] : ['errorCode'])]
  if (Object.keys(result).length !== keys.length || !keys.every((key) => Object.hasOwn(result, key))
    || typeof result.command !== 'string' || ![...SERVER_OPS_REDIS_READ_COMMANDS, ...SERVER_OPS_REDIS_WRITE_COMMANDS].some((command) => command === result.command)
    || !['completed', 'not-started', 'unknown'].includes(String(result.outcome))
    || (result.value !== null && typeof result.value !== 'string' && (typeof result.value !== 'number' || !Number.isFinite(result.value)))
    || (typeof result.value === 'string' && new TextEncoder().encode(result.value).length > SERVER_OPS_REDIS_MAX_RESULT_BYTES)
    || typeof result.truncated !== 'boolean' || typeof result.durationMs !== 'number' || !Number.isFinite(result.durationMs) || result.durationMs < 0
    || (result.errorCode !== undefined && (typeof result.errorCode !== 'string' || !/^SERVER_OPS_[A-Z_]{1,100}$/u.test(result.errorCode)))
    || (result.outcome !== 'completed' && (result.value !== null || result.truncated || result.errorCode === undefined))
    || (result.outcome === 'completed' && result.errorCode !== undefined)) throw new Error('SERVER_OPS_REDIS_RESULT_INVALID')
  return { command: result.command, outcome: result.outcome as ServerOpsRedisCommandResult['outcome'], value: result.value as ServerOpsRedisCommandResult['value'],
    truncated: result.truncated, durationMs: result.durationMs, ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode as string }) }
}
