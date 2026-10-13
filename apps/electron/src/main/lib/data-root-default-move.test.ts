import { afterEach, describe, expect, test } from 'bun:test'
import { lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DataRootLocator } from './data-root-locator'
import { handleDefaultDataRootMove } from './data-root-default-move'

const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function harness(): { home: string; locator: DataRootLocator } {
  const home = mkdtempSync(join(tmpdir(), 'dutydeck-default-move-'))
  homes.push(home)
  return { home, locator: new DataRootLocator({ homeDir: home }) }
}

function options(confirmMigration: (legacyRoot: string, targetRoot: string) => Promise<boolean>) {
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
    renameSync(legacyRoot, targetRoot)

    const result = await handleDefaultDataRootMove(locator, options(async () => {
      throw new Error('恢复路径不应弹窗')
    }))

    expect(result.status).toBe('recovered')
    expect(locator.inspect().state.activeRoot).toBe(targetRoot)
  })
})
