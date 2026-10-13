import { DEFAULT_ROOT_MIGRATION_IPC_CHANNELS } from '@proma/shared'

/** 默认根迁移 bridge 使用的最小 IPC 依赖。 */
export interface DefaultRootMigrationPreloadIpc {
  /** 调用主进程一次性确认 handler。 */
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}
/** 默认数据根确认窗口只允许回传一次用户决定。 */
export interface DefaultRootMigrationPreloadApi {
  /** 回传用户是否确认把旧数据根移动到新目录。 */
  choose: (confirmed: boolean) => Promise<void>
}

/** 创建默认根迁移确认窗口的最小 bridge。 */
export function createDefaultRootMigrationPreloadApi(
  ipc: DefaultRootMigrationPreloadIpc,
): DefaultRootMigrationPreloadApi {
  return {
    choose: (confirmed) => ipc.invoke(
      DEFAULT_ROOT_MIGRATION_IPC_CHANNELS.CHOOSE,
      confirmed,
    ) as Promise<void>,
  }
}
