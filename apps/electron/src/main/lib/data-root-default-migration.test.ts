import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DataRootMigrationCoordinator } from './data-root-migration'
import { DataRootLocator } from './data-root-locator'
import { ensureDefaultDataRootMigrationPlan } from './data-root-default-migration'
import { inspectDataRootStartup } from './data-root-startup-check'

/** 每个场景独立的临时 home，避免测试读取真实用户目录。 */
const temporaryHomes: string[] = []

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** 创建使用固定容量探针的迁移协调器，避免测试依赖真实磁盘剩余空间。 */
function createHarness(): { home: string; locator: DataRootLocator; coordinator: DataRootMigrationCoordinator } {
  /** 当前用例的临时 home 目录。 */
  const home = mkdtempSync(join(tmpdir(), 'dutydeck-default-migration-'))
  temporaryHomes.push(home)
  /** 独立 locator 只读取当前临时 home。 */
  const locator = new DataRootLocator({ homeDir: home })
  /** 固定迁移 ID 和容量，保证 BDD 断言只关注自动检测行为。 */
  const coordinator = new DataRootMigrationCoordinator({
    locator,
    createMigrationId: () => 'automatic-default-migration',
    createLockOwnerToken: () => 'automatic-default-lock',
    getAvailableBytes: async () => Number.MAX_SAFE_INTEGER,
  })
  return { home, locator, coordinator }
}

describe('默认数据根自动迁移计划', () => {
  test('Given 只有旧 ~/.proma 且身份可证明 When 启动检测 Then 创建到 ~/.DutyDeck 的 pending 计划但不复制数据', async () => {
    const { home, locator, coordinator } = createHarness()
    const legacyRoot = join(home, '.proma')
    mkdirSync(legacyRoot)
    writeFileSync(join(legacyRoot, 'settings.json'), JSON.stringify({ themeMode: 'dark' }), 'utf8')

    const result = await ensureDefaultDataRootMigrationPlan(locator, () => coordinator)

    expect(result.status).toBe('planned')
    expect(result.progress).toMatchObject({ stage: 'pending', completedBytes: 0, migrationId: 'automatic-default-migration' })
    expect(result.targetRoot).toBe(join(home, '.DutyDeck'))
    expect(existsSync(join(home, '.DutyDeck'))).toBe(false)
    expect(locator.inspect().locatorFile).toMatchObject({
      activeRoot: legacyRoot,
      migration: { sourceRoot: legacyRoot, targetRoot: join(home, '.DutyDeck'), stage: 'pending' },
    })
  })

  test('Given 新默认根已存在 When 启动检测 Then 不自动覆盖或创建迁移计划', async () => {
    const { home, locator, coordinator } = createHarness()
    mkdirSync(join(home, '.proma'))
    writeFileSync(join(home, '.proma', 'settings.json'), JSON.stringify({ themeMode: 'dark' }), 'utf8')
    mkdirSync(join(home, '.DutyDeck'))

    const result = await ensureDefaultDataRootMigrationPlan(locator, () => coordinator)

    expect(result.status).toBe('skipped')
    expect(locator.inspect().locatorFile).toBeUndefined()
  })

  test('Given 旧版本已写入 locator 指向 ~/.proma When 启动检测 Then 仍自动补建到新默认根的计划', async () => {
    const { home, locator, coordinator } = createHarness()
    const legacyRoot = join(home, '.proma')
    mkdirSync(legacyRoot)
    writeFileSync(join(legacyRoot, 'settings.json'), JSON.stringify({ themeMode: 'dark' }), 'utf8')
    locator.write({ version: 1, activeRoot: legacyRoot })

    const result = await ensureDefaultDataRootMigrationPlan(locator, () => coordinator)

    expect(result.status).toBe('planned')
    expect(locator.inspect().locatorFile?.migration?.targetRoot).toBe(join(home, '.DutyDeck'))
  })

  test('Given 自动计划被用户取消 When 再次启动检测 Then 记录跳过决策且不重复阻断', async () => {
    const { home, locator, coordinator } = createHarness()
    const legacyRoot = join(home, '.proma')
    mkdirSync(legacyRoot)
    writeFileSync(join(legacyRoot, 'settings.json'), JSON.stringify({ themeMode: 'dark' }), 'utf8')

    await ensureDefaultDataRootMigrationPlan(locator, () => coordinator)
    await coordinator.cancel()

    expect(locator.inspect().locatorFile).toMatchObject({
      activeRoot: join(home, '.DutyDeck'),
      defaultMigrationDismissed: true,
    })
    expect(existsSync(join(home, '.DutyDeck'))).toBe(false)
    expect(inspectDataRootStartup(locator, true).state.activeRoot).toBe(join(home, '.DutyDeck'))
    expect(existsSync(join(home, '.DutyDeck', '.proma-data-root.json'))).toBe(true)
    await expect(ensureDefaultDataRootMigrationPlan(locator, () => coordinator)).resolves.toMatchObject({ status: 'skipped' })
    expect(locator.inspect().state.migration).toBeNull()
  })

  test.each(['copying', 'failed'] as const)('Given 自动迁移处于 %s 且目标只有部分副本 When 取消 Then 保留源根与迁移记录并阻止普通启动', async (stage) => {
    /** 使用临时 home 下的真实协调器验证取消和下次启动之间的合同。 */
    const { home, locator, coordinator } = createHarness()
    /** 旧根包含配置及会话索引，目标只复制配置以模拟未完成状态。 */
    const legacyRoot = join(home, '.proma')
    /** 自动升级的固定目标根。 */
    const targetRoot = join(home, '.DutyDeck')
    mkdirSync(legacyRoot)
    writeFileSync(join(legacyRoot, 'settings.json'), JSON.stringify({ themeMode: 'dark' }), 'utf8')
    writeFileSync(join(legacyRoot, 'agent-sessions.json'), JSON.stringify({ version: 1, sessions: [] }), 'utf8')
    await ensureDefaultDataRootMigrationPlan(locator, () => coordinator)
    mkdirSync(targetRoot)
    writeFileSync(join(targetRoot, 'settings.json'), readFileSync(join(legacyRoot, 'settings.json')))
    locator.updateMigration('automatic-default-migration', { stage, completedBytes: 1, updatedAt: Date.now() })
    /** 取消被拒绝时，磁盘上的原计划必须保持原样。 */
    const persistedBeforeCancel = readFileSync(locator.getLocatorPath(), 'utf8')

    await expect(coordinator.cancel()).rejects.toThrow('目标目录已经存在')

    expect(readFileSync(locator.getLocatorPath(), 'utf8')).toBe(persistedBeforeCancel)
    /** 重启重新读取磁盘，不能依赖旧 locator 缓存掩盖部分副本被激活。 */
    const startup = inspectDataRootStartup(new DataRootLocator({ homeDir: home }), true)
    expect(startup.status).toBe('migration')
    expect(startup.state.activeRoot).toBe(legacyRoot)
    expect(startup.locatorFile?.migration?.stage).toBe(stage)
    expect(existsSync(join(targetRoot, '.proma-data-root.json'))).toBe(false)
    expect(existsSync(join(targetRoot, 'agent-sessions.json'))).toBe(false)
    expect(readFileSync(join(targetRoot, 'settings.json'), 'utf8')).toBe(readFileSync(join(legacyRoot, 'settings.json'), 'utf8'))
    expect(existsSync(join(legacyRoot, 'agent-sessions.json'))).toBe(true)
  })

  test.each(['directory', 'file', 'symlink', 'dangling-symlink'] as const)('Given 自动迁移 pending 目标出现 %s When 取消 Then 不跟随或删除目标且保留原计划', async (entryKind) => {
    /** 每种目标占用状态使用独立临时 home。 */
    const { home, locator, coordinator } = createHarness()
    /** 可以证明身份的旧根用于建立真实 pending 计划。 */
    const legacyRoot = join(home, '.proma')
    /** 计划创建后被占用的目标根，覆盖外部新增目录和悬空链接。 */
    const targetRoot = join(home, '.DutyDeck')
    /** 链接目的地仅用于确认取消不会跟随链接写 marker 或初始化目录。 */
    const linkedRoot = join(home, 'linked-data')
    mkdirSync(legacyRoot)
    writeFileSync(join(legacyRoot, 'settings.json'), JSON.stringify({ themeMode: 'dark' }), 'utf8')
    await ensureDefaultDataRootMigrationPlan(locator, () => coordinator)
    if (entryKind === 'directory') mkdirSync(targetRoot)
    else if (entryKind === 'file') writeFileSync(targetRoot, 'user-owned-target', 'utf8')
    else {
      if (entryKind === 'symlink') mkdirSync(linkedRoot)
      symlinkSync(linkedRoot, targetRoot, 'junction')
    }
    /** 不跟随链接记录占用项身份，拒绝取消后该项必须原样保留。 */
    const targetIdentity = lstatSync(targetRoot)
    /** 取消不得变更持久化迁移来源或清除进度。 */
    const persistedBeforeCancel = readFileSync(locator.getLocatorPath(), 'utf8')

    await expect(coordinator.cancel()).rejects.toThrow('目标目录已经存在')

    expect(readFileSync(locator.getLocatorPath(), 'utf8')).toBe(persistedBeforeCancel)
    expect(lstatSync(targetRoot).ino).toBe(targetIdentity.ino)
    expect(lstatSync(targetRoot).isSymbolicLink()).toBe(targetIdentity.isSymbolicLink())
    expect(locator.inspect().state.activeRoot).toBe(legacyRoot)
    expect(locator.inspect().locatorFile?.migration?.stage).toBe('pending')
    expect(existsSync(join(linkedRoot, '.proma-data-root.json'))).toBe(false)
    if (entryKind === 'file') expect(readFileSync(targetRoot, 'utf8')).toBe('user-owned-target')
    if (entryKind === 'dangling-symlink') expect(existsSync(linkedRoot)).toBe(false)
  })

  test('Given Proma continues using the legacy locator after cancel When DutyDeck starts again Then it does not recreate migration', async () => {
    const { home } = createHarness()
    const legacyRoot = join(home, '.proma')
    mkdirSync(legacyRoot)
    writeFileSync(join(legacyRoot, 'settings.json'), JSON.stringify({ themeMode: 'dark' }), 'utf8')
    /** 模拟旧 Proma 自己维护的 locator，DutyDeck 不得覆盖它。 */
    const locator = new DataRootLocator({ homeDir: home })
    writeFileSync(locator.getLegacyLocatorPath(), JSON.stringify({ version: 1, activeRoot: legacyRoot }), 'utf8')
    /** 协调器必须在读取旧 locator 后构造，模拟真实启动顺序。 */
    const coordinator = new DataRootMigrationCoordinator({
      locator,
      createMigrationId: () => 'automatic-default-migration',
      createLockOwnerToken: () => 'automatic-default-lock',
      getAvailableBytes: async () => Number.MAX_SAFE_INTEGER,
    })

    const initialPlan = await ensureDefaultDataRootMigrationPlan(locator, () => coordinator)
    expect(initialPlan.status).toBe('planned')
    await coordinator.cancel()
    const legacyLocatorBeforeRestart = readFileSync(locator.getLegacyLocatorPath(), 'utf8')

    /** 旧 Proma 继续写回自己的 locator，模拟用户体验旧应用后的状态。 */
    writeFileSync(locator.getLegacyLocatorPath(), JSON.stringify({ version: 1, activeRoot: legacyRoot }), 'utf8')
    const restartedLocator = new DataRootLocator({ homeDir: home })
    const restartedCoordinator = new DataRootMigrationCoordinator({
      locator: restartedLocator,
      createMigrationId: () => 'should-not-be-created',
      getAvailableBytes: async () => Number.MAX_SAFE_INTEGER,
    })

    await expect(ensureDefaultDataRootMigrationPlan(restartedLocator, () => restartedCoordinator))
      .resolves.toMatchObject({ status: 'skipped' })
    expect(restartedLocator.inspect().state.activeRoot).toBe(join(home, '.DutyDeck'))
    expect(readFileSync(locator.getLegacyLocatorPath(), 'utf8')).toBe(legacyLocatorBeforeRestart)
  })

  test('Given 另一个 DutyDeck 实例仍持有 lease When 自动检测 Then 在共享 guard 内阻断且释放 guard', async () => {
    const { home, locator, coordinator } = createHarness()
    const legacyRoot = join(home, '.proma')
    mkdirSync(legacyRoot)
    writeFileSync(join(legacyRoot, 'settings.json'), JSON.stringify({ themeMode: 'dark' }), 'utf8')
    let released = 0

    const result = await ensureDefaultDataRootMigrationPlan(locator, () => coordinator, {
      acquireMigrationGuard: async () => ({ release: () => { released += 1 } }),
      hasOtherActiveLease: async () => true,
    })

    expect(result.status).toBe('blocked')
    expect(released).toBe(1)
    expect(locator.inspect().locatorFile).toBeUndefined()
    expect(existsSync(join(home, '.DutyDeck'))).toBe(false)
  })

  test('Given 旧目录无法证明是应用数据根 When 启动检测 Then 保持无 locator 且不创建计划', async () => {
    const { home, locator, coordinator } = createHarness()
    mkdirSync(join(home, '.proma'))
    writeFileSync(join(home, '.proma', 'notes.txt'), 'user data', 'utf8')

    const result = await ensureDefaultDataRootMigrationPlan(locator, () => coordinator)

    expect(result.status).toBe('not-needed')
    expect(locator.inspect().locatorFile).toBeUndefined()
    expect(existsSync(join(home, '.DutyDeck'))).toBe(false)
  })

  test('Given 离线数据根还有提交后清理记录 When 自动检测 Then 不创建协调器或触发清理', async () => {
    const { home, locator } = createHarness()
    /** 离线旧根的清理意图应留给恢复流程，启动检测不消费它。 */
    const legacyRoot = join(home, '.proma')
    locator.write({
      version: 1,
      activeRoot: legacyRoot,
      postCommitCleanup: { migrationId: 'previous-migration', targetRoot: legacyRoot },
    })

    await expect(ensureDefaultDataRootMigrationPlan(locator, () => {
      throw new Error('恢复模式不得构造迁移协调器')
    })).resolves.toMatchObject({ status: 'not-needed' })
    expect(locator.inspect().locatorFile?.postCommitCleanup?.migrationId).toBe('previous-migration')
    expect(existsSync(legacyRoot)).toBe(false)
  })

  test('Given 等待 guard 时其他实例更改 locator When 获得保护 Then 阻断且不覆盖新定位信息', async () => {
    const { home, locator, coordinator } = createHarness()
    /** 启动快照只有旧默认根，尚未写固定定位信息。 */
    const legacyRoot = join(home, '.proma')
    mkdirSync(legacyRoot)
    writeFileSync(join(legacyRoot, 'settings.json'), JSON.stringify({ themeMode: 'dark' }), 'utf8')
    /** 模拟其他进程在异步取得 guard 期间选择的新活动根。 */
    const selectedRoot = join(home, 'selected-data')
    mkdirSync(selectedRoot)
    /** 独立定位器不共享当前启动的缓存。 */
    const otherLocator = new DataRootLocator({ homeDir: home })
    /** guard 必须在拒绝覆盖时也被释放。 */
    let released = false

    const result = await ensureDefaultDataRootMigrationPlan(locator, () => coordinator, {
      acquireMigrationGuard: async () => {
        otherLocator.write({ version: 1, activeRoot: selectedRoot })
        return { release: () => { released = true } }
      },
      hasOtherActiveLease: async () => false,
    })

    expect(result.status).toBe('blocked')
    expect(released).toBe(true)
    expect(new DataRootLocator({ homeDir: home }).inspect().locatorFile).toEqual({ version: 1, activeRoot: selectedRoot })
    expect(existsSync(join(home, '.DutyDeck'))).toBe(false)
  })
})
