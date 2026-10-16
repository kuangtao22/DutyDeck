import {
  SERVER_OPS_DEPLOYMENT_CHANNELS,
  parseServerOpsDeploymentCheck,
  parseServerOpsDeploymentCheckInput,
  parseServerOpsDeploymentListInput,
  parseServerOpsDeploymentRuns,
  parseServerOpsDeploymentTarget,
  parseServerOpsDeploymentTargetSaveInput,
  parseServerOpsDeploymentTargets,
} from '@proma/shared'
import type {
  ServerOpsDeploymentCheck,
  ServerOpsDeploymentCheckInput,
  ServerOpsDeploymentListInput,
  ServerOpsDeploymentRun,
  ServerOpsDeploymentTarget,
  ServerOpsDeploymentTargetSaveInput,
} from '@proma/shared'

/** 部署 IPC invoke 的最小注入边界。 */
export type ServerOpsDeploymentInvoke = (channel: string, input?: unknown) => Promise<unknown>

/** Renderer 可用的部署只读与目标配置 bridge。 */
export interface ServerOpsDeploymentPreload {
  listServerOpsDeploymentTargets: (input: ServerOpsDeploymentListInput) => Promise<ServerOpsDeploymentTarget[]>
  saveServerOpsDeploymentTarget: (input: ServerOpsDeploymentTargetSaveInput) => Promise<ServerOpsDeploymentTarget>
  checkServerOpsDeploymentTarget: (input: ServerOpsDeploymentCheckInput) => Promise<ServerOpsDeploymentCheck>
  listServerOpsDeploymentRuns: (input: ServerOpsDeploymentListInput) => Promise<ServerOpsDeploymentRun[]>
}

/** 在 preload 两侧校验输入输出，阻断 renderer 伪造或污染部署事实。 */
export function createServerOpsDeploymentPreload(invoke: ServerOpsDeploymentInvoke): ServerOpsDeploymentPreload {
  return {
    listServerOpsDeploymentTargets: async (input) => parseServerOpsDeploymentTargets(
      await invoke(SERVER_OPS_DEPLOYMENT_CHANNELS.LIST_TARGETS, parseServerOpsDeploymentListInput(input)),
    ),
    saveServerOpsDeploymentTarget: async (input) => parseServerOpsDeploymentTarget(
      await invoke(SERVER_OPS_DEPLOYMENT_CHANNELS.SAVE_TARGET, parseServerOpsDeploymentTargetSaveInput(input)),
    ),
    checkServerOpsDeploymentTarget: async (input) => parseServerOpsDeploymentCheck(
      await invoke(SERVER_OPS_DEPLOYMENT_CHANNELS.CHECK_TARGET, parseServerOpsDeploymentCheckInput(input)),
    ),
    listServerOpsDeploymentRuns: async (input) => parseServerOpsDeploymentRuns(
      await invoke(SERVER_OPS_DEPLOYMENT_CHANNELS.LIST_RUNS, parseServerOpsDeploymentListInput(input)),
    ),
  }
}
