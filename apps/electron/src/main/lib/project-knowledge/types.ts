import type { KnowledgeEntry, KnowledgeOperationSummary, KnowledgeScanProgress, KnowledgeWorkflow } from '@proma/shared'
import type { KnowledgeMaintenanceRecord } from '../project-knowledge-maintenance-types'
import type { ProjectKnowledgeSources } from '../project-knowledge-sources'

/** 运行时解析出的可信项目边界。 */
export interface ResolvedKnowledgeProject {
  projectId: string
  projectRoot: string
  memoryRoot: string
  cacheRoot: string
}

/** 项目知识服务的宿主依赖。 */
export interface ProjectKnowledgeServiceDependencies {
  /** 每次操作重新解析当前工作区，避免复用迁移前路径。 */
  resolveProject: (workspaceId: string) => ResolvedKnowledgeProject
  /** 在正式发布前复核工作区仍可写。 */
  assertWritable?: (workspaceId: string) => void | Promise<void>
  /** 可注入时钟用于稳定测试。 */
  now?: () => number
  /** 仅通过现有服务纯读 API 暴露的 Canvas/API 业务来源。 */
  controlledSources?: ProjectKnowledgeSources
}

/** 权威清单只引用不可变条目版本。 */
export interface KnowledgeManifest {
  /** 分组、大纲及暂停状态与条目一起原子发布。 */
  workflow?: KnowledgeWorkflow
  schemaVersion: 1
  projectId: string
  revision: number
  /** 当前可重建索引对应的条目水位；纯状态事务不推进。 */
  indexRevision?: number
  entries: Record<string, string>
  updatedAt: number
  /** 最近一次已由 manifest 接纳的资料库文件事务身份。 */
  vaultCommitId?: string
  /** 持续维护授权、队列与代次随清单原子发布。 */
  maintenance?: KnowledgeMaintenanceRecord
  /** 最近的受管内容操作，保留撤销所需版本基线。 */
  operations?: KnowledgeOperationRecord[]
  /** 旧条目到一个或多个当前条目的稳定重定向。 */
  redirects?: Record<string, string[]>
  /** 已拒绝来源的稳定身份，后续提炼不得复活。 */
  excludedSources?: string[]
}

/** 一次提交要发布的不可变条目。 */
export interface KnowledgeEntryCommit {
  entry: KnowledgeEntry
  /** 仅受管来源拥有的不可变 Markdown 正文。 */
  content?: string
}

/** 操作前后固定的条目版本；null 表示操作前不存在。 */
export interface KnowledgeOperationVersion {
  entryId: string
  revision: string | null
}

/** 受管整理操作的完整撤销记录。 */
export interface KnowledgeOperationRecord extends KnowledgeOperationSummary {
  before: KnowledgeOperationVersion[]
  after: KnowledgeOperationVersion[]
  /** 操作前相关旧 ID 的重定向。 */
  redirectsBefore: Record<string, string[]>
  /** 操作后相关旧 ID 的重定向。 */
  redirectsAfter: Record<string, string[]>
  /** 被撤销操作的 ID，仅 kind=undo 时存在。 */
  undoOf?: string
}

/** 锁内事务 callback 可读取的权威状态。 */
export interface KnowledgeTransactionCurrent {
  manifest: KnowledgeManifest
  entries: KnowledgeEntry[]
}

/** 锁内事务 callback 返回的完整更新；省略字段保持当前值。 */
export interface KnowledgeTransactionUpdate {
  /** 两步流程的下一版状态；省略时保留原值。 */
  workflow?: KnowledgeWorkflow
  commits?: KnowledgeEntryCommit[]
  maintenance?: KnowledgeMaintenanceRecord
  operations?: KnowledgeOperationRecord[]
  redirects?: Record<string, string[]>
  excludedSources?: string[]
  /** 与资料库恢复日志精确配对的文件事务身份。 */
  vaultCommitId?: string
  /** manifest 已原子发布后、释放知识锁前执行的同步收尾。 */
  onCommitted?: () => void
  /** callback 后任一发布步骤失败时、释放知识锁前执行的同步回滚。 */
  onAborted?: () => void
}

/** 可重建索引中的单条有界正文。 */
export interface KnowledgeIndexRecord {
  entryId: string
  entryRevision: string
  text: string
}

/** 可重建本地索引文件。 */
export interface KnowledgeIndexCache {
  schemaVersion: 1
  projectId: string
  manifestRevision: number
  records: Record<string, KnowledgeIndexRecord>
}

/** 服务进程内可观察的扫描任务。 */
export interface KnowledgeScanTask {
  cancelled: boolean
  progress: KnowledgeScanProgress
  promise: Promise<void>
}

/** Store 提供给 1B/1C 复用的版本发布边界。 */
export interface ProjectKnowledgeStore {
  readManifest: (project: ResolvedKnowledgeProject) => KnowledgeManifest | null
  initialize: (project: ResolvedKnowledgeProject, workspaceId?: string) => Promise<KnowledgeManifest>
  readEntries: (project: ResolvedKnowledgeProject, manifest: KnowledgeManifest) => KnowledgeEntry[]
  readEntry: (project: ResolvedKnowledgeProject, manifest: KnowledgeManifest, entryId: string) => KnowledgeEntry
  readContent: (project: ResolvedKnowledgeProject, manifest: KnowledgeManifest, entryId: string) => string | null
  commitEntries: (
    project: ResolvedKnowledgeProject,
    expectedRevision: number,
    commits: KnowledgeEntryCommit[],
    workspaceId?: string,
  ) => Promise<KnowledgeManifest>
  transact: (
    project: ResolvedKnowledgeProject,
    workspaceId: string,
    update: (current: KnowledgeTransactionCurrent) => KnowledgeTransactionUpdate,
  ) => Promise<KnowledgeManifest>
  readIndex: (project: ResolvedKnowledgeProject, manifestRevision: number) => KnowledgeIndexCache | null
  writeIndex: (project: ResolvedKnowledgeProject, cache: KnowledgeIndexCache) => void
}
