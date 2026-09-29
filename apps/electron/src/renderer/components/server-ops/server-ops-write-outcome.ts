import { getServerOpsDataWriteOutcome } from '@proma/shared'
import type { ServerOpsDataWriteResult } from '@proma/shared'
import { getServerOpsDataErrorMessage } from './server-ops-data-display'

/** 写入终态的用户可见语义；成功与否取决于数据库事实，不取决于是否点过取消。 */
export interface ServerOpsWriteOutcomePresentation {
  label: string
  detail: string
  successful: boolean
  tone: 'success' | 'warning' | 'danger' | 'muted'
}

/**
 * 把共享写回执转换为统一界面文案。
 *
 * @param result 主进程返回或历史持久化的写入事实
 * @returns 状态标签、说明、成功标识与视觉语气
 */
export function getServerOpsWriteOutcomePresentation(
  result: ServerOpsDataWriteResult,
): ServerOpsWriteOutcomePresentation {
  switch (getServerOpsDataWriteOutcome(result)) {
    case 'committed':
      return { label: '已提交', detail: '改动已生效', successful: true, tone: 'success' }
    case 'rolled-back':
      return { label: '已回滚', detail: '事务已回滚，数据未改变', successful: false, tone: 'muted' }
    case 'partial':
      return { label: '部分生效', detail: '部分改动已经生效，请核对数据库后再决定是否重跑', successful: false, tone: 'danger' }
    case 'not-started':
      return { label: '未开始', detail: '没有执行任何语句', successful: false, tone: 'muted' }
    case 'unknown':
      return { label: '结果未知', detail: '无法确认改动是否生效，请核对数据库后再决定是否重跑', successful: false, tone: 'warning' }
  }
}

/** 返回非成功回执的错误摘要；稳定错误码只负责补充原因，终态文案负责说明是否生效。 */
export function getServerOpsWriteResultError(result: ServerOpsDataWriteResult): string | null {
  const presentation = getServerOpsWriteOutcomePresentation(result)
  if (presentation.successful) return null
  if (presentation.tone === 'danger') return `写入失败：${presentation.detail}`
  if (presentation.tone === 'warning') return `写入结果未知：${presentation.detail}`
  /** 通用失败码不带原因，直接配合终态；其它码（权限、引擎等）保留具体说明。 */
  if (result.errorCode && result.errorCode !== 'SERVER_OPS_DATA_WRITE_FAILED') {
    return `${getServerOpsDataErrorMessage(new Error(result.errorCode))}；${presentation.detail}`
  }
  if (result.errorCode) return `写入失败；${presentation.detail}`
  return presentation.detail
}
