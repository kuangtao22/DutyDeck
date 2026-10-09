import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import type {
  KnowledgeDocumentWriteInput,
  KnowledgeEntry,
  KnowledgeOutline,
  KnowledgeOutlineInput,
  KnowledgeOutlineItem,
  KnowledgePlan,
  KnowledgePlanConfirmInput,
  KnowledgePlanProposalInput,
  KnowledgeWorkflow,
  KnowledgeWorkflowPauseInput,
} from '@proma/shared'
import { ensureDirectoryDurable, writeJsonFileAtomic, writeTextFileAtomic } from '../safe-file'
import { getKnowledgeRoot, validateResolvedProject } from './paths'
import { containsKnowledgeSecret } from './sensitive-text'
import type {
  KnowledgeTransactionCurrent,
  ProjectKnowledgeServiceDependencies,
  ProjectKnowledgeStore,
  ResolvedKnowledgeProject,
} from './types'

/** 单份可读 Markdown 与 Store 正文共同采用的保守大小上限。 */
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024
/** 恢复日志可覆盖多文件移动，但必须在任何可见写入前受独立预算约束。 */
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024
/** 一轮刷新最多枚举的文件数，超过后不执行删除推断。 */
const MAX_REFRESH_FILES = 1_000
/** 扫描缓存正文总预算，防止大量大文件长期占用内存。 */
const MAX_REFRESH_CACHE_BYTES = 32 * 1024 * 1024
/** 资料库内部身份注释；读取给 Agent 时会移除。 */
const DOCUMENT_IDENTITY_PATTERN = /^<!-- proma-knowledge-document (\{[^\n]+\}) -->\n?/
/** 索引首页的资料库归属注释。 */
const VAULT_IDENTITY_PATTERN = /^<!-- proma-knowledge-vault (\{[^\n]+\}) -->\n?/
/** 进程内同一工作区正在执行的刷新任务。 */
const activeRefreshes = new Map<string, Promise<void>>()

/** 资料库流程公开给 service/facade 的最小写接口。 */
export interface KnowledgeVault {
  proposePlan(input: KnowledgePlanProposalInput): Promise<void>
  confirmPlan(input: KnowledgePlanConfirmInput): Promise<void>
  saveOutline(input: KnowledgeOutlineInput): Promise<void>
  writeDocument(input: KnowledgeDocumentWriteInput): Promise<void>
  pauseWorkflow(input: KnowledgeWorkflowPauseInput): Promise<void>
  refresh(workspaceId: string): Promise<void>
}

/** 恢复日志中的单个文件变更。 */
interface VaultJournalChange {
  path: string
  previous: string | null
  /** 本事务可能出现的最终或 rename 中间内容，用于拒绝覆盖外部编辑。 */
  next: Array<string | null>
}

/** manifest 未发布时可恢复的可见文件写入日志。 */
interface VaultJournal {
  projectId: string
  transactionId: string
  changes: VaultJournalChange[]
}

/** 从正文身份注释解析出的稳定主题与条目身份。 */
interface DocumentIdentity {
  topicKey: string
  entryId: string
}

/** 刷新阶段有界扫描的 Markdown 文件。 */
interface ScannedMarkdown {
  absolutePath: string
  relativePath: string
  content: string
  identity: DocumentIdentity | null
}

/** 进程内复用未变化文件的正文与 hash，避免每次读取前重复加载整库。 */
interface ScannedMarkdownCacheRecord {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
  file: ScannedMarkdown
}

/** 最近扫描文件缓存；上限覆盖四个满额资料库。 */
const scannedMarkdownCache = new Map<string, ScannedMarkdownCacheRecord>()
/** 当前扫描缓存持有的正文总字节数。 */
let scannedMarkdownCacheBytes = 0

/** 对字符串生成 SHA-256 十六进制摘要。 */
function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

/** 校验并规范项目内相对路径。 */
function normalizeRelativePath(value: string, label: string): string {
  /** 跨平台统一保存的路径。 */
  const normalized = value.replaceAll('\\', '/').trim()
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0') || isAbsolute(normalized)) {
    throw new Error(`${label}非法`)
  }
  /** 所有相对路径片段。 */
  const segments = normalized.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw new Error(`${label}越界`)
  if (segments.some((segment) => ['.git', '.proma', '.obsidian'].includes(segment.toLowerCase()))) {
    throw new Error(`${label}不能使用 Git、Proma 或 Obsidian 内部目录`)
  }
  return segments.join('/')
}

/** 校验路径仍位于项目根内，并拒绝现有路径链中的符号链接。 */
function resolveSafeProjectPath(project: ResolvedKnowledgeProject, relativePath: string, label: string): string {
  const normalized = normalizeRelativePath(relativePath, label)
  /** 解析后的项目内绝对路径。 */
  const absolutePath = resolve(project.projectRoot, ...normalized.split('/'))
  /** 回查项目根的相对定位。 */
  const checked = relative(project.projectRoot, absolutePath)
  if (!checked || checked.startsWith('..') || isAbsolute(checked)) throw new Error(`${label}越界`)
  /** 逐级检查已经存在的父路径。 */
  let current = project.projectRoot
  for (const segment of normalized.split('/')) {
    current = join(current, segment)
    if (!existsSync(current)) break
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error(`${label}经过符号链接`)
  }
  return absolutePath
}

/** 按层创建实际目录，任何已有非目录或符号链接都拒绝。 */
function ensureSafeDirectory(project: ResolvedKnowledgeProject, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath, '资料库目录')
  let current = project.projectRoot
  for (const segment of normalized.split('/')) {
    current = join(current, segment)
    if (existsSync(current)) {
      const stat = lstatSync(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('资料库目录不是安全普通目录')
    } else {
      ensureDirectoryDurable(current)
    }
  }
  return current
}

/** 创建目标文件的安全父目录并拒绝现有符号链接目标。 */
function prepareSafeFile(project: ResolvedKnowledgeProject, rootRelativePath: string, relativePath: string): string {
  const normalizedFile = normalizeRelativePath(relativePath, '文档路径')
  if (!normalizedFile.toLowerCase().endsWith('.md')) throw new Error('资料库正文必须是 Markdown 文件')
  /** 从资料库根开始创建的安全父目录。 */
  const parentRelative = dirname(normalizedFile).replaceAll('\\', '/')
  const combinedParent = parentRelative === '.' ? rootRelativePath : `${rootRelativePath}/${parentRelative}`
  ensureSafeDirectory(project, combinedParent)
  /** 最终文件的项目内绝对路径。 */
  const target = resolveSafeProjectPath(project, `${rootRelativePath}/${normalizedFile}`, '文档路径')
  if (existsSync(target)) {
    const stat = lstatSync(target)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('资料库文档不是安全普通文件')
  }
  return target
}

/** 有界读取普通 Markdown，拒绝符号链接、硬链接与超大文件。 */
function readSafeMarkdown(filePath: string): string {
  const stat = lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_DOCUMENT_BYTES) {
    throw new Error('资料库文档类型非法或超过大小上限')
  }
  return readFileSync(filePath, 'utf8')
}

/** 去掉只供文件重命名识别使用的内部身份注释。 */
function stripDocumentIdentity(content: string): string {
  return content.replace(DOCUMENT_IDENTITY_PATTERN, '')
}

/** 解析文件头中的稳定身份；异常注释按无身份手写文件处理。 */
function parseDocumentIdentity(content: string): DocumentIdentity | null {
  const match = DOCUMENT_IDENTITY_PATTERN.exec(content)
  if (!match?.[1]) return null
  try {
    const value = JSON.parse(match[1]) as Partial<DocumentIdentity>
    return typeof value.topicKey === 'string' && typeof value.entryId === 'string' && /^[a-f0-9]{32}$/.test(value.entryId)
      ? { topicKey: value.topicKey, entryId: value.entryId }
      : null
  } catch {
    return null
  }
}

/** 为受管正文添加不展示给 Agent 的稳定身份注释。 */
function withDocumentIdentity(content: string, identity: DocumentIdentity): string {
  const clean = stripDocumentIdentity(content).trimEnd()
  return `<!-- proma-knowledge-document ${JSON.stringify(identity)} -->\n${clean}`
}

/** 移动 Markdown 后重写相对本地链接，保持图片与关联文档指向同一库内目标。 */
function rewriteRelativeMarkdownLinks(content: string, oldPath: string, newPath: string): string {
  const oldDirectory = posix.dirname(oldPath)
  const newDirectory = posix.dirname(newPath)
  return content.replace(/(!?\[[^\]]*\]\()([^\s)]+)([^)]*\))/g, (match, prefix: string, target: string, suffix: string) => {
    if (target.startsWith('#') || target.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) return match
    const hashIndex = target.indexOf('#')
    const pathPart = hashIndex >= 0 ? target.slice(0, hashIndex) : target
    const fragment = hashIndex >= 0 ? target.slice(hashIndex) : ''
    const vaultTarget = posix.normalize(posix.join(oldDirectory, pathPart))
    if (vaultTarget === '..' || vaultTarget.startsWith('../')) return match
    const rewritten = posix.relative(newDirectory, vaultTarget) || posix.basename(vaultTarget)
    return `${prefix}${rewritten}${fragment}${suffix}`
  })
}

/** 将条目完整字段变为不可变 revision。 */
function withEntryRevision(entry: Omit<KnowledgeEntry, 'revision'>): KnowledgeEntry {
  return { ...entry, revision: sha256(JSON.stringify(entry)) }
}

/** 根据项目和主题生成稳定 32 位条目 ID。 */
function createEntryId(projectId: string, topicKey: string): string {
  return sha256(`${projectId}\0${topicKey}`).slice(0, 32)
}

/** 渲染真实索引；没有正文时只显示待补文字，不生成无效链接。 */
function renderOutline(projectId: string, plan: KnowledgePlan, outline: KnowledgeOutline): string {
  /** 按已确认分组组织的大纲项。 */
  const lines = [
    `<!-- proma-knowledge-vault ${JSON.stringify({ projectId })} -->`,
    `# ${plan.title}`,
    '',
  ]
  for (const group of plan.groups) {
    lines.push(`## ${group.title}`, '')
    const items = outline.items.filter((item) => item.groupId === group.id)
    for (const item of items) {
      const target = item.entryId && item.status !== 'missing'
        ? `[${item.title}](${item.relativePath})`
        : `${item.title}（待补）`
      lines.push(`- ${target}：${item.summary}`)
      for (const section of item.sections) lines.push(`  - ${section}`)
    }
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/** 检查已有根目录是否为空或确属当前项目资料库。 */
function assertVaultRootAvailable(project: ResolvedKnowledgeProject, rootRelativePath: string): void {
  const rootPath = resolveSafeProjectPath(project, rootRelativePath, '资料库根目录')
  if (!existsSync(rootPath)) return
  const stat = lstatSync(rootPath)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('资料库根目录不是安全普通目录')
  const children = readdirSync(rootPath)
  if (children.length === 0) return
  const indexPath = join(rootPath, '索引.md')
  if (!existsSync(indexPath)) throw new Error('资料库根目录非空，不能接管陌生目录')
  const match = VAULT_IDENTITY_PATTERN.exec(readSafeMarkdown(indexPath))
  if (!match?.[1]) throw new Error('资料库根目录非空，不能接管陌生目录')
  try {
    const identity = JSON.parse(match[1]) as { projectId?: string }
    if (identity.projectId !== project.projectId) throw new Error('资料库根目录归属冲突')
  } catch (error) {
    if (error instanceof Error && error.message === '资料库根目录归属冲突') throw error
    throw new Error('资料库根目录身份损坏')
  }
}

/** 返回恢复日志路径；日志位于 Proma 内部目录，不混入用户资料。 */
function getJournalPath(project: ResolvedKnowledgeProject): string {
  return join(getKnowledgeRoot(project), 'vault-write-journal.json')
}

/** 把一组文件修改及原内容记录到恢复日志。 */
function beginJournal(
  project: ResolvedKnowledgeProject,
  changes: Array<{ path: string; next: Array<string | null> }>,
): VaultJournal {
  const journal: VaultJournal = {
    projectId: project.projectId,
    transactionId: randomUUID(),
    changes: changes.map(({ path, next }) => ({
      path,
      previous: existsSync(path) ? readSafeMarkdown(path) : null,
      next,
    })),
  }
  if (Buffer.byteLength(JSON.stringify(journal), 'utf8') > MAX_JOURNAL_BYTES) {
    throw new Error('资料库文件事务超过安全恢复预算，请缩小单次移动范围')
  }
  writeJsonFileAtomic(getJournalPath(project), journal)
  return journal
}

/** 恢复未由 manifest 接纳的可见文件修改。 */
function rollbackJournal(project: ResolvedKnowledgeProject, journal: VaultJournal): void {
  /** 先完整复验所有路径，任一外部修改都不能造成部分回滚。 */
  const checkedChanges = [...journal.changes].reverse().map((change) => {
    /** 日志即使被外部篡改也不能写出可信项目根。 */
    const checked = relative(project.projectRoot, change.path)
    if (!checked || checked.startsWith('..') || isAbsolute(checked)) throw new Error('资料库恢复日志路径越界')
    if (resolveSafeProjectPath(project, checked, '资料库恢复路径') !== change.path) {
      throw new Error('资料库恢复日志路径不匹配')
    }
    const current = existsSync(change.path) ? readSafeMarkdown(change.path) : null
    if (current !== change.previous && !change.next.includes(current)) {
      throw new Error('资料库恢复遇到外部修改，已停止回滚')
    }
    return { change, current }
  })
  for (const { change, current } of checkedChanges) {
    if (current === change.previous) continue
    if (change.previous === null) {
      if (existsSync(change.path)) rmSync(change.path)
    } else {
      writeTextFileAtomic(change.path, change.previous)
    }
  }
  if (existsSync(getJournalPath(project))) rmSync(getJournalPath(project))
}

/** 在新流程操作前处理进程异常遗留的恢复日志。 */
function recoverPendingJournal(project: ResolvedKnowledgeProject, vaultCommitId: string | undefined): void {
  const journalPath = getJournalPath(project)
  if (!existsSync(journalPath)) return
  const stat = lstatSync(journalPath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_JOURNAL_BYTES) {
    throw new Error('资料库恢复日志损坏')
  }
  const value = JSON.parse(readFileSync(journalPath, 'utf8')) as Partial<VaultJournal>
  if (value.projectId !== project.projectId
    || typeof value.transactionId !== 'string'
    || !Array.isArray(value.changes)
    || value.changes.some((change) => !change || typeof change.path !== 'string'
      || (change.previous !== null && typeof change.previous !== 'string')
      || !Array.isArray(change.next)
      || change.next.some((content) => content !== null && typeof content !== 'string'))) {
    throw new Error('资料库恢复日志损坏')
  }
  const journal = value as VaultJournal
  if (vaultCommitId === journal.transactionId) completeJournal(project)
  else rollbackJournal(project, journal)
}

/** manifest 已发布后清理短生命周期恢复日志。 */
function completeJournal(project: ResolvedKnowledgeProject): void {
  if (existsSync(getJournalPath(project))) rmSync(getJournalPath(project))
}

/** 校验提案与文档输入不含凭据并受大小限制。 */
function assertSafePayload(value: unknown, label: string, maximumBytes = MAX_DOCUMENT_BYTES): void {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  if (Buffer.byteLength(serialized, 'utf8') > maximumBytes) throw new Error(`${label}超过大小上限`)
  if (containsKnowledgeSecret(serialized)) throw new Error(`${label}含敏感内容`)
}

/** 返回当前 workflow，未建立时给出显式默认值。 */
function currentWorkflow(current: KnowledgeTransactionCurrent): KnowledgeWorkflow {
  return current.manifest.workflow ?? { paused: false }
}

/** 校验 Agent 提交的证据仍指向当前、未被排除的登记版本。 */
function assertCurrentEvidence(input: KnowledgeDocumentWriteInput, current: KnowledgeTransactionCurrent): void {
  const entries = new Map(current.entries.map((entry) => [entry.id, entry]))
  const excluded = new Set(current.manifest.excludedSources ?? [])
  for (const reference of input.evidence) {
    const entry = entries.get(reference.entryId)
    if (!entry || entry.revision !== reference.revision) throw new Error('正文证据版本已过期')
    if (entry.document) throw new Error('新版资料库正文不能互相作为发布证据')
    if (excluded.has(entry.id) || excluded.has(entry.source.id) || entry.state === 'archived') {
      throw new Error('正文证据来源已被排除')
    }
  }
}

/** 构造项目知识资料库文件流程。 */
export function createKnowledgeVault(
  dependencies: ProjectKnowledgeServiceDependencies,
  store: ProjectKnowledgeStore,
): KnowledgeVault {
  const now = dependencies.now ?? Date.now

  /** 每次操作重新解析并校验可信项目边界。 */
  function resolveProject(workspaceId: string): ResolvedKnowledgeProject {
    const project = dependencies.resolveProject(workspaceId)
    validateResolvedProject(project)
    return project
  }

  /** Agent 只提交待确认计划，不创建用户资料库目录。 */
  async function proposePlan(input: KnowledgePlanProposalInput): Promise<void> {
    assertSafePayload(input, '知识库提案', 512 * 1024)
    normalizeRelativePath(input.rootRelativePath, '资料库根目录')
    if (input.groups.length === 0 || new Set(input.groups.map((group) => group.id)).size !== input.groups.length) {
      throw new Error('知识库提案分组非法')
    }
    const project = resolveProject(input.workspaceId)
    if (!store.readManifest(project)) await store.initialize(project, input.workspaceId)
    await store.transact(project, input.workspaceId, (current) => {
      recoverPendingJournal(project, current.manifest.vaultCommitId)
      const workflow = currentWorkflow(current)
      const entries = new Map(current.entries.map((entry) => [entry.id, entry]))
      const excluded = new Set(current.manifest.excludedSources ?? [])
      const groups = input.groups.map((group) => {
        /** 同一份材料可支撑多个主题，只去掉组内重复引用。 */
        const seenSources = new Set<string>()
        return {
        ...group,
        title: group.title.trim(),
        sources: group.sources.flatMap((source) => {
          const entry = entries.get(source.entryId)
          if (!entry || entry.revision !== source.revision) throw new Error('知识库提案来源版本已过期')
          if (entry.document) throw new Error('新版资料库正文不能作为原始提案来源')
          if (entry.state === 'archived' || excluded.has(entry.id) || excluded.has(entry.source.id)) {
            throw new Error('知识库提案来源已被排除')
          }
          const key = `${source.entryId}:${source.revision}`
          if (seenSources.has(key)) return []
          seenSources.add(key)
          return [{
            ...source,
            title: entry.title,
            relativePath: entry.source.relativePath ?? entry.source.id,
            coverage: entry.metadataOnly ? 'unsupported' as const : source.coverage === 'read' ? 'read' as const : 'discovered' as const,
          }]
        }),
        }
      })
      const proposal: KnowledgePlan = {
        id: randomUUID(),
        revision: Math.max(workflow.proposal?.revision ?? 0, workflow.approved?.revision ?? 0) + 1,
        title: input.title.trim(),
        rootRelativePath: normalizeRelativePath(input.rootRelativePath, '资料库根目录'),
        groups,
        createdAt: now(),
      }
      return { workflow: { ...workflow, proposal } }
    })
  }

  /** 用户按精确计划身份和版本确认已有分组，可只修改标题。 */
  async function confirmPlan(input: KnowledgePlanConfirmInput): Promise<void> {
    assertSafePayload(input, '知识库确认', 256 * 1024)
    const project = resolveProject(input.workspaceId)
    await store.transact(project, input.workspaceId, (current) => {
      recoverPendingJournal(project, current.manifest.vaultCommitId)
      const workflow = currentWorkflow(current)
      const proposal = workflow.proposal
      if (!proposal || proposal.id !== input.planId) throw new Error('知识库提案身份不匹配')
      if (proposal.revision !== input.expectedRevision) throw new Error('知识库提案版本冲突')
      if (input.groups.length === 0 || new Set(input.groups.map((group) => group.id)).size !== input.groups.length) {
        throw new Error('至少确认一个有效分组')
      }
      const proposedGroups = new Map(proposal.groups.map((group) => [group.id, group]))
      const groups = input.groups.map((selection) => {
        const original = proposedGroups.get(selection.id)
        if (!original) throw new Error('确认包含提案外分组')
        if (!selection.title.trim()) throw new Error('确认分组标题不能为空')
        return { ...original, title: selection.title.trim() }
      })
      assertVaultRootAvailable(project, proposal.rootRelativePath)
      if (workflow.approved && workflow.approved.rootRelativePath !== proposal.rootRelativePath) {
        throw new Error('扩展确认不能更换既有资料库根目录')
      }
      const mergedGroups = new Map((workflow.approved?.groups ?? []).map((group) => [group.id, group]))
      for (const group of groups) mergedGroups.set(group.id, group)
      const approved: KnowledgePlan = { ...proposal, groups: [...mergedGroups.values()], confirmedAt: now() }
      return { workflow: { ...workflow, proposal: undefined, approved } }
    })
  }

  /** 在已确认自由分组内保存大纲，并生成真实索引 Markdown。 */
  async function saveOutline(input: KnowledgeOutlineInput): Promise<void> {
    assertSafePayload(input, '知识库大纲', 512 * 1024)
    const project = resolveProject(input.workspaceId)
    let journal: VaultJournal | null = null
    try {
      await store.transact(project, input.workspaceId, (current) => {
        recoverPendingJournal(project, current.manifest.vaultCommitId)
        const workflow = currentWorkflow(current)
        if (workflow.paused) throw new Error('知识库流程已暂停')
        const approved = workflow.approved
        if (!approved || approved.revision !== input.planRevision) throw new Error('已确认计划版本冲突')
        const currentRevision = workflow.outline?.revision ?? 0
        if (currentRevision !== input.expectedRevision) throw new Error('知识库大纲版本冲突')
        const groupIds = new Set(approved.groups.map((group) => group.id))
        const itemIds = new Set<string>()
        const paths = new Set<string>()
        const items: KnowledgeOutlineItem[] = input.items.map((item) => {
          if (!groupIds.has(item.groupId)) throw new Error('大纲包含未确认分组')
          if (!item.id || itemIds.has(item.id)) throw new Error('大纲主题身份重复')
          itemIds.add(item.id)
          const relativePath = normalizeRelativePath(item.relativePath, '大纲文档路径')
          if (!relativePath.toLowerCase().endsWith('.md') || relativePath === '索引.md' || paths.has(relativePath)) {
            throw new Error('大纲文档路径非法或重复')
          }
          paths.add(relativePath)
          return { ...item, relativePath, status: 'pending' }
        })
        /** 已有正文允许在精确大纲版本上重组，但不能从大纲中静默删除。 */
        const movedDocuments: Array<{
          oldPath: string
          newPath: string
          oldDiskContent: string
          newDiskContent: string
          entry: KnowledgeEntry
          content: string
        }> = []
        if (workflow.outline) {
          for (const existingItem of workflow.outline.items) {
            if (!existingItem.entryId) continue
            const replacement = items.find((item) => item.id === existingItem.id)
            if (!replacement) throw new Error('不能通过大纲删除已有正文')
            const existingEntry = current.entries.find((entry) => entry.id === existingItem.entryId)
            if (!existingEntry?.document || existingEntry.document.topicKey !== existingItem.id) {
              throw new Error('已有正文身份损坏')
            }
            const oldPath = resolveSafeProjectPath(
              project,
              `${approved.rootRelativePath}/${existingEntry.document.relativePath}`,
              '原正文路径',
            )
            if (!existsSync(oldPath)) throw new Error('已有正文已被外部删除')
            const oldDiskContent = readSafeMarkdown(oldPath)
            if (sha256(oldDiskContent) !== existingEntry.document.contentRevision) {
              throw new Error('已有正文存在外部修改，拒绝移动')
            }
            const pathChanged = replacement.relativePath !== existingEntry.document.relativePath
            const newPath = pathChanged
              ? prepareSafeFile(project, approved.rootRelativePath, replacement.relativePath)
              : oldPath
            if (pathChanged && existsSync(newPath)) throw new Error('重组目标文档已存在')
            const cleanContent = stripDocumentIdentity(oldDiskContent)
            const movedContent = pathChanged
              ? rewriteRelativeMarkdownLinks(cleanContent, existingEntry.document.relativePath, replacement.relativePath)
              : cleanContent
            const newDiskContent = withDocumentIdentity(movedContent, {
              topicKey: existingItem.id,
              entryId: existingEntry.id,
            })
            const group = approved.groups.find((candidate) => candidate.id === replacement.groupId)
            if (!group) throw new Error('重组分组未确认')
            const contentRevision = sha256(newDiskContent)
            const byteSize = Buffer.byteLength(movedContent, 'utf8')
            const nextEntry = withEntryRevision({
              ...existingEntry,
              title: replacement.title,
              category: group.title,
              summary: replacement.summary,
              source: { ...existingEntry.source, revision: contentRevision },
              document: {
                ...existingEntry.document,
                groupId: replacement.groupId,
                relativePath: replacement.relativePath,
                contentRevision,
              },
              byteSize,
              indexedBytes: byteSize,
              updatedAt: now(),
            })
            if (nextEntry.revision !== existingEntry.revision) {
              movedDocuments.push({ oldPath, newPath, oldDiskContent, newDiskContent, entry: nextEntry, content: movedContent })
            }
          }
        }
        const outline: KnowledgeOutline = {
          revision: currentRevision + 1,
          planRevision: approved.revision,
          items: items.map((item) => {
            const existing = workflow.outline?.items.find((candidate) => candidate.id === item.id)
            return existing ? { ...item, entryId: existing.entryId, status: existing.status } : item
          }),
          relativePath: '索引.md',
        }
        assertVaultRootAvailable(project, approved.rootRelativePath)
        ensureSafeDirectory(project, approved.rootRelativePath)
        const indexPath = prepareSafeFile(project, approved.rootRelativePath, '索引.md')
        if (workflow.outline && existsSync(indexPath)) {
          const expected = renderOutline(project.projectId, approved, workflow.outline)
          if (readSafeMarkdown(indexPath) !== expected) throw new Error('资料库索引已被人工修改')
        }
        const nextIndexContent = renderOutline(project.projectId, approved, outline)
        const journalChanges = new Map<string, Array<string | null>>()
        for (const move of movedDocuments) {
          if (move.oldPath === move.newPath) journalChanges.set(move.oldPath, [move.newDiskContent])
          else {
            journalChanges.set(move.oldPath, [null])
            /** rename 后可能在原内容重写前崩溃，两种内容都属于本事务。 */
            journalChanges.set(move.newPath, [move.oldDiskContent, move.newDiskContent])
          }
        }
        journalChanges.set(indexPath, [nextIndexContent])
        const writeJournal = beginJournal(project,
          [...journalChanges].map(([path, next]) => ({ path, next })))
        journal = writeJournal
        for (const move of movedDocuments) {
          if (move.oldPath !== move.newPath) renameSync(move.oldPath, move.newPath)
          if (move.newDiskContent !== move.oldDiskContent) writeTextFileAtomic(move.newPath, move.newDiskContent)
        }
        writeTextFileAtomic(indexPath, nextIndexContent)
        return {
          workflow: { ...workflow, outline },
          commits: movedDocuments.map((move) => ({ entry: move.entry, content: move.content })),
          vaultCommitId: writeJournal.transactionId,
          onCommitted: () => completeJournal(project),
          onAborted: () => { if (journal) rollbackJournal(project, journal) },
        }
      })
    } catch (error) {
      throw error
    }
  }

  /** 在大纲定位内发布正文，并同步索引与不可变历史版本。 */
  async function writeDocument(input: KnowledgeDocumentWriteInput): Promise<void> {
    assertSafePayload(input.content, '知识库正文')
    assertSafePayload(input.summary, '知识库摘要', 64 * 1024)
    if (input.userEvidence) assertSafePayload(input.userEvidence, '用户原话证据', 64 * 1024)
    const project = resolveProject(input.workspaceId)
    let journal: VaultJournal | null = null
    try {
      await store.transact(project, input.workspaceId, (current) => {
        recoverPendingJournal(project, current.manifest.vaultCommitId)
        const workflow = currentWorkflow(current)
        if (workflow.paused) throw new Error('知识库流程已暂停')
        const approved = workflow.approved
        const outline = workflow.outline
        if (!approved || approved.revision !== input.planRevision) throw new Error('已确认计划版本冲突')
        if (!outline || outline.revision !== input.outlineRevision) throw new Error('知识库大纲版本冲突')
        const item = outline.items.find((candidate) => candidate.id === input.itemId)
        if (!item) throw new Error('知识库大纲项不存在')
        const group = approved.groups.find((candidate) => candidate.id === item.groupId)
        if (!group) throw new Error('知识库大纲分组已失效')
        assertCurrentEvidence(input, current)
        const existing = item.entryId ? current.entries.find((entry) => entry.id === item.entryId) : undefined
        if (existing?.state === 'archived' && existing.freshness === 'unavailable') throw new Error('已删除正文不能由旧请求复活')
        if ((existing?.revision ?? null) !== input.expectedRevision) throw new Error('知识正文条目版本冲突')
        if (!existing && input.expectedRevision !== null) throw new Error('知识正文条目不存在')
        const entryId = existing?.id ?? createEntryId(project.projectId, item.id)
        const documentPath = prepareSafeFile(project, approved.rootRelativePath, item.relativePath)
        if (existing) {
          if (!existsSync(documentPath)) throw new Error('知识正文已被外部删除')
          if (sha256(readSafeMarkdown(documentPath)) !== existing.document?.contentRevision) {
            throw new Error('知识正文存在外部修改，拒绝覆盖')
          }
        } else if (existsSync(documentPath)) {
          throw new Error('目标文档已存在，拒绝接管')
        }
        const diskContent = withDocumentIdentity(input.content, { topicKey: item.id, entryId })
        const expectedStatus = input.complete ? 'ready' : 'partial'
        /** 新请求未携带用户原话时保留当前版本证据，避免更新正文时静默丢失。 */
        const userEvidence = input.userEvidence ?? existing?.userEvidence
        if (existing
          && existing.document?.contentRevision === sha256(diskContent)
          && existing.summary === input.summary
          && existing.title === item.title
          && existing.category === group.title
          && JSON.stringify(existing.evidence ?? []) === JSON.stringify(input.evidence)
          && JSON.stringify(existing.userEvidence) === JSON.stringify(userEvidence)
          && item.status === expectedStatus) {
          return {}
        }
        const indexPath = prepareSafeFile(project, approved.rootRelativePath, outline.relativePath)
        if (existsSync(indexPath)
          && readSafeMarkdown(indexPath) !== renderOutline(project.projectId, approved, outline)) {
          throw new Error('资料库索引已被人工修改')
        }
        const nextOutline: KnowledgeOutline = {
          ...outline,
          revision: outline.revision + 1,
          items: outline.items.map((candidate) => candidate.id === item.id
            ? { ...candidate, entryId, status: expectedStatus }
            : candidate),
        }
        const byteSize = Buffer.byteLength(input.content, 'utf8')
        /** source revision 表示本次磁盘正文版本；中文注释明确其不等同于 entry revision。 */
        const sourceRevision = sha256(diskContent)
        const entry = withEntryRevision({
          id: entryId,
          title: item.title,
          category: group.title,
          kind: 'document',
          state: 'draft',
          freshness: 'unverified',
          summary: input.summary,
          source: { kind: 'managed', id: `vault:${project.projectId}:${item.id}`, revision: sourceRevision },
          evidence: input.evidence,
          userEvidence,
          document: {
            topicKey: item.id,
            groupId: item.groupId,
            rootRelativePath: approved.rootRelativePath,
            relativePath: item.relativePath,
            contentRevision: sourceRevision,
          },
          byteSize,
          indexedBytes: byteSize,
          truncated: false,
          metadataOnly: false,
          updatedAt: now(),
        })
        const nextIndexContent = renderOutline(project.projectId, approved, nextOutline)
        const writeJournal = beginJournal(project, [
          { path: documentPath, next: [diskContent] },
          { path: indexPath, next: [nextIndexContent] },
        ])
        journal = writeJournal
        writeTextFileAtomic(documentPath, diskContent)
        writeTextFileAtomic(indexPath, nextIndexContent)
        return {
          workflow: { ...workflow, outline: nextOutline },
          commits: [{ entry, content: input.content }],
          vaultCommitId: writeJournal.transactionId,
          onCommitted: () => completeJournal(project),
          onAborted: () => { if (journal) rollbackJournal(project, journal) },
        }
      })
    } catch (error) {
      throw error
    }
  }

  /** 用户暂停或继续当前资料库流程。 */
  async function pauseWorkflow(input: KnowledgeWorkflowPauseInput): Promise<void> {
    const project = resolveProject(input.workspaceId)
    await store.transact(project, input.workspaceId, (current) => {
      recoverPendingJournal(project, current.manifest.vaultCommitId)
      return { workflow: { ...currentWorkflow(current), paused: input.paused } }
    })
  }

  /** 有界扫描资料库根内的普通 Markdown；隐藏目录与内部目录不进入。 */
  function scanVault(rootPath: string): { files: ScannedMarkdown[]; complete: boolean } {
    const files: ScannedMarkdown[] = []
    let complete = true
    /** 文件与目录共享枚举预算，空目录树也不能形成无界遍历。 */
    let discoveredEntries = 0
    const visit = (directoryPath: string): void => {
      if (!complete) return
      for (const child of readdirSync(directoryPath, { withFileTypes: true })) {
        discoveredEntries += 1
        if (files.length >= MAX_REFRESH_FILES || discoveredEntries > MAX_REFRESH_FILES * 4) {
          complete = false
          return
        }
        if (child.name.startsWith('.') || child.name === '索引.md') continue
        const childPath = join(directoryPath, child.name)
        if (child.isSymbolicLink()) continue
        if (child.isDirectory()) {
          visit(childPath)
          continue
        }
        if (!child.isFile() || !child.name.toLowerCase().endsWith('.md')) continue
        try {
          const stat = lstatSync(childPath)
          const cached = scannedMarkdownCache.get(childPath)
          if (cached
            && cached.dev === stat.dev
            && cached.ino === stat.ino
            && cached.size === stat.size
            && cached.mtimeMs === stat.mtimeMs
            && cached.ctimeMs === stat.ctimeMs) {
            scannedMarkdownCache.delete(childPath)
            scannedMarkdownCache.set(childPath, cached)
            files.push(cached.file)
            continue
          }
          const content = readSafeMarkdown(childPath)
          const file: ScannedMarkdown = {
            absolutePath: childPath,
            relativePath: relative(rootPath, childPath).replaceAll('\\', '/'),
            content,
            identity: parseDocumentIdentity(content),
          }
          const replaced = scannedMarkdownCache.get(childPath)
          if (replaced) scannedMarkdownCacheBytes -= Buffer.byteLength(replaced.file.content, 'utf8')
          scannedMarkdownCache.set(childPath, {
            dev: stat.dev,
            ino: stat.ino,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            ctimeMs: stat.ctimeMs,
            file,
          })
          scannedMarkdownCacheBytes += Buffer.byteLength(content, 'utf8')
          while (scannedMarkdownCache.size > MAX_REFRESH_FILES * 4
            || scannedMarkdownCacheBytes > MAX_REFRESH_CACHE_BYTES) {
            const oldest = scannedMarkdownCache.keys().next().value
            if (typeof oldest !== 'string') break
            const removed = scannedMarkdownCache.get(oldest)
            if (removed) scannedMarkdownCacheBytes -= Buffer.byteLength(removed.file.content, 'utf8')
            scannedMarkdownCache.delete(oldest)
          }
          files.push(file)
        } catch {
          complete = false
          return
        }
      }
    }
    visit(rootPath)
    return { files, complete }
  }

  /** 执行一轮磁盘权威状态合并。 */
  async function refreshOnce(workspaceId: string): Promise<void> {
    const project = resolveProject(workspaceId)
    let manifest = store.readManifest(project)
    if (!manifest) return
    /** 扫描前先持锁恢复崩溃中间态，不能把半写文件当成外部编辑。 */
    await store.transact(project, workspaceId, (current) => {
      recoverPendingJournal(project, current.manifest.vaultCommitId)
      return {}
    })
    manifest = store.readManifest(project)
    const approved = manifest?.workflow?.approved
    if (!manifest || !approved) return
    const rootPath = resolveSafeProjectPath(project, approved.rootRelativePath, '资料库根目录')
    if (!existsSync(rootPath)) return
    assertVaultRootAvailable(project, approved.rootRelativePath)
    const scan = scanVault(rootPath)
    const refreshedManifest = await store.transact(project, workspaceId, (current) => {
      recoverPendingJournal(project, current.manifest.vaultCommitId)
      const workflow = currentWorkflow(current)
      const currentApproved = workflow.approved
      if (!currentApproved || currentApproved.revision !== approved.revision) throw new Error('刷新期间计划版本变化')
      const entriesById = new Map(current.entries.map((entry) => [entry.id, entry]))
      const knownDocuments = current.entries.filter((entry) => entry.document?.rootRelativePath === approved.rootRelativePath)
      const seenIds = new Set<string>()
      /** 先统计完整扫描结果；只有唯一 marker 才能证明 rename 身份。 */
      const markerCounts = new Map<string, number>()
      for (const file of scan.files) {
        if (!file.identity) continue
        const key = `${file.identity.entryId}:${file.identity.topicKey}`
        markerCounts.set(key, (markerCounts.get(key) ?? 0) + 1)
      }
      const commits: Array<{ entry: KnowledgeEntry; content: string }> = []
      let nextOutline = workflow.outline
      for (const file of scan.files) {
        const markerEntry = file.identity ? entriesById.get(file.identity.entryId) : undefined
        const markerKey = file.identity ? `${file.identity.entryId}:${file.identity.topicKey}` : ''
        const identityEntry = markerEntry
          && markerEntry.document?.topicKey === file.identity?.topicKey
          && markerCounts.get(markerKey) === 1
          ? markerEntry
          : undefined
        const pathEntry = knownDocuments.find((entry) => entry.document?.relativePath === file.relativePath)
        const existing = identityEntry ?? pathEntry
        const topicKey = existing?.document?.topicKey ?? `external:${sha256(file.relativePath).slice(0, 16)}`
        const entryId = existing?.id ?? createEntryId(project.projectId, topicKey)
        seenIds.add(entryId)
        const contentRevision = sha256(file.content)
        if (existing?.document?.contentRevision === contentRevision
          && existing.document.relativePath === file.relativePath
          && existing.freshness !== 'unavailable') continue
        const outlineItem = nextOutline?.items.find((item) => item.id === topicKey)
        const groupId = outlineItem?.groupId ?? existing?.document?.groupId ?? currentApproved.groups[0]?.id
        const group = currentApproved.groups.find((candidate) => candidate.id === groupId)
        if (!groupId || !group) continue
        const cleanContent = stripDocumentIdentity(file.content)
        const byteSize = Buffer.byteLength(cleanContent, 'utf8')
        /** 外部变更只声明未验证草稿，不继承旧证据背书。 */
        const entry = withEntryRevision({
          ...(existing ?? {
            id: entryId,
            title: outlineItem?.title ?? basename(file.relativePath, '.md'),
            category: group.title,
            kind: 'document' as const,
            summary: outlineItem?.summary ?? `资料库文件：${file.relativePath}`,
            source: { kind: 'managed' as const, id: `vault:${project.projectId}:${topicKey}`, revision: contentRevision },
            truncated: false,
            metadataOnly: false,
          }),
          state: 'draft',
          freshness: 'unverified',
          evidence: undefined,
          source: { ...(existing?.source ?? { kind: 'managed' as const, id: `vault:${project.projectId}:${topicKey}` }), revision: contentRevision },
          document: {
            topicKey,
            groupId,
            rootRelativePath: currentApproved.rootRelativePath,
            relativePath: file.relativePath,
            contentRevision,
          },
          byteSize,
          indexedBytes: byteSize,
          updatedAt: now(),
        })
        commits.push({ entry, content: cleanContent })
        if (nextOutline && outlineItem && outlineItem.relativePath !== file.relativePath) {
          nextOutline = {
            ...nextOutline,
            revision: nextOutline.revision + 1,
            items: nextOutline.items.map((item) => item.id === topicKey ? { ...item, relativePath: file.relativePath } : item),
          }
        }
      }
      if (scan.complete) {
        for (const entry of knownDocuments) {
          if (seenIds.has(entry.id) || entry.state === 'archived') continue
          const historical = store.readContent(project, current.manifest, entry.id) ?? ''
          commits.push({
            entry: withEntryRevision({ ...entry, state: 'archived', freshness: 'unavailable', evidence: undefined, updatedAt: now() }),
            content: historical,
          })
          if (nextOutline) {
            nextOutline = {
              ...nextOutline,
              revision: nextOutline.revision + 1,
              items: nextOutline.items.map((item) => item.entryId === entry.id ? { ...item, status: 'missing' } : item),
            }
          }
        }
      }
      if (commits.length === 0 && nextOutline === workflow.outline) return {}
      if (nextOutline) {
        const indexPath = prepareSafeFile(project, currentApproved.rootRelativePath, nextOutline.relativePath)
        if (workflow.outline && existsSync(indexPath)
          && readSafeMarkdown(indexPath) !== renderOutline(project.projectId, currentApproved, workflow.outline)) {
          throw new Error('资料库索引已被人工修改')
        }
        writeTextFileAtomic(indexPath, renderOutline(project.projectId, currentApproved, nextOutline))
      }
      return { commits, workflow: nextOutline ? { ...workflow, outline: nextOutline } : workflow }
    })
    /** refresh 是显式恢复入口，因此即使原缓存丢失也按最终 manifest 重建。 */
    const indexRevision = refreshedManifest.indexRevision ?? refreshedManifest.revision
    if (store.readIndex(project, indexRevision)) return
    const records: Record<string, { entryId: string; entryRevision: string; text: string }> = {}
    for (const entry of store.readEntries(project, refreshedManifest)) {
      if (entry.state === 'archived') continue
      const content = readVaultDocument(project, entry) ?? store.readContent(project, refreshedManifest, entry.id)
      if (content === null) continue
      records[entry.id] = {
        entryId: entry.id,
        entryRevision: entry.revision,
        text: Buffer.from(content, 'utf8').subarray(0, 256 * 1024).toString('utf8'),
      }
    }
    store.writeIndex(project, {
      schemaVersion: 1,
      projectId: project.projectId,
      manifestRevision: indexRevision,
      records,
    })
  }

  /** 合并同一工作区并发刷新，避免重复扫描和相互覆盖。 */
  async function refresh(workspaceId: string): Promise<void> {
    const existing = activeRefreshes.get(workspaceId)
    if (existing) return existing
    const task = refreshOnce(workspaceId).finally(() => activeRefreshes.delete(workspaceId))
    activeRefreshes.set(workspaceId, task)
    return task
  }

  return { proposePlan, confirmPlan, saveOutline, writeDocument, pauseWorkflow, refresh }
}

/** 从当前磁盘读取权威资料库正文；来源失效不隐藏仍存在的本地正文。 */
export function readVaultDocument(project: ResolvedKnowledgeProject, entry: KnowledgeEntry): string | null {
  if (!entry.document) return null
  try {
    const rootRelativePath = normalizeRelativePath(entry.document.rootRelativePath, '资料库根目录')
    const documentRelativePath = normalizeRelativePath(entry.document.relativePath, '资料库文档路径')
    const filePath = resolveSafeProjectPath(project, `${rootRelativePath}/${documentRelativePath}`, '资料库文档路径')
    if (!existsSync(filePath)) return null
    const diskContent = readSafeMarkdown(filePath)
    if (sha256(diskContent) !== entry.document.contentRevision) return null
    return stripDocumentIdentity(diskContent)
  } catch {
    return null
  }
}
