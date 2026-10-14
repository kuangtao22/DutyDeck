import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, test } from 'bun:test'
import type { KnowledgeEntry, KnowledgePlanGroup } from '@proma/shared'
import { createProjectKnowledgeStore } from './store'
import type { ProjectKnowledgeServiceDependencies, ResolvedKnowledgeProject } from './types'
import { createKnowledgeVault, readVaultDocument } from './vault'

/** 测试结束后需要清理的真实临时目录。 */
const temporaryRoots: string[] = []

/** 创建隔离项目、真实 Store 与资料库流程。 */
function createFixture() {
  /** 当前测试的隔离父目录。 */
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'proma-vault-'))
  temporaryRoots.push(temporaryRoot)
  /** 用户项目根目录。 */
  const projectRoot = join(temporaryRoot, 'project')
  /** 应用数据根目录。 */
  const dataRoot = join(temporaryRoot, 'data')
  mkdirSync(projectRoot)
  mkdirSync(dataRoot)
  /** Store 使用的可重建索引父目录。 */
  const cacheParent = join(dataRoot, 'knowledge-cache')
  mkdirSync(cacheParent)
  /** 固定工作区对应的可信项目。 */
  const project: ResolvedKnowledgeProject = {
    projectId: 'project-1',
    projectRoot,
    memoryRoot: join(dataRoot, 'memory'),
    cacheRoot: join(cacheParent, 'workspace-1'),
  }
  /** 可注入时钟与项目解析器。 */
  let currentTime = 1_000
  const dependencies: ProjectKnowledgeServiceDependencies = {
    resolveProject: () => project,
    now: () => currentTime++,
  }
  const store = createProjectKnowledgeStore(dependencies)
  return { project, projectRoot, store, vault: createKnowledgeVault(dependencies, store) }
}

/** 生成一个可确认的自由分组。 */
function group(id = 'group-a', title = '架构'): KnowledgePlanGroup {
  return { id, title, summary: '整理项目架构', sources: [], gaps: [], outputs: ['架构说明'] }
}

/** 提案、确认并保存一个正文大纲。 */
async function prepareOutline(fixture: ReturnType<typeof createFixture>): Promise<void> {
  await fixture.vault.proposePlan({
    workspaceId: 'workspace-1', title: '项目资料库', rootRelativePath: 'docs/knowledge', groups: [group()],
  })
  const proposal = fixture.store.readManifest(fixture.project)?.workflow?.proposal
  if (!proposal) throw new Error('测试提案缺失')
  await fixture.vault.confirmPlan({
    workspaceId: 'workspace-1', planId: proposal.id, expectedRevision: proposal.revision,
    groups: [{ id: 'group-a', title: '系统架构' }],
  })
  await fixture.vault.saveOutline({
    workspaceId: 'workspace-1', planRevision: proposal.revision, expectedRevision: 0,
    items: [{ id: 'topic-a', groupId: 'group-a', title: '运行架构', relativePath: '架构/运行架构.md', summary: '说明运行架构', sections: ['边界', '流程'] }],
  })
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('项目知识资料库文件流程', () => {
  test('Given 未知或空的已知依赖 When 保存大纲 Then 拒绝伪造按项来源关系', async () => {
    const fixture = createFixture()
    await prepareOutline(fixture)
    const workflow = fixture.store.readManifest(fixture.project)!.workflow!
    const base = { workspaceId: 'workspace-1', planRevision: workflow.approved!.revision, expectedRevision: workflow.outline!.revision }
    const item = { id: 'topic-a', groupId: 'group-a', title: '运行架构', relativePath: '架构/运行架构.md', summary: '说明', sections: ['边界'] }
    await expect(fixture.vault.saveOutline({ ...base, items: [{ ...item, dependencyState: 'known', sources: [] }] })).rejects.toThrow('不能为空')
    await expect(fixture.vault.saveOutline({ ...base, items: [{ ...item, sources: [{ entryId: 'a'.repeat(32), revision: 'b'.repeat(64) }] }] })).rejects.toThrow('依赖版本')
    await expect(fixture.vault.saveOutline({ ...base, items: [{ ...item, userEvidenceIds: ['invented'] }] })).rejects.toThrow('宿主登记')
  })

  test('Given 历史用户证据仍保留 When 新评估没有当轮重验却引用它 Then 拒绝继承背书', async () => {
    const fixture = createFixture()
    await prepareOutline(fixture)
    const workflow = fixture.store.readManifest(fixture.project)!.workflow!
    const input = { workspaceId: 'workspace-1', planRevision: workflow.approved!.revision,
      outlineRevision: workflow.outline!.revision, itemId: 'topic-a', expectedRevision: null,
      content: '业务规则。', summary: '规则', complete: true, evidence: [],
      userEvidence: { sessionId: 'session', messageId: 'message', quote: '业务规则。' } }
    await fixture.vault.writeDocument(input)
    const manifest = fixture.store.readManifest(fixture.project)!
    const entry = fixture.store.readEntries(fixture.project, manifest)[0]!
    await expect(fixture.vault.writeDocument({ ...input, userEvidence: undefined,
      outlineRevision: manifest.workflow!.outline!.revision, expectedRevision: entry.revision,
      admission: { contentType: 'rule', importance: 'high', purpose: '规则复用', scope: '当前项目',
        claims: [{ statement: '业务规则。', evidenceIndexes: [], usesUserEvidence: true }],
        coverage: [{ topic: '业务', status: 'covered', reason: '原用户说明' }], issues: [], outcome: 'eligible' },
    })).rejects.toThrow('本次用户证据')
  })

  test('Given 旧运行正文事务排队 When 暂停后新代次恢复 Then 锁内守卫拒绝旧写入', async () => {
    const fixture = createFixture()
    await prepareOutline(fixture)
    const workflow = fixture.store.readManifest(fixture.project)!.workflow!
    /** 模拟事务等待期间旧运行失效，但 workflow.paused 已经被新运行清除。 */
    let current = true
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const original = fixture.store.transact
    fixture.store.transact = async (...args) => { await waiting; return original(...args) }
    const writing = fixture.vault.writeDocument({ workspaceId: 'workspace-1', planRevision: workflow.approved!.revision,
      outlineRevision: workflow.outline!.revision, itemId: 'topic-a', expectedRevision: null,
      content: '旧运行正文', summary: '旧正文', complete: true, evidence: [],
    }, () => { if (!current) throw new Error('旧运行代次失效') })
    current = false
    release()
    await expect(writing).rejects.toThrow('旧运行代次失效')
    expect(existsSync(join(fixture.projectRoot, 'docs/knowledge/架构/运行架构.md'))).toBe(false)
    expect(fixture.store.readManifest(fixture.project)!.workflow!.outline!.items[0]!.status).toBe('pending')
  })

  test('Given Store 事务生命周期 hook When 发布成功或失败 Then 都在返回前完成收尾', async () => {
    const fixture = createFixture()
    await fixture.vault.proposePlan({
      workspaceId: 'workspace-1', title: '资料库', rootRelativePath: 'knowledge', groups: [group()],
    })
    let committed = false
    await fixture.store.transact(fixture.project, 'workspace-1', (current) => ({
      workflow: { ...(current.manifest.workflow ?? { paused: false }), paused: true },
      onCommitted: () => { committed = true },
    }))
    expect(committed).toBe(true)

    let aborted = false
    await expect(fixture.store.transact(fixture.project, 'workspace-1', () => ({
      commits: [{ entry: { id: 'invalid' } as KnowledgeEntry }],
      onAborted: () => { aborted = true },
    }))).rejects.toThrow('非法')
    expect(aborted).toBe(true)
  })

  test('Given Agent 提案 When 尚未确认 Then 只保存 proposal 且不创建资料库根', async () => {
    const fixture = createFixture()
    await fixture.vault.proposePlan({
      workspaceId: 'workspace-1', title: '项目资料库', rootRelativePath: 'docs/knowledge', groups: [group()],
    })

    const workflow = fixture.store.readManifest(fixture.project)?.workflow
    expect(workflow?.proposal?.groups[0]?.title).toBe('架构')
    expect(workflow?.approved).toBeUndefined()
    expect(existsSync(join(fixture.projectRoot, 'docs/knowledge'))).toBe(false)
  })

  test('Given 提案引用来源 When 来源过期、重复、被排除或属于新文档 Then core 拒绝保存', async () => {
    const fixture = createFixture()
    await fixture.vault.proposePlan({
      workspaceId: 'workspace-1', title: '初始化', rootRelativePath: 'knowledge', groups: [group()],
    })
    const source: KnowledgeEntry = {
      id: 'a'.repeat(32), revision: 'b'.repeat(64), title: '原始来源', category: 'source', kind: 'document',
      state: 'indexed', freshness: 'current', summary: '来源',
      source: { kind: 'project-file', id: 'source:file', relativePath: 'README.md', revision: 'disk' },
      byteSize: 1, indexedBytes: 1, truncated: false, metadataOnly: false, updatedAt: 1,
    }
    await fixture.store.transact(fixture.project, 'workspace-1', () => ({ commits: [{ entry: source }] }))
    await expect(fixture.vault.proposePlan({
      workspaceId: 'workspace-1', title: '非法', rootRelativePath: 'knowledge',
      groups: [{ ...group(), sources: [{ entryId: source.id, revision: 'c'.repeat(64) }] }],
    })).rejects.toThrow('来源')
    await fixture.vault.proposePlan({
      workspaceId: 'workspace-1', title: '去重', rootRelativePath: 'knowledge',
      groups: [{ ...group(), sources: [
        { entryId: source.id, revision: source.revision },
        { entryId: source.id, revision: source.revision },
      ] }, { ...group('second-topic', '其他主题'), sources: [{ entryId: source.id, revision: source.revision }] }],
    })
    const normalizedSource = fixture.store.readManifest(fixture.project)?.workflow?.proposal?.groups[0]?.sources
    expect(normalizedSource).toEqual([expect.objectContaining({
      entryId: source.id, revision: source.revision, title: '原始来源', relativePath: 'README.md',
    })])
    expect(fixture.store.readManifest(fixture.project)?.workflow?.proposal?.groups[1]?.sources).toHaveLength(1)
    await fixture.store.transact(fixture.project, 'workspace-1', (current) => ({
      excludedSources: [...(current.manifest.excludedSources ?? []), source.source.id],
    }))
    await expect(fixture.vault.proposePlan({
      workspaceId: 'workspace-1', title: '排除', rootRelativePath: 'knowledge',
      groups: [{ ...group(), sources: [{ entryId: source.id, revision: source.revision }] }],
    })).rejects.toThrow('排除')
    const managedDocument: KnowledgeEntry = {
      ...source,
      id: 'd'.repeat(32), revision: 'e'.repeat(64), state: 'draft',
      source: { kind: 'managed', id: 'vault:document', revision: 'disk' },
      document: {
        topicKey: 'new-document', groupId: 'group-a', rootRelativePath: 'knowledge',
        relativePath: 'new.md', contentRevision: 'f'.repeat(64),
      },
    }
    await fixture.store.transact(fixture.project, 'workspace-1', () => ({
      commits: [{ entry: managedDocument, content: '# 新文档' }],
    }))
    await expect(fixture.vault.proposePlan({
      workspaceId: 'workspace-1', title: '循环', rootRelativePath: 'knowledge',
      groups: [{ ...group(), sources: [{ entryId: managedDocument.id, revision: managedDocument.revision }] }],
    })).rejects.toThrow('原始提案来源')
  })

  test('Given 两个提案分组 When 用户部分确认并改名 Then 只批准已有选中分组', async () => {
    const fixture = createFixture()
    await fixture.vault.proposePlan({
      workspaceId: 'workspace-1', title: '资料库', rootRelativePath: 'knowledge',
      groups: [group('a', '旧名'), group('b', '不确认')],
    })
    const proposal = fixture.store.readManifest(fixture.project)?.workflow?.proposal
    if (!proposal) throw new Error('测试提案缺失')
    await fixture.vault.confirmPlan({
      workspaceId: 'workspace-1', planId: proposal.id, expectedRevision: proposal.revision,
      groups: [{ id: 'a', title: '新名称' }],
    })

    expect(fixture.store.readManifest(fixture.project)?.workflow?.approved?.groups).toEqual([
      { ...group('a', '旧名'), title: '新名称' },
    ])
    await expect(fixture.vault.confirmPlan({
      workspaceId: 'workspace-1', planId: proposal.id, expectedRevision: proposal.revision - 1,
      groups: [{ id: 'a', title: '覆盖' }],
    })).rejects.toThrow(/版本|身份/)
  })

  test('Given 已确认任意分组 When 先保存大纲再写正文 Then 生成真实索引和可读 Markdown', async () => {
    const fixture = createFixture()
    await prepareOutline(fixture)
    const workflow = fixture.store.readManifest(fixture.project)?.workflow
    expect(readFileSync(join(fixture.projectRoot, 'docs/knowledge/索引.md'), 'utf8')).toContain('待补')

    await fixture.vault.writeDocument({
      workspaceId: 'workspace-1', planRevision: workflow?.approved?.revision ?? -1,
      outlineRevision: workflow?.outline?.revision ?? -1, itemId: 'topic-a', expectedRevision: null,
      content: '# 运行架构\n\n正文。', summary: '运行架构正文', complete: true, evidence: [],
      userEvidence: { sessionId: 'session-1', messageId: 'message-1', quote: '请整理运行架构' },
    })

    const manifest = fixture.store.readManifest(fixture.project)
    const entry = fixture.store.readEntries(fixture.project, manifest!)[0]
    expect(entry?.category).toBe('系统架构')
    expect(entry?.document?.relativePath).toBe('架构/运行架构.md')
    expect(entry?.userEvidence?.messageId).toBe('message-1')
    expect(readVaultDocument(fixture.project, entry!)).toBe('# 运行架构\n\n正文。')
    expect(readFileSync(join(fixture.projectRoot, 'docs/knowledge/索引.md'), 'utf8')).toContain('(架构/运行架构.md)')
    const revisionBeforeNoop = manifest!.revision
    await fixture.vault.writeDocument({
      workspaceId: 'workspace-1', planRevision: manifest!.workflow!.approved!.revision,
      outlineRevision: manifest!.workflow!.outline!.revision, itemId: 'topic-a', expectedRevision: entry!.revision,
      content: '# 运行架构\n\n正文。', summary: '运行架构正文', complete: true, evidence: [],
    })
    expect(fixture.store.readManifest(fixture.project)?.revision).toBe(revisionBeforeNoop)
  })

  test('Given 正文已发布 When 磁盘被外部修改后 Agent 仍用旧 revision 写入 Then 拒绝覆盖', async () => {
    const fixture = createFixture()
    await prepareOutline(fixture)
    let workflow = fixture.store.readManifest(fixture.project)?.workflow
    await fixture.vault.writeDocument({
      workspaceId: 'workspace-1', planRevision: workflow!.approved!.revision,
      outlineRevision: workflow!.outline!.revision, itemId: 'topic-a', expectedRevision: null,
      content: '# 初版', summary: '初版', complete: false, evidence: [],
    })
    const manifest = fixture.store.readManifest(fixture.project)!
    const entry = fixture.store.readEntries(fixture.project, manifest)[0]!
    const documentPath = join(fixture.projectRoot, 'docs/knowledge/架构/运行架构.md')
    writeFileSync(documentPath, '# 人工修改', 'utf8')
    expect(readVaultDocument(fixture.project, entry)).toBeNull()
    workflow = manifest.workflow

    await expect(fixture.vault.writeDocument({
      workspaceId: 'workspace-1', planRevision: workflow!.approved!.revision,
      outlineRevision: workflow!.outline!.revision, itemId: 'topic-a', expectedRevision: entry.revision,
      content: '# Agent 覆盖', summary: '覆盖', complete: true, evidence: [],
    })).rejects.toThrow('外部修改')
    expect(readFileSync(documentPath, 'utf8')).toBe('# 人工修改')
  })

  test('Given 已完成大纲 When 新提案扩展确认范围 Then 合并分组并保留既有进度', async () => {
    const fixture = createFixture()
    await prepareOutline(fixture)
    const before = fixture.store.readManifest(fixture.project)?.workflow
    await fixture.vault.proposePlan({
      workspaceId: 'workspace-1', title: '扩展资料库', rootRelativePath: 'docs/knowledge',
      groups: [group('group-b', '运维')],
    })
    const proposal = fixture.store.readManifest(fixture.project)?.workflow?.proposal
    await fixture.vault.confirmPlan({
      workspaceId: 'workspace-1', planId: proposal!.id, expectedRevision: proposal!.revision,
      groups: [{ id: 'group-b', title: '运行维护' }],
    })
    const after = fixture.store.readManifest(fixture.project)?.workflow
    expect(after?.proposal).toBeUndefined()
    expect(after?.approved?.groups.map((item) => item.id)).toEqual(['group-a', 'group-b'])
    expect(after?.outline).toEqual(before?.outline)
  })

  test('Given 已发布索引 When 确认新增分组并改标题后继续写正文与大纲 Then 旧索引仍是可信发布基线', async () => {
    /** 隔离的旧资料库。 */
    const fixture = createFixture()
    await prepareOutline(fixture)
    await fixture.vault.proposePlan({ workspaceId: 'workspace-1', title: '产品知识', rootRelativePath: 'docs/knowledge', groups: [group('group-b', '产品')] })
    /** 待确认的扩展计划。 */
    const proposal = fixture.store.readManifest(fixture.project)!.workflow!.proposal!
    await fixture.vault.confirmPlan({ workspaceId: 'workspace-1', planId: proposal.id, expectedRevision: proposal.revision, groups: [{ id: 'group-b', title: '产品' }] })
    /** 当前流程，正文写入先于新大纲。 */
    let workflow = fixture.store.readManifest(fixture.project)!.workflow!
    await fixture.vault.writeDocument({ workspaceId: 'workspace-1', planRevision: workflow.approved!.revision, outlineRevision: workflow.outline!.revision, itemId: 'topic-a', expectedRevision: null, content: '# 原正文', summary: '正文', complete: true, evidence: [] })
    workflow = fixture.store.readManifest(fixture.project)!.workflow!
    await fixture.vault.saveOutline({ workspaceId: 'workspace-1', planRevision: workflow.approved!.revision, expectedRevision: workflow.outline!.revision, items: [...workflow.outline!.items, { id: 'topic-b', groupId: 'group-b', title: '产品规则', relativePath: '产品/规则.md', summary: '规则', sections: [] }] })
    expect(readFileSync(join(fixture.projectRoot, 'docs/knowledge/索引.md'), 'utf8')).toContain('# 产品知识')
  })

  for (const operation of ['outline', 'document', 'refresh'] as const) {
    test(`Given 旧版索引无摘要且扩展计划只新增分组 When ${operation} Then 可证明旧结构恢复且保存新基线`, async () => {
      /** 模拟真实旧版错位数据的隔离库。 */
      const fixture = createFixture()
      await prepareOutline(fixture)
      await fixture.store.transact(fixture.project, 'workspace-1', (current) => ({ workflow: { ...current.manifest.workflow!, outline: { ...current.manifest.workflow!.outline!, publishedContentRevision: undefined } } }))
      await fixture.vault.proposePlan({ workspaceId: 'workspace-1', title: '项目资料库', rootRelativePath: 'docs/knowledge', groups: [group('group-b', '产品')] })
      /** 已确认扩展版本，不修改旧索引。 */
      const proposal = fixture.store.readManifest(fixture.project)!.workflow!.proposal!
      await fixture.vault.confirmPlan({ workspaceId: 'workspace-1', planId: proposal.id, expectedRevision: proposal.revision, groups: [{ id: 'group-b', title: '产品' }] })
      /** 读取新计划与旧大纲。 */
      const workflow = fixture.store.readManifest(fixture.project)!.workflow!
      if (operation === 'outline') await fixture.vault.saveOutline({ workspaceId: 'workspace-1', planRevision: workflow.approved!.revision, expectedRevision: workflow.outline!.revision, items: workflow.outline!.items })
      if (operation === 'document') await fixture.vault.writeDocument({ workspaceId: 'workspace-1', planRevision: workflow.approved!.revision, outlineRevision: workflow.outline!.revision, itemId: 'topic-a', expectedRevision: null, content: '# 正文', summary: '正文', complete: true, evidence: [] })
      if (operation === 'refresh') {
        writeFileSync(join(fixture.projectRoot, 'docs/knowledge/手写.md'), '# 新资料')
        await fixture.vault.refresh('workspace-1')
      }
      expect(fixture.store.readManifest(fixture.project)!.workflow!.outline!.publishedContentRevision).toMatch(/^[a-f0-9]{64}$/)
      expect(readFileSync(join(fixture.projectRoot, 'docs/knowledge/索引.md'), 'utf8')).toContain('## 产品')
    })

    test(`Given 人工修改索引 When ${operation} Then 拒绝覆盖人工内容`, async () => {
      /** 含人工索引修改的隔离库。 */
      const fixture = createFixture()
      await prepareOutline(fixture)
      /** 将要保护的原路径。 */
      const path = join(fixture.projectRoot, 'docs/knowledge/索引.md')
      writeFileSync(path, readFileSync(path, 'utf8') + '\n人工备注')
      /** 写请求所需版本。 */
      const workflow = fixture.store.readManifest(fixture.project)!.workflow!
      /** 各写入口都必须拒绝不匹配基线。 */
      const action = operation === 'outline'
        ? fixture.vault.saveOutline({ workspaceId: 'workspace-1', planRevision: workflow.approved!.revision, expectedRevision: workflow.outline!.revision, items: workflow.outline!.items })
        : operation === 'document'
          ? fixture.vault.writeDocument({ workspaceId: 'workspace-1', planRevision: workflow.approved!.revision, outlineRevision: workflow.outline!.revision, itemId: 'topic-a', expectedRevision: null, content: '# 正文', summary: '正文', complete: true, evidence: [] })
          : (writeFileSync(join(fixture.projectRoot, 'docs/knowledge/手写.md'), '# 新资料'), fixture.vault.refresh('workspace-1'))
      await expect(action).rejects.toThrow('人工修改')
      expect(readFileSync(path, 'utf8')).toContain('人工备注')
    })
  }

  test('Given 旧版标题已变化且无法证明索引来源 When 保存大纲 Then 保留冲突直到用户明确重建', async () => {
    /** 不具备发布基线的旧库。 */
    const fixture = createFixture()
    await prepareOutline(fixture)
    await fixture.store.transact(fixture.project, 'workspace-1', (current) => ({ workflow: { ...current.manifest.workflow!, approved: { ...current.manifest.workflow!.approved!, revision: 2, title: '新标题' }, outline: { ...current.manifest.workflow!.outline!, publishedContentRevision: undefined } } }))
    /** 错位的计划与大纲。 */
    const workflow = fixture.store.readManifest(fixture.project)!.workflow!
    await expect(fixture.vault.saveOutline({ workspaceId: 'workspace-1', planRevision: 2, expectedRevision: workflow.outline!.revision, items: workflow.outline!.items })).rejects.toThrow('发布基线')
    /** 用户所见差异预览。 */
    const preview = await fixture.vault.previewIndex('workspace-1')
    expect(preview.currentContent).toContain('# 项目资料库')
    expect(preview.generatedContent).toContain('# 新标题')
    /** 用户明确确认后原文必须进入可恢复备份。 */
    const rebuilt = await fixture.vault.rebuildIndex({ workspaceId: 'workspace-1', planRevision: preview.planRevision, outlineRevision: preview.outlineRevision, expectedContentRevision: preview.currentRevision })
    expect(JSON.parse(readFileSync(join(fixture.projectRoot, rebuilt.backupRelativePath!), 'utf8')).content).toBe(preview.currentContent!)
    expect(readFileSync(join(fixture.projectRoot, 'docs/knowledge/索引.md'), 'utf8')).toBe(preview.generatedContent)
  })

  test('Given 重建预览后文件或计划改变 When 用户确认旧预览 Then 不覆盖新内容', async () => {
    /** 用于迟到确认校验的隔离库。 */
    const fixture = createFixture()
    await prepareOutline(fixture)
    /** 原预览与请求身份。 */
    const preview = await fixture.vault.previewIndex('workspace-1')
    const input = { workspaceId: 'workspace-1', planRevision: preview.planRevision, outlineRevision: preview.outlineRevision, expectedContentRevision: preview.currentRevision }
    await expect(fixture.vault.rebuildIndex({ ...input, planRevision: input.planRevision + 1 })).rejects.toThrow('计划版本')
    await expect(fixture.vault.rebuildIndex({ ...input, outlineRevision: input.outlineRevision + 1 })).rejects.toThrow('大纲版本')
    writeFileSync(join(fixture.projectRoot, 'docs/knowledge/索引.md'), '# 迟到人工修改')
    await expect(fixture.vault.rebuildIndex(input)).rejects.toThrow('预览版本')
    expect(readFileSync(join(fixture.projectRoot, 'docs/knowledge/索引.md'), 'utf8')).toBe('# 迟到人工修改')
  })

  for (const operation of ['refresh', 'rebuild'] as const) {
    test(`Given ${operation} 索引已写入但 manifest 失败 When 回滚 Then 索引和基线仍保持旧版本`, async () => {
      /** 用于注入提交失败的独立 Store。 */
      const fixture = createFixture()
      await prepareOutline(fixture)
      /** 发布前的可信版本。 */
      const before = fixture.store.readManifest(fixture.project)!
      const preview = await fixture.vault.previewIndex('workspace-1')
      const originalTransact = fixture.store.transact
      fixture.store.transact = async (project, workspaceId, update) => originalTransact(project, workspaceId, (current) => {
        /** 仅在真正写文件的事务处模拟失败，refresh 的前置恢复不受影响。 */
        const result = update(current)
        if (result.vaultCommitId) { result.onAborted?.(); throw new Error('模拟索引提交失败') }
        return result
      })
      writeFileSync(join(fixture.projectRoot, 'docs/knowledge/手写.md'), '# 新资料')
      await expect(operation === 'refresh' ? fixture.vault.refresh('workspace-1') : fixture.vault.rebuildIndex({ workspaceId: 'workspace-1', planRevision: preview.planRevision, outlineRevision: preview.outlineRevision, expectedContentRevision: preview.currentRevision })).rejects.toThrow('模拟索引提交失败')
      expect(readFileSync(join(fixture.projectRoot, 'docs/knowledge/索引.md'), 'utf8')).toBe(preview.currentContent!)
      expect(fixture.store.readManifest(fixture.project)!.workflow).toEqual(before.workflow)
    })
  }

  test('Given 已生成正文引用同目录图片 When 用户要求重组路径 Then 保持条目身份并修正相对链接', async () => {
    const fixture = createFixture()
    await prepareOutline(fixture)
    let workflow = fixture.store.readManifest(fixture.project)?.workflow
    await fixture.vault.writeDocument({
      workspaceId: 'workspace-1', planRevision: workflow!.approved!.revision,
      outlineRevision: workflow!.outline!.revision, itemId: 'topic-a', expectedRevision: null,
      content: '# 运行架构\n\n![图](assets/flow.png)', summary: '运行架构正文', complete: true, evidence: [],
    })
    const beforeManifest = fixture.store.readManifest(fixture.project)!
    const beforeEntry = fixture.store.readEntries(fixture.project, beforeManifest)[0]!
    workflow = beforeManifest.workflow

    await fixture.vault.saveOutline({
      workspaceId: 'workspace-1', planRevision: workflow!.approved!.revision,
      expectedRevision: workflow!.outline!.revision,
      items: [{ id: 'topic-a', groupId: 'group-a', title: '运行架构', relativePath: '重组/运行架构.md', summary: '说明运行架构', sections: ['边界', '流程'] }],
    })

    const afterManifest = fixture.store.readManifest(fixture.project)!
    const afterEntry = fixture.store.readEntries(fixture.project, afterManifest)[0]!
    expect(afterEntry.id).toBe(beforeEntry.id)
    expect(afterEntry.revision).not.toBe(beforeEntry.revision)
    expect(afterEntry.document?.relativePath).toBe('重组/运行架构.md')
    expect(existsSync(join(fixture.projectRoot, 'docs/knowledge/架构/运行架构.md'))).toBe(false)
    expect(readVaultDocument(fixture.project, afterEntry)).toContain('![图](../架构/assets/flow.png)')
    expect(fixture.store.readContent(fixture.project, beforeManifest, beforeEntry.id)).toContain('assets/flow.png')
  })

  test('Given 正文移动后 manifest 发布失败 When 锁内回滚 Then 原路径与内容完整恢复', async () => {
    const fixture = createFixture()
    await prepareOutline(fixture)
    let workflow = fixture.store.readManifest(fixture.project)?.workflow
    await fixture.vault.writeDocument({
      workspaceId: 'workspace-1', planRevision: workflow!.approved!.revision,
      outlineRevision: workflow!.outline!.revision, itemId: 'topic-a', expectedRevision: null,
      content: '# 原正文', summary: '原正文', complete: true, evidence: [],
    })
    workflow = fixture.store.readManifest(fixture.project)?.workflow
    const oldPath = join(fixture.projectRoot, 'docs/knowledge/架构/运行架构.md')
    const newPath = join(fixture.projectRoot, 'docs/knowledge/重组/运行架构.md')
    const oldContent = readFileSync(oldPath, 'utf8')
    const originalTransact = fixture.store.transact
    fixture.store.transact = async (project, workspaceId, update) => originalTransact(project, workspaceId, (current) => {
      const result = update(current)
      result.onAborted?.()
      throw new Error('模拟 manifest 失败')
    })

    await expect(fixture.vault.saveOutline({
      workspaceId: 'workspace-1', planRevision: workflow!.approved!.revision,
      expectedRevision: workflow!.outline!.revision,
      items: [{ id: 'topic-a', groupId: 'group-a', title: '运行架构', relativePath: '重组/运行架构.md', summary: '说明运行架构', sections: ['边界'] }],
    })).rejects.toThrow('模拟 manifest 失败')
    expect(readFileSync(oldPath, 'utf8')).toBe(oldContent)
    expect(existsSync(newPath)).toBe(false)
  })

  test('Given 证据引用已过期或被排除 When 写正文 Then core 拒绝发布', async () => {
    const fixture = createFixture()
    await prepareOutline(fixture)
    const source: KnowledgeEntry = {
      id: '1'.repeat(32), revision: '2'.repeat(64), title: '来源', category: 'source', kind: 'document',
      state: 'indexed', freshness: 'current', summary: '来源',
      source: { kind: 'project-file', id: 'source:file', relativePath: 'README.md', revision: 'disk-rev' },
      byteSize: 1, indexedBytes: 1, truncated: false, metadataOnly: false, updatedAt: 1,
    }
    await fixture.store.transact(fixture.project, 'workspace-1', () => ({ commits: [{ entry: source }] }))
    const workflow = fixture.store.readManifest(fixture.project)?.workflow

    await expect(fixture.vault.writeDocument({
      workspaceId: 'workspace-1', planRevision: workflow!.approved!.revision,
      outlineRevision: workflow!.outline!.revision, itemId: 'topic-a', expectedRevision: null,
      content: '# 内容', summary: '内容', complete: true,
      evidence: [{ entryId: source.id, revision: '3'.repeat(64), quote: '旧引文' }],
    })).rejects.toThrow('证据')
  })

  test('Given 资料库路径经过符号链接 When 保存大纲 Then 拒绝跨目录写入', async () => {
    const fixture = createFixture()
    const outside = join(fixture.projectRoot, '..', 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(fixture.projectRoot, 'linked'))
    await fixture.vault.proposePlan({
      workspaceId: 'workspace-1', title: '资料库', rootRelativePath: 'linked/vault', groups: [group()],
    })
    const proposal = fixture.store.readManifest(fixture.project)?.workflow?.proposal
    await expect(fixture.vault.confirmPlan({
      workspaceId: 'workspace-1', planId: proposal!.id, expectedRevision: proposal!.revision,
      groups: [{ id: 'group-a', title: '架构' }],
    })).rejects.toThrow('符号链接')
  })

  test('Given 已发布正文 When 外部改写、改名和删除后刷新 Then 保持身份并标记草稿或缺失', async () => {
    const fixture = createFixture()
    await prepareOutline(fixture)
    const workflow = fixture.store.readManifest(fixture.project)?.workflow
    await fixture.vault.writeDocument({
      workspaceId: 'workspace-1', planRevision: workflow!.approved!.revision,
      outlineRevision: workflow!.outline!.revision, itemId: 'topic-a', expectedRevision: null,
      content: '# 初版', summary: '初版', complete: true, evidence: [],
    })
    let manifest = fixture.store.readManifest(fixture.project)!
    const original = fixture.store.readEntries(fixture.project, manifest)[0]!
    const oldPath = join(fixture.projectRoot, 'docs/knowledge/架构/运行架构.md')
    writeFileSync(oldPath, readFileSync(oldPath, 'utf8').replace('# 初版', '# 人工新版'), 'utf8')
    await fixture.vault.refresh('workspace-1')
    manifest = fixture.store.readManifest(fixture.project)!
    expect(fixture.store.readEntry(fixture.project, manifest, original.id)).toMatchObject({ state: 'draft', freshness: 'unverified' })

    const newPath = join(fixture.projectRoot, 'docs/knowledge/架构/重命名.md')
    renameSync(oldPath, newPath)
    await fixture.vault.refresh('workspace-1')
    manifest = fixture.store.readManifest(fixture.project)!
    expect(fixture.store.readEntry(fixture.project, manifest, original.id).document?.relativePath).toBe('架构/重命名.md')

    rmSync(newPath)
    await fixture.vault.refresh('workspace-1')
    manifest = fixture.store.readManifest(fixture.project)!
    expect(fixture.store.readEntry(fixture.project, manifest, original.id)).toMatchObject({ state: 'archived', freshness: 'unavailable' })
  })

  test('Given manifest 发布失败 When 正文已经进入写阶段 Then 恢复旧磁盘内容', async () => {
    const fixture = createFixture()
    await prepareOutline(fixture)
    const workflow = fixture.store.readManifest(fixture.project)?.workflow
    const originalTransact = fixture.store.transact
    fixture.store.transact = async (project, workspaceId, update) => originalTransact(project, workspaceId, (current) => {
      const result = update(current)
      result.onAborted?.()
      throw new Error('模拟 manifest 失败')
    })

    await expect(fixture.vault.writeDocument({
      workspaceId: 'workspace-1', planRevision: workflow!.approved!.revision,
      outlineRevision: workflow!.outline!.revision, itemId: 'topic-a', expectedRevision: null,
      content: '# 不应遗留', summary: '失败内容', complete: true, evidence: [],
    })).rejects.toThrow('模拟 manifest 失败')
    expect(existsSync(join(fixture.projectRoot, 'docs/knowledge/架构/运行架构.md'))).toBe(false)
  })

  test('Given 发布失败前文件又被外部修改 When 回滚 Then 不覆盖人工新内容', async () => {
    const fixture = createFixture()
    await prepareOutline(fixture)
    const workflow = fixture.store.readManifest(fixture.project)?.workflow
    const documentPath = join(fixture.projectRoot, 'docs/knowledge/架构/运行架构.md')
    const originalTransact = fixture.store.transact
    fixture.store.transact = async (project, workspaceId, update) => originalTransact(project, workspaceId, (current) => {
      const result = update(current)
      writeFileSync(documentPath, '# 人工并发修改', 'utf8')
      result.onAborted?.()
      throw new Error('模拟 manifest 失败')
    })

    await expect(fixture.vault.writeDocument({
      workspaceId: 'workspace-1', planRevision: workflow!.approved!.revision,
      outlineRevision: workflow!.outline!.revision, itemId: 'topic-a', expectedRevision: null,
      content: '# Agent 内容', summary: '失败内容', complete: true, evidence: [],
    })).rejects.toThrow('外部修改')
    expect(readFileSync(documentPath, 'utf8')).toBe('# 人工并发修改')
  })

  test('Given 文件事务崩溃后无关 manifest 先提交 When refresh Then 按事务 ID 回滚而不误认成功', async () => {
    const fixture = createFixture()
    await prepareOutline(fixture)
    const workflow = fixture.store.readManifest(fixture.project)?.workflow
    const documentPath = join(fixture.projectRoot, 'docs/knowledge/架构/运行架构.md')
    const originalTransact = fixture.store.transact
    fixture.store.transact = async (project, workspaceId, update) => originalTransact(project, workspaceId, (current) => {
      update(current)
      /** 模拟进程在文件写完、callback 尚未把 update 交给 Store 时崩溃。 */
      throw new Error('模拟进程崩溃')
    })
    await expect(fixture.vault.writeDocument({
      workspaceId: 'workspace-1', planRevision: workflow!.approved!.revision,
      outlineRevision: workflow!.outline!.revision, itemId: 'topic-a', expectedRevision: null,
      content: '# 崩溃中间态', summary: '中间态', complete: true, evidence: [],
    })).rejects.toThrow('模拟进程崩溃')
    expect(existsSync(documentPath)).toBe(true)

    fixture.store.transact = originalTransact
    await fixture.store.transact(fixture.project, 'workspace-1', (current) => ({
      workflow: { ...(current.manifest.workflow ?? { paused: false }), paused: true },
    }))
    await fixture.vault.refresh('workspace-1')
    const manifest = fixture.store.readManifest(fixture.project)!
    expect(existsSync(documentPath)).toBe(false)
    expect(fixture.store.readEntries(fixture.project, manifest).some((entry) => entry.document?.topicKey === 'topic-a')).toBe(false)
  })

  test('Given 接近正文上限的更新在写后崩溃 When 下次进入事务 Then 大型恢复日志仍可完整回滚', async () => {
    const fixture = createFixture()
    await prepareOutline(fixture)
    let workflow = fixture.store.readManifest(fixture.project)?.workflow
    const originalContent = `# 大文档\n\n${'A'.repeat(1_100_000)}`
    await fixture.vault.writeDocument({
      workspaceId: 'workspace-1', planRevision: workflow!.approved!.revision,
      outlineRevision: workflow!.outline!.revision, itemId: 'topic-a', expectedRevision: null,
      content: originalContent, summary: '大文档', complete: true, evidence: [],
    })
    const manifest = fixture.store.readManifest(fixture.project)!
    const entry = fixture.store.readEntries(fixture.project, manifest)[0]!
    workflow = manifest.workflow
    const documentPath = join(fixture.projectRoot, 'docs/knowledge/架构/运行架构.md')
    const originalTransact = fixture.store.transact
    fixture.store.transact = async (project, workspaceId, update) => originalTransact(project, workspaceId, (current) => {
      update(current)
      throw new Error('模拟大型写入崩溃')
    })
    await expect(fixture.vault.writeDocument({
      workspaceId: 'workspace-1', planRevision: workflow!.approved!.revision,
      outlineRevision: workflow!.outline!.revision, itemId: 'topic-a', expectedRevision: entry.revision,
      content: `# 大文档\n\n${'B'.repeat(1_100_000)}`, summary: '大文档', complete: true, evidence: [],
    })).rejects.toThrow('模拟大型写入崩溃')
    fixture.store.transact = originalTransact
    await fixture.vault.pauseWorkflow({ workspaceId: 'workspace-1', paused: true })
    expect(readFileSync(documentPath, 'utf8')).toContain('AAA')
    expect(readFileSync(documentPath, 'utf8')).not.toContain('BBB')
  })

  test('Given 原文档存在更早排序的 marker 副本 When refresh Then 副本不能劫持原条目身份', async () => {
    const fixture = createFixture()
    await prepareOutline(fixture)
    const workflow = fixture.store.readManifest(fixture.project)?.workflow
    await fixture.vault.writeDocument({
      workspaceId: 'workspace-1', planRevision: workflow!.approved!.revision,
      outlineRevision: workflow!.outline!.revision, itemId: 'topic-a', expectedRevision: null,
      content: '# 原正文', summary: '原正文', complete: true, evidence: [],
    })
    const before = fixture.store.readManifest(fixture.project)!
    const original = fixture.store.readEntries(fixture.project, before)[0]!
    const originalPath = join(fixture.projectRoot, 'docs/knowledge/架构/运行架构.md')
    const copyDirectory = join(fixture.projectRoot, 'docs/knowledge/0copy')
    mkdirSync(copyDirectory)
    writeFileSync(join(copyDirectory, '副本.md'), readFileSync(originalPath, 'utf8'), 'utf8')
    await fixture.vault.refresh('workspace-1')
    const after = fixture.store.readManifest(fixture.project)!
    const entries = fixture.store.readEntries(fixture.project, after)
    expect(entries.find((entry) => entry.id === original.id)?.document?.relativePath).toBe('架构/运行架构.md')
    expect(entries.find((entry) => entry.document?.relativePath === '0copy/副本.md')?.id).not.toBe(original.id)
  })

  test('Given 手写 Markdown 没有身份注释 When 刷新 Then 以稳定 ID 登记并重建缓存', async () => {
    const fixture = createFixture()
    await prepareOutline(fixture)
    const manualPath = join(fixture.projectRoot, 'docs/knowledge/手写.md')
    writeFileSync(manualPath, '# 手写资料\n\nmanual-keyword', 'utf8')
    await fixture.vault.refresh('workspace-1')
    const manifest = fixture.store.readManifest(fixture.project)!
    const entry = fixture.store.readEntries(fixture.project, manifest).find((candidate) => candidate.document?.relativePath === '手写.md')
    expect(entry?.id).toMatch(/^[a-f0-9]{32}$/)
    expect(entry?.document?.contentRevision).toBe(createHash('sha256').update(readFileSync(manualPath)).digest('hex'))
    expect(fixture.store.readIndex(fixture.project, manifest.indexRevision ?? manifest.revision)?.records[entry!.id]?.text).toContain('manual-keyword')
  })
})
