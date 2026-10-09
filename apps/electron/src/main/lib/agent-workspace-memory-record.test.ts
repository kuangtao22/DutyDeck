import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as realConfigPaths from './config-paths'
import { acquireMediaFileLock } from './media/media-file-lock'

interface WorkspaceMemoryAppendResult {
  status: string
  relativePath: string
  absolutePath: string
}

interface WorkspaceMemoryManagerTestApi {
  appendWorkspaceAutoMemoryFile?: (
    workspaceSlug: string,
    relativePath: string,
    content: string,
  ) => WorkspaceMemoryAppendResult
}
interface WorkspaceMemoryJournalTestApi {
  appendWorkspaceMemoryWithJournal: (input: {
    workspaceSlug: string
    sessionId: string
    toolCallId: string
    userMessageId?: string
    relativePath: string
    content: string
    operationId?: string
  }) => { status: string; operationId: string }
  replayWorkspaceMemoryOperations: (workspaceSlug: string) => Array<{ status: string }>
  readCommittedKnowledgeMemorySources: (
    workspaceSlug: string,
    sessionId: string,
    userMessageId: string,
  ) => Array<{ operationId: string; relativePath: string; contentDigest: string; content: string }>
}

/** 生成与生产 journal 相同的 SHA-256 正文摘要。 */
function contentDigest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** 返回隔离数据根内指定工作区的 journal 路径。 */
function memoryJournalPath(workspaceSlug: string): string {
  return join(temporaryHome, '.proma', 'agent-workspaces', workspaceSlug, '.memory-operations.jsonl')
}

/** 写入一条完整 journal 记录，供崩溃与非法持久化状态测试使用。 */
function writeJournalOperations(workspaceSlug: string, operations: Array<Record<string, unknown>>): void {
  const path = memoryJournalPath(workspaceSlug)
  mkdirSync(join(temporaryHome, '.proma', 'agent-workspaces', workspaceSlug), { recursive: true })
  writeFileSync(path, `${operations.map((operation) => JSON.stringify(operation)).join('\n')}\n`, 'utf8')
}

/** 构造一条可由恢复器严格校验的记忆操作。 */
function journalOperation(workspaceSlug: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const content = '## 可恢复记录'
  return {
    operationId: 'operation-1',
    workspaceSlug,
    sessionId: 'session-1',
    toolCallId: 'tool-1',
    userMessageId: 'user-1',
    relativePath: 'decisions.md',
    baselineDigest: contentDigest(''),
    targetDigest: contentDigest(`${content}\n`),
    content,
    status: 'intent',
    updatedAt: 1,
    ...overrides,
  }
}

/** 测试期间使用隔离的 Proma 数据根，避免触碰用户真实工作区。 */
let temporaryHome = ''
/** 延迟加载工作区管理器，确保它首次解析路径时使用隔离数据根。 */
let memoryManager: WorkspaceMemoryManagerTestApi
let journal: WorkspaceMemoryJournalTestApi

mock.module('./config-paths', () => ({
  ...realConfigPaths,
  /** 测试工作区索引固定放在当前临时数据根。 */
  getAgentWorkspacesIndexPath: () => join(temporaryHome, '.proma', 'agent-workspaces.json'),
  /** 返回测试专用的工作区父目录。 */
  getAgentWorkspacesDir: () => {
    const workspacesPath = join(temporaryHome, '.proma', 'agent-workspaces')
    mkdirSync(workspacesPath, { recursive: true })
    return workspacesPath
  },
  /** 创建并返回当前用例对应的工作区目录。 */
  getAgentWorkspacePath: (slug: string) => {
    const workspacePath = join(temporaryHome, '.proma', 'agent-workspaces', slug)
    mkdirSync(workspacePath, { recursive: true })
    return workspacePath
  },
  /** 未覆盖的配置路径只为满足工作区管理器模块导入契约。 */
  getWorkspaceMcpPath: () => '',
  getWorkspaceSkillsDir: () => '',
  getWorkspaceFilesDir: () => '',
  getInactiveSkillsDir: () => '',
  getDefaultSkillsDir: () => '',
  parseSkillVersion: () => undefined,
  RETIRED_DEFAULT_SKILL_SLUGS: new Set<string>(),
  isRetiredDefaultSkill: () => false,
}))

beforeAll(async () => {
  temporaryHome = mkdtempSync(join(tmpdir(), 'proma-memory-record-'))
  memoryManager = await import('./agent-workspace-manager') as unknown as WorkspaceMemoryManagerTestApi
  journal = await import('./project-knowledge-memory-journal') as unknown as WorkspaceMemoryJournalTestApi
})

afterAll(() => {
  if (temporaryHome) rmSync(temporaryHome, { recursive: true, force: true })
})

test('Given 新的 Markdown 记忆 When 记录同一段两次 Then 原子追加且重试不重复', () => {
  /** 当前实现必须通过此入口追加受管长期记忆。 */
  const append = memoryManager.appendWorkspaceAutoMemoryFile
  expect(typeof append).toBe('function')
  if (!append) throw new Error('appendWorkspaceAutoMemoryFile 尚未实现')

  /** 固定本测试使用的工作区和相对 Markdown 路径。 */
  const workspaceSlug = 'memory-create'
  /** 记录内容使用完整 Markdown 区块，方便后续模型读取和检索。 */
  const entry = '## 工具偏好\n\n- 记录后应明确说明保存位置。'
  /** 首次调用应创建文件，重复调用应识别为已记录。 */
  const first = append(workspaceSlug, 'user-profile.md', entry)
  const retry = append(workspaceSlug, 'user-profile.md', entry)
  /** 真实持久化目录来自当前测试 HOME 下的默认 Proma 数据根。 */
  const filePath = join(temporaryHome, '.proma', 'agent-workspaces', workspaceSlug, 'memory', 'user-profile.md')

  expect(first.status).toBe('created')
  expect(retry.status).toBe('already_recorded')
  expect(first.relativePath).toBe('user-profile.md')
  expect(first.absolutePath).toBe(filePath)
  expect(readFileSync(filePath, 'utf8')).toBe(`${entry}\n`)
})

test('Given 已有用户记忆 When 记录新条目 Then 保留原文并将新内容追加到文件末尾', () => {
  /** 当前实现必须通过此入口追加受管长期记忆。 */
  const append = memoryManager.appendWorkspaceAutoMemoryFile
  expect(typeof append).toBe('function')
  if (!append) throw new Error('appendWorkspaceAutoMemoryFile 尚未实现')

  /** 为目标工作区准备已有记忆正文，验证追加不会覆盖它。 */
  const workspaceSlug = 'memory-append'
  /** 记录内容使用可区分的旧、新 Markdown 段落。 */
  const filePath = join(temporaryHome, '.proma', 'agent-workspaces', workspaceSlug, 'memory', 'user-profile.md')
  const existingContent = '# 用户画像\n\n- 喜欢先给结论。\n'
  const entry = '- 新增偏好：操作结果说明保存路径。'
  mkdirSync(join(temporaryHome, '.proma', 'agent-workspaces', workspaceSlug, 'memory'), { recursive: true })
  writeFileSync(filePath, existingContent, 'utf8')

  /** 已存在文件应报告 appended，并且只在末尾增加新记录。 */
  const result = append(workspaceSlug, 'user-profile.md', entry)

  expect(result.status).toBe('appended')
  expect(readFileSync(filePath, 'utf8')).toBe(`${existingContent}\n${entry}\n`)
})

test('Given 越界相对路径 When 记录记忆 Then 拒绝写入且不触碰工作区外文件', () => {
  /** 当前实现必须通过此入口追加受管长期记忆。 */
  const append = memoryManager.appendWorkspaceAutoMemoryFile
  expect(typeof append).toBe('function')
  if (!append) throw new Error('appendWorkspaceAutoMemoryFile 尚未实现')

  /** 越界路径尝试写入工作区 memory 目录的兄弟文件。 */
  const workspaceSlug = 'memory-traversal'
  /** 计算越界目标，确认调用后它仍然不存在。 */
  const outsidePath = join(temporaryHome, '.proma', 'agent-workspaces', workspaceSlug, 'outside.md')

  expect(() => append(workspaceSlug, '../outside.md', '## 不应写入')).toThrow()
  expect(existsSync(outsidePath)).toBe(false)
})

test('Given 非 Markdown 目标 When 记录记忆 Then 拒绝写入', () => {
  /** 当前实现必须通过此入口追加受管长期记忆。 */
  const append = memoryManager.appendWorkspaceAutoMemoryFile
  expect(typeof append).toBe('function')
  if (!append) throw new Error('appendWorkspaceAutoMemoryFile 尚未实现')

  /** 工具只能生成供记忆模块读取的 Markdown 文件。 */
  expect(() => append('memory-extension', 'note.txt', '不应写入')).toThrow('只允许写入 Markdown')
})

test('Given memory 内的文件软链接指向外部 When 记录记忆 Then 拒绝跟随软链接', () => {
  /** 当前实现必须通过此入口追加受管长期记忆。 */
  const append = memoryManager.appendWorkspaceAutoMemoryFile
  expect(typeof append).toBe('function')
  if (!append) throw new Error('appendWorkspaceAutoMemoryFile 尚未实现')

  /** 为软链接测试准备受管目录和其外部目标文件。 */
  const workspaceSlug = 'memory-symlink'
  /** 目标文件位于 memory 根之外，内容用于确认没有被覆盖。 */
  const outsidePath = join(temporaryHome, 'outside-memory.md')
  /** 软链接放在记忆根中，尝试从此路径写入必须被路径校验拒绝。 */
  const memoryDir = join(temporaryHome, '.proma', 'agent-workspaces', workspaceSlug, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  writeFileSync(outsidePath, '保留原文', 'utf8')
  symlinkSync(outsidePath, join(memoryDir, 'linked.md'))

  expect(() => append(workspaceSlug, 'linked.md', '## 不应写入')).toThrow()
  expect(readFileSync(outsidePath, 'utf8')).toBe('保留原文')
})

test('Given 记忆追加在意图后中断 When 下次恢复 Then 只在 baseline 未变时重放并提交', () => {
  const input = {
    workspaceSlug: 'memory-journal', sessionId: 'session-1', toolCallId: 'tool-1', userMessageId: 'user-1',
    relativePath: 'decisions.md', content: '## 稳定写入',
  }
  const first = journal.appendWorkspaceMemoryWithJournal(input)
  expect(first.status).toBe('committed')
  const retry = journal.appendWorkspaceMemoryWithJournal({ ...input, operationId: first.operationId })
  expect(retry.status).toBe('committed')
  expect(readFileSync(join(temporaryHome, '.proma', 'agent-workspaces', 'memory-journal', 'memory', 'decisions.md'), 'utf8')).toBe('## 稳定写入\n')
})

test('Given 已提交操作后的人工修改 When 重放 Then 标记 conflict 且不覆盖人工内容', () => {
  const input = {
    workspaceSlug: 'memory-conflict', sessionId: 'session-2', toolCallId: 'tool-2',
    relativePath: 'decisions.md', content: '## Agent 记录',
  }
  const first = journal.appendWorkspaceMemoryWithJournal(input)
  const filePath = join(temporaryHome, '.proma', 'agent-workspaces', 'memory-conflict', 'memory', 'decisions.md')
  writeFileSync(filePath, '## 人工修改\n', 'utf8')
  const journalPath = join(temporaryHome, '.proma', 'agent-workspaces', 'memory-conflict', '.memory-operations.jsonl')
  const intentOnly = readFileSync(journalPath, 'utf8').split('\n').filter(Boolean).slice(0, 1).join('\n') + '\n'
  writeFileSync(journalPath, intentOnly, 'utf8')
  const replay = journal.appendWorkspaceMemoryWithJournal({ ...input, operationId: first.operationId })
  expect(replay.status).toBe('conflict')
  expect(readFileSync(filePath, 'utf8')).toBe('## 人工修改\n')
})

test('Given 工具未传 operationId When 同一工具调用重试 Then 派生同一操作且正文只追加一次', () => {
  const input = {
    workspaceSlug: 'memory-stable-id', sessionId: 'session-stable', toolCallId: 'call_1|fc_1', userMessageId: 'user-stable',
    relativePath: 'decisions.md', content: '## 稳定工具调用',
  }

  const first = journal.appendWorkspaceMemoryWithJournal(input)
  const retry = journal.appendWorkspaceMemoryWithJournal(input)
  const filePath = join(temporaryHome, '.proma', 'agent-workspaces', input.workspaceSlug, 'memory', input.relativePath)

  expect(retry.operationId).toBe(first.operationId)
  expect(readFileSync(filePath, 'utf8')).toBe('## 稳定工具调用\n')
})

test('Given 同一操作存在 intent 与 conflict When 重试 Then 使用最后状态且不复活旧意图', () => {
  const workspaceSlug = 'memory-latest-status'
  const intent = journalOperation(workspaceSlug)
  writeJournalOperations(workspaceSlug, [intent, { ...intent, status: 'conflict', updatedAt: 2 }])

  const result = journal.appendWorkspaceMemoryWithJournal({
    workspaceSlug,
    sessionId: 'session-1',
    toolCallId: 'tool-1',
    userMessageId: 'user-1',
    relativePath: 'decisions.md',
    content: '## 可恢复记录',
    operationId: 'operation-1',
  })

  expect(result.status).toBe('conflict')
  expect(existsSync(join(temporaryHome, '.proma', 'agent-workspaces', workspaceSlug, 'memory', 'decisions.md'))).toBe(false)
})

test('Given journal 只持久化 intent When 启动恢复 Then 从权威工作区追加正文并提交', () => {
  const workspaceSlug = 'memory-crash-after-intent'
  writeJournalOperations(workspaceSlug, [journalOperation(workspaceSlug)])

  expect(journal.replayWorkspaceMemoryOperations(workspaceSlug)).toEqual([expect.objectContaining({ status: 'committed' })])
  expect(readFileSync(join(temporaryHome, '.proma', 'agent-workspaces', workspaceSlug, 'memory', 'decisions.md'), 'utf8')).toBe('## 可恢复记录\n')
})

test('Given 正文已落盘但 committed 未持久化 When 启动恢复 Then 只补提交状态不重复追加', () => {
  const workspaceSlug = 'memory-crash-after-body'
  const operation = journalOperation(workspaceSlug)
  writeJournalOperations(workspaceSlug, [operation])
  const filePath = join(temporaryHome, '.proma', 'agent-workspaces', workspaceSlug, 'memory', 'decisions.md')
  mkdirSync(join(temporaryHome, '.proma', 'agent-workspaces', workspaceSlug, 'memory'), { recursive: true })
  writeFileSync(filePath, '## 可恢复记录\n', 'utf8')

  expect(journal.replayWorkspaceMemoryOperations(workspaceSlug)).toEqual([expect.objectContaining({ status: 'committed' })])
  expect(readFileSync(filePath, 'utf8')).toBe('## 可恢复记录\n')
})

test('Given committed 后正文被人工修改 When 相同工具调用重试 Then 报告冲突且不覆盖或重复追加', () => {
  const input = {
    workspaceSlug: 'memory-committed-edited', sessionId: 'session-edited', toolCallId: 'tool-edited', userMessageId: 'user-edited',
    relativePath: 'decisions.md', content: '## Agent 记录',
  }
  const first = journal.appendWorkspaceMemoryWithJournal(input)
  const filePath = join(temporaryHome, '.proma', 'agent-workspaces', input.workspaceSlug, 'memory', input.relativePath)
  writeFileSync(filePath, '## Agent 记录\n\n## 人工新增\n', 'utf8')

  const retry = journal.appendWorkspaceMemoryWithJournal(input)

  expect(retry.operationId).toBe(first.operationId)
  expect(retry.status).toBe('conflict')
  expect(readFileSync(filePath, 'utf8')).toBe('## Agent 记录\n\n## 人工新增\n')
})

test('Given committed 正文被人工删除或纠正 When maintenance 查询显式来源 Then 旧正文不再参与去重', () => {
  const input = {
    workspaceSlug: 'memory-dedup-edited', sessionId: 'session-dedup-edited', toolCallId: 'tool-dedup-edited',
    userMessageId: 'user-dedup-edited', relativePath: 'decisions.md', content: '## 原决定\n\n采用短信登录',
  }
  journal.appendWorkspaceMemoryWithJournal(input)
  const filePath = join(temporaryHome, '.proma', 'agent-workspaces', input.workspaceSlug, 'memory', input.relativePath)
  /** 不重试原工具调用，复现 journal 仍为 committed、正文已由用户纠正的真实状态。 */
  writeFileSync(filePath, '## 人工纠正\n\n改为邮箱验证码\n', 'utf8')

  expect(journal.readCommittedKnowledgeMemorySources(input.workspaceSlug, input.sessionId, input.userMessageId)).toEqual([])
})

test('Given committed 后同文件发生合法追加 When maintenance 查询原回合 Then 原正文仍参与去重', () => {
  const workspaceSlug = 'memory-dedup-appended'
  const first = {
    workspaceSlug, sessionId: 'session-dedup-first', toolCallId: 'tool-dedup-first', userMessageId: 'user-dedup-first',
    relativePath: 'decisions.md', content: '## 登录决定\n\n采用短信登录',
  }
  journal.appendWorkspaceMemoryWithJournal(first)
  journal.appendWorkspaceMemoryWithJournal({
    workspaceSlug, sessionId: 'session-dedup-second', toolCallId: 'tool-dedup-second', userMessageId: 'user-dedup-second',
    relativePath: 'decisions.md', content: '## 通知决定\n\n采用站内信',
  })

  expect(journal.readCommittedKnowledgeMemorySources(workspaceSlug, first.sessionId, first.userMessageId))
    .toEqual([expect.objectContaining({ relativePath: first.relativePath, content: first.content })])
})

test('Given 正文已包含完全相同记录 When 首次登记操作 Then target 按真实未变正文提交', () => {
  const workspaceSlug = 'memory-existing-exact'
  const filePath = join(temporaryHome, '.proma', 'agent-workspaces', workspaceSlug, 'memory', 'decisions.md')
  mkdirSync(join(temporaryHome, '.proma', 'agent-workspaces', workspaceSlug, 'memory'), { recursive: true })
  writeFileSync(filePath, '## 已存在记录\n', 'utf8')

  const result = journal.appendWorkspaceMemoryWithJournal({
    workspaceSlug, sessionId: 'session-existing', toolCallId: 'tool-existing', userMessageId: 'user-existing',
    relativePath: 'decisions.md', content: '## 已存在记录',
  }) as { status: string; operationId: string; targetDigest?: string }

  expect(result.status).toBe('committed')
  expect(result.targetDigest).toBe(contentDigest('## 已存在记录\n'))
  expect(readFileSync(filePath, 'utf8')).toBe('## 已存在记录\n')
})

test('Given 另一写入持有操作总锁 When 尝试追加 Then baseline、正文与 journal 均不越过锁边界', () => {
  const workspaceSlug = 'memory-operation-lock'
  const path = memoryJournalPath(workspaceSlug)
  mkdirSync(join(temporaryHome, '.proma', 'agent-workspaces', workspaceSlug), { recursive: true })
  const release = acquireMediaFileLock(`${path}.operation.lock`)
  try {
    expect(() => journal.appendWorkspaceMemoryWithJournal({
      workspaceSlug, sessionId: 'session-lock', toolCallId: 'tool-lock', userMessageId: 'user-lock',
      relativePath: 'decisions.md', content: '## 不应越过锁',
    })).toThrow('MEDIA_FILE_BUSY')
    expect(existsSync(path)).toBe(false)
    expect(existsSync(join(temporaryHome, '.proma', 'agent-workspaces', workspaceSlug, 'memory', 'decisions.md'))).toBe(false)
  } finally {
    release()
  }
})

test('Given journal 携带越界路径或伪造工作区 When 恢复 Then 严格拒绝且不触碰目标文件', () => {
  const workspaceSlug = 'memory-invalid-journal'
  writeJournalOperations(workspaceSlug, [journalOperation(workspaceSlug, { relativePath: '../outside.md' })])
  expect(() => journal.replayWorkspaceMemoryOperations(workspaceSlug)).toThrow('记忆操作日志非法')

  writeJournalOperations(workspaceSlug, [journalOperation(workspaceSlug, { workspaceSlug: 'other-workspace' })])
  expect(() => journal.replayWorkspaceMemoryOperations(workspaceSlug)).toThrow('记忆操作日志非法')

  writeJournalOperations(workspaceSlug, [journalOperation(workspaceSlug, { operationId: '../forged-operation' })])
  expect(() => journal.replayWorkspaceMemoryOperations(workspaceSlug)).toThrow('记忆操作日志非法')
  expect(existsSync(join(temporaryHome, '.proma', 'agent-workspaces', workspaceSlug, 'outside.md'))).toBe(false)
})
