import { INTERACTION_DESIGN_READ_METHODS, parseInteractionDesignCommand } from '@proma/shared'
import type { InteractionDesignChanged, InteractionDesignInputs, InteractionDesignMethod, InteractionDesignResults } from '@proma/shared'

/** 身份解析后的唯一模块执行入口，UI 与 Agent 共享。 */
export interface InteractionDesignExecutor {
  /** 当前绑定的项目身份，仅由主进程赋值。 */
  workspaceId: string
  /** 复核当前会话/根目录没有漂移。 */
  assertCurrent(): void
  /** 执行具有关联返回类型的模块命令。 */
  execute<M extends InteractionDesignMethod>(method: M, input: InteractionDesignInputs[M], signal?: AbortSignal): Promise<InteractionDesignResults[M]>
}

/** 业务服务窄接口，便于隔离文件存储与权限测试。 */
export interface InteractionDesignCommandService {
  /** 执行已经通过宿主归属验证的命令。 */
  invoke<M extends InteractionDesignMethod>(method: M, input: InteractionDesignInputs[M]): Promise<InteractionDesignResults[M]>
}

/** 授权事实与文件服务由生产宿主注入，renderer 不可选项目路径。 */
export interface InteractionDesignAccessDependencies {
  /** 获取当前普通会话，已归档或内部会话由宿主拒绝。 */
  resolveSession(sessionId: string): { workspaceId: string; projectRoot: string }
  /** 在每次新请求和异步返回后检查调用者仍有效。 */
  assertCaller?(): void
  /** 返回本次执行权限；Agent 计划模式禁止写，手工 UI 保持既有权限。 */
  canWrite?(): boolean
  /** 租约防止异步文件写期间迁移或删除项目。 */
  acquireWriteLease(workspaceId: string): () => void
  /** 为固定根构建服务，并在落盘前调用 assertCurrent。 */
  createService(context: { workspaceId: string; projectRoot: string; assertCurrent(): void }): InteractionDesignCommandService
  /** 轻量失效事件，不附带任何页面正文。 */
  onChanged?(event: InteractionDesignChanged): void
}

/**
 * 固定一次 IPC/Agent 运行的项目归属，防迟到操作写到新项目。
 * @param sessionId 可信入口绑定的普通会话。
 * @param dependencies 主进程身份、租约和文件服务。
 * @returns 校验身份并执行命令的窄接口。
 */
export function createInteractionDesignAccess(sessionId: string, dependencies: InteractionDesignAccessDependencies): InteractionDesignExecutor {
  dependencies.assertCaller?.()
  const initial = dependencies.resolveSession(sessionId)
  const assertCurrent = (): void => {
    dependencies.assertCaller?.()
    const current = dependencies.resolveSession(sessionId)
    if (current.workspaceId !== initial.workspaceId || current.projectRoot !== initial.projectRoot) throw new Error('INTERACTION_DESIGN_ACCESS_CHANGED: 项目归属或目录已变化，请重新打开原型')
  }
  return {
    workspaceId: initial.workspaceId,
    assertCurrent,
    async execute<M extends InteractionDesignMethod>(method: M, input: InteractionDesignInputs[M], signal?: AbortSignal): Promise<InteractionDesignResults[M]> {
      /** 独立工具调用可比整轮更早被取消；在每次读取返回及提交前重新检查。 */
      const assertInvocation = (): void => {
        assertCurrent()
        if (signal?.aborted) throw new Error('INTERACTION_DESIGN_ABORTED: 本次工具调用已取消')
      }
      assertInvocation()
      if (input.sessionId !== sessionId) throw new Error('INTERACTION_DESIGN_ACCESS_DENIED: 会话身份不匹配')
      const command = parseInteractionDesignCommand({ method, input })
      const writes = !INTERACTION_DESIGN_READ_METHODS.includes(method)
      if (writes && dependencies.canWrite?.() === false) throw new Error('INTERACTION_DESIGN_READ_ONLY: 计划模式不能修改原型')
      const release = writes ? dependencies.acquireWriteLease(initial.workspaceId) : undefined
      try {
        const service = dependencies.createService({ ...initial, assertCurrent: () => {
          assertInvocation()
          if (writes && dependencies.canWrite?.() === false) throw new Error('INTERACTION_DESIGN_READ_ONLY: 写入权限已变更')
        } })
        const result = await service.invoke(method, command.input as InteractionDesignInputs[M])
        assertInvocation()
        if (writes) dependencies.onChanged?.({ workspaceId: initial.workspaceId, ...('prototypeId' in command.input ? { prototypeId: command.input.prototypeId } : {}) })
        return result
      } finally { release?.() }
    },
  }
}
