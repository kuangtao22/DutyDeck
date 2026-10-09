import { join } from 'node:path'
import { getAgentWorkspace } from './agent-workspace-manager'
import { getConfigDir, resolveWorkspaceFilesDir } from './config-paths'
import { acquireWorkspaceWriteLease, getWorkspaceOperationBlockReason } from './workspace-operation-lock'
import { isWorkspaceSlug } from './workspace-slug'
import { createProjectKnowledgeService } from './project-knowledge/service'
import { isOrdinaryTopLevelAgentSession } from '@proma/shared'
import type { KnowledgeSnapshot } from '@proma/shared'
import type { ProjectKnowledgeIpcService } from './project-knowledge-ipc'
import type { ResolvedKnowledgeProject } from './project-knowledge/types'
import { getAgentSessionMeta, getPersistedAgentMessageReceipt, isAgentSessionDeleting, readPersistedAgentEvidence } from './agent-session-manager'
import { createProjectKnowledgeAgentMaintenance } from './project-knowledge-agent-maintenance'
import type { ProjectKnowledgeAgentMaintenance } from './project-knowledge-agent-maintenance'
import type { ProjectKnowledgeSources } from './project-knowledge-sources'
import { previewKnowledgeMemory } from './project-knowledge-memory-preview'

/** 每个数据根独立的服务实例，避免数据根切换后误用旧索引。 */
const services = new Map<string, ProjectKnowledgeRuntime>()
/** Canvas 依赖在 IPC 组合完成后注入，检索服务始终通过已授权业务服务读取。 */
let controlledSources: ProjectKnowledgeSources | undefined

/** 绑定由宿主持有的 Canvas/API 服务，不暴露可替换文件路径。 */
export function registerProjectKnowledgeSources(sources: ProjectKnowledgeSources): void {
  controlledSources = sources
}

/** 运行时公开已授权的读写端口，底层 store 仅供宿主内部调用。 */
interface ProjectKnowledgeRuntime extends ProjectKnowledgeIpcService {
  /** 扫描后台完成句柄。 */
  waitForScan(workspaceId: string): Promise<void>
  /** 当前 Agent 的受控写入端口，模型和 Skill 由当前回合负责。 */
  createAgentMaintenance(input: AgentKnowledgeMaintenanceInput): ProjectKnowledgeAgentMaintenance
  /** 退役旧独立模型队列，不丢弃已有知识与排除记录。 */
  retireLegacyMaintenance(workspaceId: string): Promise<void>
}

/** 固定当前用户回合及其动态权限，不允许模型指定会话身份。 */
interface AgentKnowledgeMaintenanceInput {
  sessionId: string
  userMessageId: string
  assertRunActive(): void
  canMutate(): boolean
}

/** 验证项目归属；返回指纹供异步 IPC 前后复核。 */
export function getProjectKnowledgeBinding(workspaceId: string): string {
  /** 仅使用权威工作区索引，拒绝调用方传入 slug 或任意路径。 */
  const workspace = getAgentWorkspace(workspaceId)
  if (!workspace || workspace.id !== workspaceId || !isWorkspaceSlug(workspace.slug)) throw new Error('项目不存在或知识库归属无效')
  return `${getConfigDir()}\0${workspace.id}\0${workspace.slug}\0${workspace.projectRootPath ?? resolveWorkspaceFilesDir(workspace.slug)}`
}

/** 创建或取得当前数据根的知识服务；此过程不扫描、不创建资料。 */
export function getProjectKnowledgeService(): ProjectKnowledgeRuntime {
  /** 数据根随配置迁移变化，不能在模块加载时固定。 */
  const configRoot = getConfigDir()
  const existing = services.get(configRoot)
  if (existing) return existing
  /** 底层服务每次操作均重新读取工作区绑定。 */
  const resolveProject = (workspaceId: string): ResolvedKnowledgeProject => {
      getProjectKnowledgeBinding(workspaceId)
      if (getConfigDir() !== configRoot) throw new Error('数据目录已变化，请重新打开知识库')
      const workspace = getAgentWorkspace(workspaceId)
      if (!workspace) throw new Error('项目不存在')
      return {
        projectId: workspace.id,
        projectRoot: workspace.projectRootPath ?? resolveWorkspaceFilesDir(workspace.slug),
        memoryRoot: join(configRoot, 'agent-workspaces', workspace.slug, 'memory'),
        cacheRoot: join(configRoot, 'knowledge-cache', workspace.id),
      }
    }
  const service = createProjectKnowledgeService({
    resolveProject,
    controlledSources: {
      list: async (projectId) => {
        getProjectKnowledgeBinding(projectId)
        return controlledSources?.list(projectId) ?? { sources: [], total: 0, truncated: false, skipped: 0 }
      },
      read: async (input) => {
        getProjectKnowledgeBinding(input.projectId)
        return controlledSources?.read(input) ?? { status: 'unavailable', content: '', truncated: false }
      },
    },
    assertWritable: (workspaceId) => {
      getProjectKnowledgeBinding(workspaceId)
      const reason = getWorkspaceOperationBlockReason(workspaceId)
      if (reason) throw new Error(reason)
    },
  })
  /** 每次扫描持有迁移租约直到后台任务结束，IPC 返回 running 不释放租约。 */
  const startScan = service.startScan.bind(service)
  service.startScan = async (workspaceId: string): Promise<KnowledgeSnapshot> => {
    /** 租约从初始化前开始持有；同步失败与后台完成都必须释放。 */
    const release = acquireWorkspaceWriteLease(workspaceId)
    try {
      const snapshot = await startScan(workspaceId)
      void service.waitForScan(workspaceId).catch(() => undefined).finally(release)
      return snapshot
    } catch (error) {
      release()
      throw error
    }
  }
  /** 所有 Agent 发布都持有迁移租约，证据校验由同一当前回合闭包提供。 */
  const createAgentMaintenance = (input: AgentKnowledgeMaintenanceInput): ProjectKnowledgeAgentMaintenance => {
    /** 只允许当前普通顶层会话，不接受调用方指定项目。 */
    const initial = getAgentSessionMeta(input.sessionId)
    if (!isOrdinaryTopLevelAgentSession(initial) || !initial.workspaceId) throw new Error('当前会话不能维护项目知识')
    const workspaceId = initial.workspaceId
    const binding = getProjectKnowledgeBinding(workspaceId)
    /** 每次读取及事务发布重新校验归属和运行代次。 */
    const assertCurrent = (): void => {
      input.assertRunActive()
      const current = getAgentSessionMeta(input.sessionId)
      if (getConfigDir() !== configRoot || isAgentSessionDeleting(input.sessionId)
        || !isOrdinaryTopLevelAgentSession(current) || current.archived
        || current.explorationParentSessionId !== undefined || current.workspaceId !== workspaceId
        || (current.toolMode ?? 'standard') !== 'standard'
        || getProjectKnowledgeBinding(workspaceId) !== binding) throw new Error('知识维护会话或项目归属已变化')
    }
    assertCurrent()
    return createProjectKnowledgeAgentMaintenance({
      workspaceId, sessionId: input.sessionId, userMessageId: input.userMessageId,
      store: service.store, resolveProject, readSource: service.read,
      assertCurrent, canMutate: input.canMutate,
      readUserEvidence: () => {
        assertCurrent()
        const receipt = getPersistedAgentMessageReceipt(input.sessionId, input.userMessageId)
        return receipt ? readPersistedAgentEvidence(input.sessionId, [receipt]).records
          .find((record) => record.uuid === input.userMessageId && record.role === 'user') : undefined
      },
      runWorkspaceWrite: async (effect) => {
        assertCurrent()
        const release = acquireWorkspaceWriteLease(workspaceId)
        try { return await effect() }
        finally { release() }
      },
      workflow: {
        getSnapshot: service.getSnapshot,
        proposePlan: service.proposePlan,
        saveOutline: service.saveOutline,
        writeDocument: service.writeDocument,
        copyAsset: service.copyAsset,
      },
    })
  }
  /** 所有用户写操作持有迁移租约直到完成，避免检查与写之间迁移。 */
  const mutate = async (workspaceId: string, operation: () => Promise<unknown>): Promise<KnowledgeSnapshot> => {
    const release = acquireWorkspaceWriteLease(workspaceId)
    try { await operation(); return await runtime.getSnapshot(workspaceId) }
    finally { release() }
  }
  const runtime: ProjectKnowledgeRuntime = {
    ...service,
    getSnapshot: async (workspaceId) => {
      const snapshot = await service.getSnapshot(workspaceId)
      /** 旧设置保留在磁盘作历史兼容，不能在新版显示为仍运行的后台服务。 */
      return { ...snapshot, pendingTurns: 0, maintenanceStatus: undefined,
        maintenance: { ...snapshot.maintenance, enabled: false, channelId: undefined, modelId: undefined } }
    },
    createAgentMaintenance,
    retireLegacyMaintenance: async (workspaceId) => {
      const project = resolveProject(workspaceId)
      const previous = service.store.readManifest(project)?.maintenance
      if (!previous || (!previous.settings.enabled && !previous.jobs.some((job) => job.status === 'running' || job.status === 'pending'))) return
      await mutate(workspaceId, () => service.store.transact(project, workspaceId, ({ manifest }) => {
        const state = manifest.maintenance ? structuredClone(manifest.maintenance) : undefined
        if (!state) return {}
        state.settings = { ...state.settings, enabled: false, generation: state.settings.generation + 1 }
        for (const job of state.jobs) if (job.status === 'pending' || job.status === 'running') {
          job.status = 'excluded'
          job.message = '知识提炼已迁移至当前 Agent 的 knowledge-maintenance Skill'
        }
        return { maintenance: state }
      }))
    },
    updateMaintenance: async () => { throw new Error('知识提炼由当前 Agent 调用 Skill 执行，无需独立模型设置') },
    retryMaintenance: async () => { throw new Error('请通过更新知识库在 Agent 中重新执行知识维护 Skill') },
    reviewEntry: (input) => mutate(input.workspaceId, () => service.reviewEntry(input)),
    confirmPlan: (input) => mutate(input.workspaceId, () => service.confirmPlan(input)),
    pauseWorkflow: (input) => mutate(input.workspaceId, () => service.pauseWorkflow(input)),
    organize: (workspaceId) => mutate(workspaceId, () => service.organize(workspaceId)),
    undo: (workspaceId, operationId) => mutate(workspaceId, () => service.undo(workspaceId, operationId)),
    excludeSession: async () => { throw new Error('当前知识提炼仅使用当前用户回合，不再扫描历史会话队列') },
    previewMemory: (workspaceId) => previewKnowledgeMemory(workspaceId, service),
  }
  services.set(configRoot, runtime)
  return runtime
}

/** 启动时仅退役已有旧队列，不重放历史会话或发起模型调用。 */
export async function recoverProjectKnowledge(workspaceId: string): Promise<void> {
  const service = getProjectKnowledgeService()
  if (!(await service.getSnapshot(workspaceId)).initialized) return
  await service.retireLegacyMaintenance(workspaceId)
}
