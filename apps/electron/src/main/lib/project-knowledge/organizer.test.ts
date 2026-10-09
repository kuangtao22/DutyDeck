import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KnowledgeEntry } from '@proma/shared'
import { emptyKnowledgeMaintenance } from '../project-knowledge-maintenance-types'
import { createProjectKnowledgeService } from './service'

describe('项目知识库受管正文与整理', () => {
  /** 测试隔离根目录。 */
  let fixtureRoot: string
  /** 测试项目根。 */
  let projectRoot: string
  /** 测试 memory 根。 */
  let memoryRoot: string
  /** 测试缓存根。 */
  let cacheRoot: string
  /** 稳定测试时间。 */
  let currentTime: number

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proma-knowledge-organizer-'))
    projectRoot = join(fixtureRoot, 'project')
    memoryRoot = join(fixtureRoot, 'memory')
    cacheRoot = join(fixtureRoot, 'cache')
    mkdirSync(projectRoot)
    mkdirSync(memoryRoot)
    currentTime = 10_000
  })

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true })
  })

  /** 创建绑定当前临时目录的服务。 */
  function createService() {
    return createProjectKnowledgeService({
      resolveProject: () => ({ projectId: 'project-1', projectRoot, memoryRoot, cacheRoot }),
      now: () => currentTime,
    })
  }

  /** 当前测试使用的可信项目边界。 */
  function getProject() {
    return { projectId: 'project-1', projectRoot, memoryRoot, cacheRoot }
  }

  /** 创建合法受管条目。 */
  function createManagedEntry(
    seed: string,
    title: string,
    content: string,
    state: KnowledgeEntry['state'] = 'confirmed',
    sourceKind: 'managed' | 'conversation' = 'managed',
  ): KnowledgeEntry {
    /** 测试条目的稳定 ID。 */
    const id = createHash('sha256').update(seed).digest('hex').slice(0, 32)
    /** 测试条目的不可变 revision。 */
    const revision = createHash('sha256').update(`${seed}\0${title}\0${state}\0${content}`).digest('hex')
    return {
      id,
      revision,
      title,
      category: 'business',
      kind: 'document',
      state,
      freshness: 'current',
      summary: title,
      source: {
        kind: sourceKind,
        id: `source:${seed}`,
        revision: createHash('sha256').update(content).digest('hex'),
      },
      byteSize: Buffer.byteLength(content, 'utf8'),
      indexedBytes: Buffer.byteLength(content, 'utf8'),
      truncated: false,
      metadataOnly: false,
      updatedAt: currentTime,
    }
  }

  /** 在一次事务中写入受管条目及正文。 */
  async function seedEntries(entries: Array<{ entry: KnowledgeEntry; content: string }>) {
    /** 当前测试服务。 */
    const service = createService()
    await service.store.initialize(getProject(), 'workspace-1')
    await service.store.transact(getProject(), 'workspace-1', () => ({ commits: entries }))
    return service
  }

  test('Given 相同提炼正文来自两个文档 When 自动合并 Then 保留双方证据且撤销恢复各自依据', async () => {
    /** 正文相同但原文证据不同，合并不能丢掉来源版本。 */
    const content = '产品只处理本地项目。'
    const first = createManagedEntry('evidence-first', '项目范围', content)
    const second = createManagedEntry('evidence-second', '项目范围', content)
    first.evidence = [{ entryId: 'a'.repeat(32), revision: 'a'.repeat(64), quote: '本地项目' }]
    second.evidence = [{ entryId: 'b'.repeat(32), revision: 'b'.repeat(64), quote: '本地项目' }]
    const service = await seedEntries([{ entry: first, content }, { entry: second, content }])
    const organized = await service.organize('workspace-1')
    /** 合并后仍存活的知识条目必须保留完整证据集合。 */
    const active = organized.entries.filter((entry) => entry.state !== 'archived')
    expect(active).toHaveLength(1)
    expect(active[0]?.evidence).toHaveLength(2)
    const operation = organized.operations!.find((item) => item.kind === 'merge')!
    const undone = await service.undo('workspace-1', operation.id)
    expect(undone.entries.filter((entry) => entry.state !== 'archived').map((entry) => entry.evidence?.length)).toEqual([1, 1])
  })

  test('Given 受管正文已发布且索引缺失 When 读取与搜索 Then 从不可变正文返回且不读取原会话', async () => {
    /** 仅保存提炼正文、不保存原会话的候选。 */
    const content = '# 登录决策\n登录鉴权采用短期 token。'
    /** conversation 来源的受管条目。 */
    const entry = createManagedEntry('conversation-1', '登录决策', content, 'draft', 'conversation')
    /** 已发布受管正文的服务。 */
    const service = await seedEntries([{ entry, content }])

    expect(existsSync(cacheRoot)).toBe(false)
    expect(service.store.readContent(getProject(), service.store.readManifest(getProject())!, entry.id)).toBe(content)
    /** 无缓存时从受管正文执行的检索。 */
    const search = await service.search({ workspaceId: 'workspace-1', query: 'token 鉴权', includeHistory: true })
    /** 受管正文的分页读取。 */
    const read = await service.read({ workspaceId: 'workspace-1', entryId: entry.id })
    expect(search.indexStatus).toBe('missing')
    expect(search.items[0]?.entry.id).toBe(entry.id)
    expect(read).toMatchObject({ status: 'readable', content })

    writeFileSync(join(projectRoot, 'README.md'), '# Project', 'utf8')
    await service.startScan('workspace-1')
    await service.waitForScan('workspace-1')
    /** 扫描重建缓存后受管正文仍可检索。 */
    const rebuilt = await service.search({ workspaceId: 'workspace-1', query: 'token 鉴权', includeHistory: true })
    expect(rebuilt.indexStatus).toBe('ready')
    expect(rebuilt.items[0]?.entry.id).toBe(entry.id)
  })

  test('Given 维护已暂停并递增 generation When 迟到事务在同锁内复核 Then 拒绝发布且 revision 不变', async () => {
    /** 事务测试服务。 */
    const service = createService()
    await service.store.initialize(getProject(), 'workspace-1')
    /** 暂停后的维护状态。 */
    const maintenance = emptyKnowledgeMaintenance()
    maintenance.settings.generation = 1
    await service.store.transact(getProject(), 'workspace-1', () => ({ maintenance }))
    /** 暂停后的权威清单。 */
    const paused = service.store.readManifest(getProject())!

    await expect(service.store.transact(getProject(), 'workspace-1', (current) => {
      if (current.manifest.maintenance?.settings.generation !== 0) throw new Error('维护代次已变化')
      return { commits: [] }
    })).rejects.toThrow('维护代次已变化')
    expect(service.store.readManifest(getProject())?.revision).toBe(paused.revision)
  })

  test('Given 受管正文已写但 manifest 发布失败 When 事务退出 Then 旧清单仍是唯一权威版本', async () => {
    /** 事务故障测试服务。 */
    const service = createService()
    await service.store.initialize(getProject(), 'workspace-1')
    /** 发布失败前的清单。 */
    const before = service.store.readManifest(getProject())!
    /** 待提交受管条目。 */
    const entry = createManagedEntry('failed-transaction', '未发布', '未发布正文')
    mkdirSync(join(projectRoot, '.proma/knowledge/manifest.json.tmp'))

    await expect(service.store.transact(getProject(), 'workspace-1', () => ({
      commits: [{ entry, content: '未发布正文' }],
    }))).rejects.toThrow()
    expect(service.store.readManifest(getProject())).toEqual(before)
    expect(readFileSync(join(projectRoot, '.proma/knowledge/manifest.json'), 'utf8')).not.toContain(entry.id)
  })

  test('Given 下一版清单超过读取上限 When 事务发布 Then 拒绝且不写条目依赖', async () => {
    /** 清单上限测试服务。 */
    const service = createService()
    await service.store.initialize(getProject(), 'workspace-1')
    /** 超限事务前的权威清单字节。 */
    const manifestPath = join(projectRoot, '.proma/knowledge/manifest.json')
    const before = readFileSync(manifestPath, 'utf8')
    /** 若清单合法才允许写入的受管条目。 */
    const entry = createManagedEntry('oversized-manifest', '超限事务', '不得提前写入')
    /** 约 4.5 MiB 的排除来源集合。 */
    const excludedSources = Array.from({ length: 4_500 }, (_, index) => `${index}:${'x'.repeat(995)}`)

    await expect(service.store.transact(getProject(), 'workspace-1', () => ({
      commits: [{ entry, content: '不得提前写入' }],
      excludedSources,
    }))).rejects.toThrow('知识库清单超过大小上限')
    expect(readFileSync(manifestPath, 'utf8')).toBe(before)
    expect(existsSync(join(projectRoot, '.proma/knowledge/entries', entry.id))).toBe(false)
  })

  test('Given 条目 revision 父目录被替换为软链接 When 读取 Then 拒绝跟随目录外内容', async () => {
    /** 受管正文及其条目版本。 */
    const content = '# 安全条目\n不可越界读取。'
    const entry = createManagedEntry('symlink-parent', '安全条目', content)
    const service = await seedEntries([{ entry, content }])
    /** 原 revision 目录与伪造的目录外目标。 */
    const revisionDirectory = join(
      projectRoot,
      '.proma/knowledge/entries',
      entry.id,
      'revisions',
      entry.revision,
    )
    const outsideDirectory = join(fixtureRoot, 'outside-revision')
    const entryJson = readFileSync(join(revisionDirectory, 'entry.json'), 'utf8')
    rmSync(revisionDirectory, { recursive: true })
    mkdirSync(outsideDirectory)
    writeFileSync(join(outsideDirectory, 'entry.json'), entryJson, 'utf8')
    writeFileSync(join(outsideDirectory, 'content.md'), content, 'utf8')
    symlinkSync(outsideDirectory, revisionDirectory)

    await expect(service.read({ workspaceId: 'workspace-1', entryId: entry.id }))
      .rejects.toThrow('条目版本目录')
  })

  test('Given 完全重复条目和多章节长文 When 整理 Then 合并拆分、旧引用可读且重复整理无操作', async () => {
    /** 重复正文。 */
    const duplicateContent = '# 支付规则\n退款必须记录审计。'
    /** 可拆分的三段正文。 */
    const splitContent = '# 项目手册\n## 安装\n安装说明。\n## 配置\n配置说明。\n## 发布\n发布说明。'
    /** 重复条目 A。 */
    const duplicateA = createManagedEntry('duplicate-a', '支付规则 A', duplicateContent)
    /** 重复条目 B。 */
    const duplicateB = createManagedEntry('duplicate-b', '支付规则 B', duplicateContent)
    /** 待拆分条目。 */
    const splitEntry = createManagedEntry('split-parent', '项目手册', splitContent, 'confirmed', 'conversation')
    /** 已准备整理样本的服务。 */
    const service = await seedEntries([
      { entry: duplicateA, content: duplicateContent },
      { entry: duplicateB, content: duplicateContent },
      { entry: splitEntry, content: splitContent },
    ])

    /** 首次整理后的快照。 */
    const organized = await service.organize('workspace-1')
    /** 合并操作。 */
    const mergeOperation = organized.operations?.find((operation) => operation.kind === 'merge')
    /** 拆分操作。 */
    const splitOperation = organized.operations?.find((operation) => operation.kind === 'split')
    expect(mergeOperation).toBeDefined()
    expect(splitOperation).toBeDefined()
    expect((await service.read({ workspaceId: 'workspace-1', entryId: duplicateB.id })).content).toBe(duplicateContent)
    /** 旧拆分 ID 返回包含所有子条目 ID 的目录正文。 */
    const splitRedirect = await service.read({ workspaceId: 'workspace-1', entryId: splitEntry.id })
    expect(splitRedirect.content).toContain('已拆分为')
    for (const childId of splitOperation?.entryIds.filter((entryId) => entryId !== splitEntry.id) ?? []) {
      expect(splitRedirect.content).toContain(childId)
    }

    /** 重复整理不得产生新 revision 或操作。 */
    const replay = await service.organize('workspace-1')
    expect(replay.revision).toBe(organized.revision)
    expect(replay.operations).toEqual(organized.operations)
  })

  test('Given 旧条目经历多轮合并 When 读取最初引用 Then 跟随重定向链且循环映射明确失败', async () => {
    /** 三轮合并链最终保留的正文。 */
    const content = '# 当前规则\n最终正文。'
    /** 最初被合并的条目。 */
    const original = createManagedEntry('redirect-original', '旧规则', '# 旧规则')
    /** 第一轮合并后的条目。 */
    const intermediate = createManagedEntry('redirect-intermediate', '中间规则', '# 中间规则')
    /** 第二轮合并后的当前条目。 */
    const current = createManagedEntry('redirect-current', '当前规则', content)
    /** 已写入三代条目的服务。 */
    const service = await seedEntries([
      { entry: original, content: '# 旧规则' },
      { entry: intermediate, content: '# 中间规则' },
      { entry: current, content },
    ])
    await service.store.transact(getProject(), 'workspace-1', () => ({
      redirects: {
        [original.id]: [intermediate.id],
        [intermediate.id]: [current.id],
      },
    }))

    expect((await service.read({ workspaceId: 'workspace-1', entryId: original.id })).content).toBe(content)

    await service.store.transact(getProject(), 'workspace-1', () => ({
      redirects: {
        [original.id]: [intermediate.id],
        [intermediate.id]: [original.id],
      },
    }))
    await expect(service.read({ workspaceId: 'workspace-1', entryId: original.id }))
      .rejects.toThrow('知识条目重定向损坏')
  })

  test('Given 整理操作尚未被后续修改 When 撤销 Then 创建恢复 revision 并保留操作记录', async () => {
    /** 完全重复正文。 */
    const content = '# 重复\n相同正文。'
    /** 合并候选 A。 */
    const entryA = createManagedEntry('undo-a', 'A', content)
    /** 合并候选 B。 */
    const entryB = createManagedEntry('undo-b', 'B', content)
    /** 整理测试服务。 */
    const service = await seedEntries([{ entry: entryA, content }, { entry: entryB, content }])
    const organized = await service.organize('workspace-1')
    /** 待撤销的合并操作。 */
    const operation = organized.operations?.find((candidate) => candidate.kind === 'merge')
    if (!operation) throw new Error('测试合并操作缺失')

    /** 撤销后的快照。 */
    const undone = await service.undo('workspace-1', operation.id)
    expect(undone.operations?.at(-1)).toMatchObject({ kind: 'undo', undoable: false })
    expect((await service.read({ workspaceId: 'workspace-1', entryId: entryB.id })).content).toBe(content)
  })

  test('Given 整理后条目被人工更新 When 撤销旧操作 Then 报告冲突且不覆盖新正文', async () => {
    /** 完全重复正文。 */
    const content = '# 重复\n相同正文。'
    /** 合并候选 A。 */
    const entryA = createManagedEntry('conflict-a', 'A', content)
    /** 合并候选 B。 */
    const entryB = createManagedEntry('conflict-b', 'B', content)
    /** 撤销冲突测试服务。 */
    const service = await seedEntries([{ entry: entryA, content }, { entry: entryB, content }])
    const organized = await service.organize('workspace-1')
    /** 待制造冲突的合并操作。 */
    const operation = organized.operations?.find((candidate) => candidate.kind === 'merge')
    if (!operation) throw new Error('测试合并操作缺失')
    /** 操作后的当前条目。 */
    const manifest = service.store.readManifest(getProject())!
    const currentEntry = service.store.readEntry(getProject(), manifest, entryB.id)
    /** 人工修改后的正文。 */
    const manualContent = '# 人工更新\n不得被撤销覆盖。'
    /** 人工修改后的新 revision。 */
    const manualEntry = {
      ...currentEntry,
      revision: createHash('sha256').update(`${currentEntry.revision}\0manual`).digest('hex'),
      title: '人工更新',
      state: 'confirmed' as const,
      updatedAt: currentTime + 1,
    }
    await service.store.transact(getProject(), 'workspace-1', () => ({
      commits: [{ entry: manualEntry, content: manualContent }],
    }))

    await expect(service.undo('workspace-1', operation.id)).rejects.toThrow('整理撤销冲突')
    /** 冲突后原条目的人工正文仍保持在当前不可变版本。 */
    const afterConflict = service.store.readManifest(getProject())!
    expect(service.store.readContent(getProject(), afterConflict, entryB.id)).toBe(manualContent)
  })

  test('Given 草稿候选 When 确认或拒绝 Then 发布审核版本且拒绝来源不能复活', async () => {
    /** 将被确认的草稿。 */
    const confirmed = createManagedEntry('review-confirm', '确认候选', '确认正文', 'draft', 'conversation')
    /** 将被拒绝的草稿。 */
    const rejected = createManagedEntry('review-reject', '拒绝候选', '拒绝正文', 'draft', 'conversation')
    /** 审核测试服务。 */
    const service = await seedEntries([
      { entry: confirmed, content: '确认正文' },
      { entry: rejected, content: '拒绝正文' },
    ])

    await service.reviewEntry({
      workspaceId: 'workspace-1',
      entryId: confirmed.id,
      expectedRevision: confirmed.revision,
      action: 'confirm',
    })
    const reviewed = await service.reviewEntry({
      workspaceId: 'workspace-1',
      entryId: rejected.id,
      expectedRevision: rejected.revision,
      action: 'reject',
    })
    expect(reviewed.entries.find((entry) => entry.id === confirmed.id)?.state).toBe('confirmed')
    expect(reviewed.entries.find((entry) => entry.id === rejected.id)?.state).toBe('archived')
    expect(service.store.readManifest(getProject())?.excludedSources).toContain(rejected.source.id)
    expect((await service.search({
      workspaceId: 'workspace-1',
      query: '拒绝正文',
      includeHistory: true,
    })).items.some((item) => item.entry.id === rejected.id)).toBe(false)
    expect((await service.read({ workspaceId: 'workspace-1', entryId: rejected.id })).status).toBe('unavailable')

    /** 尝试以同一来源重新发布的新草稿。 */
    const resurrected = createManagedEntry('review-reject', '复活候选', '拒绝正文', 'draft', 'conversation')
    await expect(service.store.transact(getProject(), 'workspace-1', () => ({
      commits: [{ entry: resurrected, content: '拒绝正文' }],
    }))).rejects.toThrow('来源已被拒绝')
  })

  test('Given 已确认原文件条目 When 用户拒绝 Then 只排除来源且不改写原文件', async () => {
    /** 原文件正文。 */
    const sourceContent = '# External\n用户不希望继续使用。'
    writeFileSync(join(projectRoot, 'external.md'), sourceContent, 'utf8')
    /** 已扫描原文件的服务。 */
    const service = createService()
    await service.startScan('workspace-1')
    await service.waitForScan('workspace-1')
    /** 当前原文件条目。 */
    const entry = (await service.getSnapshot('workspace-1')).entries[0]
    if (!entry) throw new Error('测试原文件条目缺失')

    await service.reviewEntry({
      workspaceId: 'workspace-1',
      entryId: entry.id,
      expectedRevision: entry.revision,
      action: 'reject',
    })
    expect((await service.read({ workspaceId: 'workspace-1', entryId: entry.id })).status).toBe('unavailable')
    expect((await service.search({ workspaceId: 'workspace-1', query: 'External', includeHistory: true })).items).toEqual([])
    expect(readFileSync(join(projectRoot, 'external.md'), 'utf8')).toBe(sourceContent)
  })
})
