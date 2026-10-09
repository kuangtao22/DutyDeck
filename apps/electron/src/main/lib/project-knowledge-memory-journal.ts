import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { acquireMediaFileLock } from './media/media-file-lock'
import { readWorkspaceAutoMemoryFile, appendWorkspaceAutoMemoryFile } from './agent-workspace-manager'
import { getAgentWorkspacePath } from './config-paths'
import { writeTextFileAtomic } from './safe-file'
import { isWorkspaceSlug } from './workspace-slug'

/** 显式记忆追加的可恢复操作记录。 */
export interface WorkspaceMemoryOperation {
  operationId: string
  workspaceSlug: string
  sessionId: string
  toolCallId: string
  userMessageId?: string
  relativePath: string
  baselineDigest: string
  targetDigest: string
  content: string
  status: 'intent' | 'committed' | 'conflict'
  updatedAt: number
}

/** 供项目知识服务去重的已提交记忆来源。 */
export interface CommittedKnowledgeMemorySource {
  operationId: string
  relativePath: string
  contentDigest: string
  content: string
}

const JOURNAL_FILE = '.memory-operations.jsonl'
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024
const MAX_MEMORY_CONTENT_BYTES = 20_000
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const DIGEST_PATTERN = /^[a-f0-9]{64}$/

/** 会话与供应商工具调用 ID 只作为不透明身份参与哈希，允许 `|` 等真实协议分隔符。 */
function isSafeOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** 从一次真实工具调用的权威身份派生稳定操作 ID，确保 SDK 重试不会生成新操作。 */
function deriveOperationId(input: Pick<WorkspaceMemoryOperation, 'workspaceSlug' | 'sessionId' | 'toolCallId' | 'userMessageId'>): string {
  return createHash('sha256')
    .update('proma-memory-operation-v1\0')
    .update(input.workspaceSlug).update('\0')
    .update(input.sessionId).update('\0')
    .update(input.userMessageId ?? '').update('\0')
    .update(input.toolCallId)
    .digest('hex')
}

function journalPath(workspaceSlug: string): string {
  if (!isWorkspaceSlug(workspaceSlug)) throw new Error('记忆操作日志非法')
  return join(getAgentWorkspacePath(workspaceSlug), JOURNAL_FILE)
}

/** 校验日志内相对路径的纯语法；真实文件访问仍交由工作区 memory 安全边界复核。 */
function isSafeMemoryRelativePath(relativePath: string): boolean {
  if (relativePath.length === 0 || relativePath.length > 1024 || isAbsolute(relativePath)
    || /^[A-Za-z]:[\\/]/.test(relativePath) || relativePath.includes('\0')) return false
  /** 日志统一按正斜杠检查目录层级，拒绝空段、当前目录与上级目录。 */
  const segments = relativePath.replace(/\\/g, '/').split('/')
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    && relativePath.toLowerCase().endsWith('.md')
}

/** 严格解析单条持久化记录，拒绝未知字段、伪造工作区及不安全路径。 */
function parseOperation(value: unknown, authoritativeWorkspaceSlug: string): WorkspaceMemoryOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('记忆操作日志非法')
  /** JSON 记录只允许状态机合同中的已知字段，避免恢复时默默信任扩展载荷。 */
  const record = value as Record<string, unknown>
  const allowedKeys = new Set([
    'operationId', 'workspaceSlug', 'sessionId', 'toolCallId', 'userMessageId', 'relativePath',
    'baselineDigest', 'targetDigest', 'content', 'status', 'updatedAt',
  ])
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) throw new Error('记忆操作日志非法')
  if (typeof record.operationId !== 'string' || !SAFE_ID_PATTERN.test(record.operationId)
    || record.workspaceSlug !== authoritativeWorkspaceSlug
    || !isSafeOpaqueId(record.sessionId)
    || !isSafeOpaqueId(record.toolCallId)
    || (record.userMessageId !== undefined && !isSafeOpaqueId(record.userMessageId))
    || typeof record.relativePath !== 'string' || !isSafeMemoryRelativePath(record.relativePath)
    || typeof record.baselineDigest !== 'string' || !DIGEST_PATTERN.test(record.baselineDigest)
    || typeof record.targetDigest !== 'string' || !DIGEST_PATTERN.test(record.targetDigest)
    || typeof record.content !== 'string' || record.content.trim().length === 0
    || Buffer.byteLength(record.content, 'utf8') > MAX_MEMORY_CONTENT_BYTES
    || (record.status !== 'intent' && record.status !== 'committed' && record.status !== 'conflict')
    || !Number.isSafeInteger(record.updatedAt) || Number(record.updatedAt) < 0) {
    throw new Error('记忆操作日志非法')
  }
  return record as unknown as WorkspaceMemoryOperation
}

function readOperations(workspaceSlug: string): WorkspaceMemoryOperation[] {
  const path = journalPath(workspaceSlug)
  if (!existsSync(path)) return []
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JOURNAL_BYTES) throw new Error('记忆操作日志非法')
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean)
      .map((line) => parseOperation(JSON.parse(line), workspaceSlug))
  } catch {
    throw new Error('记忆操作日志非法')
  }
}

/** 在调用方已持有操作总锁时追加一条 journal 状态，避免相同锁的嵌套获取。 */
function appendOperationLocked(workspaceSlug: string, operation: WorkspaceMemoryOperation): void {
  const path = journalPath(workspaceSlug)
  /** 原子替换前读取同一总锁保护下的完整日志。 */
  const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
  /** 每个状态单独占一行，恢复时以 operationId 的最后一条为准。 */
  const next = `${current}${JSON.stringify(operation)}\n`
  if (Buffer.byteLength(next, 'utf8') > MAX_JOURNAL_BYTES) throw new Error('记忆操作日志超过上限')
  writeTextFileAtomic(path, next)
}

function normalizedAppend(existing: string, content: string): string {
  const normalized = content.replace(/\r\n?/g, '\n').trim()
  const separator = existing.length === 0 ? '' : /(?:\r?\n){2}$/.test(existing) ? '' : /\r?\n$/.test(existing) ? '\n' : '\n\n'
  return `${existing}${separator}${normalized}\n`
}

/** 判断归一化正文是否已经作为完整 Markdown 记录存在，与底层追加器保持相同去重语义。 */
function hasExactMemoryEntry(existing: string, content: string): boolean {
  /** 只归一化比较副本，不改变用户文件原有行尾。 */
  const normalizedExisting = existing.replace(/\r\n?/g, '\n')
  /** 工具正文按底层追加器合同去除首尾空白。 */
  const normalizedContent = content.replace(/\r\n?/g, '\n').trim()
  let occurrence = normalizedExisting.indexOf(normalizedContent)
  while (occurrence >= 0) {
    /** 完整段落必须从文件头或双换行后开始。 */
    const startsAtBoundary = occurrence === 0 || normalizedExisting.slice(occurrence - 2, occurrence) === '\n\n'
    /** 完整段落必须在文件尾、单个结尾换行或双换行前结束。 */
    const entryEnd = occurrence + normalizedContent.length
    const suffixLength = normalizedExisting.length - entryEnd
    const endsAtBoundary = suffixLength === 0
      || (suffixLength === 1 && normalizedExisting[entryEnd] === '\n')
      || (suffixLength >= 2 && normalizedExisting.slice(entryEnd, entryEnd + 2) === '\n\n')
    if (startsAtBoundary && endsAtBoundary) return true
    occurrence = normalizedExisting.indexOf(normalizedContent, occurrence + 1)
  }
  return false
}

/** 计算底层安全追加器完成后的真实目标正文；完全重复时目标就是当前原文。 */
function expectedMemoryContent(existing: string, content: string): string {
  return hasExactMemoryEntry(existing, content) ? existing : normalizedAppend(existing, content)
}

function readMemoryContent(workspaceSlug: string, relativePath: string): string {
  try { return readWorkspaceAutoMemoryFile(workspaceSlug, relativePath).content ?? '' } catch (error) {
    if (error instanceof Error && error.message.startsWith('文件不存在:')) return ''
    throw error
  }
}

/** 以最后一条记录构建操作状态，确保 intent 不会覆盖后续 committed/conflict。 */
function latestOperations(operations: WorkspaceMemoryOperation[]): Map<string, WorkspaceMemoryOperation> {
  /** 同一 operationId 的后续行覆盖前序状态。 */
  const latest = new Map<string, WorkspaceMemoryOperation>()
  for (const operation of operations) latest.set(operation.operationId, operation)
  return latest
}

/** 校验本次工具调用身份和正文参数，防止同一稳定 ID 被不同载荷复用。 */
function operationMatchesInput(operation: WorkspaceMemoryOperation, input: MemoryOperationInput): boolean {
  return operation.workspaceSlug === input.workspaceSlug
    && operation.sessionId === input.sessionId
    && operation.toolCallId === input.toolCallId
    && operation.userMessageId === input.userMessageId
    && operation.relativePath === input.relativePath
    && operation.content === input.content
}

/** 显式记忆工具写入 journal 所需的权威调用参数。 */
type MemoryOperationInput = Omit<WorkspaceMemoryOperation, 'operationId' | 'baselineDigest' | 'targetDigest' | 'status' | 'updatedAt'> & { operationId?: string }

/** 校验未持久化的工具输入，避免在取得路径或文件锁前接受非法身份。 */
function validateInput(input: MemoryOperationInput): void {
  if (!isWorkspaceSlug(input.workspaceSlug)
    || !isSafeOpaqueId(input.sessionId)
    || !isSafeOpaqueId(input.toolCallId)
    || (input.userMessageId !== undefined && !isSafeOpaqueId(input.userMessageId))
    || (input.operationId !== undefined && !SAFE_ID_PATTERN.test(input.operationId))
    || !isSafeMemoryRelativePath(input.relativePath)
    || typeof input.content !== 'string' || input.content.trim().length === 0
    || Buffer.byteLength(input.content, 'utf8') > MAX_MEMORY_CONTENT_BYTES) {
    throw new Error('记忆操作参数非法')
  }
}

/** 先登记意图，再追加正文，最后标记 committed；重试与重启均可恢复。 */
export function appendWorkspaceMemoryWithJournal(input: MemoryOperationInput): WorkspaceMemoryOperation {
  validateInput(input)
  /** 缺省 ID 沿真实工具调用身份稳定派生，显式 ID 仅供持久化恢复使用。 */
  const operationId = input.operationId ?? deriveOperationId(input)
  /** 总锁覆盖读取 baseline、正文副作用、结果核验和终态发布。 */
  const path = journalPath(input.workspaceSlug)
  const release = acquireMediaFileLock(`${path}.operation.lock`)
  try {
    /** 每次锁内重读日志，避免使用取得锁前的过期状态。 */
    const existingOperation = latestOperations(readOperations(input.workspaceSlug)).get(operationId)
    if (existingOperation && !operationMatchesInput(existingOperation, input)) {
      throw new Error('记忆操作参数与已登记操作不一致')
    }

    /** 终态 conflict 永不恢复为 intent，防止重试覆盖用户修改。 */
    if (existingOperation?.status === 'conflict') return existingOperation
    /** 当前正文始终从权威 workspace 与已校验相对路径读取。 */
    const current = readMemoryContent(input.workspaceSlug, input.relativePath)
    const currentDigest = digest(current)
    if (existingOperation?.status === 'committed') {
      if (currentDigest === existingOperation.targetDigest) return existingOperation
      /** committed 后正文发生任何变化都只记录冲突，不覆盖或再次追加。 */
      const conflict = { ...existingOperation, status: 'conflict' as const, updatedAt: Date.now() }
      appendOperationLocked(input.workspaceSlug, conflict)
      return conflict
    }

    /** 新操作在写 intent 前计算与底层去重结果一致的真实目标。 */
    const operation: WorkspaceMemoryOperation = existingOperation ?? {
      ...input,
      operationId,
      baselineDigest: currentDigest,
      targetDigest: digest(expectedMemoryContent(current, input.content)),
      status: 'intent',
      updatedAt: Date.now(),
    }
    if (!existingOperation) appendOperationLocked(input.workspaceSlug, operation)

    if (currentDigest !== operation.baselineDigest && currentDigest !== operation.targetDigest) {
      /** baseline 和预期 target 均不匹配，说明中断期间存在外部修改。 */
      const conflict = { ...operation, status: 'conflict' as const, updatedAt: Date.now() }
      appendOperationLocked(input.workspaceSlug, conflict)
      return conflict
    }
    if (currentDigest === operation.baselineDigest && operation.baselineDigest !== operation.targetDigest) {
      appendWorkspaceAutoMemoryFile(input.workspaceSlug, operation.relativePath, operation.content)
    }
    /** 正文写入后必须按真实文件重新核验，不能根据追加器返回状态推测提交。 */
    const writtenDigest = digest(readMemoryContent(input.workspaceSlug, operation.relativePath))
    if (writtenDigest !== operation.targetDigest) {
      const conflict = { ...operation, status: 'conflict' as const, updatedAt: Date.now() }
      appendOperationLocked(input.workspaceSlug, conflict)
      return conflict
    }
    const committed = { ...operation, status: 'committed' as const, updatedAt: Date.now() }
    appendOperationLocked(input.workspaceSlug, committed)
    return committed
  } finally {
    release()
  }
}

/** 重启或下一次访问时恢复尚未提交的记忆操作。 */
export function replayWorkspaceMemoryOperations(workspaceSlug: string): WorkspaceMemoryOperation[] {
  /** workspaceSlug 来自启动恢复枚举，是恢复访问的唯一权威工作区。 */
  const latest = latestOperations(readOperations(workspaceSlug))
  const results: WorkspaceMemoryOperation[] = []
  for (const operation of latest.values()) {
    if (operation.status !== 'intent') continue
    /** 不把日志内 workspace 字段作为路径来源，始终覆盖为调用方的权威 slug。 */
    results.push(appendWorkspaceMemoryWithJournal({
      workspaceSlug,
      sessionId: operation.sessionId,
      toolCallId: operation.toolCallId,
      userMessageId: operation.userMessageId,
      relativePath: operation.relativePath,
      content: operation.content,
      operationId: operation.operationId,
    }))
  }
  return results
}

/** 返回已提交且属于指定用户回合的记忆正文，供后台提炼去重。 */
export function readCommittedKnowledgeMemorySources(workspaceSlug: string, sessionId: string, userMessageId: string): CommittedKnowledgeMemorySource[] {
  const latest = latestOperations(readOperations(workspaceSlug))
  /** 同一文件只读取一次；无法安全读取时不得用历史 journal 抑制新知识。 */
  const currentContents = new Map<string, string | undefined>()
  return [...latest.values()]
    .filter((operation) => operation.status === 'committed' && operation.sessionId === sessionId && operation.userMessageId === userMessageId)
    .filter((operation) => {
      if (!currentContents.has(operation.relativePath)) {
        try { currentContents.set(operation.relativePath, readMemoryContent(workspaceSlug, operation.relativePath)) }
        catch { currentContents.set(operation.relativePath, undefined) }
      }
      const current = currentContents.get(operation.relativePath)
      return current !== undefined && hasExactMemoryEntry(current, operation.content)
    })
    .map((operation) => ({ operationId: operation.operationId, relativePath: operation.relativePath, contentDigest: digest(operation.content), content: operation.content }))
}
