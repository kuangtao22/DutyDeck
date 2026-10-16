import type { CanvasSessionChangeEvent, CanvasSessionMeta, CanvasTarget, DeleteCanvasSessionInput, UpdateCanvasSessionInput } from '@proma/shared'
import type { WorkspaceOperationGuard } from '../workspace-operation-guard'
import type { CanvasSessionIdleCheck } from './canvas-session-idle-guard'
import type { CanvasSessionStore } from './canvas-session-store'

/** UI 与 Agent 共用的画布生命周期边界。 */
export interface CanvasSessionManagement {
  /** 更新标题或归档状态；在写守卫内复核调用方授权。 */
  update: (input: UpdateCanvasSessionInput, assertAuthorized?: () => void) => CanvasSessionMeta
  /** 删除整张画布并清理关联和内部会话；返回删除前元数据。 */
  delete: (input: DeleteCanvasSessionInput, assertAuthorized?: () => void) => Promise<CanvasSessionMeta>
}

/** 生命周期服务复用唯一 Store、写守卫、运行检查与广播。 */
export interface CanvasSessionManagementDependencies {
  guard: Pick<WorkspaceOperationGuard, 'runWorkspaceWrite'>
  sessions: Pick<CanvasSessionStore, 'update' | 'delete'>
  getProjectReadOnlyReason: (projectId: string) => string | undefined
  broadcast: (event: CanvasSessionChangeEvent) => void
  /** 与节点写入共用同一个画布事务队列，避免在提交中删除。 */
  runExclusive?: <T>(target: CanvasTarget, effect: () => Promise<T>) => Promise<T>
  assertCanvasIdle?: (projectId: string, canvasId: string) => void | CanvasSessionIdleCheck | Promise<void | CanvasSessionIdleCheck>
  cleanupBindings?: (projectId: string, canvasId: string) => void
  cleanupInternalSessions?: (projectId: string, canvasId: string) => Promise<void>
}

/** 创建无独立持久化状态的共享服务，避免 IPC 和工具各自维护删除流程。 */
export function createCanvasSessionManagement(dependencies: CanvasSessionManagementDependencies): CanvasSessionManagement {
  /** 每次在副作用前 fresh 校验项目可写性和宿主授权。 */
  const assertWritable = (projectId: string, assertAuthorized?: () => void): void => {
    assertAuthorized?.()
    /** 项目离线、迁移或撤权必须立即阻断写入。 */
    const reason = dependencies.getProjectReadOnlyReason(projectId)
    if (reason) throw new Error(reason)
  }
  return {
    update: (input, assertAuthorized) => {
      assertWritable(input.projectId, assertAuthorized)
      /** 更新只有在项目写 lease 内成功原子提交后才可广播。 */
      const session = dependencies.guard.runWorkspaceWrite(input.projectId, () => {
        assertWritable(input.projectId, assertAuthorized)
        return dependencies.sessions.update(input)
      })
      dependencies.broadcast({ projectId: input.projectId, canvasId: session.id, cause: 'updated' })
      return session
    },
    delete: async (input, assertAuthorized) => {
      assertWritable(input.projectId, assertAuthorized)
      /** 必须先取得画布串行槽，再取得 workspace 写 lease。 */
      const remove = (): Promise<CanvasSessionMeta> => dependencies.guard.runWorkspaceWrite(input.projectId, async () => {
        assertWritable(input.projectId, assertAuthorized)
        /** 异步读取结束后保留观察者，直到最终同步复查及索引删除完成。 */
        const idleCheck = await dependencies.assertCanvasIdle?.(input.projectId, input.canvasId)
        /** 最终检查与删除之间无 await；撤权异常也必须释放订阅。 */
        let session: CanvasSessionMeta
        try {
          assertWritable(input.projectId, assertAuthorized)
          if (idleCheck) idleCheck.assertIdle()
          session = dependencies.sessions.delete(input)
        } finally { if (idleCheck) idleCheck.dispose() }
        try {
          dependencies.cleanupBindings?.(input.projectId, input.canvasId)
        } catch {
          console.error('[CanvasSessionManagement] Canvas 关联清理失败')
        }
        await dependencies.cleanupInternalSessions?.(input.projectId, input.canvasId)
        dependencies.broadcast({ projectId: input.projectId, canvasId: session.id, cause: 'deleted' })
        return session
      })
      return dependencies.runExclusive
        ? dependencies.runExclusive({ projectId: input.projectId, canvasId: input.canvasId }, remove)
        : remove()
    },
  }
}
