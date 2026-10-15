/** Agent 远程任务的公开生命周期；未知结果不能作为部署成功或失败重试的依据。 */
export type ServerOpsTaskState = 'starting' | 'running' | 'exited' | 'unknown' | 'interrupted'

/** 任务仅属于发起它的普通用户会话，SSH 身份由主进程绑定。 */
export interface ServerOpsTaskSummary {
  taskId: string
  sessionId: string
  hostId: string
  connectionId: string
  command: string
  state: ServerOpsTaskState
  createdAt: number
  exitCode?: number
  signal?: string
  message?: string
  warnings?: string[]
}

/** 读取和用户输入必须同时携带所属会话与任务身份。 */
export interface ServerOpsTaskTarget { sessionId: string; taskId: string }

/** 有界读取使用原始字符偏移；等待只影响本次读取，不限制远端任务时长。 */
export interface ServerOpsTaskReadInput extends ServerOpsTaskTarget {
  offset?: number
  waitMs?: number
}

/** 原始输出仅供 xterm；Agent Facade 会移除终端控制序列。 */
export interface ServerOpsTaskReadResult {
  task: ServerOpsTaskSummary
  output: string
  offset: number
  nextOffset: number
  availableStartOffset: number
  availableEndOffset: number
  truncatedBefore: boolean
  truncatedAfter: boolean
}

/** 密码输入仅允许 renderer 调用；不提供 Agent 写入工具。 */
export interface ServerOpsTaskUserInput extends ServerOpsTaskTarget { data: string }
/** 用户终端的实际尺寸。 */
export interface ServerOpsTaskUserResize extends ServerOpsTaskTarget { cols: number; rows: number }

/** 仅推送身份和状态；输出通过授权的分页读取取得。 */
export const SERVER_OPS_TASK_IPC_CHANNELS = {
  LIST: 'server-ops:task:list', READ: 'server-ops:task:read',
  WRITE: 'server-ops:task:write', RESIZE: 'server-ops:task:resize',
  INTERRUPT: 'server-ops:task:interrupt', CHANGED: 'server-ops:task:changed',
} as const

export * from './server-ops-task-session-validation'
