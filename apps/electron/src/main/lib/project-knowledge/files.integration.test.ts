import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { createProjectKnowledgeService } from './service'
import type { ResolvedKnowledgeProject } from './types'

/** 仅保存本测试建立的隔离目录。 */
const temporaryRoots: string[] = []

/** 建立真实服务和临时项目，返回可重启的相同依赖。 */
function fixture() {
  /** 项目与应用缓存均限定在临时目录。 */
  const root = mkdtempSync(join(tmpdir(), 'knowledge-files-integration-'))
  temporaryRoots.push(root)
  mkdirSync(join(root, 'project'))
  mkdirSync(join(root, 'data'))
  /** 与运行时相同的可信路径绑定。 */
  const project: ResolvedKnowledgeProject = {
    projectId: 'project-files', projectRoot: join(root, 'project'),
    memoryRoot: join(root, 'data/memory'), cacheRoot: join(root, 'data/knowledge-cache/workspace'),
  }
  /** 重启服务时仍复用同一个项目身份。 */
  const dependencies = { resolveProject: () => project }
  return { project, dependencies, service: createProjectKnowledgeService(dependencies) }
}

/** 从真实扫描材料建立一个任意业务分组，返回正文写入基线。 */
async function prepare(context: ReturnType<typeof fixture>) {
  writeFileSync(join(context.project.projectRoot, 'notes.md'), '# 活动资料\n\n社区周末活动面向亲子家庭。')
  await context.service.startScan('workspace')
  await context.service.waitForScan('workspace')
  /** 来源只能引用扫描得到的真实版本。 */
  const source = (await context.service.search({ workspaceId: 'workspace', query: '', scope: 'sources' })).items
    .find((hit) => hit.entry.source.relativePath === 'notes.md')!.entry
  /** 分组无固定业务分类，由提案自由定义。 */
  const proposal = (await context.service.proposePlan({
    workspaceId: 'workspace', title: '活动知识库', rootRelativePath: '资料库',
    groups: [{ id: 'events', title: '社区活动', summary: '亲子活动策划', sources: [{ entryId: source.id, revision: source.revision }], gaps: [], outputs: ['执行方案'] }],
  })).workflow!.proposal!
  expect(existsSync(join(context.project.projectRoot, '资料库'))).toBe(false)
  await context.service.confirmPlan({ workspaceId: 'workspace', planId: proposal.id, expectedRevision: proposal.revision, groups: [{ id: 'events', title: '亲子活动' }] })
  /** 大纲先发布，尚无正文时不产生条目链接。 */
  const snapshot = await context.service.saveOutline({ workspaceId: 'workspace', planRevision: proposal.revision, expectedRevision: 0,
    items: [{ id: 'event-plan', groupId: 'events', title: '执行方案', relativePath: '亲子活动/执行方案.md', summary: '社区执行安排', sections: ['受众', '流程', '限制'] }],
  })
  expect(snapshot.workflow!.outline!.items[0]!.entryId).toBeUndefined()
  return { workspaceId: 'workspace', planRevision: proposal.revision, outlineRevision: snapshot.workflow!.outline!.revision,
    itemId: 'event-plan', expectedRevision: null, content: '# 执行方案\n\n社区周末活动面向亲子家庭。\n\n## 受众\n亲子家庭\n\n## 流程\n体验\n\n## 限制\n待补',
    summary: '活动执行安排', complete: true, evidence: [{ entryId: source.id, revision: source.revision, quote: '社区周末活动面向亲子家庭。' }] }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('真实知识文件与服务整链', () => {
  test('Given 正文仅依据当前用户决定 When 新会话读取 Then 保留用户溯源且不误报来源丢失', async () => {
    const context = fixture()
    const input = await prepare(context)
    await context.service.writeDocument({ ...input, content: '# 活动决定\n活动免费。', evidence: [],
      userEvidence: { sessionId: 'session-1', messageId: 'message-1', quote: '活动免费。' } })
    const entry = (await context.service.search({ workspaceId: 'workspace', query: '活动免费', scope: 'knowledge' })).items[0]!.entry
    const result = await context.service.read({ workspaceId: 'workspace', entryId: entry.id })
    expect(result.status).toBe('readable')
    expect(result.entry.freshness).toBe('unverified')
    expect(result.entry.userEvidence?.quote).toBe('活动免费。')
  })

  test('Given 旧碎片被完整正文精确吸收 When 查询默认知识 Then 收起旧碎片且历史与原件可继续读取', async () => {
    const context = fixture()
    const input = await prepare(context)
    /** 原碎片是已有不可变历史，迁移不能删除它。 */
    const legacy = { id: 'b'.repeat(32), revision: 'c'.repeat(64), title: '既有活动约定', category: 'decisions', kind: 'decision' as const,
      state: 'confirmed' as const, freshness: 'current' as const, summary: '活动约定',
      source: { kind: 'conversation' as const, id: 'legacy-memory', revision: 'd'.repeat(64) },
      byteSize: 12, indexedBytes: 12, truncated: false, metadataOnly: false, updatedAt: 1 }
    await context.service.store.transact(context.project, 'workspace', () => ({ commits: [{ entry: legacy, content: '活动保持免费。' }] }))
    await context.service.writeDocument({ ...input, evidence: [{ entryId: legacy.id, revision: legacy.revision, quote: '活动保持免费。' }] })
    expect((await context.service.search({ workspaceId: 'workspace', query: '', scope: 'knowledge' })).items).toHaveLength(1)
    expect((await context.service.search({ workspaceId: 'workspace', query: '', scope: 'knowledge', includeHistory: true })).items).toHaveLength(2)
    expect((await context.service.read({ workspaceId: 'workspace', entryId: legacy.id })).content).toBe('活动保持免费。')
  })

  test('Given 已扫描图片和已确认大纲 When 复制原格式附件 Then 返回真实相对引用且不改动原图', async () => {
    const context = fixture()
    /** 二进制不需要模型读取全部字节，宿主只核验登记身份。 */
    const original = Buffer.from([137, 80, 78, 71, 0, 3, 7, 11])
    writeFileSync(join(context.project.projectRoot, 'visual.png'), original)
    const input = await prepare(context)
    const source = (await context.service.search({ workspaceId: 'workspace', query: 'visual', scope: 'sources' })).items[0]!.entry
    const assetInput = { workspaceId: 'workspace', planRevision: input.planRevision, outlineRevision: input.outlineRevision,
      itemId: input.itemId, sourceEntryId: source.id, sourceRevision: source.revision, relativePath: 'assets/视觉.png' }
    const result = await context.service.copyAsset(assetInput)
    expect(result.documentRelativePath).toBe('../assets/视觉.png')
    expect(readFileSync(join(context.project.projectRoot, '资料库/assets/视觉.png'))).toEqual(original)
    expect(readFileSync(join(context.project.projectRoot, 'visual.png'))).toEqual(original)
    expect(await context.service.copyAsset(assetInput)).toEqual(result)
    writeFileSync(join(context.project.projectRoot, '资料库/assets/视觉.png'), '外部修改')
    await expect(context.service.copyAsset(assetInput)).rejects.toThrow('同名附件')
    await expect(context.service.copyAsset({ ...assetInput, relativePath: '../outside.png' })).rejects.toThrow()
    await context.service.pauseWorkflow({ workspaceId: 'workspace', paused: true })
    await expect(context.service.copyAsset(assetInput)).rejects.toThrow('暂停')
  })

  test('Given 已确认并生成正文 When 原始来源变化或删除 Then 正文始终可读并标明需复核', async () => {
    const context = fixture()
    await context.service.writeDocument(await prepare(context))
    /** 固定已发布正文身份。 */
    const entry = (await context.service.search({ workspaceId: 'workspace', query: '', scope: 'knowledge' })).items[0]!.entry
    writeFileSync(join(context.project.projectRoot, 'notes.md'), '# 原始材料已变化')
    expect(await context.service.read({ workspaceId: 'workspace', entryId: entry.id })).toMatchObject({ status: 'readable', entry: { freshness: 'changed' } })
    rmSync(join(context.project.projectRoot, 'notes.md'))
    /** 保存过的自包含正文不依赖来源文件持续存在。 */
    const result = await context.service.read({ workspaceId: 'workspace', entryId: entry.id })
    expect(result.status).toBe('readable')
    expect(result.entry.freshness).toBe('unavailable')
    expect(result.content).toContain('亲子家庭')
  })

  test('Given 外部编辑并移动 Markdown When 服务重启且缓存丢失 Then 检索真实最新正文且删除后不复活', async () => {
    const context = fixture()
    await context.service.writeDocument(await prepare(context))
    /** 外部编辑器保留稳定注释，移动文件不改变主题身份。 */
    const oldPath = join(context.project.projectRoot, '资料库/亲子活动/执行方案.md')
    const newPath = join(context.project.projectRoot, '资料库/亲子活动/新版方案.md')
    writeFileSync(oldPath, readFileSync(oldPath, 'utf8').replace('社区周末活动面向亲子家庭。', '特别主题：银河探索。'))
    renameSync(oldPath, newPath)
    rmSync(context.project.cacheRoot, { recursive: true, force: true })
    /** 新进程必须从真实文件恢复索引。 */
    const restarted = createProjectKnowledgeService(context.dependencies)
    const result = await restarted.search({ workspaceId: 'workspace', query: '银河探索', scope: 'knowledge' })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]!.entry.document!.relativePath).toBe('亲子活动/新版方案.md')
    expect((await restarted.read({ workspaceId: 'workspace', entryId: result.items[0]!.entry.id })).content).toContain('银河探索')
    rmSync(newPath)
    expect((await restarted.search({ workspaceId: 'workspace', query: '银河探索', scope: 'knowledge' })).items).toHaveLength(0)
    expect((await restarted.read({ workspaceId: 'workspace', entryId: result.items[0]!.entry.id })).status).toBe('unavailable')
    expect(existsSync(newPath)).toBe(false)
  })

  test('Given 正式大纲的三个章节 When 重新扫描并调用旧整理器 Then 自身文件不循环提炼且不自动拆分', async () => {
    const context = fixture()
    await context.service.writeDocument(await prepare(context))
    await context.service.startScan('workspace')
    await context.service.waitForScan('workspace')
    expect((await context.service.search({ workspaceId: 'workspace', query: '', scope: 'sources' })).items).toHaveLength(1)
    await context.service.organize('workspace')
    /** 自定义分组与单文档身份均保持。 */
    const entries = (await context.service.search({ workspaceId: 'workspace', query: '', scope: 'knowledge' })).items
    expect(entries).toHaveLength(1)
    expect(entries[0]!.entry.category).toBe('亲子活动')
    expect(entries[0]!.entry.state).not.toBe('archived')
  })
})
