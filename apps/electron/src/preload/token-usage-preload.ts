/** Token 统计桥只提供固定 IPC，无任意文件写入能力。 */
import { TOKEN_USAGE_IPC } from '@proma/shared'
import type { TokenUsageAPI, TokenUsageSnapshot, TokenUsageTaskDetail } from '@proma/shared'

/** 创建可注入的 preload API，参数仍由主进程做完整验证。 */
export function createTokenUsagePreload(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>): TokenUsageAPI {
  return {
    getTokenUsage: query => invoke(TOKEN_USAGE_IPC.QUERY, query) as Promise<TokenUsageSnapshot>,
    getTokenUsageTask: (taskId, query) => invoke(TOKEN_USAGE_IPC.TASK, taskId, query) as Promise<TokenUsageTaskDetail | null>,
    exportTokenUsage: query => invoke(TOKEN_USAGE_IPC.EXPORT, query) as Promise<{ saved: boolean; count: number }>,
  }
}
