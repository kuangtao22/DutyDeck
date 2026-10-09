/** 运维写入审批卡的展示投影；不参与权限判断，也不改变工具输入。 */
export interface ServerOpsApprovalView {
  /** 审批卡标题。 */
  title: string
  /** 目标和执行范围等说明。 */
  details: string[]
  /** 即将执行的完整 SQL 或 Redis 命令。 */
  operation: string
  /** 只说明用户需要留意的风险和确认边界。 */
  warnings: string[]
  /** 数据库写入时单独展示正文，避免长 SQL 混在普通描述里。 */
  sql?: string
}

/** 将主进程传来的多行中文说明拆成目标说明和风险提醒。 */
function splitApprovalDescription(description: string | undefined): { details: string[]; warnings: string[] } {
  const lines = (description ?? '').split('\n').map((line) => line.trim()).filter(Boolean)
  const warnings = lines.filter((line) => line.startsWith('注意：') || line.startsWith('风险：'))
  const details = lines.filter((line) => !warnings.includes(line))
  return { details, warnings }
}

/**
 * 生成运维数据库/Redis 写入的中文审批卡内容。
 *
 * @param toolName Agent 工具名
 * @param toolInput 工具原始参数
 * @param sdkTitle 主进程签发的审批标题
 * @param sdkDescription 主进程签发的目标与风险说明
 * @returns 运维写入展示投影；非写入工具返回 null
 */
export function describeServerOpsApproval(
  toolName: string,
  toolInput: Record<string, unknown>,
  sdkTitle: string | undefined,
  sdkDescription: string | undefined,
): ServerOpsApprovalView | null {
  if (toolName === 'ops_database_write') {
    const sql = typeof toolInput.sql === 'string' ? toolInput.sql : ''
    if (!sql) return null
    const description = splitApprovalDescription(sdkDescription)
    return {
      title: sdkTitle ?? '数据库写入需要确认',
      details: description.details.length > 0 ? description.details : [
        '数据源：' + (typeof toolInput.sourceId === 'string' ? toolInput.sourceId : '未知'),
        '数据库：' + (typeof toolInput.database === 'string' ? toolInput.database : '未知'),
      ],
      operation: sql,
      sql,
      warnings: [
        ...description.warnings,
        '本次确认只批准这一个目标和这段 SQL；目标或内容变化会重新确认。',
      ],
    }
  }
  if (toolName === 'ops_redis_write') {
    const command = typeof toolInput.command === 'string' ? toolInput.command : ''
    const args = Array.isArray(toolInput.args) && toolInput.args.every((arg): arg is string => typeof arg === 'string') ? toolInput.args : []
    if (!command || args.length === 0) return null
    const description = splitApprovalDescription(sdkDescription)
    return {
      title: sdkTitle ?? 'Redis 写入需要确认',
      details: description.details.length > 0 ? description.details : [
        '数据源：' + (typeof toolInput.sourceId === 'string' ? toolInput.sourceId : '未知'),
      ],
      operation: [command, ...args].join(' '),
      warnings: [
        ...description.warnings,
        '本次确认只批准本次 Redis 写入；结果未知时必须先读取核对，不能自动重试。',
      ],
    }
  }
  return null
}
