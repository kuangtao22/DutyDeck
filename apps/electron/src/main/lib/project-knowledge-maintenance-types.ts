import type { KnowledgeMaintenanceSettings } from '@proma/shared'
import type { SDKMessageAppendReceipt } from './agent-session-manager'

/** 已成功回合的持久化任务；只保存消息定位，不保存隐藏会话副本。 */
export interface KnowledgeMaintenanceJob {
  /** 来源身份与模型版本无关，升级不会把已拒绝候选复活。 */
  id: string
  /** 证据所属会话和最初用户消息身份。 */
  sessionId: string
  userMessageId: string
  /** 文件来源任务固定到扫描条目版本；存在时不使用会话字段。 */
  sourceRefs?: Array<{ entryId: string; revision: string }>
  /** 每个来源版本独立完成，避免批次重新分组导致重复收费。 */
  sourceIdentities?: string[]
  /** 启用前回合不得进入队列。 */
  startedAt: number
  /** 真实消息写入回执，可在重启后验证。 */
  receipts: SDKMessageAppendReceipt[]
  /** 分析状态；running 重启后等待用户重试以免重复收费。 */
  status: 'pending' | 'running' | 'failed' | 'completed' | 'excluded'
  /** 本作业启动所用授权代次。 */
  generation: number
  /** 已发起模型请求次数；失败也计费到作业预算。 */
  attempts: number
  /** 持有本作业的宿主进程，避免另一个应用实例误判仍在运行的作业。 */
  ownerPid?: number
  /** 简短失败原因，不保存原始模型错误和输入。 */
  message?: string
  /** 正式整理完成时间。 */
  completedAt?: number
}

/** 随同权威 manifest 原子发布的维护授权与水位。 */
export interface KnowledgeMaintenanceRecord {
  /** 用户明确选择的模型、预算与授权代次。 */
  settings: KnowledgeMaintenanceSettings
  /** 待整理/已整理作业，来源 ID 保持幂等。 */
  jobs: KnowledgeMaintenanceJob[]
  /** 独立于队列内容的持久化排除集合。 */
  excludedSessions: string[]
  /** 已消耗的自然日预算，不因切模型或重启清零。 */
  budget: { day: string; used: number }
  /** 近期任务之外的已完成来源身份，防止重放。 */
  completedSources: string[]
  /** 最近一次整理水位。 */
  lastProcessedAt?: number
}

/** 未授权项目的维护默认值；不产生任何后台模型调用。 */
export function emptyKnowledgeMaintenance(): KnowledgeMaintenanceRecord {
  return {
    settings: { enabled: false, dailyJobLimit: 20, generation: 0 },
    jobs: [], excludedSessions: [], completedSources: [], budget: { day: '', used: 0 },
  }
}
