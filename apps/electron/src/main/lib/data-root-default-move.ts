import { accessSync, constants, lstatSync, opendirSync, renameSync, rmdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DataRootLocator } from './data-root-locator'
import type { DataRootMigrationGuard } from './data-root-instance-lease'
import { inspectPromaDataRootIdentity } from './data-root-marker'
import { rebaseMovedDataRootOwnedPaths } from './owned-path-rebaser'

/** 默认数据根升级的并发保护与用户决定回调。 */
export interface DefaultDataRootMoveOptions {
  /** 用户确认后取得跨进程迁移 guard。 */
  acquireMigrationGuard: () => Promise<DataRootMigrationGuard>
  /** 检查是否仍有其它 DutyDeck 实例持有普通数据根 lease。 */
  hasOtherActiveLease: () => Promise<boolean>
  /** 弹窗返回 true 表示用户确认移动。 */
  confirmMigration: (legacyRoot: string, targetRoot: string) => Promise<boolean>
}

/** 默认根移动的可观察结果。 */
export interface DefaultDataRootMoveResult {
  status: 'not-needed' | 'declined' | 'moved' | 'recovered' | 'blocked' | 'failed'
  legacyRoot: string
  targetRoot: string
  error?: unknown
}

/**
 * 轻量检测旧默认根，按用户选择把它原子移动到新默认根。
 *
 * @param locator 当前进程的数据根定位器。
 * @param options 并发保护及弹窗决定。
 * @returns 本次启动是否完成了移动或崩溃恢复。
 */
export async function handleDefaultDataRootMove(
  locator: DataRootLocator,
  options: DefaultDataRootMoveOptions,
): Promise<DefaultDataRootMoveResult> {
  /** 新旧默认根固定在同一个 home 下。 */
  const targetRoot = locator.getDefaultRoot()
  const legacyRoot = locator.getLegacyDefaultRoot()
  /** 首次无副作用读取定位状态，避免业务模块提前解析数据根。 */
  const initial = locator.inspect()
  if (initial.status === 'invalid' || initial.state.migration !== null || initial.locatorFile?.postCommitCleanup !== undefined) {
    return { status: 'not-needed', legacyRoot, targetRoot }
  }
  if (initial.locatorFile?.defaultMigrationDismissed === true) {
    return { status: 'not-needed', legacyRoot, targetRoot }
  }

  /** locator 缺失或明确指向旧根时，旧根才有资格触发默认升级。 */
  const pointsToLegacy = initial.state.activeRoot !== null
    && resolve(initial.state.activeRoot) === resolve(legacyRoot)
  if (initial.locatorFile !== undefined && !pointsToLegacy) {
    return { status: 'not-needed', legacyRoot, targetRoot }
  }

  /** 新默认根已有内容时不读取旧根配置，也不打断用户。 */
  const initialTargetState = inspectTargetState(targetRoot)
  /** 先处理上次重命名已完成但 locator 尚未提交的崩溃窗口。 */
  if (!pathExists(legacyRoot) && initialTargetState !== 'unsafe' && isUsableRoot(targetRoot)) {
    if (!pointsToLegacy) return { status: 'not-needed', legacyRoot, targetRoot }
    return finalizeMovedRoot(locator, legacyRoot, targetRoot, options, 'recovered', directoryIdentity(targetRoot))
  }
  if (initialTargetState === 'occupied' || initialTargetState === 'unsafe') {
    return { status: 'not-needed', legacyRoot, targetRoot }
  }
  if (!isUsableRoot(legacyRoot)) return { status: 'not-needed', legacyRoot, targetRoot }
  /** 新默认根只允许缺失或空目录进入迁移候选。 */

  /** 弹窗期间不持有 guard，避免用户犹豫阻塞其他实例的正常写入。 */
  /** 用户在原子移动前的明确选择。 */
  let confirmed: boolean
  try {
    confirmed = await options.confirmMigration(legacyRoot, targetRoot)
  } catch (error) {
    return { status: 'failed', legacyRoot, targetRoot, error }
  }
  if (!confirmed) {
    /** 拒绝后继续使用旧根，并记住决定，避免每次启动重复打断用户。 */
    try {
      locator.write({ version: 1, activeRoot: legacyRoot, defaultMigrationDismissed: true })
      return { status: 'declined', legacyRoot, targetRoot }
    } catch (error) {
      return { status: 'failed', legacyRoot, targetRoot, error }
    }
  }

  let guard: DataRootMigrationGuard | null = null
  try {
    guard = await options.acquireMigrationGuard()
    if (await options.hasOtherActiveLease()) {
      return {
        status: 'blocked',
        legacyRoot,
        targetRoot,
        error: new Error('检测到另一个 DutyDeck 实例正在使用旧数据目录'),
      }
    }
    /** guard 后重新读取权威 locator，防止覆盖其它实例的选择。 */
    const fresh = new DataRootLocator({ homeDir: dirname(locator.getLocatorPath()) }).inspect()
    if (JSON.stringify(fresh.locatorFile) !== JSON.stringify(initial.locatorFile)) {
      return {
        status: 'blocked',
        legacyRoot,
        targetRoot,
        error: new Error('数据根定位信息已被另一个实例更新'),
      }
    }
    /** 重新确认目标仍为空，阻断弹窗期间的外部占用。 */
    const freshTargetState = inspectTargetState(targetRoot)
    if (freshTargetState === 'occupied' || freshTargetState === 'unsafe') {
      return { status: 'not-needed', legacyRoot, targetRoot }
    }
    if (freshTargetState === 'empty') {
      /** 只删除确认为空的真实目录，绝不递归清理用户内容。 */
      rmdirSync(targetRoot)
    }
    /** 在 rename 前捕获物理身份，移动后用于阻断目录替换竞态。 */
    const sourceIdentity = directoryIdentity(legacyRoot)
    /** Node rename 在同一文件系统内只改变目录项，不创建第二份数据。 */
    renameSync(legacyRoot, targetRoot)
    /** 后续恢复函数会重新取得 guard，避免同一进程重复持有迁移 intent。 */
    guard.release()
    guard = null
    return await finalizeMovedRoot(locator, legacyRoot, targetRoot, options, 'moved', sourceIdentity)
  } catch (error) {
    return { status: 'failed', legacyRoot, targetRoot, error }
  } finally {
    guard?.release()
  }
}

/** 重命名已完成后重写受管路径并提交新的活动根。 */
async function finalizeMovedRoot(
  locator: DataRootLocator,
  legacyRoot: string,
  targetRoot: string,
  options: DefaultDataRootMoveOptions,
  status: 'moved' | 'recovered',
  sourceIdentity: { dev: string; ino: string },
): Promise<DefaultDataRootMoveResult> {
  let guard: DataRootMigrationGuard | null = null
  try {
    guard = await options.acquireMigrationGuard()
    if (await options.hasOtherActiveLease()) {
      return { status: 'blocked', legacyRoot, targetRoot, error: new Error('检测到另一个 DutyDeck 实例正在使用数据目录') }
    }
    if (!isUsableRoot(targetRoot)) throw new Error('移动后的新数据目录不可用')
    /** 移动后 source 已不存在，使用 target-only guard 重写内部受管绝对路径。 */
    rebaseMovedDataRootOwnedPaths({ sourceRoot: legacyRoot, targetRoot, sourceIdentity })
    /** 原目录已被改名，不留下指向不存在路径的“恢复旧根”入口。 */
    locator.write({ version: 1, activeRoot: targetRoot })
    return { status, legacyRoot, targetRoot }
  } catch (error) {
    /** locator 保持旧根时，下次启动仍可依据 source/target 状态继续恢复。 */
    return { status: 'failed', legacyRoot, targetRoot, error }
  } finally {
    guard?.release()
  }
}

/** 不跟随最终符号链接判断路径是否存在。 */
function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
  }
}

/** 新默认根的轻量状态；仅真实空目录允许被迁移替换。 */
function inspectTargetState(path: string): 'missing' | 'empty' | 'occupied' | 'unsafe' {
  try {
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return 'unsafe'
    /** 只读取一个目录项，避免为判断非空而枚举整个新数据目录。 */
    const directory = opendirSync(path)
    try {
      return directory.readSync() === null ? 'empty' : 'occupied'
    } finally {
      directory.closeSync()
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'missing'
    return 'unsafe'
  }
}

/** 捕获目录的稳定设备号与 inode，供移动后的目标身份复验。 */
function directoryIdentity(path: string): { dev: string; ino: string } {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('数据根必须是实际目录')
  return { dev: String(stat.dev), ino: String(stat.ino) }
}

/** 证明目录是可读写的 Proma 数据根，整个过程只读取少量元数据。 */
function isUsableRoot(root: string): boolean {
  try {
    const stat = lstatSync(root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false
    accessSync(root, constants.R_OK | constants.W_OK | constants.X_OK)
    return inspectPromaDataRootIdentity(root) !== null
  } catch {
    return false
  }
}
