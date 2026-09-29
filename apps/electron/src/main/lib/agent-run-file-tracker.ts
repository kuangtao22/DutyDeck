import type { AgentRunFileChange } from '@proma/shared'
import { createHash } from 'node:crypto'
import { open, realpath } from 'node:fs/promises'
import { constants, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/** 单文件、每轮留存、数量与计算预算；超限保持可见但不给伪精确数字。 */
export const AGENT_RUN_FILE_TRACKER_LIMITS = {
  maxFileBytes: 1024 * 1024,
  maxRetainedBytes: 8 * 1024 * 1024,
  maxFiles: 256,
  maxDiffOperations: 200_000,
  maxLines: 50_000,
} as const

/** 编排层传入的显式授权范围；附加单文件不会扩张为整个父目录。 */
interface AgentRunFileTrackerOptions {
  cwd: string
  roots: string[]
  files?: string[]
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
  private readonly tracked = new Map<string, TrackedFile>()
  private readonly retainedSnapshots = new Map<StoredFileSnapshot, number>()
  private retainedBytes = 0
  /** 达到文件数量预算时让上层明确提示统计不完整。 */
  truncated = false
  /** 已获准路径的词法别名，watcher 无需额外读取磁盘。 */
  private readonly aliases = new Map<string, string>()

  constructor(options: AgentRunFileTrackerOptions) {
    this.cwd = resolve(this.expandHome(options.cwd))
    this.lexicalRoots = options.roots.map(path => this.resolveInput(path))
    this.lexicalFiles = new Set((options.files ?? []).map(path => this.resolveInput(path)))
    this.roots = options.roots.map(path => this.canonicalizeConfiguredPath(path))
    this.files = new Set((options.files ?? []).map(path => this.canonicalizePotentialPathSync(this.resolveInput(path))))
  }

  /** 在受控写工具实际执行前捕获首次基线，并检查此前是否混入外部改动。 */
  async before(path: string): Promise<void> {
    const lexicalPath = this.resolveInput(path)
    const canonicalPath = await this.resolveAllowedPath(path)
    const observedKey = this.observationKey(lexicalPath)
    this.aliases.set(lexicalPath, canonicalPath)
    const existing = this.tracked.get(canonicalPath) ?? this.tracked.get(observedKey)
    if (existing) {
      if (existing.observedOnly) {
        if (lexicalPath !== canonicalPath) {
          this.tracked.delete(observedKey)
          existing.canonicalPath = canonicalPath
          this.tracked.set(canonicalPath, existing)
        }
        return
      }
      const actual = await this.readSnapshot(canonicalPath)
      if (!this.snapshotsEqual(existing.current, actual)) {
        existing.externalChange = true
        existing.cachedChange = undefined
      }
      this.replaceCurrent(existing, actual)
      return
    }
    if (this.tracked.size >= AGENT_RUN_FILE_TRACKER_LIMITS.maxFiles) { this.truncated = true; return }

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
      if (this.tracked.size >= AGENT_RUN_FILE_TRACKER_LIMITS.maxFiles) { this.truncated = true; return }
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

  /** 不读取磁盘的受管范围判断，同时接受显式根的真实路径别名。 */
  owns(path: string): boolean {
    try { this.assertLexicallyAllowed(this.resolveInput(path)); return true } catch { return false }
  }

  /** 多轮同时触碰同一文件时永久撤销精确行数，避免双方冒领相同最终内容。 */
  invalidate(path: string): void {
    const tracked = this.tracked.get(this.observationKey(this.resolveInput(path)))
    if (!tracked || tracked.observedOnly) return
    tracked.externalChange = true
    tracked.cachedChange = undefined
  }

  /** 查询本轮写工具是否已触碰路径，用于共享根的精确归属。 */
  hasControlledPath(path: string): boolean {
    const tracked = this.tracked.get(this.observationKey(this.resolveInput(path)))
    return tracked !== undefined && !tracked.observedOnly
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
