/**
 * 编排工厂的 IPC handler（四层契约的第 3 层）。
 *
 * 三条纪律：
 * - **只接应用自身窗口**（`isAuthorizedSender`），逐次 fresh-read 会话归属；
 * - **workspace 不由调用方声明**：一律通过 `requireSession` 反查，根目录再由主进程解析；
 * - **写操作前复核会话**（`assertCurrent`），避免等待期间的迟到结果落到新的所有权范围。
 *
 * 运行（`runScene`）是这里唯一长时间占用请求的方法：它在主进程里跑完整条链路
 * （可能几十秒），跑完才返回。渲染层因此用"运行中"状态遮住这段时间，
 * 而不是把 runner 搬到渲染层 —— 模型调用与凭据都只能在主进程里发生。
 */
import { CAPABILITY_FACTORY_CHANNELS, parseCapabilityFactoryCommand } from '@proma/shared'
import type { CapabilityEvaluation, CapabilityRun, CapabilitySceneDefinition } from '@proma/shared'
import type { CapabilityFactoryService } from './capability-factory-service'
import type { CapabilityFactoryRunOptions } from './capability-factory-run'

/** IPC 只需要发送方身份，不向业务层暴露 Electron 句柄。 */
export interface CapabilityFactoryIpcEvent {
  sender: {
    id: number
    /** 进度只发回这次 invoke 的 WebContents，不做全窗口广播。 */
    send(channel: string, payload: unknown): void
  }
}

/** handler 依赖；服务与根目录解析都由宿主注入，便于测试替身。 */
export interface CapabilityFactoryIpcDependencies {
  ipc: {
    handle(channel: string, listener: (event: CapabilityFactoryIpcEvent, input: unknown) => Promise<unknown>): void
    removeHandler(channel: string): void
  }
  isAuthorizedSender(event: CapabilityFactoryIpcEvent): boolean
  /** 按会话反查归属；不接受调用方传入的 workspaceId。 */
  requireSession(sessionId: string): { id: string; workspaceId: string }
  /** 由主进程按工作区解析存储根目录。 */
  resolveRootDir(workspaceId: string): string
  /** 取得该根目录对应的服务。 */
  getService(rootDir: string): CapabilityFactoryService
  /**
   * 执行一次运行。**模型端口在这一层接线**：它要读渠道、解密凭据、走代理，
   * 还要知道当前会话用的是哪个模型 —— 全是宿主事实，IPC 层不该自己猜。
   */
  runScene(request: {
    rootDir: string
    sessionId: string
    sceneId: string
    input: Record<string, unknown>
    options?: CapabilityFactoryRunOptions
    onProgress?: (run: CapabilityRun) => void
  }): Promise<CapabilityRun>
  /** 单步试跑：只跑一个带提示词的步骤（定义可由调用方临时覆盖）。 */
  runStep(request: {
    rootDir: string
    sessionId: string
    sceneId: string
    stepId: string
    input: Record<string, unknown>
    definition?: CapabilitySceneDefinition
    onProgress?: (run: CapabilityRun) => void
  }): Promise<CapabilityRun>
  /** 在系统文件管理器里显示某个导出产物；缺省表示该宿主不支持（界面隐藏入口）。 */
  revealDelivery?: (absolutePath: string) => void
  /** 跑一次评测（对数据集的每条用例跑一次整链）；由宿主接线到运行适配器。 */
  runEvaluation?(request: {
    rootDir: string
    sessionId: string
    sceneId: string
    datasetId: string
  }): Promise<CapabilityEvaluation>
}

/** 只向应用自身窗口注册编排工厂通道。 */
export function registerCapabilityFactoryIpc(
  dependencies: CapabilityFactoryIpcDependencies,
): { dispose(): void } {
  dependencies.ipc.handle(CAPABILITY_FACTORY_CHANNELS.INVOKE, async (event, value) => {
    if (!dependencies.isAuthorizedSender(event)) throw new Error('CAPABILITY_FACTORY_ACCESS_DENIED')
    const command = parseCapabilityFactoryCommand(value)
    const session = dependencies.requireSession(command.input.sessionId)
    const rootDir = dependencies.resolveRootDir(session.workspaceId)
    const service = dependencies.getService(rootDir)

    /** 等待结束后再次验证窗口与会话，禁止迟到结果进入新的所有权范围。 */
    const assertCurrent = (): void => {
      if (!dependencies.isAuthorizedSender(event)) throw new Error('CAPABILITY_FACTORY_ACCESS_DENIED')
      try {
        const current = dependencies.requireSession(command.input.sessionId)
        const currentRootDir = dependencies.resolveRootDir(current.workspaceId)
        if (current.id !== session.id || current.workspaceId !== session.workspaceId || currentRootDir !== rootDir) {
          throw new Error('CAPABILITY_FACTORY_ACCESS_DENIED')
        }
      } catch {
        throw new Error('CAPABILITY_FACTORY_ACCESS_DENIED')
      }
    }

    /** 只有发起方声明 requestId 时才开启进度回传，保持旧调用方为单次 invoke。 */
    const requestId = 'requestId' in command.input ? command.input.requestId : undefined
    const progress = requestId
      ? (run: CapabilityRun): void => {
          assertCurrent()
          event.sender.send(CAPABILITY_FACTORY_CHANNELS.PROGRESS, { requestId, run })
        }
      : undefined

    switch (command.method) {
      case 'listScenes': return service.listScenes()
      case 'getScene': return service.getScene(command.input.sceneId)
      case 'createScene': return service.createScene(command.input.name)
      case 'renameScene': {
        const result = service.renameScene(command.input.sceneId, command.input.name)
        assertCurrent()
        return result
      }
      case 'deleteScene': {
        const result = service.deleteScene(command.input.sceneId)
        assertCurrent()
        return result
      }
      case 'saveDraft': {
        const result = service.saveDraft(
          command.input.sceneId, command.input.definition, 'human', command.input.note,
          command.input.expectedState,
        )
        assertCurrent()
        return result
      }
      case 'discardDraft': return service.discardDraft(command.input.sceneId, command.input.expectedState)
      case 'adoptDraft': {
        const result = service.adoptDraft(command.input.sceneId, {
          ...(command.input.expectedVersion === undefined ? {} : { expectedVersion: command.input.expectedVersion }),
          ...(command.input.expectedDraftCreatedAt === undefined
            ? {} : { expectedDraftCreatedAt: command.input.expectedDraftCreatedAt }),
          ...(command.input.expectedDraftDefinition === undefined
            ? {} : { expectedDraftDefinition: command.input.expectedDraftDefinition }),
        })
        assertCurrent()
        return result
      }
      case 'listVersions': return service.listVersions(command.input.sceneId)
      case 'listStubs': return service.listStubs()
      case 'setStub': {
        const result = service.setStub(
          command.input.capabilityId, command.input.payload, command.input.note, command.input.source,
        )
        assertCurrent()
        return result
      }
      case 'deleteStub': {
        const result = service.deleteStub(command.input.capabilityId)
        assertCurrent()
        return result
      }
      case 'runScene': {
        const result = await dependencies.runScene({
          rootDir, sessionId: session.id, sceneId: command.input.sceneId, input: command.input.input,
          options: {
            ...(command.input.target === undefined ? {} : { target: command.input.target }),
            ...(command.input.expectedVersion === undefined ? {} : { expectedVersion: command.input.expectedVersion }),
            ...(command.input.expectedDraftCreatedAt === undefined
              ? {} : { expectedDraftCreatedAt: command.input.expectedDraftCreatedAt }),
            ...(command.input.expectedDraftDefinition === undefined
              ? {} : { expectedDraftDefinition: command.input.expectedDraftDefinition }),
            ...(command.input.comparisonId === undefined ? {} : { comparisonId: command.input.comparisonId }),
            ...(command.input.comparisonRole === undefined ? {} : { comparisonRole: command.input.comparisonRole }),
          },
          ...(progress ? { onProgress: progress } : {}),
        })
        assertCurrent()
        return result
      }
      case 'runStep': {
        const result = await dependencies.runStep({
          rootDir, sessionId: session.id, sceneId: command.input.sceneId, stepId: command.input.stepId,
          input: command.input.input,
          ...(command.input.definition === undefined ? {} : { definition: command.input.definition }),
          ...(progress ? { onProgress: progress } : {}),
        })
        assertCurrent()
        return result
      }
      case 'listRuns': return service.listRuns(command.input.sceneId, command.input.limit, command.input.kind)
      case 'listTasks': return service.listTasks(command.input.sceneId)
      case 'revealDelivery': {
        if (!dependencies.revealDelivery) return { revealed: false }
        /** 路径由主进程用根目录 + 已校验的文件名拼出来，不接受调用方传路径。 */
        const scenes = service.listScenes()
        const delivery = service.listDeliveries()
          .filter((item) => item.fileName === command.input.fileName)
          .filter((item) => scenes.some((scene) => scene.id === item.sceneId))
          .at(-1)
        if (!delivery?.filePath) return { revealed: false }
        dependencies.revealDelivery(delivery.filePath)
        return { revealed: true }
      }
      case 'listDatasets': return service.listDatasets()
      case 'createDataset': {
        const result = service.createDataset(command.input.name)
        assertCurrent()
        return result
      }
      case 'addCase': {
        const result = service.addCase(command.input.datasetId, command.input.input, {
          ...(command.input.name === undefined ? {} : { name: command.input.name }),
          ...(command.input.fromRunId === undefined ? {} : { fromRunId: command.input.fromRunId, source: 'regression' }),
        })
        assertCurrent()
        return result
      }
      case 'deleteCase': {
        const result = service.deleteCase(command.input.datasetId, command.input.caseId)
        assertCurrent()
        return result
      }
      case 'listEvaluations': return service.listEvaluations(command.input.sceneId, command.input.limit)
      case 'runEvaluation': {
        if (!dependencies.runEvaluation) throw new Error('CAPABILITY_FACTORY_EVALUATION_UNAVAILABLE')
        const result = await dependencies.runEvaluation({
          rootDir, sessionId: session.id, sceneId: command.input.sceneId, datasetId: command.input.datasetId,
        })
        assertCurrent()
        return result
      }
      case 'rollback': {
        const result = service.rollback(command.input.sceneId, command.input.targetVersion)
        assertCurrent()
        return result
      }
      case 'exportPackage': {
        // 导出是人工动作：走到这里说明是界面点出来的，来源固定记 'human'
        const result = service.exportPackage(command.input.sceneId, {
          packageVersion: command.input.packageVersion,
          fileName: command.input.fileName,
        })
        assertCurrent()
        return result
      }
      default: return service.listDeliveries()
    }
  })

  return {
    dispose(): void {
      dependencies.ipc.removeHandler(CAPABILITY_FACTORY_CHANNELS.INVOKE)
    },
  }
}
