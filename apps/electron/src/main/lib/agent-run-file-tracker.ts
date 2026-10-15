import type { AgentRunFileChange } from '@proma/shared'
import { createHash } from 'node:crypto'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { constants, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { isAgentRunFileNoisePath, shouldTrackAgentRunFilePath } from './agent-run-file-change-path-policy'

/** 单文件、每轮留存、数量与计算预算；超限保持可见但不给伪精确数字。 */
export const AGENT_RUN_FILE_TRACKER_LIMITS = {
  maxFileBytes: 1024 * 1024,
  maxRetainedBytes: 8 * 1024 * 1024,
  maxFiles: 256,
  maxDiffOperations: 200_000,
  maxLines: 50_000,
} as const

/** 轮次基线的独立预算；未变化文件不占展示槽位，只在结束时按元数据筛选。 */
export const AGENT_RUN_FILE_BASELINE_LIMITS = {
  maxFiles: 2048,
  maxDirectories: 4096,
  maxScanMs: 1500,
  maxRetainedBytes: 4 * 1024 * 1024,
} as const

/** 基线扫描中明确跳过的高频目录；显式 write/edit 仍由主 tracker 正常统计。 */
const BASELINE_NOISE_SEGMENTS = new Set([
  'node_modules', '.git', 'dist', 'build', '.cache', '__pycache__', '.venv', 'venv',
  '.turbo', '.parcel-cache', '.svelte-kit', '.gradle',
])

/** Date.now 只有毫秒精度，给文件系统的亚毫秒时间戳留出边界误差。 */
const BASELINE_START_TIME_TOLERANCE_MS = 2

/** 编排层传入的显式授权范围；附加单文件不会扩张为整个父目录。 */
interface AgentRunFileTrackerOptions {
  cwd: string
  roots: string[]
  files?: string[]
  /** 轮次开始时间，用于识别基线扫描期间才发生的写入。 */
  startedAt?: number
}

type StoredFileKind = 'missing' | 'text' | 'binary' | 'too_large' | 'unavailable' | 'budget_exceeded'

/** 内存中的一次有界采样；signature 用于相同内容复用与外部变更检测。 */
interface StoredFileSnapshot {
  kind: StoredFileKind
  signature: string
  text?: string
  retainedBytes: number
}

interface TrackedFile {
  /** 保留用户路径供展示，真实路径仅用于身份校验和读取。 */
  path: string
  canonicalPath: string
  baseline: StoredFileSnapshot
  current: StoredFileSnapshot
  externalChange: boolean
  observedOnly: boolean
  cachedChange?: AgentRunFileChange
}

/** 轮次开始时保存的单文件基线；metadata 用于结束时避免重读未变化正文。 */
interface BaselineFile {
  path: string
  canonicalPath: string
  snapshot: StoredFileSnapshot
  metadata?: FileMetadata
}

/** 文件元数据指纹；只用于判断是否需要读取正文，不作为变更统计依据。 */
interface FileMetadata {
  size: number
  mtimeMs: number
  ctimeMs: number
  birthtimeMs: number
  dev: number
  ino: number
}

/** 按行最短编辑距离得出的新增和删除数量。 */
interface DiffCounts {
  additions: number
  deletions: number
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

/** 记录一次 Agent 运行内文件首次写入前与最终落盘内容之间的净变化。 */
export class AgentRunFileTracker {
  private readonly cwd: string
  private readonly roots: string[]
  private readonly files: Set<string>
  private readonly lexicalRoots: string[]
  private readonly lexicalFiles: Set<string>
  private readonly startedAt: number
  private readonly tracked = new Map<string, TrackedFile>()
  /** 基线与展示槽分离，避免扫描到的未改文件占满 256 个实时统计名额。 */
  private readonly baseline = new Map<string, BaselineFile>()
  private baselineRetainedBytes = 0
  private readonly invalidatedBaseline = new Set<string>()
  /** 基线尚未完成时收到的共享目录冲突，待基线落地后仍必须保持未知。 */
  private readonly invalidatedPaths = new Set<string>()
  private baselineTruncated = false
  private baselineComplete = false
  private readonly baselineReady: Promise<void>
  private readonly retainedSnapshots = new Map<StoredFileSnapshot, number>()
  private retainedBytes = 0
  /** 达到文件数量预算时让上层明确提示统计不完整。 */
  truncated = false
  /** 已获准路径的词法别名，watcher 无需额外读取磁盘。 */
  private readonly aliases = new Map<string, string>()

  constructor(options: AgentRunFileTrackerOptions) {
    this.cwd = resolve(this.expandHome(options.cwd))
    this.startedAt = options.startedAt ?? Date.now()
    this.lexicalRoots = options.roots.map(path => this.resolveInput(path))
    this.lexicalFiles = new Set((options.files ?? []).map(path => this.resolveInput(path)))
    this.roots = options.roots.map(path => this.canonicalizeConfiguredPath(path))
    this.files = new Set((options.files ?? []).map(path => this.canonicalizePotentialPathSync(this.resolveInput(path))))
    this.baselineReady = this.captureBaseline().catch(() => {
      this.baselineTruncated = true
      this.baselineComplete = false
    })
  }

  /** 等待轮次基线完成；正常运行不阻塞工具启动，只在轮次结束时作为统计边界。 */
  async waitForBaseline(): Promise<void> {
    await this.baselineReady
  }

  /** 在受控写工具实际执行前捕获首次基线，并检查此前是否混入外部改动。 */
  async before(path: string): Promise<void> {
    const lexicalPath = this.resolveInput(path)
    const canonicalPath = await this.resolveAllowedPath(path)
    const observedKey = this.observationKey(lexicalPath)
    this.aliases.set(lexicalPath, canonicalPath)
    let existing = this.tracked.get(canonicalPath) ?? this.tracked.get(observedKey)
    if (existing?.observedOnly) {
      // watcher 只能先留下未知占位；真正的 write/edit 到来时必须升级为受控基线，
      // 否则该文件永远只能显示“暂无行数统计”。
      this.tracked.delete(observedKey)
      this.tracked.delete(canonicalPath)
      const baseline = this.baseline.get(canonicalPath) ?? this.baseline.get(observedKey)
      if (baseline) {
        const current = await this.readSnapshot(canonicalPath)
        this.recordBaselineEvidence(baseline, current, existing.path, !this.snapshotsEqual(baseline.snapshot, current))
        return
      }
      existing = undefined
    }
    if (existing) {
      const actual = await this.readSnapshot(canonicalPath)
      if (!this.snapshotsEqual(existing.current, actual)) {
        existing.externalChange = true
        existing.cachedChange = undefined
      }
      this.replaceCurrent(existing, actual)
      return
    }
    if (!this.reserveControlledSlot()) return

    const baseline = await this.readSnapshot(canonicalPath)
    const retainedBaseline = this.retainSnapshot(baseline)
    const retainedCurrent = this.retainSnapshot(retainedBaseline)
    this.tracked.set(canonicalPath, {
      path: lexicalPath,
      canonicalPath,
      baseline: retainedBaseline,
      current: retainedCurrent,
      externalChange: false,
      observedOnly: false,
    })
  }

  /** 在工具成功、失败或取消后读取真实落盘状态，避免仅凭工具入参推断结果。 */
  async after(path: string): Promise<void> {
    const lexicalPath = this.resolveInput(path)
    const canonicalPath = await this.resolveAllowedPath(path)
    let tracked = this.tracked.get(canonicalPath) ?? this.tracked.get(lexicalPath)
    if (!tracked) {
      if (!this.reserveControlledSlot()) return
      const unavailable = this.createUnavailableSnapshot('missing_baseline')
      tracked = {
        path: lexicalPath,
        canonicalPath,
        baseline: unavailable,
        current: unavailable,
        externalChange: false,
        observedOnly: true,
      }
      this.tracked.set(canonicalPath, tracked)
    }
    if (tracked.observedOnly) return
    this.replaceCurrent(tracked, await this.readSnapshot(canonicalPath))
  }

  /** 对已跟踪文件核验当前磁盘状态；差异一旦出现，本轮统计永久标记为外部污染。 */
  async verify(): Promise<void> {
    for (const tracked of this.tracked.values()) {
      if (tracked.observedOnly) continue
      const actual = await this.readSnapshot(tracked.canonicalPath)
      if (!this.snapshotsEqual(tracked.current, actual)) {
        tracked.externalChange = true
        tracked.cachedChange = undefined
      }
      this.replaceCurrent(tracked, actual)
    }
  }

  /**
   * 在轮次结束时收敛脚本、子代理和其它非写工具造成的变化。
   *
   * 基线扫描只保留元数据和有界正文；未变化文件不会进入 tracker 展示槽，
   * 因此脚本批量修改不会把整个项目渲染成“暂无行数统计”。
   */
  async finalizeBaseline(): Promise<void> {
    await this.baselineReady
    if (this.baselineTruncated || !this.baselineComplete) this.truncated = true

    for (const baseline of this.baseline.values()) {
      const key = this.observationKey(baseline.canonicalPath)
      if (this.invalidatedBaseline.has(key) || this.invalidatedPaths.has(key)) continue
      const tracked = this.tracked.get(baseline.canonicalPath) ?? this.tracked.get(this.observationKey(baseline.path))
      if (tracked && !tracked.observedOnly) continue

      // watcher 已经报告的路径必须读取一次；其它路径先用 metadata 判断，避免重读全项目正文。
      const shouldRead = tracked?.observedOnly === true || await this.baselineMetadataChanged(baseline)
      if (!shouldRead) continue
      const current = await this.readSnapshot(baseline.canonicalPath)
      this.recordBaselineEvidence(baseline, current, tracked?.path)
    }

    // 基线完整时，watcher 报告但基线没有的路径可证明是本轮新建文件；
    // 基线不完整时保留 unknown，避免把扫描遗漏误报成新增。
    for (const tracked of [...this.tracked.values()]) {
      if (!tracked.observedOnly) continue
      const key = this.observationKey(tracked.canonicalPath)
      if (this.invalidatedBaseline.has(key) || this.invalidatedPaths.has(key) || this.baseline.has(key) || !this.baselineComplete) continue
      const canonicalPath = await this.canonicalizePotentialPath(tracked.canonicalPath)
      const current = await this.readSnapshot(canonicalPath)
      this.recordBaselineEvidence({
        path: tracked.path,
        canonicalPath,
        snapshot: this.createMissingSnapshot(),
      }, current, tracked.path)
    }
  }

  /** 记录 watcher 提供的变化证据；没有事前内容时只标记 unknown，不补建假基线。 */
  observe(paths: readonly string[]): void {
    for (const path of paths) {
      let lexicalPath: string
      try {
        lexicalPath = this.resolveInput(path)
        this.assertLexicallyAllowed(lexicalPath)
      } catch {
        continue
      }
      const trackedKey = this.observationKey(lexicalPath)
      if (this.tracked.has(trackedKey)) continue
      if (this.tracked.size >= AGENT_RUN_FILE_TRACKER_LIMITS.maxFiles) { this.truncated = true; continue }
      const unavailable = this.createUnavailableSnapshot('watcher_only')
      this.tracked.set(trackedKey, {
        path: lexicalPath,
        canonicalPath: lexicalPath,
        baseline: unavailable,
        current: unavailable,
        externalChange: false,
        observedOnly: true,
      })
    }
  }

  /**
   * 为受控写入预留槽位；容量已满时优先淘汰 watcher-only 占位。
   *
   * 监听事件只是候选证据，不能挤掉 write/edit 已明确给出的路径。被淘汰的候选会
   * 通过 truncated 标记反映统计不完整，但不会静默阻断真实写入采集。
   *
   * @returns 是否成功获得受控文件槽位。
   */
  private reserveControlledSlot(): boolean {
    if (this.tracked.size < AGENT_RUN_FILE_TRACKER_LIMITS.maxFiles) return true
    /** 选择最早的 watcher-only 占位，尽量保持已确认路径稳定。 */
    const observedOnlyKey = [...this.tracked.entries()].find(([, tracked]) => tracked.observedOnly)?.[0]
    if (observedOnlyKey !== undefined) {
      this.tracked.delete(observedOnlyKey)
      this.truncated = true
      return true
    }
    this.truncated = true
    return false
  }

  /** 不读取磁盘的受管范围判断，同时接受显式根的真实路径别名。 */
  owns(path: string): boolean {
    try { this.assertLexicallyAllowed(this.resolveInput(path)); return true } catch { return false }
  }

  /** 多轮同时触碰同一文件时永久撤销精确行数，避免双方冒领相同最终内容。 */
  invalidate(path: string): void {
    const key = this.observationKey(this.resolveInput(path))
    const tracked = this.tracked.get(key)
    if (tracked && !tracked.observedOnly) {
      tracked.externalChange = true
      tracked.cachedChange = undefined
      return
    }
    if (this.baseline.has(key)) this.invalidatedBaseline.add(key)
    else this.invalidatedPaths.add(key)
  }

  /** 查询本轮写工具是否已触碰路径，用于共享根的精确归属。 */
  hasControlledPath(path: string): boolean {
    const tracked = this.tracked.get(this.observationKey(this.resolveInput(path)))
    if (tracked !== undefined) return !tracked.observedOnly
    const key = this.observationKey(this.resolveInput(path))
    return this.baseline.has(key) && !this.invalidatedBaseline.has(key) && !this.invalidatedPaths.has(key)
  }

  /** 在轮次开始后异步建立有界文件基线；不阻塞首个模型工具调用。 */
  private async captureBaseline(): Promise<void> {
    const scanStartedAt = Date.now()
    let scannedDirectories = 0
    const scanBudgetExceeded = (): boolean => Date.now() - scanStartedAt > AGENT_RUN_FILE_BASELINE_LIMITS.maxScanMs

    const scanDirectory = async (directory: string): Promise<void> => {
      if (this.baselineTruncated) return
      if (scanBudgetExceeded()) {
        this.baselineTruncated = true
        return
      }
      if (++scannedDirectories > AGENT_RUN_FILE_BASELINE_LIMITS.maxDirectories) {
        this.baselineTruncated = true
        return
      }
      let handle: Awaited<ReturnType<typeof opendir>>
      try {
        handle = await opendir(directory)
      } catch {
        this.baselineTruncated = true
        return
      }
      for await (const entry of handle) {
        if (this.baselineTruncated) return
        if (scanBudgetExceeded()) {
          this.baselineTruncated = true
          return
        }
        const childPath = resolve(directory, entry.name)
        if (entry.isDirectory()) {
          if (this.isBaselineNoiseDirectory(childPath)) continue
          await scanDirectory(childPath)
          continue
        }
        if (!entry.isFile()) continue
        await this.captureBaselineFile(childPath)
      }
    }

    for (const root of this.roots) {
      if (this.isBaselineNoiseDirectory(root)) continue
      const metadata = await this.readFileMetadata(root)
      if (metadata) await this.captureBaselineFile(root)
      else await scanDirectory(root)
      if (this.baselineTruncated) return
    }

    // 附加单文件可能位于 root 之外，必须单独建立基线；显式写入仍允许这些路径。
    for (const file of this.lexicalFiles) {
      if (this.baselineTruncated) return
      if (scanBudgetExceeded()) {
        this.baselineTruncated = true
        return
      }
      await this.captureBaselineFile(file, true)
    }
    this.baselineComplete = !this.baselineTruncated
  }

  /** 捕获单个基线文件；正文与 tracker 共用 8 MiB 留存预算。 */
  private async captureBaselineFile(path: string, explicit = false): Promise<void> {
    if (!shouldTrackAgentRunFilePath(path)) return
    if (!explicit && (isAgentRunFileNoisePath(path) || this.isBaselineNoiseDirectory(path))) return
    if (this.baseline.size >= AGENT_RUN_FILE_BASELINE_LIMITS.maxFiles) {
      this.baselineTruncated = true
      return
    }
    let canonicalPath: string
    try {
      canonicalPath = await this.canonicalizePotentialPath(path)
      this.assertAllowed(canonicalPath)
    } catch {
      if (!explicit) this.baselineTruncated = true
      return
    }
    if (this.baseline.has(canonicalPath)) return

    const metadata = await this.readFileMetadata(canonicalPath)
    const snapshot = metadata
      ? await this.readStableBaselineSnapshot(canonicalPath, metadata)
      : this.createMissingSnapshot()
    this.baseline.set(canonicalPath, {
      path,
      canonicalPath,
      snapshot: this.retainBaselineSnapshot(snapshot),
      ...(metadata ? { metadata } : {}),
    })
  }

  /** 基线读取期间若文件已变化，禁止把变更后的正文当成轮次前内容。 */
  private async readStableBaselineSnapshot(path: string, initial: FileMetadata): Promise<StoredFileSnapshot> {
    const boundary = this.startedAt + BASELINE_START_TIME_TOLERANCE_MS
    if (initial.birthtimeMs > boundary) return this.createMissingSnapshot()
    if (initial.mtimeMs > boundary || initial.ctimeMs > boundary) {
      return this.createUnavailableSnapshot('baseline_race')
    }
    const snapshot = await this.readSnapshot(path)
    const final = await this.readFileMetadata(path)
    if (!final || !this.metadataEqual(initial, final)) return this.createUnavailableSnapshot('baseline_race')
    return snapshot
  }

  /** 结束时只对 metadata 发生变化或 watcher 点名的基线文件读取正文。 */
  private async baselineMetadataChanged(baseline: BaselineFile): Promise<boolean> {
    if (!baseline.metadata) return true
    const current = await this.readFileMetadata(baseline.canonicalPath)
    return current === undefined || !this.metadataEqual(baseline.metadata, current)
  }

  /** 将基线前后结果放入有限展示槽；watcher-only 会在这里升级为精确记录。 */
  private recordBaselineEvidence(
    baseline: BaselineFile,
    current: StoredFileSnapshot,
    displayPath?: string,
    externalChange = false,
  ): void {
    const observedKey = this.observationKey(baseline.path)
    const canonicalKey = this.observationKey(baseline.canonicalPath)
    const existing = this.tracked.get(canonicalKey) ?? this.tracked.get(observedKey)
    if (existing?.observedOnly) {
      this.tracked.delete(observedKey)
      this.tracked.delete(canonicalKey)
    } else if (existing) {
      return
    }
    if (!this.reserveControlledSlot()) return

    const retainedBaseline = this.retainSnapshot(baseline.snapshot)
    const retainedCurrent = this.snapshotsEqual(retainedBaseline, current)
      ? retainedBaseline
      : this.retainSnapshot(current)
    this.tracked.set(canonicalKey, {
      path: displayPath ?? baseline.path,
      canonicalPath: baseline.canonicalPath,
      baseline: retainedBaseline,
      current: retainedCurrent,
      externalChange: externalChange || baseline.snapshot.kind === 'unavailable',
      observedOnly: false,
    })
    if (this.baseline.get(baseline.canonicalPath) === baseline) {
      this.baseline.delete(baseline.canonicalPath)
      this.releaseBaselineSnapshot(baseline.snapshot)
    }
  }

  /** 读取普通文件元数据；目录、符号链接和不可读路径不进入基线。 */
  private async readFileMetadata(path: string): Promise<FileMetadata | undefined> {
    try {
      const stat = await lstat(path)
      if (!stat.isFile()) return undefined
      return {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        birthtimeMs: stat.birthtimeMs,
        dev: stat.dev,
        ino: stat.ino,
      }
    } catch {
      return undefined
    }
  }

  /** 比较元数据指纹；内容统计仍由 snapshot signature 决定。 */
  private metadataEqual(left: FileMetadata, right: FileMetadata): boolean {
    return left.size === right.size
      && left.mtimeMs === right.mtimeMs
      && left.ctimeMs === right.ctimeMs
      && left.birthtimeMs === right.birthtimeMs
      && left.dev === right.dev
      && left.ino === right.ino
  }

  /** 基线扫描中的高频目录不值得读取正文；显式文件不会走此判断。 */
  private isBaselineNoiseDirectory(path: string): boolean {
    const segments = path.replace(/\\/g, '/').split('/').filter(Boolean).map(segment => segment.toLowerCase())
    return segments.some(segment => BASELINE_NOISE_SEGMENTS.has(segment))
  }

  /** 返回不带正文的缺失基线，用于证明完整扫描下 watcher 报告的是新建文件。 */
  private createMissingSnapshot(): StoredFileSnapshot {
    return { kind: 'missing', signature: 'missing', retainedBytes: 0 }
  }

  /** 基线正文使用独立预算，不能挤掉 write/edit 的实时采集预算。 */
  private retainBaselineSnapshot(snapshot: StoredFileSnapshot): StoredFileSnapshot {
    if (snapshot.retainedBytes === 0) return snapshot
    if (this.baselineRetainedBytes + snapshot.retainedBytes > AGENT_RUN_FILE_BASELINE_LIMITS.maxRetainedBytes) {
      return { kind: 'budget_exceeded', signature: snapshot.signature, retainedBytes: 0 }
    }
    this.baselineRetainedBytes += snapshot.retainedBytes
    return snapshot
  }

  /** 基线证据升级为变化记录后释放其独立正文预算。 */
  private releaseBaselineSnapshot(snapshot: StoredFileSnapshot): void {
    this.baselineRetainedBytes = Math.max(0, this.baselineRetainedBytes - snapshot.retainedBytes)
  }

  /** 把已知根别名映射到同一个索引；watcher 热路径不执行 realpath I/O。 */
  private observationKey(path: string): string {
    const known = this.aliases.get(path)
    if (known) return known
    for (let index = 0; index < this.lexicalRoots.length; index += 1) {
      const delta = relative(this.lexicalRoots[index]!, path)
      if (delta === '' || (!isAbsolute(delta) && delta !== '..' && !delta.startsWith(`..${sep}`))) {
        return resolve(this.roots[index]!, delta)
      }
    }
    const fileIndex = [...this.lexicalFiles].indexOf(path)
    return fileIndex >= 0 ? [...this.files][fileIndex]! : path
  }

  /** 返回仅含路径、状态和数字的稳定快照，不暴露文件正文。 */
  snapshot(): AgentRunFileChange[] {
    return [...this.tracked.values()].map((tracked) => {
      tracked.cachedChange ??= this.toFileChange(tracked)
      return { ...tracked.cachedChange }
    })
  }

  /** 将输入路径解析为通过 realpath 范围校验的绝对路径。 */
  private async resolveAllowedPath(path: string): Promise<string> {
    const canonicalPath = await this.canonicalizePotentialPath(this.resolveInput(path))
    this.assertAllowed(canonicalPath)
    return canonicalPath
  }

  /** 支持工具参数里的相对路径与当前用户 home 简写。 */
  private resolveInput(path: string): string {
    const expanded = this.expandHome(path)
    return resolve(isAbsolute(expanded) ? expanded : resolve(this.cwd, expanded))
  }

  /** 展开用户目录简写，返回供路径解析使用的字符串。 */
  private expandHome(path: string): string {
    if (path === '~') return homedir()
    if (path.startsWith(`~${sep}`)) return resolve(homedir(), path.slice(2))
    return path
  }

  /** 校验授权根的真实路径，允许尚未创建的目录。 */
  private canonicalizeConfiguredPath(path: string): string {
    return this.canonicalizePotentialPathSync(this.resolveInput(path))
  }

  /** 对尚不存在的新增文件，从最近存在祖先 realpath 后重建路径，阻断软链目录逃逸。 */
  private async canonicalizePotentialPath(path: string): Promise<string> {
    let cursor = path
    const missingSegments: string[] = []
    while (true) {
      try {
        const canonicalAncestor = await realpath(cursor)
        return resolve(canonicalAncestor, ...missingSegments.reverse())
      } catch (error) {
        if (!this.isMissingError(error)) throw error
        const parent = dirname(cursor)
        if (parent === cursor) throw error
        missingSegments.push(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)))
        cursor = parent
      }
    }
  }

  /** 初始化时解析最近存在祖先，避免缺失附加目录阻断采集器。 */
  private canonicalizePotentialPathSync(path: string): string {
    let cursor = path
    const missingSegments: string[] = []
    while (true) {
      try {
        const canonicalAncestor = realpathSync(cursor)
        return resolve(canonicalAncestor, ...missingSegments.reverse())
      } catch (error) {
        if (!this.isMissingError(error)) throw error
        const parent = dirname(cursor)
        if (parent === cursor) throw error
        missingSegments.push(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)))
        cursor = parent
      }
    }
  }

  /** 验证实际读取路径位于明确授权的根或单文件内。 */
  private assertAllowed(path: string): void {
    const insideRoot = this.roots.some(root => {
      const relation = relative(root, path)
      return relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation))
    })
    if (!insideRoot && !this.files.has(path)) throw new Error(`文件不在本轮允许范围内: ${path}`)
  }

  /** watcher 热路径只做标准化后的词法范围判断，真正读取仍由 before/after 的 realpath 校验负责。 */
  private assertLexicallyAllowed(path: string): void {
    const insideRoot = this.lexicalRoots.some(root => {
      const relation = relative(root, path)
      return relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation))
    })
    const insideCanonicalRoot = this.roots.some(root => {
      const delta = relative(root, path)
      return delta === '' || (!isAbsolute(delta) && delta !== '..' && !delta.startsWith(`..${sep}`))
    })
    if (!insideRoot && !insideCanonicalRoot && !this.lexicalFiles.has(path) && !this.files.has(path)) throw new Error(`文件不在本轮允许范围内: ${path}`)
  }

  /** 有界读取文件；正文最多保留 1 MiB，二进制只保留摘要。 */
  private async readSnapshot(path: string): Promise<StoredFileSnapshot> {
    try {
      const currentCanonicalPath = await realpath(path)
      this.assertAllowed(currentCanonicalPath)
      if (currentCanonicalPath !== path) return this.createUnavailableSnapshot('path_identity_changed')
      // 固定大小缓冲区+描述符读取，即使 stat 后文件变大也不突破读取预算。
      const handle = await open(currentCanonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW)
      let bytes: Buffer
      try {
        const fileStat = await handle.stat()
        if (!fileStat.isFile()) return this.createUnavailableSnapshot('not_regular_file')
        if (fileStat.size > AGENT_RUN_FILE_TRACKER_LIMITS.maxFileBytes) {
          return { kind: 'too_large', signature: `${fileStat.size}:${fileStat.mtimeMs}:${fileStat.ctimeMs}`, retainedBytes: 0 }
        }
        const buffer = Buffer.alloc(AGENT_RUN_FILE_TRACKER_LIMITS.maxFileBytes + 1)
        let length = 0
        while (length < buffer.length) {
          const result = await handle.read(buffer, length, buffer.length - length, length)
          if (result.bytesRead === 0) break
          length += result.bytesRead
        }
        if (length > AGENT_RUN_FILE_TRACKER_LIMITS.maxFileBytes) return { kind: 'too_large', signature: `growing:${length}`, retainedBytes: 0 }
        const finalStat = await handle.stat()
        if (fileStat.size !== finalStat.size || fileStat.mtimeMs !== finalStat.mtimeMs || fileStat.ctimeMs !== finalStat.ctimeMs) return this.createUnavailableSnapshot('changed_during_read')
        bytes = buffer.subarray(0, length)
      } finally { await handle.close() }
      if (this.isBinary(bytes)) {
        return {
          kind: 'binary',
          signature: createHash('sha256').update(bytes).digest('hex'),
          retainedBytes: 0,
        }
      }
      const text = utf8Decoder.decode(bytes)
      return {
        kind: 'text',
        signature: createHash('sha256').update(bytes).digest('hex'),
        text,
        retainedBytes: bytes.byteLength,
      }
    } catch (error) {
      if (this.isMissingError(error)) return { kind: 'missing', signature: 'missing', retainedBytes: 0 }
      return this.createUnavailableSnapshot(this.errorCode(error))
    }
  }

  /** 以零字节与严格 UTF-8 解码识别不能做文本行统计的内容。 */
  private isBinary(bytes: Buffer): boolean {
    if (bytes.includes(0)) return true
    try {
      utf8Decoder.decode(bytes)
      return false
    } catch {
      return true
    }
  }

  /** 保留不可读原因摘要，不保留文件内容。 */
  private createUnavailableSnapshot(signature: string): StoredFileSnapshot {
    return { kind: 'unavailable', signature, retainedBytes: 0 }
  }

  /** 引用计数避免首次 baseline/current 相同内容占用两份预算。 */
  private retainSnapshot(snapshot: StoredFileSnapshot): StoredFileSnapshot {
    const currentReferences = this.retainedSnapshots.get(snapshot) ?? 0
    if (currentReferences === 0 && snapshot.retainedBytes > 0) {
      if (this.retainedBytes + snapshot.retainedBytes > AGENT_RUN_FILE_TRACKER_LIMITS.maxRetainedBytes) {
        return { kind: 'budget_exceeded', signature: snapshot.signature, retainedBytes: 0 }
      }
      this.retainedBytes += snapshot.retainedBytes
    }
    this.retainedSnapshots.set(snapshot, currentReferences + 1)
    return snapshot
  }

  /** 释放一个快照引用，并归还对应的本轮内容预算。 */
  private releaseSnapshot(snapshot: StoredFileSnapshot): void {
    const currentReferences = this.retainedSnapshots.get(snapshot)
    if (!currentReferences) return
    if (currentReferences === 1) {
      this.retainedSnapshots.delete(snapshot)
      this.retainedBytes -= snapshot.retainedBytes
      return
    }
    this.retainedSnapshots.set(snapshot, currentReferences - 1)
  }

  /** 仅在实际内容变化时替换当前采样并失效该文件缓存。 */
  private replaceCurrent(tracked: TrackedFile, snapshot: StoredFileSnapshot): void {
    if (this.snapshotsEqual(tracked.current, snapshot)) return
    this.releaseSnapshot(tracked.current)
    tracked.current = this.retainSnapshot(
      this.snapshotsEqual(tracked.baseline, snapshot) ? tracked.baseline : snapshot,
    )
    tracked.cachedChange = undefined
  }

  /** 比较内容类别与摘要，不依赖文件时间推断文本是否相同。 */
  private snapshotsEqual(left: StoredFileSnapshot, right: StoredFileSnapshot): boolean {
    return left.kind === right.kind && left.signature === right.signature
  }

  /** 将内存内容转换为不带正文的可传输统计。 */
  private toFileChange(tracked: TrackedFile): AgentRunFileChange {
    if (tracked.observedOnly) return { path: tracked.path, status: 'unknown', statsState: 'unavailable' }

    const status = this.resolveStatus(tracked.baseline, tracked.current)
    if (tracked.externalChange) return { path: tracked.path, status, statsState: 'external_change' }
    const incompleteState = this.resolveIncompleteState(tracked.baseline, tracked.current)
    if (incompleteState) return { path: tracked.path, status, statsState: incompleteState }

    if (status === 'unchanged') return { path: tracked.path, status, statsState: 'complete', additions: 0, deletions: 0 }
    const counts = this.calculateDiff(tracked.baseline.text ?? '', tracked.current.text ?? '')
    if (!counts) return { path: tracked.path, status, statsState: 'budget_exceeded' }
    return { path: tracked.path, status, statsState: 'complete', ...counts }
  }

  /** 从文件存在性和内容摘要区分新增、删除、修改和还原。 */
  private resolveStatus(baseline: StoredFileSnapshot, current: StoredFileSnapshot): AgentRunFileChange['status'] {
    if (baseline.kind === 'unavailable' || current.kind === 'unavailable'
      || baseline.kind === 'budget_exceeded' || current.kind === 'budget_exceeded') return 'unknown'
    if (baseline.kind === 'missing' && current.kind !== 'missing') return 'added'
    if (baseline.kind !== 'missing' && current.kind === 'missing') return 'deleted'
    if (this.snapshotsEqual(baseline, current)) return 'unchanged'
    return 'modified'
  }

  /** 按可靠性返回无法统计的原因，避免填入零值。 */
  private resolveIncompleteState(
    baseline: StoredFileSnapshot,
    current: StoredFileSnapshot,
  ): Exclude<AgentRunFileChange['statsState'], 'complete' | 'external_change' | 'budget_exceeded'> | 'budget_exceeded' | undefined {
    const kinds = new Set<StoredFileKind>([baseline.kind, current.kind])
    if (kinds.has('budget_exceeded')) return 'budget_exceeded'
    if (kinds.has('unavailable')) return 'unavailable'
    if (kinds.has('too_large')) return 'too_large'
    if (kinds.has('binary')) return 'binary'
    return undefined
  }

  /** 用有界 Myers 最短编辑距离计算行级新增/删除数，避免二次方矩阵占用。 */
  private calculateDiff(before: string, after: string): DiffCounts | undefined {
    // 单文件字节很小也可能有百万空行，先限制行数再分配行数组。
    if (this.exceedsLineBudget(before) || this.exceedsLineBudget(after)) return undefined
    const beforeLines = this.splitLines(before)
    const afterLines = this.splitLines(after)
    let prefix = 0
    while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix += 1
    let beforeEnd = beforeLines.length
    let afterEnd = afterLines.length
    while (beforeEnd > prefix && afterEnd > prefix && beforeLines[beforeEnd - 1] === afterLines[afterEnd - 1]) {
      beforeEnd -= 1
      afterEnd -= 1
    }
    const left = beforeLines.slice(prefix, beforeEnd)
    const right = afterLines.slice(prefix, afterEnd)
    if (left.length === 0) return { additions: right.length, deletions: 0 }
    if (right.length === 0) return { additions: 0, deletions: left.length }

    const maxDistance = left.length + right.length
    const furthest = new Map<number, number>([[1, 0]])
    let operations = 0
    for (let distance = 0; distance <= maxDistance; distance += 1) {
      for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
        operations += 1
        if (operations > AGENT_RUN_FILE_TRACKER_LIMITS.maxDiffOperations) return undefined
        const down = furthest.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY
        const previousRightward = furthest.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY
        let x = diagonal === -distance || (diagonal !== distance && previousRightward < down)
          ? down
          : previousRightward + 1
        let y = x - diagonal
        while (x < left.length && y < right.length && left[x] === right[y]) {
          x += 1
          y += 1
          operations += 1
          if (operations > AGENT_RUN_FILE_TRACKER_LIMITS.maxDiffOperations) return undefined
        }
        furthest.set(diagonal, x)
        if (x >= left.length && y >= right.length) {
          const lcsLength = (left.length + right.length - distance) / 2
          return {
            additions: right.length - lcsLength,
            deletions: left.length - lcsLength,
          }
        }
      }
    }
    return undefined
  }

  /** 分配 diff 数组前校验行数，避免换行密集文件造成内存峰值。 */
  private exceedsLineBudget(text: string): boolean {
    let lines = 1
    for (let index = 0; index < text.length; index += 1) {
      if (text.charCodeAt(index) === 10 && ++lines > AGENT_RUN_FILE_TRACKER_LIMITS.maxLines) return true
    }
    return false
  }

  /** 按实际行拆分并保留末尾换行差异。 */
  private splitLines(text: string): string[] {
    if (text.length === 0) return []
    const parts = text.split('\n')
    const hasTrailingNewline = parts.at(-1) === ''
    if (hasTrailingNewline) parts.pop()
    const lines = parts.map((line, index) => (
      index < parts.length - 1 || hasTrailingNewline ? `${line}\n` : line
    ))
    return lines
  }

  /** 只把 ENOENT 当作缺失，权限错误不能视为新增。 */
  private isMissingError(error: unknown): boolean {
    return this.errorCode(error) === 'ENOENT'
  }

  /** 从未知异常中提取安全的错误码。 */
  private errorCode(error: unknown): string {
    if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code
    return 'unknown_error'
  }
}
