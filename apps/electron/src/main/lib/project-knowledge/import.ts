import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, opendir, rename, rm } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { writeJsonFileAtomicSecure } from '../safe-file'
import { containsKnowledgeSecret } from './sensitive-text'

/** 导入的文件类型；非正文资料仅作为附件/分析来源保留，不执行。 */
type ImportKind = 'document' | 'attachment'
/** 原生文件选择器授予的来源及当前项目代次校验。 */
export interface KnowledgeImportOptions {
  projectRoot: string
  paths: string[]
  assertCurrent: () => void
}
/** 导入结果中的文件地址均相对当前项目。 */
export interface KnowledgeImportResult {
  rootRelativePath: string
  imported: number
  unchanged: number
  files: Array<{ relativePath: string; kind: ImportKind }>
  skipped: Array<{ path: string; reason: string }>
}
/** 包内可信文件记录，用于内容版本和人工变更检查。 */
interface ImportFile { path: string; kind: ImportKind; hash: string; bytes: number }
/** 正文与普通来源类型白名单。 */
const DOCUMENTS = new Set(['.md', '.mdx', '.txt', '.rst', '.adoc'])
/** 不执行的附件/源码白名单。 */
const ATTACHMENTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.html', '.css', '.js', '.jsx', '.ts', '.tsx', '.swift', '.go', '.py', '.java', '.rs', '.c', '.h', '.cpp', '.xml', '.mp3', '.mp4', '.wav'])
/** 有界扫描：逐个异步读取，内存峰值约单文件 32 MiB。 */
const MAX_FILE = 32 * 1024 * 1024
const MAX_TOTAL = 256 * 1024 * 1024
const MAX_ENTRIES = 4096
/** 内部目录与凭据文件不能作为知识导入。 */
const BLOCKED = /^(?:\.|node_modules$|vendor$|credentials?(?:\.|$)|secrets?(?:\.|$)|id_rsa$|id_ed25519$)|\.(?:pem|key|p12|pfx|keystore)$/i
/** 字节指纹不保存正文、凭据或绝对来源路径。 */
function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }
/** 验证 child 位于 parent 内；相同目录也算包含。 */
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}
/** 每个分量都拒绝软链接，避免只校验叶子而穿过外部目录。 */
async function checkedPath(path: string): Promise<void> {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('必须使用绝对路径')
  let current = parse(path).root
  for (const part of relative(current, path).split(sep).filter(Boolean)) {
    current = join(current, part)
    const stat = await lstat(current)
    if (stat.isSymbolicLink()) throw new Error('符号链接不可导入')
  }
}
/** 逐层建立目标目录，所有现有分量均须为真实目录。 */
async function ensureDirectory(path: string): Promise<void> {
  try { await checkedPath(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await ensureDirectory(dirname(path))
    try { await mkdir(path, { mode: 0o700 }) } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure
    }
    await checkedPath(path)
  }
  if (!(await lstat(path)).isDirectory()) throw new Error('目标不是目录')
}
/** 安全有界读取，使用同一个 no-follow 句柄验证身份和大小。 */
async function readBounded(path: string, limit = MAX_FILE): Promise<Buffer> {
  await checkedPath(path)
  const before = await lstat(path)
  if (!before.isFile() || before.size > limit) throw new Error('不是普通文件或超过单文件预算')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.size > limit) throw new Error('来源身份变化或超过预算')
    const bytes = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < bytes.length) {
      const chunk = await handle.read(bytes, length, bytes.length - length, null)
      if (!chunk.bytesRead) break
      length += chunk.bytesRead
    }
    const after = await handle.stat()
    await checkedPath(path)
    if (length !== stat.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error('读取期间来源发生变化')
    return bytes.subarray(0, length)
  } finally { await handle.close() }
}
/** 从 Markdown/HTML 提取明确的本地链接；不解析或执行脚本。 */
function dependencies(text: string): string[] {
  return [...text.matchAll(/(?:\]\(\s*<?([^\s)>]+)>?|(?:src|href)=["']([^"']+)["']|^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?)/gm)]
    .map(match => match[1] ?? match[2] ?? match[3] ?? '')
    .filter(value => value && !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value))
}

/** 保留授权来源的完整字节和相对目录，以不可覆盖的版本包原子发布；返回成功和跳过项。 */
export async function importKnowledgeSources(options: KnowledgeImportOptions): Promise<KnowledgeImportResult> {
  const { projectRoot, paths, assertCurrent } = options
  assertCurrent()
  await checkedPath(projectRoot)
  assertCurrent()
  const result: KnowledgeImportResult = { rootRelativePath: '.context/knowledge-imports', imported: 0, unchanged: 0, files: [], skipped: [] }
  const destination = join(projectRoot, result.rootRelativePath)
  let count = 0
  let total = 0
  for (const selected of [...new Set(paths)]) {
    assertCurrent()
    let staging: string | undefined
    try {
      if (!isAbsolute(selected)) throw new Error('来源必须是绝对路径')
      const source = resolve(selected)
      await checkedPath(source)
      assertCurrent()
      const sourceStat = await lstat(source)
      const sourceRoot = sourceStat.isDirectory() ? source : dirname(source)
      if (within(source, destination) || within(destination, source)) throw new Error('来源不能包含导入目录或位于导入目录内')
      if (BLOCKED.test(basename(source))) throw new Error('隐藏内部目录或凭据不可导入')
      await ensureDirectory(destination)
      assertCurrent()
      const rootHash = digest(source)
      const rootName = `${basename(source).replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 60)}-${rootHash.slice(0, 16)}`
      const packageRoot = join(destination, rootName)
      await ensureDirectory(packageRoot)
      staging = join(packageRoot, `.staging-${randomUUID()}`)
      await mkdir(staging, { mode: 0o700 })
      const entries: ImportFile[] = []
      const visited = new Set<string>()
      /** 单文件模式只遍历明确链接；目录模式遍历受限树，均不跟随软链接。 */
      const visit = async (path: string, depth: number): Promise<void> => {
        assertCurrent()
        if (visited.has(path)) return
        visited.add(path)
        if (++count > MAX_ENTRIES || depth > 48) throw new Error('超过文件数量或目录深度预算')
        try {
          if (!within(sourceRoot, path)) throw new Error('链接越界，未获得来源目录授权')
          const rel = relative(sourceRoot, path)
          if (rel.split(sep).some(part => BLOCKED.test(part))) throw new Error('隐藏内部目录或凭据不可导入')
          await checkedPath(path)
          const stat = await lstat(path)
          if (stat.isDirectory()) {
            const directory = await opendir(path)
            for await (const child of directory) await visit(join(path, child.name), depth + 1)
            return
          }
          const extension = extname(path).toLowerCase()
          const kind: ImportKind = DOCUMENTS.has(extension) ? 'document' : 'attachment'
          if (!DOCUMENTS.has(extension) && !ATTACHMENTS.has(extension)) throw new Error('不支持的文件类型')
          /** 剩余额度在打开正文前检查，耗尽后不继续读取每个超额大文件。 */
          const remainingBytes = MAX_TOTAL - total
          if (stat.size > remainingBytes) throw new Error('超过总字节预算')
          const bytes = await readBounded(path, Math.min(MAX_FILE, remainingBytes))
          assertCurrent()
          if (total + bytes.length > MAX_TOTAL) throw new Error('超过总字节预算')
          total += bytes.length
          if (containsKnowledgeSecret(bytes.toString('utf8'))) throw new Error('内容疑似包含凭据，已跳过')
          const output = join(staging!, rel)
          await ensureDirectory(dirname(output))
          assertCurrent()
          const file = await open(output, 'wx', 0o600)
          try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
          entries.push({ path: rel.split(sep).join('/'), kind, hash: digest(bytes), bytes: bytes.length })
          if (!sourceStat.isDirectory() && kind === 'document') {
            for (const link of dependencies(bytes.toString('utf8'))) {
              try { await visit(resolve(dirname(path), decodeURIComponent(link.split(/[?#]/)[0]!)), depth + 1) }
              catch (error) { assertCurrent(); result.skipped.push({ path: link, reason: (error as Error).message }) }
            }
          }
        } catch (error) {
          assertCurrent()
          result.skipped.push({ path, reason: (error as Error).message })
          if (count > MAX_ENTRIES) throw error
        }
        assertCurrent()
      }
      await visit(source, 0)
      assertCurrent()
      if (!entries.length) continue
      entries.sort((a, b) => a.path.localeCompare(b.path))
      const version = digest(JSON.stringify(entries))
      let published = join(packageRoot, version)
      let unchanged = false
      try {
        const manifest = JSON.parse((await readBounded(join(published, '.import-manifest.json'), 2 * 1024 * 1024)).toString('utf8')) as { version?: unknown; sourceHash?: unknown; files?: unknown }
        if (manifest.version !== version || manifest.sourceHash !== rootHash || JSON.stringify(manifest.files) !== JSON.stringify(entries)) throw new Error('包清单变化')
        for (const entry of entries) {
          assertCurrent()
          if (digest(await readBounded(join(published, entry.path))) !== entry.hash) throw new Error('包内正文已被人工修改')
        }
        unchanged = true
      } catch {
        assertCurrent()
        try { await lstat(published); published = `${published}-${randomUUID()}` } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      if (!unchanged) {
        assertCurrent()
        await checkedPath(staging)
        writeJsonFileAtomicSecure(join(staging, '.import-manifest.json'), { schemaVersion: 1, sourceHash: rootHash, version, files: entries }, { expectedDestination: { kind: 'missing' } })
        await checkedPath(packageRoot)
        assertCurrent()
        await rename(staging, published)
        staging = undefined
        result.imported += entries.length
      } else result.unchanged += entries.length
      result.files.push(...entries.map(entry => ({ relativePath: relative(projectRoot, join(published, entry.path)).split(sep).join('/'), kind: entry.kind })))
    } catch (error) {
      assertCurrent()
      result.skipped.push({ path: selected, reason: (error as Error).message })
    } finally {
      if (staging) {
        // 清理仅属于本轮的随机暂存包；父链变化时不越界删除。
        try { await checkedPath(staging); await rm(staging, { recursive: true, force: true }) } catch { /* 保留异常暂存供诊断 */ }
      }
    }
  }
  assertCurrent()
  return result
}
