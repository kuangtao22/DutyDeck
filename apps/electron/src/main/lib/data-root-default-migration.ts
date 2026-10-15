import { accessSync, constants, lstatSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { DataRootMigrationProgress } from '@proma/shared'
import type { DataRootMigrationCoordinator } from './data-root-migration'
import type { DataRootMigrationGuard } from './data-root-instance-lease'
import { DataRootLocator } from './data-root-locator'
import { inspectPromaDataRootIdentity } from './data-root-marker'

/** 启动时自动迁移计划的处理结果。 */
export interface DefaultDataRootMigrationPlanResult {
  /** 计划状态：已创建、无需处理、条件不满足、被并发实例阻断或创建失败。 */
  status: 'planned' | 'not-needed' | 'skipped' | 'blocked' | 'failed'
  /** 被识别出的历史默认根。 */
  legacyRoot: string
  /** 当前版本默认目标根。 */
  targetRoot: string
  /** 已创建的计划摘要；其它状态不提供。 */
  progress?: DataRootMigrationProgress
  /** 计划创建失败时的稳定错误。 */
  error?: unknown
}

/** 自动计划的跨进程并发保护；生产启动传入，单元测试可省略。 */
export interface DefaultDataRootMigrationGuards {
  /** 取得共享迁移 intent，覆盖检查与计划落盘。 */
  acquireMigrationGuard: () => Promise<DataRootMigrationGuard>
  /** 检查是否仍有其他 DutyDeck 进程持有普通数据根 lease。 */
  hasOtherActiveLease: () => Promise<boolean>
}

/**
 * 检测旧默认根并只创建一次 pending 迁移计划。
 *
 * @param locator 当前进程固定使用的数据根定位器。
 * @param getCoordinator 按需取得与路径管理窗口共用的协调器，避免恢复模式提前清理数据。
 * @returns 启动检测结果；不会在此处复制用户数据。
 */
export async function ensureDefaultDataRootMigrationPlan(
  locator: DataRootLocator,
  getCoordinator: () => DataRootMigrationCoordinator,
  guards?: DefaultDataRootMigrationGuards,
): Promise<DefaultDataRootMigrationPlanResult> {
  /** 新版本默认根与历史根都位于同一个 home 目录。 */
  const targetRoot = locator.getDefaultRoot()
  const legacyRoot = locator.getLegacyDefaultRoot()

  /** 已有迁移、非法 locator 或自定义根均交给现有启动状态机处理。 */
  const initial = locator.inspect()
  if (initial.status === 'invalid' || initial.state.migration !== null || initial.locatorFile?.postCommitCleanup !== undefined) {
    return { status: 'not-needed', legacyRoot, targetRoot }
  }

  /** 用户主动取消过自动升级后，交还普通启动，避免每次重启重复阻断。 */
  if (initial.locatorFile?.defaultMigrationDismissed === true) {
    return { status: 'skipped', legacyRoot, targetRoot }
  }

  /** 只允许无 locator 的默认场景，或 locator 明确仍指向旧默认根。 */
  const activeRoot = initial.state.activeRoot
  const pointsToLegacyRoot = activeRoot !== null && resolve(activeRoot) === resolve(legacyRoot)
  const canAdoptLegacyRoot = initial.locatorFile === undefined || pointsToLegacyRoot
  if (!canAdoptLegacyRoot) {
    return { status: 'skipped', legacyRoot, targetRoot }
  }

  /** 新目标已经存在时不猜测用户意图，避免覆盖一个可能已被手动初始化的根。 */
  if (pathExists(targetRoot)) return { status: 'skipped', legacyRoot, targetRoot }
  if (!isUsableLegacyRoot(legacyRoot)) return { status: 'not-needed', legacyRoot, targetRoot }

  /** 生产启动必须在同一共享 guard 内完成并发检查与计划落盘，避免旧实例继续写源根。 */
  let migrationGuard: DataRootMigrationGuard | null = null
  try {
    if (guards !== undefined) {
      try {
        migrationGuard = await guards.acquireMigrationGuard()
        if (await guards.hasOtherActiveLease()) {
          return {
            status: 'blocked',
            legacyRoot,
            targetRoot,
            error: new Error('检测到另一个 DutyDeck 实例正在使用旧数据根，请先退出该实例后再启动迁移'),
          }
        }
      } catch (error) {
        return {
          status: 'blocked',
          legacyRoot,
          targetRoot,
          error,
        }
      }
    }
    /** 等待 guard 期间其他进程可能已更新 locator，禁止用先前缓存覆盖其迁移或目录选择。 */
    const current = new DataRootLocator({ homeDir: dirname(locator.getLocatorPath()) }).inspect()
    if (current.status === 'invalid' || JSON.stringify(current.locatorFile) !== JSON.stringify(initial.locatorFile)) {
      return {
        status: 'blocked',
        legacyRoot,
        targetRoot,
        error: new Error('数据根定位信息已被另一个实例更新，请重新启动以读取最新状态'),
      }
    }
    if (pathExists(targetRoot)) return { status: 'skipped', legacyRoot, targetRoot }
    /** 没有定位文件时先把旧根写成活动根，复用既有迁移预检与 locator 合同。 */
    if (initial.locatorFile === undefined) locator.write({ version: 1, activeRoot: legacyRoot })
    /** createPlan 只扫描、校验并持久化 pending，不创建目标副本。 */
    const progress = await getCoordinator().createPlan(targetRoot, { origin: 'default-root-upgrade' })
    return { status: 'planned', legacyRoot, targetRoot, progress }
  } catch (error) {
    /** 计划失败时保留旧根作为可用回退，避免用户因迁移预检失败而失去配置。 */
    return { status: 'failed', legacyRoot, targetRoot, error }
  } finally {
    /** 计划已持久化后，locator 的 migration 状态会阻止普通启动；此处可安全释放 intent。 */
    migrationGuard?.release()
  }
}

/** 判断目标路径是否已存在，拒绝把文件或符号链接当作空目标。 */
function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
  }
}

/** 证明旧默认根是可读写的真实 Proma 数据目录。 */
function isUsableLegacyRoot(root: string): boolean {
  try {
    const stat = lstatSync(root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false
    accessSync(root, constants.R_OK | constants.W_OK | constants.X_OK)
    realpathSync(root)
    return inspectPromaDataRootIdentity(root) !== null
  } catch {
    return false
  }
}
