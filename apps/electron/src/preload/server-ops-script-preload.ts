import {
  SERVER_OPS_SCRIPT_CHANNELS,
  SERVER_OPS_SCRIPT_DRAFT_CHANNELS,
  parseServerOpsScriptListInput,
  parseServerOpsScriptListResult,
  parseServerOpsScriptSaveInput,
  parseServerOpsScriptSaveResult,
  parseServerOpsScriptDeleteInput,
  parseServerOpsScriptDeleteResult,
  parseServerOpsScriptRunInput,
  parseServerOpsScriptRun,
  parseServerOpsScriptCancelRunInput,
  parseServerOpsScriptRunListInput,
  parseServerOpsScriptRunListResult,
  parseServerOpsScriptDraftSession,
  parseServerOpsScriptDraftDismiss,
  parseServerOpsScriptDraftListResult,
} from '@proma/shared'
import type {
  ServerOpsScriptListInput,
  ServerOpsScriptListResult,
  ServerOpsScriptSaveResult,
  ServerOpsScriptDeleteResult,
  ServerOpsScriptRunInput,
  ServerOpsScriptRun,
  ServerOpsScriptCancelRunInput,
  ServerOpsScriptRunListInput,
  ServerOpsScriptRunListResult,
  ServerOpsScriptDraftListResult,
} from '@proma/shared'

/** 脚本 preload 调用主进程所需的最小接口。 */
export type ServerOpsScriptInvoke = (channel: string, input: unknown) => Promise<unknown>

/** 订阅主进程草稿变更事件的薄封装；返回解绑函数。 */
export type ServerOpsScriptSubscribe = (channel: string, listener: (input: unknown) => void) => () => void

/**
 * Renderer 可使用的脚本库严格桥接。
 *
 * 运行入口只暴露"已确认"的调用形态：调用方必须显式传 `confirmed: true`，
 * 主进程还会再复核窗口所有权；Agent 侧没有这条通道。
 */
export interface ServerOpsScriptPreload {
  listServerOpsScripts(input: ServerOpsScriptListInput): Promise<ServerOpsScriptListResult>
  saveServerOpsScript(input: unknown): Promise<ServerOpsScriptSaveResult>
  deleteServerOpsScript(input: { scriptId: string }): Promise<ServerOpsScriptDeleteResult>
  runServerOpsScript(input: ServerOpsScriptRunInput): Promise<ServerOpsScriptRun>
  cancelServerOpsScriptRun(input: ServerOpsScriptCancelRunInput): Promise<void>
  listServerOpsScriptRuns(input: ServerOpsScriptRunListInput): Promise<ServerOpsScriptRunListResult>
  /** 列出当前会话收到的 Agent 脚本草稿。 */
  listServerOpsScriptDrafts(sessionId: string): Promise<ServerOpsScriptDraftListResult>
  /** 忽略一条草稿；不会删除已保存的脚本。 */
  dismissServerOpsScriptDraft(input: { sessionId: string; id: string }): Promise<void>
  onServerOpsScriptDraftChanged(listener: (input: unknown) => void): () => void
}

/** 组合脚本 API，并在 IPC 两侧都使用 exact-key parser。 */
export function createServerOpsScriptPreload(invoke: ServerOpsScriptInvoke, subscribe?: ServerOpsScriptSubscribe): ServerOpsScriptPreload {
  return {
    listServerOpsScripts: async (input) => parseServerOpsScriptListResult(
      await invoke(SERVER_OPS_SCRIPT_CHANNELS.LIST, parseServerOpsScriptListInput(input)),
    ),
    saveServerOpsScript: async (input) => parseServerOpsScriptSaveResult(
      await invoke(SERVER_OPS_SCRIPT_CHANNELS.SAVE, parseServerOpsScriptSaveInput(input)),
    ),
    deleteServerOpsScript: async (input) => parseServerOpsScriptDeleteResult(
      await invoke(SERVER_OPS_SCRIPT_CHANNELS.DELETE, parseServerOpsScriptDeleteInput(input)),
    ),
    runServerOpsScript: async (input) => parseServerOpsScriptRun(
      await invoke(SERVER_OPS_SCRIPT_CHANNELS.RUN, parseServerOpsScriptRunInput(input)),
    ),
    cancelServerOpsScriptRun: async (input) => {
      /** 取消只接受空回执，携带结果说明协议被破坏。 */
      const result = await invoke(SERVER_OPS_SCRIPT_CHANNELS.CANCEL_RUN, parseServerOpsScriptCancelRunInput(input))
      if (result !== undefined) throw new Error('SERVER_OPS_SCRIPT_CANCEL_RESULT_INVALID')
    },
    listServerOpsScriptRuns: async (input) => parseServerOpsScriptRunListResult(
      await invoke(SERVER_OPS_SCRIPT_CHANNELS.LIST_RUNS, parseServerOpsScriptRunListInput(input)),
    ),
    listServerOpsScriptDrafts: async (sessionId) => parseServerOpsScriptDraftListResult(
      await invoke(SERVER_OPS_SCRIPT_DRAFT_CHANNELS.LIST, parseServerOpsScriptDraftSession(sessionId)),
    ),
    dismissServerOpsScriptDraft: async (input) => {
      const result = await invoke(SERVER_OPS_SCRIPT_DRAFT_CHANNELS.DISMISS, parseServerOpsScriptDraftDismiss(input))
      if (result !== undefined) throw new Error('SERVER_OPS_SCRIPT_DRAFT_DISMISS_RESULT_INVALID')
    },
    /** 缺少订阅能力时返回空解绑函数，避免界面在旧 preload 上崩溃。 */
    onServerOpsScriptDraftChanged: (listener) => subscribe?.(SERVER_OPS_SCRIPT_DRAFT_CHANNELS.CHANGED, listener) ?? (() => undefined),
  }
}
