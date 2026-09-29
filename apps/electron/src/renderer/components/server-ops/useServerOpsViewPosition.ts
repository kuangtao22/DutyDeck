import * as React from 'react'
import { useAtom } from 'jotai'
import {
  DEFAULT_SERVER_OPS_VIEW_POSITION,
  selectedServerOpsConnectionIdAtom,
  selectedServerOpsProjectIdAtom,
  serverOpsViewPositionsAtom,
  updateServerOpsViewPosition,
} from '@/atoms/server-ops-atoms'
import type { ServerOpsViewPosition } from '@/atoms/server-ops-atoms'

/** 一个会话视图的位置与更新动作；项目、连接和区段必须作为同一快照恢复。 */
export interface ServerOpsViewPositionController extends ServerOpsViewPosition {
  setProjectId: (projectId: string | null) => void
  setConnectionId: (connectionId: string | null) => void
  update: (patch: Partial<ServerOpsViewPosition>) => void
}

/**
 * 按 viewScope 保存运维工作区位置。
 *
 * @param viewScope 会话与 Pane 的稳定标识
 * @returns 当前 scope 的完整位置和更新动作
 */
export function useServerOpsViewPosition(viewScope: string): ServerOpsViewPositionController {
  /** 持久选择只作为新 scope 的默认值；已有 scope 永远读取自己的运行期快照。 */
  const [defaultProjectId, setDefaultProjectId] = useAtom(selectedServerOpsProjectIdAtom)
  const [defaultConnectionId, setDefaultConnectionId] = useAtom(selectedServerOpsConnectionIdAtom)
  const [positions, setPositions] = useAtom(serverOpsViewPositionsAtom)
  const saved = positions.get(viewScope)
  const position = saved ?? {
    ...DEFAULT_SERVER_OPS_VIEW_POSITION,
    projectId: defaultProjectId,
    connectionId: defaultConnectionId,
  }

  /** 合并写入当前 scope；相同值由纯函数保持 Map 引用不变。 */
  const update = React.useCallback((patch: Partial<ServerOpsViewPosition>): void => {
    setPositions((current) => updateServerOpsViewPosition(current, viewScope, patch))
  }, [setPositions, viewScope])

  /** 首次真实挂载即冻结默认值，后续会话选择不会污染本 scope。 */
  React.useEffect(() => {
    setPositions((current) => current.has(viewScope) ? current : updateServerOpsViewPosition(current, viewScope, {
      ...DEFAULT_SERVER_OPS_VIEW_POSITION,
      projectId: defaultProjectId,
      connectionId: defaultConnectionId,
    }))
  }, [defaultConnectionId, defaultProjectId, setPositions, viewScope])

  /** 项目选择既更新当前 scope，也成为未来新 scope 的默认。 */
  const setProjectId = React.useCallback((projectId: string | null): void => {
    setDefaultProjectId(projectId)
    update({ projectId })
  }, [setDefaultProjectId, update])

  /** 连接选择采用与项目相同的隔离规则。 */
  const setConnectionId = React.useCallback((connectionId: string | null): void => {
    setDefaultConnectionId(connectionId)
    update({ connectionId })
  }, [setDefaultConnectionId, update])

  return React.useMemo(() => ({ ...position, setProjectId, setConnectionId, update }), [position, setProjectId, setConnectionId, update])
}
