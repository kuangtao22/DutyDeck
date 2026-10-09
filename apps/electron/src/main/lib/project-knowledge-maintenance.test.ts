import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionMeta, KnowledgeEntry } from '@proma/shared'
import { createProjectKnowledgeService } from './project-knowledge/service'
import { createKnowledgeMaintenance, isKnowledgeTurnSuccessful, parseKnowledgeCandidates } from './project-knowledge-maintenance'
import type { KnowledgeCompletedTurn } from './project-knowledge-maintenance'
import type { PersistedAgentEvidenceRecord } from './agent-session-manager'
import type { KnowledgeSourceRef } from './project-knowledge-source-distillation'

/** 每个测试独占真实知识目录，验证原子发布和重启读取。 */
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** 构造确定性模型响应，引用实际输入中的消息身份与原文。 */
const response = (content = '采用短信登录', quote = '决定：采用短信登录', messageId = 'u1') => JSON.stringify({ candidates: [{
  title: '登录方式', content, category: 'decisions', kind: 'decision', messageId, quote,
}] })

/** 存储是真实文件；模型与会话只模拟远端输出和权威会话边界。 */
async function fixture(callModel: () => Promise<string> = async () => response()) {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-maintenance-')); roots.push(root)
  const project = { projectId: 'w1', projectRoot: root, memoryRoot: join(root, 'memory'), cacheRoot: join(root, 'cache') }
  mkdirSync(project.memoryRoot)
  const service = createProjectKnowledgeService({ resolveProject: () => project })
  await service.store.initialize(project, 'w1')
  const state: { session: AgentSessionMeta | undefined; now: number; calls: number; records: PersistedAgentEvidenceRecord[]; sourceBodies: Map<string, string>; truncatedSources: Set<string> } = {
    session: { id: 's1', workspaceId: 'w1', title: '会话', createdAt: 1, updatedAt: 1 }, now: 1000, calls: 0,
    sourceBodies: new Map(),
    truncatedSources: new Set(),
    records: [
      { uuid: 'u1', role: 'user', text: '决定：采用短信登录', sha256: 'u-hash', byteOffset: 0, byteLength: 50 },
      { uuid: 'a1', role: 'assistant', text: '已了解你的决定', sha256: 'a-hash', byteOffset: 50, byteLength: 50 },
    ],
  }
  const dependencies = {
    store: service.store, resolveProject: () => project, getSession: () => state.session,
    readEvidence: () => ({ sessionId: 's1', records: state.records, truncated: false, skipped: 0 }),
    readSource: async (_workspaceId: string, ref: KnowledgeSourceRef) => {
      const content = state.sourceBodies.get(`${ref.entryId}:${ref.revision}`)
      return content === undefined ? null : { ref, content, truncated: state.truncatedSources.has(`${ref.entryId}:${ref.revision}`) }
    },
    validateModel: () => undefined, callModel: async () => { state.calls += 1; return callModel() }, now: () => state.now,
  }
  const maintenance = createKnowledgeMaintenance(dependencies)
  const turn: KnowledgeCompletedTurn = { workspaceId: 'w1', sessionId: 's1', userMessageId: 'u1', startedAt: 1001,
    toolMode: 'standard', resultSubtype: 'success', terminalReason: 'completed',
    receipts: [{ sessionId: 's1', status: 'written', byteOffset: 0, byteLength: 100, fileIdentity: { dev: 1, ino: 1 },
      messages: [{ uuid: 'u1', sha256: 'u-hash', contentSha256: 'u-hash', byteOffset: 0, byteLength: 50 }] }] }
  const enable = async (dailyJobLimit = 20) => {
    await maintenance.updateSettings({ workspaceId: 'w1', enabled: true, channelId: 'channel', modelId: 'model', dailyJobLimit })
    await maintenance.wait('w1')
  }
  return { project, service, state, dependencies, maintenance, turn, enable }
}

/** 将可提炼的扫描文档写入权威清单，并登记测试正文。 */
async function seedSource(
  fixtureValue: Awaited<ReturnType<typeof fixture>>,
  input: { id: string; revision: string; title: string; content: string; relativePath?: string },
): Promise<KnowledgeEntry> {
  /** 不含自身 revision 的扫描条目元数据。 */
  const base: Omit<KnowledgeEntry, 'revision'> = {
    id: input.id,
    title: input.title,
    category: 'engineering',
    kind: 'document',
    state: 'confirmed',
    freshness: 'current',
    summary: input.title,
    source: { kind: 'project-file', id: `project-file:${input.relativePath ?? 'README.md'}`, relativePath: input.relativePath ?? 'README.md', revision: `source-${input.revision}` },
    byteSize: Buffer.byteLength(input.content),
    indexedBytes: Buffer.byteLength(input.content),
    truncated: false,
    metadataOnly: false,
    updatedAt: fixtureValue.state.now,
  }
  /** 测试固定条目版本，模拟扫描器发布结果。 */
  const entry: KnowledgeEntry = { ...base, revision: input.revision }
  fixtureValue.state.sourceBodies.set(`${entry.id}:${entry.revision}`, input.content)
  await fixtureValue.service.store.transact(fixtureValue.project, 'w1', () => ({ commits: [{ entry }] }))
  return entry
}

describe('项目知识持续维护', () => {
  test('Given 已扫描的同主题资料 When 启用维护 Then 自动提炼草稿并保留多来源引用且未变来源不重复收费', async () => {
    /** 模型输出引用两份扫描文档。 */
    const firstId = '1'.repeat(32)
    const secondId = '2'.repeat(32)
    const firstRevision = 'a'.repeat(64)
    const secondRevision = 'b'.repeat(64)
    const f = await fixture(async () => JSON.stringify({ candidates: [{
      title: '项目存储原则', content: '项目采用本地优先，并要求配置原子写。', category: 'engineering', kind: 'rule',
      evidence: [
        { entryId: firstId, revision: firstRevision, quote: '项目采用本地优先。' },
        { entryId: secondId, revision: secondRevision, quote: '配置必须原子写。' },
      ],
    }] }))
    await seedSource(f, { id: firstId, revision: firstRevision, title: 'README', content: '项目采用本地优先。' })
    await seedSource(f, { id: secondId, revision: secondRevision, title: '工程规则', content: '配置必须原子写。', relativePath: 'docs/rules.md' })

    await f.enable()
    await f.maintenance.enqueueSources('w1')
    await f.maintenance.wait('w1')

    const knowledge = (await f.service.getSnapshot('w1')).entries.find((entry) => entry.source.kind === 'managed')
    expect(knowledge).toMatchObject({ state: 'draft', evidence: [{ entryId: firstId, revision: firstRevision }, { entryId: secondId, revision: secondRevision }] })
    expect(f.state.calls).toBe(1)
    await f.maintenance.enqueueSources('w1')
    await f.maintenance.wait('w1')
    expect(f.state.calls).toBe(1)
    expect(f.maintenance.status('w1')).toMatchObject({ pendingSources: 0, failedSources: 0 })
  })

  test('Given 来源只改无关段落且提炼结论不变 When 新版本完成提炼 Then 原知识刷新证据版本且不消失', async () => {
    const sourceId = '6'.repeat(32)
    const firstRevision = '1'.repeat(64)
    const secondRevision = '2'.repeat(64)
    let activeRevision = firstRevision
    const f = await fixture(async () => JSON.stringify({ candidates: [{
      title: '项目原则', content: '项目坚持本地优先。', category: 'overview', kind: 'rule',
      evidence: [{ entryId: sourceId, revision: activeRevision, quote: '项目坚持本地优先。' }],
    }] }))
    await seedSource(f, { id: sourceId, revision: firstRevision, title: 'README', content: '项目坚持本地优先。\n首版附注。' })
    await f.maintenance.updateSettings({ workspaceId: 'w1', enabled: true, channelId: 'channel', modelId: 'model', dailyJobLimit: 20 })
    await f.maintenance.wait('w1')
    const firstKnowledge = (await f.service.getSnapshot('w1')).entries.find((entry) => entry.source.kind === 'managed')!

    activeRevision = secondRevision
    f.state.sourceBodies.delete(`${sourceId}:${firstRevision}`)
    await seedSource(f, { id: sourceId, revision: secondRevision, title: 'README', content: '项目坚持本地优先。\n新版附注。' })
    await f.maintenance.enqueueSources('w1')
    await f.maintenance.wait('w1')

    const refreshed = (await f.service.getSnapshot('w1')).entries.find((entry) => entry.id === firstKnowledge.id)
    expect(refreshed?.evidence).toEqual([{ entryId: sourceId, revision: secondRevision, quote: '项目坚持本地优先。' }])
    expect(refreshed?.revision).not.toBe(firstKnowledge.revision)
    const manifest = f.service.store.readManifest(f.project)!
    expect(f.service.store.readContent(f.project, manifest, firstKnowledge.id)).toBe('项目坚持本地优先。')
  })

  test('Given 用户已人工改写提炼正文 When 原文来源升级但模型仍返回旧结论 Then 不覆盖正文也不刷新依据背书', async () => {
    const sourceId = 'c'.repeat(32)
    const firstRevision = '9'.repeat(64)
    const secondRevision = 'a'.repeat(64)
    let activeRevision = firstRevision
    const f = await fixture(async () => JSON.stringify({ candidates: [{
      title: '项目原则', content: '项目坚持本地优先。', category: 'overview', kind: 'rule',
      evidence: [{ entryId: sourceId, revision: activeRevision, quote: '项目坚持本地优先。' }],
    }] }))
    await seedSource(f, { id: sourceId, revision: firstRevision, title: 'README', content: '项目坚持本地优先。' })
    await f.maintenance.updateSettings({ workspaceId: 'w1', enabled: true, channelId: 'channel', modelId: 'model', dailyJobLimit: 20 })
    await f.maintenance.wait('w1')
    const knowledge = (await f.service.getSnapshot('w1')).entries.find((entry) => entry.source.kind === 'managed')!
    const manualContent = '用户人工补充：只允许本地加密存储。'
    const manualBase = { ...knowledge, summary: manualContent, byteSize: Buffer.byteLength(manualContent), indexedBytes: Buffer.byteLength(manualContent), updatedAt: 2000 }
    const manualEntry = { ...manualBase, revision: createHash('sha256').update(JSON.stringify(manualBase) + manualContent).digest('hex') }
    await f.service.store.transact(f.project, 'w1', () => ({ commits: [{ entry: manualEntry, content: manualContent }] }))

    activeRevision = secondRevision
    f.state.sourceBodies.delete(`${sourceId}:${firstRevision}`)
    await seedSource(f, { id: sourceId, revision: secondRevision, title: 'README', content: '项目坚持本地优先。\n新版附注。' })
    await f.maintenance.enqueueSources('w1')
    await f.maintenance.wait('w1')

    const manifest = f.service.store.readManifest(f.project)!
    const preserved = f.service.store.readEntry(f.project, manifest, knowledge.id)
    expect(preserved.evidence?.[0]?.revision).toBe(firstRevision)
    expect(f.service.store.readContent(f.project, manifest, knowledge.id)).toBe(manualContent)
  })

  test('Given 来源版本没有变化 When 重复发现来源 Then 不推进manifest版本也不写新任务', async () => {
    const f = await fixture(async () => '{"candidates":[]}')
    await seedSource(f, { id: '7'.repeat(32), revision: '3'.repeat(64), title: 'README', content: '本地优先。' })
    await f.maintenance.updateSettings({ workspaceId: 'w1', enabled: true, channelId: 'channel', modelId: 'model', dailyJobLimit: 20 })
    await f.maintenance.wait('w1')
    await f.maintenance.enqueueSources('w1')
    const stableRevision = f.service.store.readManifest(f.project)!.revision
    await f.maintenance.enqueueSources('w1')
    expect(f.service.store.readManifest(f.project)!.revision).toBe(stableRevision)
  })

  test('Given 排队来源在模型前已失效 When 调度处理 Then 不调用模型不扣预算且旧版本不再重排', async () => {
    const sourceId = '8'.repeat(32)
    const sourceRevision = '4'.repeat(64)
    const f = await fixture(async () => '{"candidates":[]}')
    const blocked = createKnowledgeMaintenance({ ...f.dependencies, acquireModelLease: () => { throw new Error('暂不处理') } })
    await seedSource(f, { id: sourceId, revision: sourceRevision, title: 'README', content: '旧资料。' })
    await blocked.updateSettings({ workspaceId: 'w1', enabled: true, channelId: 'channel', modelId: 'model', dailyJobLimit: 20 })
    await blocked.wait('w1')
    f.state.sourceBodies.delete(`${sourceId}:${sourceRevision}`)
    const resumed = createKnowledgeMaintenance(f.dependencies)

    resumed.schedule('w1')
    await resumed.wait('w1')

    const state = f.service.store.readManifest(f.project)!.maintenance!
    expect(f.state.calls).toBe(0)
    expect(state.budget.used).toBe(0)
    expect(state.completedSources).toHaveLength(1)
    await resumed.enqueueSources('w1')
    expect(resumed.status('w1').pendingSources).toBe(0)
  })

  test('Given 来源正文只读取到有界页面 When 发布提炼知识 Then 标记依据未完整覆盖', async () => {
    const sourceId = '9'.repeat(32)
    const sourceRevision = '5'.repeat(64)
    const f = await fixture(async () => JSON.stringify({ candidates: [{
      title: '局部规则', content: '当前可见部分要求原子写。', category: 'engineering', kind: 'rule',
      evidence: [{ entryId: sourceId, revision: sourceRevision, quote: '配置要求原子写。' }],
    }] }))
    await seedSource(f, { id: sourceId, revision: sourceRevision, title: '长文档', content: '配置要求原子写。' })
    f.state.truncatedSources.add(`${sourceId}:${sourceRevision}`)

    await f.maintenance.updateSettings({ workspaceId: 'w1', enabled: true, channelId: 'channel', modelId: 'model', dailyJobLimit: 20 })
    await f.maintenance.wait('w1')

    const knowledge = (await f.service.getSnapshot('w1')).entries.find((entry) => entry.source.kind === 'managed')
    expect(knowledge?.truncated).toBe(true)
  })

  test('Given 文件来源提炼失败 When 查询维护状态 Then 明确显示失败而非空闲', async () => {
    const f = await fixture(async () => '{"invalid":true}')
    await seedSource(f, { id: 'a'.repeat(32), revision: '6'.repeat(64), title: 'README', content: '项目说明。' })

    await f.maintenance.updateSettings({ workspaceId: 'w1', enabled: true, channelId: 'channel', modelId: 'model', dailyJobLimit: 20 })
    await f.maintenance.wait('w1')

    expect(f.maintenance.status('w1')).toMatchObject({ status: 'failed', failedSources: 1 })
  })

  test('Given 文件候选已被拒绝 When 同一逐字依据只改模型标题和措辞 Then 不得复活候选', async () => {
    const sourceId = 'b'.repeat(32)
    const firstRevision = '7'.repeat(64)
    const secondRevision = '8'.repeat(64)
    let activeRevision = firstRevision
    let wording = { title: '存储原则', content: '项目使用本地存储。' }
    const f = await fixture(async () => JSON.stringify({ candidates: [{
      ...wording,
      category: 'engineering', kind: 'rule',
      evidence: [{ entryId: sourceId, revision: activeRevision, quote: '配置保存在本地。' }],
    }] }))
    await seedSource(f, { id: sourceId, revision: firstRevision, title: 'README', content: '配置保存在本地。' })
    await f.maintenance.updateSettings({ workspaceId: 'w1', enabled: true, channelId: 'channel', modelId: 'model', dailyJobLimit: 20 })
    await f.maintenance.wait('w1')
    const candidate = (await f.service.getSnapshot('w1')).entries.find((entry) => entry.source.kind === 'managed')!
    await f.service.reviewEntry({ workspaceId: 'w1', entryId: candidate.id, expectedRevision: candidate.revision, action: 'reject' })

    activeRevision = secondRevision
    wording = { title: '本地数据约束', content: '所有项目配置都必须留在本机。' }
    f.state.sourceBodies.delete(`${sourceId}:${firstRevision}`)
    await seedSource(f, { id: sourceId, revision: secondRevision, title: 'README', content: '配置保存在本地。\n增加附注。' })
    await f.maintenance.enqueueSources('w1')
    await f.maintenance.wait('w1')

    const managed = (await f.service.getSnapshot('w1')).entries.filter((entry) => entry.source.kind === 'managed')
    expect(managed).toHaveLength(1)
    expect(managed[0]?.state).toBe('archived')
  })

  test('Given 来源在模型生成期间改变 When 迟到结果返回 Then 拒绝旧版本且新版本可以重新排队', async () => {
    let finish!: (value: string) => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => { started = resolve })
    const sourceId = '3'.repeat(32)
    const firstRevision = 'c'.repeat(64)
    const secondRevision = 'd'.repeat(64)
    let sourceCalls = 0
    const f = await fixture(() => {
      sourceCalls += 1
      if (sourceCalls > 1) return Promise.resolve('{"candidates":[]}')
      started()
      return new Promise((resolve) => { finish = resolve })
    })
    await seedSource(f, { id: sourceId, revision: firstRevision, title: '规划', content: '首版规划。' })
    await f.maintenance.updateSettings({ workspaceId: 'w1', enabled: true, channelId: 'channel', modelId: 'model', dailyJobLimit: 20 })
    await f.maintenance.enqueueSources('w1')
    await entered
    /** 模拟扫描发布新条目版本并使旧正文不再可 fresh-read。 */
    f.state.sourceBodies.delete(`${sourceId}:${firstRevision}`)
    await seedSource(f, { id: sourceId, revision: secondRevision, title: '规划', content: '新版规划。' })
    finish(JSON.stringify({ candidates: [{
      title: '项目规划', content: '首版规划', category: 'planning', kind: 'fact',
      evidence: [{ entryId: sourceId, revision: firstRevision, quote: '首版规划。' }],
    }] }))
    await f.maintenance.wait('w1')
    expect((await f.service.getSnapshot('w1')).entries.filter((entry) => entry.source.kind === 'managed')).toHaveLength(0)

    await f.maintenance.enqueueSources('w1')
    await f.maintenance.wait('w1')
    expect(sourceCalls).toBe(2)
    expect(f.maintenance.status('w1').pendingSources).toBe(0)
  })

  test('Given 文件提炼未授权或已暂停 When 扫描来源入队 Then 不调用模型且共享每日预算', async () => {
    const sourceId = '4'.repeat(32)
    const f = await fixture(async () => '{"candidates":[]}')
    await seedSource(f, { id: sourceId, revision: 'e'.repeat(64), title: 'README', content: '本地优先。' })
    await f.maintenance.enqueueSources('w1')
    expect(f.state.calls).toBe(0)

    await f.enable(1)
    await f.maintenance.enqueueSources('w1')
    await f.maintenance.wait('w1')
    await f.maintenance.enqueue(f.turn)
    await f.maintenance.wait('w1')
    expect(f.state.calls).toBe(1)
    expect(f.maintenance.status('w1').status).toBe('blocked')
  })

  test('Given 文件提炼模型正在生成 When 用户暂停维护 Then 迟到结果不能发布', async () => {
    let finish!: (value: string) => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => { started = resolve })
    const sourceId = '5'.repeat(32)
    const sourceRevision = 'f'.repeat(64)
    const f = await fixture(() => { started(); return new Promise((resolve) => { finish = resolve }) })
    await seedSource(f, { id: sourceId, revision: sourceRevision, title: 'README', content: '采用本地优先。' })
    await f.maintenance.updateSettings({ workspaceId: 'w1', enabled: true, channelId: 'channel', modelId: 'model', dailyJobLimit: 20 })
    await entered

    await f.maintenance.updateSettings({ workspaceId: 'w1', enabled: false, dailyJobLimit: 20 })
    finish(JSON.stringify({ candidates: [{
      title: '存储原则', content: '项目采用本地优先。', category: 'engineering', kind: 'rule',
      evidence: [{ entryId: sourceId, revision: sourceRevision, quote: '采用本地优先。' }],
    }] }))
    await f.maintenance.wait('w1')

    expect((await f.service.getSnapshot('w1')).entries.filter((entry) => entry.source.kind === 'managed')).toHaveLength(0)
    expect(f.maintenance.status('w1').status).toBe('paused')
  })
  test('Given 刚启用维护且空队列任务正在收尾 When 立即登记回合 Then 唤醒不会丢失', async () => {
    const f = await fixture()
    await f.maintenance.updateSettings({ workspaceId: 'w1', enabled: true, channelId: 'channel', modelId: 'model', dailyJobLimit: 20 })
    await f.maintenance.enqueue(f.turn); await f.maintenance.wait('w1')
    expect(f.state.calls).toBe(1)
    expect(f.maintenance.status('w1').pendingTurns).toBe(0)
  })
  test('Given 尚未授权 When 成功对话落盘 Then 不读取历史或调用模型', async () => {
    const f = await fixture()
    await f.maintenance.enqueue(f.turn)
    await f.maintenance.wait('w1')
    expect(f.state.calls).toBe(0)
    expect(f.maintenance.status('w1').pendingTurns).toBe(0)
  })

  test('Given 合规成功回合 When 自动整理 Then 发布有源知识并推进水位且重放不重复', async () => {
    const f = await fixture(); await f.enable()
    await f.maintenance.enqueue(f.turn); await f.maintenance.wait('w1')
    const snapshot = await f.service.getSnapshot('w1')
    expect(snapshot.entries).toHaveLength(1)
    expect(snapshot.entries[0]?.state).toBe('confirmed')
    expect((await f.service.read({ workspaceId: 'w1', entryId: snapshot.entries[0]!.id })).content).toBe('决定：采用短信登录')
    expect(f.maintenance.status('w1').pendingTurns).toBe(0)
    await f.maintenance.enqueue(f.turn); await f.maintenance.wait('w1')
    expect(f.state.calls).toBe(1)
  })

  test('Given 失败取消或有子任务 When 终态到达 Then 不生成新分析', async () => {
    const f = await fixture(); await f.enable()
    for (const change of [{ resultSubtype: 'error' }, { terminalReason: undefined }, { stoppedByUser: true }, { backgroundTasksPending: true }, { triggeredBy: 'automation' as const }]) {
      expect(isKnowledgeTurnSuccessful({ ...f.turn, ...change })).toBe(false)
      await f.maintenance.enqueue({ ...f.turn, ...change })
    }
    expect(f.state.calls).toBe(0)
  })

  test('Given 未采纳建议 When 引用助手提议 Then 只保留草稿', async () => {
    const f = await fixture(async () => response('建议使用 OAuth', '已了解你的决定', 'a1')); await f.enable()
    await f.maintenance.enqueue(f.turn); await f.maintenance.wait('w1')
    expect((await f.service.getSnapshot('w1')).entries[0]?.state).toBe('draft')
  })

  test('Given 伪造来源或引文 When 分析返回 Then 拒绝且不推进已整理水位', async () => {
    const f = await fixture(async () => response('假内容', '不存在的引文', 'u1')); await f.enable()
    await f.maintenance.enqueue(f.turn); await f.maintenance.wait('w1')
    expect((await f.service.getSnapshot('w1')).entries).toHaveLength(0)
    expect(f.maintenance.status('w1').failedTurns).toBe(1)
    expect(() => parseKnowledgeCandidates(response('正文', '决定：采用短信登录', 'outside'), f.state.records)).toThrow('引用')
  })

  test('Given 模型正在生成 When 用户暂停 Then 迟到结果不能发布', async () => {
    let finish!: (value: string) => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => { started = resolve })
    const f = await fixture(() => { started(); return new Promise((resolve) => { finish = resolve }) }); await f.enable()
    await f.maintenance.enqueue(f.turn); await entered
    await f.maintenance.updateSettings({ workspaceId: 'w1', enabled: false, dailyJobLimit: 20 })
    finish(response()); await f.maintenance.wait('w1')
    expect((await f.service.getSnapshot('w1')).entries).toHaveLength(0)
    expect(f.maintenance.status('w1').status).toBe('paused')
  })

  test('Given 一个项目仍有多个回合 When 另一项目也请求维护 Then 全局串行并轮流取得处理机会', async () => {
    const order: string[] = []
    let finish!: (value: string) => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => { started = resolve })
    let aCalls = 0
    let active = 0
    let maximum = 0
    const a = await fixture(async () => {
      aCalls += 1; order.push(`a${aCalls}`); active += 1; maximum = Math.max(maximum, active)
      if (aCalls === 1) { started(); await new Promise<string>((resolve) => { finish = resolve }) }
      active -= 1; return '{"candidates":[]}'
    })
    const b = await fixture(async () => { order.push('b1'); active += 1; maximum = Math.max(maximum, active); active -= 1; return '{"candidates":[]}' })
    await a.enable(); await b.enable()
    await a.maintenance.enqueue(a.turn); await entered
    a.state.records.push({ ...a.state.records[0]!, uuid: 'u2' })
    await a.maintenance.enqueue({ ...a.turn, userMessageId: 'u2' })
    await b.maintenance.enqueue(b.turn)
    finish('done')
    await Promise.all([a.maintenance.wait('w1'), b.maintenance.wait('w1')])
    expect(maximum).toBe(1)
    expect(order).toEqual(['a1', 'b1', 'a2'])
  })

  test('Given 分析正在运行 When 用户点击重试 Then 不重复消费模型预算', async () => {
    let finish!: (value: string) => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => { started = resolve })
    const f = await fixture(() => { started(); return new Promise((resolve) => { finish = resolve }) }); await f.enable()
    await f.maintenance.enqueue(f.turn); await entered
    await expect(f.maintenance.retry('w1')).rejects.toThrow('正在运行')
    finish(response()); await f.maintenance.wait('w1')
    expect(f.state.calls).toBe(1)
  })

  test('Given 模型正在生成 When 来源会话删除 Then 不发布旧来源', async () => {
    let finish!: (value: string) => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => { started = resolve })
    const f = await fixture(() => { started(); return new Promise((resolve) => { finish = resolve }) }); await f.enable()
    await f.maintenance.enqueue(f.turn); await entered
    f.state.session = undefined; finish(response()); await f.maintenance.wait('w1')
    expect((await f.service.getSnapshot('w1')).entries).toHaveLength(0)
  })

  test('Given 今日预算耗尽 When 新回合到达 Then 不换渠道且近期原文仍可被新会话读取', async () => {
    const f = await fixture(async () => '{"candidates":[]}'); await f.enable(1)
    await f.maintenance.enqueue(f.turn); await f.maintenance.wait('w1')
    f.state.records[0] = { ...f.state.records[0]!, uuid: 'u2', text: '纠正：登录改为邮箱验证码' }
    await f.maintenance.enqueue({ ...f.turn, userMessageId: 'u2' }); await f.maintenance.wait('w1')
    expect(f.state.calls).toBe(1)
    expect(f.maintenance.status('w1').status).toBe('blocked')
    expect(f.maintenance.recent('w1', '登录方式')[0]?.text).toContain('邮箱验证码')
    const restarted = createKnowledgeMaintenance(f.dependencies)
    expect(restarted.status('w1').pendingTurns).toBe(1)
  })

  test('Given 候选被用户拒绝 When 同来源重试 Then 不复活', async () => {
    const f = await fixture(); await f.enable()
    await f.maintenance.enqueue(f.turn); await f.maintenance.wait('w1')
    const entry = (await f.service.getSnapshot('w1')).entries[0]!
    await f.service.reviewEntry({ workspaceId: 'w1', entryId: entry.id, expectedRevision: entry.revision, action: 'reject' })
    await f.maintenance.enqueue(f.turn); await f.maintenance.wait('w1')
    expect((await f.service.search({ workspaceId: 'w1', query: '登录' })).items).toHaveLength(0)
    expect(f.state.calls).toBe(1)
  })

  test('Given 已确认登录方式 When 用户明确纠正并引用旧条目 Then 旧条目 superseded 且默认搜索只返回新确认知识', async () => {
    /** 第二轮模型输出可在取得旧条目 ID 后设置。 */
    let modelResponse = response()
    const f = await fixture(async () => modelResponse)
    await f.enable()
    await f.maintenance.enqueue(f.turn)
    await f.maintenance.wait('w1')
    /** 首轮自动确认的旧登录方式。 */
    const oldEntry = (await f.service.getSnapshot('w1')).entries[0]
    if (!oldEntry) throw new Error('旧知识条目缺失')
    /** 用户第二轮明确纠正的真实落盘证据。 */
    const correctedText = '纠正：登录方式改为邮箱'
    f.state.records = [
      { uuid: 'u2', role: 'user', text: correctedText, sha256: 'u2-hash', byteOffset: 100, byteLength: 50 },
      { uuid: 'a2', role: 'assistant', text: '已按纠正更新', sha256: 'a2-hash', byteOffset: 150, byteLength: 50 },
    ]
    modelResponse = JSON.stringify({ candidates: [{
      title: '登录方式', content: '登录方式改为邮箱', category: 'decisions', kind: 'decision',
      messageId: 'u2', quote: correctedText, replacesEntryId: oldEntry.id,
    }] })
    /** 第二轮回执固定到新的用户消息身份。 */
    const correctedTurn: KnowledgeCompletedTurn = {
      ...f.turn,
      userMessageId: 'u2',
      startedAt: 1002,
      receipts: [{
        ...f.turn.receipts[0]!,
        byteOffset: 100,
        messages: [{ uuid: 'u2', sha256: 'u2-hash', contentSha256: 'u2-hash', byteOffset: 100, byteLength: 50 }],
      }],
    }

    await f.maintenance.enqueue(correctedTurn)
    await f.maintenance.wait('w1')

    /** 包含历史状态的权威目录。 */
    const snapshot = await f.service.getSnapshot('w1')
    /** 默认搜索应排除被替代旧版本。 */
    const visible = await f.service.search({ workspaceId: 'w1', query: '登录方式' })
    expect(snapshot.entries.find((entry) => entry.id === oldEntry.id)).toMatchObject({ state: 'superseded' })
    expect(snapshot.entries.find((entry) => entry.id !== oldEntry.id)).toMatchObject({
      state: 'confirmed', summary: correctedText,
    })
    expect(visible.items).toHaveLength(1)
    expect(visible.items[0]?.entry).toMatchObject({ state: 'confirmed', summary: correctedText })
  })

  test('Given 已确认同标题知识 When 新对话不是明确替代 Then 新候选保持 draft 且不覆盖旧条目', async () => {
    /** 按轮次切换模型输出。 */
    let modelResponse = response()
    const f = await fixture(async () => modelResponse)
    await f.enable()
    await f.maintenance.enqueue(f.turn)
    await f.maintenance.wait('w1')
    /** 首轮确认条目及其不可变版本。 */
    const oldEntry = (await f.service.getSnapshot('w1')).entries[0]
    if (!oldEntry) throw new Error('旧知识条目缺失')
    /** 第二轮只是讨论建议，不构成明确纠正。 */
    const suggestionText = '可以考虑把登录改为邮箱验证码'
    f.state.records = [
      { uuid: 'u2', role: 'user', text: suggestionText, sha256: 'u2-hash', byteOffset: 100, byteLength: 50 },
      { uuid: 'a2', role: 'assistant', text: '这是一个未采纳建议', sha256: 'a2-hash', byteOffset: 150, byteLength: 50 },
    ]
    modelResponse = JSON.stringify({ candidates: [{
      title: '登录方式', content: '建议使用邮箱验证码', category: 'decisions', kind: 'decision',
      messageId: 'u2', quote: suggestionText,
    }] })
    /** 只引用本轮用户证据的回合。 */
    const suggestionTurn: KnowledgeCompletedTurn = {
      ...f.turn,
      userMessageId: 'u2',
      startedAt: 1002,
      receipts: [{
        ...f.turn.receipts[0]!,
        byteOffset: 100,
        messages: [{ uuid: 'u2', sha256: 'u2-hash', contentSha256: 'u2-hash', byteOffset: 100, byteLength: 50 }],
      }],
    }

    await f.maintenance.enqueue(suggestionTurn)
    await f.maintenance.wait('w1')

    /** 同标题冲突后的两个权威条目。 */
    const entries = (await f.service.getSnapshot('w1')).entries
    expect(entries.find((entry) => entry.id === oldEntry.id)).toMatchObject({
      revision: oldEntry.revision, state: 'confirmed',
    })
    expect(entries.find((entry) => entry.id !== oldEntry.id)).toMatchObject({
      state: 'draft', summary: expect.stringContaining('待核对'),
    })
  })

  test('Given 模型等待期间旧条目被人工更新 When 迟到结果声明替代 Then 不 supersede 人工新版', async () => {
    /** 第二轮 provider 的人工完成回调。 */
    let finishReplacement!: (value: string) => void
    /** 第二轮 provider 已读取基线的通知。 */
    let markReplacementStarted!: () => void
    const replacementStarted = new Promise<void>((resolve) => { markReplacementStarted = resolve })
    /** 首轮直接返回确认知识，第二轮等待人工修改完成。 */
    let modelCall = 0
    const f = await fixture(async () => {
      modelCall += 1
      if (modelCall === 1) return response()
      markReplacementStarted()
      return new Promise<string>((resolve) => { finishReplacement = resolve })
    })
    await f.enable()
    await f.maintenance.enqueue(f.turn)
    await f.maintenance.wait('w1')
    /** 模型第二轮开始前的旧知识。 */
    const oldEntry = (await f.service.getSnapshot('w1')).entries[0]
    if (!oldEntry) throw new Error('旧知识条目缺失')
    /** 第二轮明确纠正证据。 */
    const correctedText = '纠正：登录方式改为邮箱'
    f.state.records = [
      { uuid: 'u2', role: 'user', text: correctedText, sha256: 'u2-hash', byteOffset: 100, byteLength: 50 },
      { uuid: 'a2', role: 'assistant', text: '等待整理', sha256: 'a2-hash', byteOffset: 150, byteLength: 50 },
    ]
    /** 启动会固定旧条目 baseline 的第二轮任务。 */
    const correctedTurn: KnowledgeCompletedTurn = {
      ...f.turn,
      userMessageId: 'u2',
      startedAt: 1002,
      receipts: [{
        ...f.turn.receipts[0]!,
        byteOffset: 100,
        messages: [{ uuid: 'u2', sha256: 'u2-hash', contentSha256: 'u2-hash', byteOffset: 100, byteLength: 50 }],
      }],
    }
    await f.maintenance.enqueue(correctedTurn)
    await replacementStarted
    /** 模型等待期间由用户人工发布的同 ID 新版本。 */
    const manualContent = '决定：人工确认继续使用短信登录'
    const manualBase = {
      ...oldEntry,
      summary: manualContent,
      source: { ...oldEntry.source, revision: 'manual-revision' },
      byteSize: Buffer.byteLength(manualContent),
      indexedBytes: Buffer.byteLength(manualContent),
      updatedAt: 2000,
    }
    /** 人工版本 revision 绑定完整元数据和正文。 */
    const manualEntry = {
      ...manualBase,
      revision: createHash('sha256').update(JSON.stringify(manualBase) + manualContent).digest('hex'),
    }
    await f.service.store.transact(f.project, 'w1', () => ({
      commits: [{ entry: manualEntry, content: manualContent }],
    }))
    finishReplacement(JSON.stringify({ candidates: [{
      title: '登录方式', content: '登录方式改为邮箱', category: 'decisions', kind: 'decision',
      messageId: 'u2', quote: correctedText, replacesEntryId: oldEntry.id,
    }] }))
    await f.maintenance.wait('w1')

    /** 迟到模型只能新增待核对草稿，不能覆盖人工新版。 */
    const entries = (await f.service.getSnapshot('w1')).entries
    expect(entries.find((entry) => entry.id === oldEntry.id)).toMatchObject({
      revision: manualEntry.revision, state: 'confirmed', summary: manualContent,
    })
    expect(entries.find((entry) => entry.id !== oldEntry.id)).toMatchObject({
      state: 'draft', summary: expect.stringContaining('待核对'),
    })
  })

  test('Given 数据根模型租约正忙 When 调度待整理回合 Then 作业保持 pending 且不扣每日预算', async () => {
    /** 真实知识目录与会话证据 fixture。 */
    const f = await fixture()
    /** 统计模型租约申请次数，证明调度确实到达跨实例门禁。 */
    let leaseAttempts = 0
    /** 模拟另一个应用实例仍持有数据根模型租约。 */
    const maintenance = createKnowledgeMaintenance({
      ...f.dependencies,
      acquireModelLease: () => {
        leaseAttempts += 1
        throw new Error('模型租约正忙')
      },
    })
    await maintenance.updateSettings({
      workspaceId: 'w1', enabled: true, channelId: 'channel', modelId: 'model', dailyJobLimit: 20,
    })

    await maintenance.enqueue(f.turn)
    await maintenance.wait('w1')

    /** 调度失败后的权威维护记录。 */
    const state = f.service.store.readManifest(f.project)?.maintenance
    expect(leaseAttempts).toBe(1)
    expect(f.state.calls).toBe(0)
    expect(state?.jobs[0]).toMatchObject({ status: 'pending', attempts: 0 })
    expect(state?.budget.used).toBe(0)
    expect(maintenance.status('w1')).toMatchObject({ status: 'queued', pendingTurns: 1, failedTurns: 0 })
  })

  test('Given 暂停后 provider 忽略 abort When 第二项目请求维护 Then 等真实请求收尾才释放全局槽和模型租约', async () => {
    /** 第一项目 provider 的人工完成回调。 */
    let finishFirst!: (value: string) => void
    /** 第一项目实际进入 provider 的通知。 */
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })
    /** 共享跨实例模型租约是否仍被持有。 */
    let leaseHeld = false
    /** 成功取得模型租约的次数。 */
    let leaseAcquires = 0
    /** 真实 provider Promise 收尾后释放租约的次数。 */
    let leaseReleases = 0
    /** 首次释放模型租约的通知。 */
    let markFirstReleased!: () => void
    const firstReleased = new Promise<void>((resolve) => { markFirstReleased = resolve })
    /** 模拟数据根级不可重入模型租约。 */
    const acquireModelLease = (): (() => void) => {
      if (leaseHeld) throw new Error('模型租约正忙')
      leaseHeld = true
      leaseAcquires += 1
      /** 每个租约只能释放一次。 */
      let released = false
      return () => {
        if (released) return
        released = true
        leaseHeld = false
        leaseReleases += 1
        if (leaseReleases === 1) markFirstReleased()
      }
    }
    /** 第一项目的 provider 忽略 AbortSignal，直到测试显式结束远程请求。 */
    const first = await fixture(() => {
      markFirstStarted()
      return new Promise<string>((resolve) => { finishFirst = resolve })
    })
    /** 第二项目的 provider 可立即完成，用于证明全局槽恢复后能够继续。 */
    const second = await fixture(async () => '{"candidates":[]}')
    /** 两个独立维护实例共享同一数据根级模型租约。 */
    const firstMaintenance = createKnowledgeMaintenance({ ...first.dependencies, acquireModelLease })
    const secondMaintenance = createKnowledgeMaintenance({ ...second.dependencies, acquireModelLease })
    await firstMaintenance.updateSettings({
      workspaceId: 'w1', enabled: true, channelId: 'channel', modelId: 'model', dailyJobLimit: 20,
    })
    await secondMaintenance.updateSettings({
      workspaceId: 'w1', enabled: true, channelId: 'channel', modelId: 'model', dailyJobLimit: 20,
    })

    await firstMaintenance.enqueue(first.turn)
    await firstStarted
    await firstMaintenance.updateSettings({ workspaceId: 'w1', enabled: false, dailyJobLimit: 20 })
    await firstMaintenance.wait('w1')
    expect(leaseHeld).toBe(true)
    expect(leaseReleases).toBe(0)

    await secondMaintenance.enqueue(second.turn)
    await secondMaintenance.wait('w1')
    /** provider 未真实收尾前，第二实例既不能 claim 作业也不能取得模型租约。 */
    const blockedState = second.service.store.readManifest(second.project)?.maintenance
    expect(second.state.calls).toBe(0)
    expect(blockedState?.jobs[0]).toMatchObject({ status: 'pending', attempts: 0 })
    expect(blockedState?.budget.used).toBe(0)
    expect(leaseAcquires).toBe(1)

    finishFirst('{"candidates":[]}')
    await firstReleased
    expect(leaseHeld).toBe(false)
    /** 槽真实释放后重新唤醒第二项目，作业才可以开始。 */
    secondMaintenance.schedule('w1')
    await secondMaintenance.wait('w1')
    expect(second.state.calls).toBe(1)
    expect(secondMaintenance.status('w1').pendingTurns).toBe(0)
    expect(leaseAcquires).toBe(2)
    expect(leaseReleases).toBe(2)
  })

  test('Given 重启时存在存活和死亡的 foreign owner When 恢复维护 Then 存活任务保持 running 且死亡任务转 failed', async () => {
    /** 使用忙租约先登记一个不会被当前实例 claim 的真实作业。 */
    const f = await fixture()
    const seeding = createKnowledgeMaintenance({
      ...f.dependencies,
      acquireModelLease: () => { throw new Error('播种期间不启动模型') },
    })
    await seeding.updateSettings({
      workspaceId: 'w1', enabled: true, channelId: 'channel', modelId: 'model', dailyJobLimit: 20,
    })
    await seeding.enqueue(f.turn)
    await seeding.wait('w1')
    /** 使用 PID 1 表示仍存活的其它实例，极大 PID 表示已退出 owner。 */
    const aliveOwnerPid = 1
    const deadOwnerPid = 2_147_483_647
    await f.service.store.transact(f.project, 'w1', ({ manifest }) => {
      /** 复用真实登记作业的完整回执和代次。 */
      const base = structuredClone(manifest.maintenance?.jobs[0])
      if (!base) throw new Error('测试作业缺失')
      /** 同一维护记录中的两个 foreign owner 作业。 */
      const maintenance = structuredClone(manifest.maintenance!)
      maintenance.jobs = [
        { ...base, id: 'a'.repeat(64), status: 'running', ownerPid: aliveOwnerPid },
        { ...base, id: 'd'.repeat(64), status: 'running', ownerPid: deadOwnerPid },
      ]
      return { maintenance }
    })
    /** 模拟应用重启后新建的维护调度器。 */
    const recovered = createKnowledgeMaintenance(f.dependencies)

    await recovered.recover('w1')
    await recovered.wait('w1')

    /** 恢复后的权威任务状态。 */
    const jobs = f.service.store.readManifest(f.project)?.maintenance?.jobs ?? []
    expect(jobs.find((job) => job.ownerPid === aliveOwnerPid)).toMatchObject({ status: 'running' })
    expect(jobs.find((job) => job.ownerPid === deadOwnerPid)).toMatchObject({
      status: 'failed', message: '上次分析被中断，请重试',
    })
    expect(recovered.status('w1')).toMatchObject({ status: 'running', pendingTurns: 2, failedTurns: 1 })
    expect(f.state.calls).toBe(0)
  })
})
