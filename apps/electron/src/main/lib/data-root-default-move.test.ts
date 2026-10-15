import { afterEach, describe, expect, test } from 'bun:test'
import { lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DataRootLocator } from './data-root-locator'
import { handleDefaultDataRootMove, requestDefaultDataRootMove } from './data-root-default-move'

const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function harness(): { home: string; locator: DataRootLocator } {
  const home = mkdtempSync(join(tmpdir(), 'dutydeck-default-move-'))
  homes.push(home)
  return { home, locator: new DataRootLocator({ homeDir: home }) }
}

function options(confirmMigration: (legacyRoot: string, targetRoot: string) => Promise<boolean | null>) {
  return {
    acquireMigrationGuard: async () => ({ release: () => undefined }),
    hasOtherActiveLease: async () => false,
    confirmMigration,
  }
}

describe('默认数据根移动', () => {
  test('旧根存在且新根不存在时确认后直接移动目录，不复制数据', async () => {
    const { home, locator } = harness()
    const legacyRoot = join(home, '.proma')
    const targetRoot = join(home, '.DutyDeck')
    mkdirSync(legacyRoot)
    writeFileSync(join(legacyRoot, 'settings.json'), JSON.stringify({ themeMode: 'dark' }))
    const before = lstatSync(legacyRoot)

    const result = await handleDefaultDataRootMove(locator, options(async () => true))

    expect(result.status).toBe('moved')
    expect(lstatSync(targetRoot).ino).toBe(before.ino)
    expect(() => lstatSync(legacyRoot)).toThrow()
    expect(locator.inspect().state.activeRoot).toBe(targetRoot)
    expect(locator.inspect().locatorFile?.previousRoot).toBeUndefined()
  })

  test('新根为空目录时允许确认迁移并替换空目录', async () => {
    const { home, locator } = harness()
    const legacyRoot = join(home, '.proma')
    mkdirSync(legacyRoot)
    writeFileSync(join(legacyRoot, 'settings.json'), JSON.stringify({ themeMode: 'dark' }))
    mkdirSync(join(home, '.DutyDeck'))

    const result = await handleDefaultDataRootMove(locator, options(async () => true))

    expect(result.status).toBe('moved')
    expect(lstatSync(join(home, '.DutyDeck', 'settings.json')).isFile()).toBe(true)
  })

  test('新根已有内容时跳过检测且不弹窗', async () => {
    const { home, locator } = harness()
    mkdirSync(join(home, '.proma'))
    writeFileSync(join(home, '.proma', 'settings.json'), JSON.stringify({ themeMode: 'dark' }))
    mkdirSync(join(home, '.DutyDeck'))
    writeFileSync(join(home, '.DutyDeck', 'user-owned.json'), '{}')
    let prompted = false

    const result = await handleDefaultDataRootMove(locator, options(async () => {
      prompted = true
      return true
    }))

    expect(result.status).toBe('not-needed')
    expect(prompted).toBe(false)
  })

  test('用户拒绝后继续使用旧根并记住选择', async () => {
    const { home, locator } = harness()
    const legacyRoot = join(home, '.proma')
    mkdirSync(legacyRoot)
    writeFileSync(join(legacyRoot, 'settings.json'), JSON.stringify({ themeMode: 'dark' }))

    const result = await handleDefaultDataRootMove(locator, options(async () => false))

    expect(result.status).toBe('declined')
    expect(locator.inspect().state.activeRoot).toBe(legacyRoot)
    expect(locator.inspect().locatorFile?.defaultMigrationDismissed).toBe(true)
  })

  test('重命名后 locator 尚未提交时下次启动恢复到新根', async () => {
    const { home, locator } = harness()
    const legacyRoot = join(home, '.proma')
    const targetRoot = join(home, '.DutyDeck')
    mkdirSync(legacyRoot)
    writeFileSync(join(legacyRoot, 'settings.json'), JSON.stringify({ themeMode: 'dark' }))
    locator.write({ version: 1, activeRoot: legacyRoot })
    requestDefaultDataRootMove(locator)
    renameSync(legacyRoot, targetRoot)

    const result = await handleDefaultDataRootMove(locator, options(async () => {
      throw new Error('恢复路径不应弹窗')
    }))

    expect(result.status).toBe('recovered')
    expect(locator.inspect().state.activeRoot).toBe(targetRoot)
  })
})

 test('Given 临时关闭确认 When 检测 Then 不持久拒绝并继续旧根', async () => {
   const { home, locator } = harness()
   const legacyRoot = join(home, '.proma')
   mkdirSync(legacyRoot)
   writeFileSync(join(legacyRoot, 'settings.json'), JSON.stringify({ themeMode: 'dark' }))
   const result = await handleDefaultDataRootMove(locator, options(async () => null))
   expect(result.status).toBe('cancelled')
   expect(locator.inspect().locatorFile?.defaultMigrationDismissed).toBeUndefined()
   expect(locator.inspect().state.activeRoot).toBe(legacyRoot)
 })

 test('Given 历史拒绝 When 设置确认请求 Then 重启后移动且不重复询问', async () => {
   const { home, locator } = harness()
   const legacyRoot = join(home, '.proma')
   mkdirSync(legacyRoot)
   writeFileSync(join(legacyRoot, 'settings.json'), JSON.stringify({ themeMode: 'dark' }))
   locator.write({ version: 1, activeRoot: legacyRoot, defaultMigrationDismissed: true, previousRoot: join(home, 'backup') })
   requestDefaultDataRootMove(locator)
   expect(lstatSync(legacyRoot).isDirectory()).toBe(true)
   const result = await handleDefaultDataRootMove(locator, options(async () => { throw new Error('不可重复确认') }))
   expect(result.status).toBe('moved')
   expect(locator.inspect().locatorFile?.defaultRootMoveRequest).toBeUndefined()
   expect(locator.inspect().locatorFile?.previousRoot).toBe(join(home, 'backup'))
 })
 test('Given 请求后源被替换 When 启动 Then 保留请求并阻止迁移', async () => {
   const { home, locator } = harness()
   const legacyRoot = join(home, '.proma')
   mkdirSync(legacyRoot)
   writeFileSync(join(legacyRoot, 'settings.json'), JSON.stringify({ themeMode: 'dark' }))
   locator.write({ version: 1, activeRoot: legacyRoot })
   requestDefaultDataRootMove(locator)
   renameSync(legacyRoot, join(home, 'original'))
   mkdirSync(legacyRoot)
   writeFileSync(join(legacyRoot, 'settings.json'), JSON.stringify({ themeMode: 'dark' }))
   const result = await handleDefaultDataRootMove(locator, options(async () => true))
   expect(result.status).toBe('failed')
   expect(locator.inspect().state.activeRoot).toBe(legacyRoot)
   expect(locator.inspect().locatorFile?.defaultRootMoveRequest).toBeDefined()
 })

 test('Given 重启前目标被占用 When 执行请求 Then 保留两边数据与原 locator', async () => {
   const { home, locator } = harness()
   const source = join(home, '.proma')
   mkdirSync(source)
   writeFileSync(join(source, 'settings.json'), JSON.stringify({ themeMode: 'dark' }))
   locator.write({ version: 1, activeRoot: source })
   requestDefaultDataRootMove(locator)
   mkdirSync(join(home, '.DutyDeck'))
   writeFileSync(join(home, '.DutyDeck', 'other.json'), '{}')
   const result = await handleDefaultDataRootMove(locator, options(async () => true))
   expect(result.status).toBe('failed')
   expect(lstatSync(join(source, 'settings.json')).isFile()).toBe(true)
   expect(lstatSync(join(home, '.DutyDeck', 'other.json')).isFile()).toBe(true)
   expect(locator.inspect().state.activeRoot).toBe(source)
 })
 test('Given 移动后目标被替换 When 恢复 Then 不采纳错误目标', async () => {
   const { home, locator } = harness()
   const source = join(home, '.proma')
   const target = join(home, '.DutyDeck')
   mkdirSync(source)
   writeFileSync(join(source, 'settings.json'), JSON.stringify({ themeMode: 'dark' }))
   locator.write({ version: 1, activeRoot: source })
   requestDefaultDataRootMove(locator)
   renameSync(source, join(home, 'original'))
   mkdirSync(target)
   writeFileSync(join(target, 'settings.json'), JSON.stringify({ themeMode: 'dark' }))
   const result = await handleDefaultDataRootMove(locator, options(async () => true))
   expect(result.status).toBe('failed')
   expect(locator.inspect().state.activeRoot).toBe(source)
 })


test('Given 默认根移动前已有自定义历史根 When 确认移动 Then 保留原别名且不访问旧副本', async () => {
  /** 历史根无需存在，默认移动只能操作当前默认旧根。 */
  const { home, locator } = harness()
  const legacyRoot = join(home, '.proma')
  const historicalRoot = join(home, 'removed-custom-root')
  mkdirSync(legacyRoot)
  writeFileSync(join(legacyRoot, 'settings.json'), JSON.stringify({ themeMode: 'dark' }))
  locator.write({ version: 1, activeRoot: legacyRoot, historicalRoots: [historicalRoot] })
  expect((await handleDefaultDataRootMove(locator, options(async () => true))).status).toBe('moved')
  expect(locator.inspect().locatorFile?.historicalRoots).toEqual([historicalRoot])
  expect(locator.getHistoricalRoots()).toContain(historicalRoot)
})
