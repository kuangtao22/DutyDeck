/** 单个文件在本轮受控写入前后形成的净变化；不包含文件正文。 */
export interface AgentRunFileChange {
  /** 经过运行范围校验的绝对路径。 */
  path: string
  /** 文件操作类型；unchanged 表示本轮已还原，unknown 表示仅有监听证据。 */
  status: 'added' | 'modified' | 'deleted' | 'unchanged' | 'unknown'
  /** 行数不可用时必须保留原因，不伪造零值。 */
  statsState: 'complete' | 'binary' | 'too_large' | 'unavailable' | 'external_change' | 'budget_exceeded'
  /** 精确统计时新增的行数。 */
  additions?: number
  /** 精确统计时删除的行数。 */
  deletions?: number
}

/** 可持久化、可跨进程传输的本轮文件统计快照。 */
export interface AgentRunFileChangesSnapshot {
  /** 对应 startedAt 的字符串，用于复用既有本轮归属逻辑。 */
  runId: string
  /** 同一轮单调递增的快照版本，拒绝迟到的历史读取。 */
  revision?: number
  /** 本轮开始时间。 */
  startedAt: number
  /** 本轮结束时间；运行中省略。 */
  endedAt?: number
  /** 已捕获的文件净变化，包含还原状态以覆盖旧工具路径。 */
  files: AgentRunFileChange[]
  /** 监听器无法唯一归属的共享目录改动。 */
  hasUnattributedChanges?: boolean
}

/** 工具权限通过后，在真正执行前后触发的轻量采集请求。 */
export interface AgentFileChangeCapture {
  /** before/after 用于写类工具；verify 校验终端污染；invalidate 处理采集超时。 */
  phase: 'before' | 'after' | 'verify' | 'invalidate'
  /** write/edit 的最终入参路径；verify 不需要路径。 */
  path?: string
}
