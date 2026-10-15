import { describe, expect, test } from 'bun:test'
import { DEFAULT_ROOT_MIGRATION_IPC_CHANNELS } from '@proma/shared'
import { createDefaultRootMigrationPreloadApi, type DefaultRootMigrationPreloadIpc } from './default-root-migration-preload'

describe('默认数据根迁移 preload API', () => {
  test('确认结果只通过固定通道传给主进程', async () => {
    const calls: Array<{ channel: string; args: unknown[] }> = []
    const ipc: DefaultRootMigrationPreloadIpc = {
      invoke: async (channel, ...args) => {
        calls.push({ channel, args })
        return undefined
      },
    }
    const api = createDefaultRootMigrationPreloadApi(ipc)

    await api.choose(true)
    await api.choose(false)
    await api.choose(null)

    expect(calls).toEqual([
      { channel: DEFAULT_ROOT_MIGRATION_IPC_CHANNELS.CHOOSE, args: [true] },
      { channel: DEFAULT_ROOT_MIGRATION_IPC_CHANNELS.CHOOSE, args: [false] },
      { channel: DEFAULT_ROOT_MIGRATION_IPC_CHANNELS.CHOOSE, args: [null] },
    ])
  })
})
