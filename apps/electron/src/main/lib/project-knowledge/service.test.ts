import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KnowledgeEntry } from '@proma/shared'
import { emptyKnowledgeMaintenance } from '../project-knowledge-maintenance-types'
import type {
  ProjectKnowledgeControlledSource,
  ProjectKnowledgeSources,
} from '../project-knowledge-sources'
import { createProjectKnowledgeService } from './service'

describe('项目知识库 1A 核心服务', () => {
  /** 每个测试隔离使用的临时根目录。 */
  let fixtureRoot: string
  /** 模拟用户项目的可信根目录。 */
  let projectRoot: string
  /** 模拟当前工作区 memory 的可信根目录。 */
  let memoryRoot: string
  /** 模拟可丢失索引缓存的可信根目录。 */
  let cacheRoot: string
  /** 固定时间用于稳定断言清单更新时间。 */
  let currentTime: number

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proma-project-knowledge-'))
    projectRoot = join(fixtureRoot, 'project')
    memoryRoot = join(fixtureRoot, 'memory')
    cacheRoot = join(fixtureRoot, 'cache')
    mkdirSync(projectRoot)
    mkdirSync(memoryRoot)
    currentTime = 1_000
  })

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true })
  })

  /** 创建绑定当前测试目录的知识服务。 */
  function createService(projectId = 'project-1', controlledSources?: ProjectKnowledgeSources) {
    return createProjectKnowledgeService({
      resolveProject: (workspaceId) => ({
        projectId: workspaceId === 'workspace-2' ? 'project-2' : projectId,
        projectRoot,
        memoryRoot,
        cacheRoot,
      }),
      now: () => currentTime,
      controlledSources,
    })
  }

  /** 用真实版本存储建立带文件证据的提炼知识，返回发布后的条目。 */
  async function publishDistilled(service: ReturnType<typeof createService>, source: KnowledgeEntry, title = '退款规则') {
    /** 固定知识正文用于检验检索不会返回过期结论。 */
    const content = '退款必须核对订单状态。'
    /** 与项目扫描共用的可信目录配置。 */
    const project = { projectId: 'project-1', projectRoot, memoryRoot, cacheRoot }
    /** 不可变提炼条目包含源文件的确切条目版本。 */
    const entry: KnowledgeEntry = {
      ...source, id: createHash('sha256').update(title).digest('hex').slice(0, 32),
      revision: createHash('sha256').update(`${title}:${source.revision}`).digest('hex'),
      title, summary: content, kind: 'rule', state: 'draft',
      source: { kind: 'managed', id: `distilled:${title}`, revision: source.revision },
      evidence: [{ entryId: source.id, revision: source.revision, quote: '核对订单状态' }],
    }
    await service.store.transact(project, 'workspace-1', () => ({ commits: [{ entry, content }] }))
    return entry
  }

  test('Given 仅扫描到文件 When 浏览知识与来源 Then 文件不冒充已提炼知识且两类独立计数', async () => {
    writeFileSync(join(projectRoot, 'README.md'), '# 项目\n退款需核对订单状态。')
    writeFileSync(join(projectRoot, 'core.mjs'), 'export const value = 1')
    /** 扫描不会隐式调用模型，也不能把来源标成已确认知识。 */
    const service = createService()
    await service.startScan('workspace-1')
    await service.waitForScan('workspace-1')
    expect(await service.getSnapshot('workspace-1')).toMatchObject({ knowledgeCount: 0, sourceCount: 2 })
    expect((await service.search({ workspaceId: 'workspace-1', query: '', scope: 'knowledge' })).total).toBe(0)
    /** 来源页仍可访问完整索引。 */
    const sources = await service.search({ workspaceId: 'workspace-1', query: '', scope: 'sources' })
    expect(sources.total).toBe(2)
    expect(sources.items.every((hit) => hit.entry.state === 'indexed')).toBe(true)
  })

  test('Given 来源和提炼知识混合 When 分页检索 Then 在分页前按知识范围过滤', async () => {
    writeFileSync(join(projectRoot, 'README.md'), '# 项目\n退款需核对订单状态。')
    /** 多来源不能挤占知识结果的第一页。 */
    for (let index = 0; index < 15; index += 1) writeFileSync(join(projectRoot, `source-${index}.md`), '# 原始资料')
    const service = createService()
    await service.startScan('workspace-1')
    await service.waitForScan('workspace-1')
    /** 选出可追溯的规则来源。 */
    const source = (await service.getSnapshot('workspace-1')).entries.find((entry) => entry.source.relativePath === 'README.md')!
    await publishDistilled(service, source)
    await publishDistilled(service, source, '订单核验')
    /** 空关键词同样进行服务端范围过滤。 */
    const first = await service.search({ workspaceId: 'workspace-1', query: '', scope: 'knowledge', limit: 1 })
    expect(first.total).toBe(2)
    expect(first.nextOffset).toBe(1)
    expect(first.items[0]?.entry.source.kind).toBe('managed')
    expect((await service.search({ workspaceId: 'workspace-1', query: '', scope: 'sources', limit: 1 })).total).toBe(16)
    expect(await service.getSnapshot('workspace-1')).toMatchObject({ knowledgeCount: 2, sourceCount: 16 })
    await expect(service.search({ workspaceId: 'workspace-1', query: '', scope: 'invalid' as 'all' })).rejects.toThrow('范围')
  })

  test('Given 六个更高分项目文件与相关记忆 When 限定记忆来源检索 Then 分页前保留记忆命中', async () => {
    /** 项目文件的标题、路径和正文同时命中，足以占满默认六条结果。 */
    for (let index = 0; index < 6; index += 1) {
      writeFileSync(join(projectRoot, `本地存储-${index}.md`), '# 本地存储\n项目文件中的本地存储说明。')
    }
    writeFileSync(join(memoryRoot, 'decisions.md'), '# 决策\n本地存储采用可移植 JSON 文件。')
    const service = createService()
    await service.startScan('workspace-1')
    await service.waitForScan('workspace-1')

    const mixed = await service.search({ workspaceId: 'workspace-1', query: '本地存储', scope: 'sources', limit: 6 })
    expect(mixed.items).toHaveLength(6)
    expect(mixed.items.every(({ entry }) => entry.source.kind === 'project-file')).toBe(true)

    const memory = await service.search({
      workspaceId: 'workspace-1', query: '本地存储', scope: 'sources', sourceKind: 'memory-file', limit: 6,
    })
    expect(memory.total).toBe(1)
    expect(memory.items[0]?.entry.source.kind).toBe('memory-file')
    expect(memory.nextOffset).toBeUndefined()
    await expect(service.search({
      workspaceId: 'workspace-1', query: '本地存储', sourceKind: 'unknown' as 'memory-file',
    })).rejects.toThrow('来源类型')
  })

  test('Given 文件提炼的知识 When 原文件未复扫就变化或删除 Then 检索与正文都不返回旧结论', async () => {
    writeFileSync(join(projectRoot, 'README.md'), '# 项目\n退款需核对订单状态。')
    const service = createService()
    await service.startScan('workspace-1')
    await service.waitForScan('workspace-1')
    /** 源条目和派生知识绑定在同一清单版本链。 */
    const source = (await service.getSnapshot('workspace-1')).entries[0]!
    const knowledge = await publishDistilled(service, source)
    expect((await service.read({ workspaceId: 'workspace-1', entryId: knowledge.id })).status).toBe('readable')
    writeFileSync(join(projectRoot, 'README.md'), '# 项目\n退款流程已变更，需要人工审核。')
    expect(await service.read({ workspaceId: 'workspace-1', entryId: knowledge.id })).toMatchObject({ status: 'changed', content: '' })
    expect((await service.search({ workspaceId: 'workspace-1', query: '退款规则', scope: 'knowledge' })).items[0])
      .toMatchObject({ snippet: '', entry: { freshness: 'changed' } })
    await service.startScan('workspace-1')
    await service.waitForScan('workspace-1')
    expect((await service.read({ workspaceId: 'workspace-1', entryId: knowledge.id })).status).toBe('changed')
    rmSync(join(projectRoot, 'README.md'))
    /** 仍基于旧版本的知识至少不能恢复成可读状态。 */
    expect((await service.read({ workspaceId: 'workspace-1', entryId: knowledge.id })).status).not.toBe('readable')
  })

  test('Given 尚未建库 When 只读快照、搜索与正文 Then 返回空结果且不创建文件', async () => {
    /** 未初始化项目的纯内存快照。 */
    const service = createService()
    /** 未初始化项目的目录搜索结果。 */
    const search = await service.search({ workspaceId: 'workspace-1', query: '' })

    expect(await service.getSnapshot('workspace-1')).toMatchObject({
      projectId: 'project-1',
      initialized: false,
      revision: 0,
      entries: [],
      totalEntries: 0,
      maintenance: { enabled: false, dailyJobLimit: 20, generation: 0 },
      pendingTurns: 0,
    })
    expect(search).toEqual({ revision: 0, items: [], total: 0, indexStatus: 'missing' })
    await expect(service.read({
      workspaceId: 'workspace-1',
      entryId: '00000000000000000000000000000000',
    })).rejects.toThrow('知识条目不存在')
    expect(existsSync(join(projectRoot, '.proma'))).toBe(false)
    expect(existsSync(cacheRoot)).toBe(false)
  })

  test('Given 同一真实项目根已有归属 When 另一个项目 ID 扫描 Then 明确冲突且不覆盖清单', async () => {
    writeFileSync(join(projectRoot, 'README.md'), '# Alpha\n项目知识。', 'utf8')
    /** 首个项目拥有的知识服务。 */
    const firstService = createService('project-1')
    await firstService.startScan('workspace-1')
    await firstService.waitForScan('workspace-1')
    /** 首次发布的权威清单内容。 */
    const manifestPath = join(projectRoot, '.proma/knowledge/manifest.json')
    /** 冲突前的清单字节用于证明不会被覆盖。 */
    const beforeConflict = readFileSync(manifestPath, 'utf8')

    /** 同根但不同 projectId 的服务。 */
    const secondService = createService()
    await expect(secondService.startScan('workspace-2')).rejects.toThrow('知识库归属冲突')
    expect(readFileSync(manifestPath, 'utf8')).toBe(beforeConflict)
  })

  test('Given 文本、记忆、图片、凭据与软链接 When 扫描 Then 只登记安全来源并支持中英文检索', async () => {
    mkdirSync(join(projectRoot, 'docs'))
    mkdirSync(join(projectRoot, '.proma'), { recursive: true })
    writeFileSync(join(projectRoot, 'README.md'), '# Order Service\n订单服务负责 checkout and payment。', 'utf8')
    writeFileSync(join(projectRoot, 'docs/api.md'), '# Payment API\n支付接口支持退款。', 'utf8')
    writeFileSync(join(projectRoot, 'diagram.png'), Buffer.from([1, 2, 3, 4]))
    writeFileSync(join(projectRoot, '.env'), 'SECRET=never-index', 'utf8')
    writeFileSync(join(projectRoot, '.proma/internal.md'), '不应自扫描', 'utf8')
    writeFileSync(join(memoryRoot, 'decision.md'), '# 决策\n结算流程采用异步队列。', 'utf8')
    symlinkSync(join(projectRoot, 'docs/api.md'), join(projectRoot, 'linked.md'))

    /** 执行真实扫描的知识服务。 */
    const service = createService()
    /** startScan 必须立即暴露 running 状态。 */
    const started = await service.startScan('workspace-1')
    expect(started.scan.status).toBe('running')
    await service.waitForScan('workspace-1')
    /** 扫描完成后的权威快照。 */
    const completed = await service.getSnapshot('workspace-1')
    /** 中文查询应命中英文标题/路径或中文正文。 */
    const chinese = await service.search({ workspaceId: 'workspace-1', query: '支付' })
    /** 英文别名应命中中文“订单”正文。 */
    const englishAlias = await service.search({ workspaceId: 'workspace-1', query: 'order' })

    expect(completed.scan.status).toBe('completed')
    expect(completed.entries.map((entry) => entry.source.relativePath).sort()).toEqual([
      'README.md',
      'decision.md',
      'diagram.png',
      'docs/api.md',
    ])
    expect(completed.entries.find((entry) => entry.source.relativePath === 'diagram.png')).toMatchObject({
      kind: 'asset',
      metadataOnly: true,
      indexedBytes: 0,
    })
    expect(chinese.items[0]?.entry.source.relativePath).toBe('docs/api.md')
    expect(chinese.items[0]?.snippet).toContain('支付接口')
    expect(englishAlias.items.some((item) => item.entry.source.relativePath === 'README.md')).toBe(true)
    expect(readFileSync(join(projectRoot, '.proma/knowledge/manifest.json'), 'utf8')).not.toContain('SECRET')
  })

  test('Given 超长 UTF-8 文档 When 分页读取 Then 每页不超过 24 KiB 且可无损续读', async () => {
    /** 超过两页且包含多字节中文的正文。 */
    const content = `# 长文档\n${'项目知识分页读取。'.repeat(5_000)}`
    writeFileSync(join(projectRoot, 'long.md'), content, 'utf8')
    /** 已建立索引的知识服务。 */
    const service = createService()
    await service.startScan('workspace-1')
    await service.waitForScan('workspace-1')
    /** 扫描完成后的权威快照。 */
    const snapshot = await service.getSnapshot('workspace-1')
    /** 长文档对应的稳定条目。 */
    const entry = snapshot.entries.find((candidate) => candidate.source.relativePath === 'long.md')
    if (!entry) throw new Error('测试条目缺失')

    /** 第一页有界正文。 */
    const firstPage = await service.read({ workspaceId: 'workspace-1', entryId: entry.id })
    /** 使用服务返回的 UTF-8 边界继续读取。 */
    const secondPage = await service.read({
      workspaceId: 'workspace-1',
      entryId: entry.id,
      offset: firstPage.nextOffset,
      expectedRevision: entry.revision,
    })

    expect(Buffer.byteLength(firstPage.content, 'utf8')).toBeLessThanOrEqual(24 * 1024)
    expect(firstPage.nextOffset).toBeDefined()
    expect(firstPage.content + secondPage.content).toBe(content.slice(0, (firstPage.content + secondPage.content).length))
    expect(firstPage.status).toBe('readable')
  })

  test('Given 来源在扫描后变化或删除 When 搜索与读取 Then 不把旧缓存冒充当前正文', async () => {
    writeFileSync(join(projectRoot, 'status.md'), '# 状态\n旧版发布流程。', 'utf8')
    /** 已建立旧索引的知识服务。 */
    const service = createService()
    await service.startScan('workspace-1')
    await service.waitForScan('workspace-1')
    /** 旧来源版本对应的权威快照。 */
    const snapshot = await service.getSnapshot('workspace-1')
    /** 来源变化测试使用的条目。 */
    const entry = snapshot.entries[0]
    if (!entry) throw new Error('测试条目缺失')
    writeFileSync(join(projectRoot, 'status.md'), '# 状态\n新版灰度流程。', 'utf8')

    /** 旧正文关键词不能继续从缓存命中。 */
    const staleSearch = await service.search({ workspaceId: 'workspace-1', query: '旧版发布' })
    /** 读取明确报告来源变化。 */
    const changedRead = await service.read({ workspaceId: 'workspace-1', entryId: entry.id })
    expect(staleSearch.items).toHaveLength(1)
    expect(staleSearch.items[0]).toMatchObject({ entry: { freshness: 'changed', summary: '' }, snippet: '' })
    expect(changedRead).toMatchObject({ status: 'changed', content: '' })

    rmSync(join(projectRoot, 'status.md'))
    /** 删除后的读取明确报告不可用。 */
    const unavailableRead = await service.read({ workspaceId: 'workspace-1', entryId: entry.id })
    expect(unavailableRead).toMatchObject({ status: 'unavailable', content: '' })
  })

  test('Given 应用离线期间来源新增和删除 When 更新扫描 Then 新增被登记且删除保留 unavailable', async () => {
    writeFileSync(join(projectRoot, 'old.md'), '# 旧资料', 'utf8')
    /** 跨两轮扫描复用的知识服务。 */
    const service = createService()
    await service.startScan('workspace-1')
    await service.waitForScan('workspace-1')
    rmSync(join(projectRoot, 'old.md'))
    writeFileSync(join(projectRoot, 'new.md'), '# 新资料\n离线新增内容。', 'utf8')
    currentTime += 1

    await service.startScan('workspace-1')
    await service.waitForScan('workspace-1')
    /** 更新扫描后的完整快照。 */
    const updated = await service.getSnapshot('workspace-1')
    expect(updated.entries.find((entry) => entry.source.relativePath === 'old.md')?.freshness).toBe('unavailable')
    expect(updated.entries.find((entry) => entry.source.relativePath === 'new.md')?.freshness).toBe('current')
  })

  test('Given 索引缓存丢失 When 浏览与查询 Then 目录仍可用且不会递归重扫项目', async () => {
    writeFileSync(join(projectRoot, 'guide.md'), '# Guide\ncache-only-keyword', 'utf8')
    /** 已建立知识库的服务。 */
    const service = createService()
    await service.startScan('workspace-1')
    await service.waitForScan('workspace-1')
    rmSync(cacheRoot, { recursive: true, force: true })
    writeFileSync(join(projectRoot, 'offline-added.md'), '# 尚未扫描', 'utf8')

    /** 缓存丢失后的目录浏览。 */
    const browse = await service.search({ workspaceId: 'workspace-1', query: '' })
    /** 正文关键词不能触发扫描重建。 */
    const query = await service.search({ workspaceId: 'workspace-1', query: 'cache-only-keyword' })
    expect(browse.indexStatus).toBe('missing')
    expect(browse.items.map((item) => item.entry.source.relativePath)).toEqual(['guide.md'])
    expect(query.items).toEqual([])
    expect(existsSync(cacheRoot)).toBe(false)

    await service.startScan('workspace-1')
    await service.waitForScan('workspace-1')
    /** 手动更新扫描后重建的正文索引。 */
    const rebuilt = await service.search({ workspaceId: 'workspace-1', query: 'cache-only-keyword' })
    expect(rebuilt.indexStatus).toBe('ready')
    expect(rebuilt.items[0]?.entry.source.relativePath).toBe('guide.md')
  })

  test('Given 大量候选来源 When 立即取消 Then 扫描停止发布删除判断并显示 cancelled', async () => {
    for (let index = 0; index < 300; index += 1) {
      writeFileSync(join(projectRoot, `file-${index}.md`), `# 文件 ${index}\n${'内容'.repeat(1_000)}`, 'utf8')
    }
    /** 支持取消后台扫描的知识服务。 */
    const service = createService()
    await service.startScan('workspace-1')
    /** 取消请求后的即时快照。 */
    const cancelling = await service.cancelScan('workspace-1')
    await service.waitForScan('workspace-1')
    /** 后台在途批次收尾后的最终快照。 */
    const cancelled = await service.getSnapshot('workspace-1')

    expect(['running', 'cancelled']).toContain(cancelling.scan.status)
    expect(cancelled.scan.status).toBe('cancelled')
    expect(cancelled.scan.finishedAt).toBeDefined()
  })

  test('Given memory 目录尚不存在 When 只读和首次扫描 Then 不创建 memory 且正常完成', async () => {
    rmSync(memoryRoot, { recursive: true, force: true })
    writeFileSync(join(projectRoot, 'README.md'), '# Empty Memory', 'utf8')
    /** 绑定缺失 memory 根的服务。 */
    const service = createService()

    expect((await service.getSnapshot('workspace-1')).initialized).toBe(false)
    expect(existsSync(memoryRoot)).toBe(false)
    await service.startScan('workspace-1')
    await service.waitForScan('workspace-1')
    /** 扫描结束后的快照。 */
    const snapshot = await service.getSnapshot('workspace-1')
    expect(snapshot.scan.status).toBe('completed')
    expect(snapshot.scan.message).toBeUndefined()
    expect(existsSync(memoryRoot)).toBe(false)
  })

  test('Given 数据根存在但两级缓存目录缺失 When 首次扫描 Then 创建固定缓存目录并写入索引', async () => {
    /** 模拟运行时已经创建的业务配置根目录。 */
    const configRoot = join(fixtureRoot, 'config')
    mkdirSync(configRoot)
    /** 缓存目录严格使用运行时传入的固定两级路径。 */
    const nestedCacheRoot = join(configRoot, 'knowledge-cache', 'workspace-1')
    writeFileSync(join(projectRoot, 'README.md'), '# Cache Bootstrap\n首次缓存目录。', 'utf8')
    /** 使用真实文件系统路径执行首次扫描。 */
    const service = createProjectKnowledgeService({
      resolveProject: () => ({
        projectId: 'project-1',
        projectRoot,
        memoryRoot,
        cacheRoot: nestedCacheRoot,
      }),
      now: () => currentTime,
    })

    await service.startScan('workspace-1')
    await service.waitForScan('workspace-1')
    /** 扫描结果用于确认缓存失败提示不再出现。 */
    const snapshot = await service.getSnapshot('workspace-1')
    /** 搜索结果用于确认新索引已经可读。 */
    const search = await service.search({ workspaceId: 'workspace-1', query: 'Cache Bootstrap' })

    expect(existsSync(join(nestedCacheRoot, 'project-knowledge-index.json'))).toBe(true)
    expect(snapshot.scan.status).toBe('completed')
    expect(snapshot.scan.message).toBeUndefined()
    expect(search.indexStatus).toBe('ready')
  })

  test('Given 缓存父目录是软链接 When 写入索引 Then 拒绝越过父链写入', () => {
    /** 模拟运行时已经创建的业务配置根目录。 */
    const configRoot = join(fixtureRoot, 'config')
    /** 软链接指向的外部实际目录。 */
    const outsideRoot = join(fixtureRoot, 'outside')
    mkdirSync(configRoot)
    mkdirSync(outsideRoot)
    symlinkSync(outsideRoot, join(configRoot, 'knowledge-cache'))
    /** 经过软链接父目录解析的工作区缓存路径。 */
    const nestedCacheRoot = join(configRoot, 'knowledge-cache', 'workspace-1')
    const service = createService()

    expect(() => service.store.writeIndex({
      projectId: 'project-1',
      projectRoot,
      memoryRoot,
      cacheRoot: nestedCacheRoot,
    }, {
      schemaVersion: 1,
      projectId: 'project-1',
      manifestRevision: 0,
      records: {},
    })).toThrow('知识缓存父目录不是安全的实际目录')
    expect(existsSync(join(outsideRoot, 'workspace-1', 'project-knowledge-index.json'))).toBe(false)
  })

  test('Given manifest 发布写入失败 When 提交新条目版本 Then 旧清单保持可读', async () => {
    writeFileSync(join(projectRoot, 'README.md'), '# Stable', 'utf8')
    /** 已有稳定清单的服务。 */
    const service = createService()
    await service.startScan('workspace-1')
    await service.waitForScan('workspace-1')
    /** 当前可信项目边界。 */
    const project = { projectId: 'project-1', projectRoot, memoryRoot, cacheRoot }
    /** 提交前权威清单。 */
    const before = service.store.readManifest(project)
    if (!before) throw new Error('测试清单缺失')
    /** 当前条目。 */
    const entry = service.store.readEntries(project, before)[0]
    if (!entry) throw new Error('测试条目缺失')
    /** 占用 safe-file 固定临时路径以模拟 manifest 发布失败。 */
    mkdirSync(join(projectRoot, '.proma/knowledge/manifest.json.tmp'))

    await expect(service.store.commitEntries(project, before.revision, [{
      entry: { ...entry, title: '未发布标题', revision: 'f'.repeat(64) },
    }], 'workspace-1')).rejects.toThrow()
    /** 失败后的权威清单。 */
    const after = service.store.readManifest(project)
    expect(after).toEqual(before)
    expect(service.store.readEntries(project, before)[0]?.title).toBe('Stable')
  })

  test('Given 新扫描已发布 When 持有旧 manifest 的读者继续读取 Then 仍取得旧不可变版本', async () => {
    writeFileSync(join(projectRoot, 'decision.md'), '# 旧决定\n采用 A。', 'utf8')
    /** 跨版本读取测试服务。 */
    const service = createService()
    await service.startScan('workspace-1')
    await service.waitForScan('workspace-1')
    /** 当前可信项目边界。 */
    const project = { projectId: 'project-1', projectRoot, memoryRoot, cacheRoot }
    /** 读者固定的旧清单。 */
    const oldManifest = service.store.readManifest(project)
    if (!oldManifest) throw new Error('测试清单缺失')
    /** 旧清单引用的不可变条目。 */
    const oldEntry = service.store.readEntries(project, oldManifest)[0]
    writeFileSync(join(projectRoot, 'decision.md'), '# 新决定\n采用 B。', 'utf8')
    currentTime += 1
    await service.startScan('workspace-1')
    await service.waitForScan('workspace-1')

    /** 新清单引用的新版本。 */
    const newManifest = service.store.readManifest(project)
    if (!newManifest) throw new Error('测试新清单缺失')
    expect(service.store.readEntries(project, oldManifest)[0]).toEqual(oldEntry)
    expect(service.store.readEntries(project, newManifest)[0]?.revision).not.toBe(oldEntry?.revision)
  })

  test('Given 已登记来源后来变成多硬链接 When 更新扫描 Then 提取失败不误标来源删除', async () => {
    writeFileSync(join(projectRoot, 'source.md'), '# Source\n可信正文。', 'utf8')
    /** 跨扫描复用的知识服务。 */
    const service = createService()
    await service.startScan('workspace-1')
    await service.waitForScan('workspace-1')
    linkSync(join(projectRoot, 'source.md'), join(projectRoot, 'source-copy.md'))

    await service.startScan('workspace-1')
    await service.waitForScan('workspace-1')
    /** 读取失败后的快照。 */
    const snapshot = await service.getSnapshot('workspace-1')
    expect(snapshot.scan.status).toBe('completed')
    expect(snapshot.scan.message).toContain('未把未枚举来源标记为删除')
    expect(snapshot.entries.find((entry) => entry.source.relativePath === 'source.md')?.freshness).toBe('current')
  })

  test('Given 中文自然问句和英文认证文档 When 搜索 Then 分词与别名召回相关资料', async () => {
    writeFileSync(join(projectRoot, 'authentication.md'), '# Authentication\nLogin uses token based auth.', 'utf8')
    writeFileSync(join(projectRoot, 'checkout.md'), '# Checkout\n订单支付流程通过队列执行。', 'utf8')
    /** 自然语言检索测试服务。 */
    const service = createService()
    await service.startScan('workspace-1')
    await service.waitForScan('workspace-1')

    /** 中文登录问句通过 auth/login 别名召回英文资料。 */
    const login = await service.search({ workspaceId: 'workspace-1', query: '登录怎么实现' })
    /** 中文长问句按词段和双字片段召回流程资料。 */
    const payment = await service.search({ workspaceId: 'workspace-1', query: '订单支付流程是什么' })
    expect(login.items[0]?.entry.source.relativePath).toBe('authentication.md')
    expect(payment.items[0]?.entry.source.relativePath).toBe('checkout.md')
  })

  test('Given 同批文件接近总读取上限 When 扫描 Then 预留预算后不调度超额正文读取', async () => {
    /** 每个文件恰好占满单文件 256 KiB 提取预算。 */
    const fileContent = 'a'.repeat(256 * 1024)
    for (let index = 0; index < 66; index += 1) {
      writeFileSync(join(projectRoot, `budget-${index}.txt`), fileContent, 'utf8')
    }
    /** 资源预算测试服务。 */
    const service = createService()
    await service.startScan('workspace-1')
    await service.waitForScan('workspace-1')
    /** 接近总预算后的扫描状态。 */
    const snapshot = await service.getSnapshot('workspace-1')

    expect(snapshot.scan.indexed).toBe(64)
    expect(snapshot.scan.skipped).toBeGreaterThanOrEqual(2)
    expect(snapshot.totalEntries).toBe(64)
  })

  test('Given 正文索引已就绪 When 只更新维护状态 Then 新 manifest revision 继续复用原索引', async () => {
    writeFileSync(join(projectRoot, 'guide.md'), '# Guide\nstable-index-keyword', 'utf8')
    /** 已建立正文索引的服务。 */
    const service = createService()
    await service.startScan('workspace-1')
    await service.waitForScan('workspace-1')
    expect((await service.search({ workspaceId: 'workspace-1', query: 'stable-index-keyword' })).indexStatus).toBe('ready')
    /** 设置事务前的索引文件身份。 */
    const indexPath = join(cacheRoot, 'project-knowledge-index.json')
    /** 原子文件的 inode 与时间可证明是否发生整文件重写。 */
    const indexIdentity = lstatSync(indexPath)
    /** 只变化设置、不含条目提交的维护状态。 */
    const maintenance = emptyKnowledgeMaintenance()
    maintenance.settings.generation = 1
    await service.store.transact({ projectId: 'project-1', projectRoot, memoryRoot, cacheRoot }, 'workspace-1', () => ({
      maintenance,
    }))

    /** 设置事务后的正文检索。 */
    const afterSettings = await service.search({ workspaceId: 'workspace-1', query: 'stable-index-keyword' })
    expect(afterSettings.indexStatus).toBe('ready')
    expect(afterSettings.items[0]?.entry.source.relativePath).toBe('guide.md')
    expect(lstatSync(indexPath).ino).toBe(indexIdentity.ino)
    expect(lstatSync(indexPath).mtimeMs).toBe(indexIdentity.mtimeMs)
  })

  test('Given 条目目录已热读 When 只推进维护状态 Then 不重新读取全部不可变条目', async () => {
    writeFileSync(join(projectRoot, 'cached-entry.md'), '# 缓存条目\n稳定元数据。', 'utf8')
    const service = createService()
    await service.startScan('workspace-1')
    await service.waitForScan('workspace-1')
    /** 首次快照建立当前条目水位缓存。 */
    const before = await service.getSnapshot('workspace-1')
    const entry = before.entries[0]
    if (!entry) throw new Error('缓存测试条目缺失')
    /** 模拟条目文件在纯状态事务期间暂时不可读。 */
    rmSync(join(
      projectRoot,
      '.proma/knowledge/entries',
      entry.id,
      'revisions',
      entry.revision,
    ), { recursive: true })
    const maintenance = emptyKnowledgeMaintenance()
    maintenance.settings.generation = 1
    await service.store.transact(
      { projectId: 'project-1', projectRoot, memoryRoot, cacheRoot },
      'workspace-1',
      () => ({ maintenance }),
    )

    /** 新 manifest 对象仍复用相同 indexRevision 的条目元数据。 */
    expect((await service.getSnapshot('workspace-1')).entries[0]?.id).toBe(entry.id)
    /** 详情读取仍执行父链与文件存在性校验，不由元数据缓存绕过。 */
    await expect(service.read({ workspaceId: 'workspace-1', entryId: entry.id })).rejects.toThrow()
  })

  test('Given Canvas 与接口受控来源 When 扫描查询及来源变化 Then fresh-read 且截断目录不误删', async () => {
    /** Canvas 仅元数据来源。 */
    const canvasSource: ProjectKnowledgeControlledSource = {
      kind: 'canvas',
      sourceId: 'canvas:canvas-1:node-1',
      title: '用户流程图',
      revision: 'canvas:1:content:1',
      summary: 'Canvas 中的流程节点',
      content: '',
      metadataOnly: true,
      byteSize: 0,
      indexedBytes: 0,
      truncated: false,
      updatedAt: 900,
    }
    /** 当前接口安全投影，可在测试中模拟版本变化。 */
    let apiSource: ProjectKnowledgeControlledSource | undefined = {
      kind: 'api',
      sourceId: 'api:request-1',
      title: '创建订单',
      revision: 'catalog:1:request:1',
      summary: 'POST 接口定义',
      content: '# 创建订单\n方法：POST\n查询参数：tenantId',
      metadataOnly: false,
      byteSize: 62,
      indexedBytes: 62,
      truncated: false,
      updatedAt: 901,
    }
    /** 是否模拟受控目录因总量上限截断。 */
    let listTruncated = false
    /** 是否在目录中省略仍可按 ID 读取的接口来源。 */
    let omitApiFromList = false
    /** 完全由稳定业务 ID 驱动的受控来源测试适配器。 */
    const controlledSources: ProjectKnowledgeSources = {
      async list() {
        return {
          sources: [canvasSource, ...(!omitApiFromList && apiSource ? [apiSource] : [])],
          total: listTruncated ? 2 : 1 + (apiSource ? 1 : 0),
          truncated: listTruncated,
          skipped: 0,
        }
      },
      async read(input) {
        const source = input.sourceId === canvasSource.sourceId
          ? canvasSource
          : input.sourceId === apiSource?.sourceId
            ? apiSource
            : undefined
        if (!source) return { status: 'unavailable', content: '', truncated: false }
        if (input.expectedRevision && input.expectedRevision !== source.revision) {
          return { status: 'changed', source, content: '', truncated: false }
        }
        return {
          status: source.metadataOnly ? 'metadata-only' : 'readable',
          source,
          content: source.content,
          truncated: source.truncated,
        }
      },
    }
    /** 已注入受控服务的知识核心。 */
    const service = createService('project-1', controlledSources)
    await service.startScan('workspace-1')
    await service.waitForScan('workspace-1')
    /** 首次扫描登记的两个业务来源。 */
    const first = await service.getSnapshot('workspace-1')
    const canvasEntry = first.entries.find((entry) => entry.source.kind === 'canvas')
    const apiEntry = first.entries.find((entry) => entry.source.kind === 'api')
    if (!canvasEntry || !apiEntry) throw new Error('受控来源测试条目缺失')

    expect(first.scan).toMatchObject({ discovered: 2, indexed: 1 })
    expect((await service.search({ workspaceId: 'workspace-1', query: 'tenantId' })).items[0]?.entry.id).toBe(apiEntry.id)
    expect(await service.read({ workspaceId: 'workspace-1', entryId: apiEntry.id })).toMatchObject({
      status: 'readable',
      content: apiSource.content,
    })
    expect((await service.read({ workspaceId: 'workspace-1', entryId: canvasEntry.id })).status).toBe('metadata-only')

    apiSource = { ...apiSource, revision: 'catalog:2:request:2', content: '# 创建订单\n方法：PUT' }
    expect((await service.search({ workspaceId: 'workspace-1', query: 'tenantId' })).items[0]).toMatchObject({
      entry: { freshness: 'changed' },
      snippet: '',
    })
    expect((await service.read({ workspaceId: 'workspace-1', entryId: apiEntry.id })).status).toBe('changed')

    /** 截断目录未列出仍存在的来源时，扫描不得推断删除。 */
    listTruncated = true
    omitApiFromList = true
    await service.startScan('workspace-1')
    await service.waitForScan('workspace-1')
    expect((await service.getSnapshot('workspace-1')).entries.find((entry) => entry.id === apiEntry.id)?.freshness).toBe('current')

    /** 完整目录确认来源删除后，条目才进入 unavailable。 */
    listTruncated = false
    apiSource = undefined
    await service.startScan('workspace-1')
    await service.waitForScan('workspace-1')
    expect((await service.getSnapshot('workspace-1')).entries.find((entry) => entry.id === apiEntry.id)?.freshness).toBe('unavailable')
    expect((await service.read({ workspaceId: 'workspace-1', entryId: apiEntry.id })).status).toBe('unavailable')
  })

  test('Given 一千条受管原文 When 按元数据查询 Then 只读取当前页相关正文', async () => {
    /** 大目录性能测试服务。 */
    const service = createService()
    await service.store.initialize({ projectId: 'project-1', projectRoot, memoryRoot, cacheRoot }, 'workspace-1')
    /** 一千条正文中只有一条元数据匹配查询。 */
    const commits = Array.from({ length: 1_000 }, (_, index) => {
      const content = `# 原文 ${index}\n独立内容 ${index}`
      const id = createHash('sha256').update(`performance-managed-${index}`).digest('hex').slice(0, 32)
      const revision = createHash('sha256').update(`${id}\0${content}`).digest('hex')
      return {
        entry: {
          id,
          revision,
          title: index === 777 ? '唯一目标 needle' : `普通原文 ${index}`,
          category: 'business' as const,
          kind: 'document' as const,
          state: 'confirmed' as const,
          freshness: 'current' as const,
          summary: `原文摘要 ${index}`,
          source: { kind: 'managed' as const, id: `managed:performance-${index}`, revision },
          byteSize: Buffer.byteLength(content, 'utf8'),
          indexedBytes: Buffer.byteLength(content, 'utf8'),
          truncated: false,
          metadataOnly: false,
          updatedAt: index,
        },
        content,
      }
    })
    await service.store.transact(
      { projectId: 'project-1', projectRoot, memoryRoot, cacheRoot },
      'workspace-1',
      () => ({ commits }),
    )
    /** 统计搜索阶段实际读取的不可变正文数量。 */
    const originalReadContent = service.store.readContent
    let contentReadCount = 0
    service.store.readContent = (...args) => {
      contentReadCount += 1
      return originalReadContent(...args)
    }

    const result = await service.search({ workspaceId: 'workspace-1', query: 'needle' })
    expect(result.total).toBe(1)
    expect(result.items[0]?.entry.title).toBe('唯一目标 needle')
    expect(contentReadCount).toBe(1)
  })

  test('Given 五百条受控来源 When 浏览或查询全部命中 Then 只 fresh-read 当前页', async () => {
    /** 五百条共享正文关键词的受控 API 投影。 */
    const sources: ProjectKnowledgeControlledSource[] = Array.from({ length: 500 }, (_, index) => ({
      kind: 'api',
      sourceId: `api:performance-${index}`,
      title: `性能接口 ${index}`,
      revision: `catalog:1:request:${index}`,
      summary: '性能接口定义',
      content: `# 性能接口 ${index}\nshared-controlled-token`,
      metadataOnly: false,
      byteSize: 64,
      indexedBytes: 64,
      truncated: false,
      updatedAt: index,
    }))
    /** 统计按 ID fresh-read 的适配器。 */
    let controlledReadCount = 0
    const controlledSources: ProjectKnowledgeSources = {
      async list() {
        return { sources, total: sources.length, truncated: false, skipped: 0 }
      },
      async read(input) {
        controlledReadCount += 1
        const source = sources.find((candidate) => candidate.sourceId === input.sourceId)
        if (!source) return { status: 'unavailable', content: '', truncated: false }
        return { status: 'readable', source, content: source.content, truncated: false }
      },
    }
    const service = createService('project-1', controlledSources)
    await service.startScan('workspace-1')
    await service.waitForScan('workspace-1')

    controlledReadCount = 0
    expect((await service.search({ workspaceId: 'workspace-1', query: '' })).items).toHaveLength(6)
    expect(controlledReadCount).toBe(6)
    controlledReadCount = 0
    const query = await service.search({ workspaceId: 'workspace-1', query: 'shared-controlled-token' })
    expect(query.total).toBe(500)
    expect(query.items).toHaveLength(6)
    expect(controlledReadCount).toBe(6)
  })

  test('Given 普通文件正文含凭据 When 扫描 Then 不把敏感正文写入条目或索引', async () => {
    writeFileSync(join(projectRoot, 'notes.md'), '# Notes\napi_key=abcdefghijklmnop', 'utf8')
    /** 敏感正文扫描服务。 */
    const service = createService()
    await service.startScan('workspace-1')
    await service.waitForScan('workspace-1')
    expect((await service.getSnapshot('workspace-1')).totalEntries).toBe(0)

    writeFileSync(join(projectRoot, 'notes.md'), '# Notes\n公开说明。', 'utf8')
    await service.startScan('workspace-1')
    await service.waitForScan('workspace-1')
    writeFileSync(join(projectRoot, 'notes.md'), '# Notes\npassword: abcdefghijklmnop', 'utf8')
    currentTime += 1
    await service.startScan('workspace-1')
    await service.waitForScan('workspace-1')
    /** 已登记来源变敏感后的快照。 */
    const changed = await service.getSnapshot('workspace-1')
    expect(changed.entries[0]?.freshness).toBe('changed')
    expect((await service.search({ workspaceId: 'workspace-1', query: 'abcdefghijklmnop', includeHistory: true })).items).toEqual([])
    expect(readFileSync(join(cacheRoot, 'project-knowledge-index.json'), 'utf8')).not.toContain('abcdefghijklmnop')
  })
})
