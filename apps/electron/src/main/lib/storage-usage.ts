import type { StorageProjectUsage, StorageSessionUsage } from '../../types/settings'

/** 参与项目占用汇总的单个会话输入。 */
export interface StorageSessionUsageInput {
  sessionId: string
  title?: string
  workspaceSlug?: string
  workspaceName?: string
  transcriptBytes: number
  workspaceBytes: number
  updatedAt: number
  archived: boolean
  starred?: boolean
  pinned?: boolean
}

/** 将会话占用按项目分组，并提供稳定的默认排序。 */
export function buildStorageProjectUsage(
  inputs: readonly StorageSessionUsageInput[],
): StorageProjectUsage[] {
  /** 以项目 slug 聚合，未关联项目统一放入一个分组。 */
  const projects = new Map<string, StorageProjectUsage>()

  for (const input of inputs) {
    /** 已确认的非负文件大小，避免异常文件系统数据污染汇总。 */
    const transcriptBytes = Math.max(0, input.transcriptBytes)
    const workspaceBytes = Math.max(0, input.workspaceBytes)
    const session: StorageSessionUsage = {
      sessionId: input.sessionId,
      title: input.title,
      bytes: transcriptBytes + workspaceBytes,
      transcriptBytes,
      workspaceBytes,
      updatedAt: input.updatedAt,
      archived: input.archived,
      starred: input.starred === true,
      pinned: input.pinned === true,
    }
    const projectId = input.workspaceSlug ?? '__unassigned__'
    const project = projects.get(projectId) ?? {
      projectId,
      projectName: input.workspaceName ?? '未关联项目',
      workspaceSlug: input.workspaceSlug,
      totalBytes: 0,
      sessionCount: 0,
      lastActivityAt: 0,
      sessions: [],
    }
    project.totalBytes += session.bytes
    project.sessionCount += 1
    project.lastActivityAt = Math.max(project.lastActivityAt, session.updatedAt)
    project.sessions.push(session)
    projects.set(projectId, project)
  }

  /** 会话默认按占用大小降序，用户可在弹窗中切换按日期查看。 */
  for (const project of projects.values()) {
    project.sessions.sort((left, right) => (
      right.bytes - left.bytes
      || right.updatedAt - left.updatedAt
      || left.sessionId.localeCompare(right.sessionId)
    ))
  }

  return [...projects.values()].sort((left, right) => (
    right.totalBytes - left.totalBytes
    || right.lastActivityAt - left.lastActivityAt
    || left.projectName.localeCompare(right.projectName)
  ))
}
