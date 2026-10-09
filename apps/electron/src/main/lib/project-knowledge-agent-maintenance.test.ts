import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  KnowledgeAssetCopyInput,
  KnowledgeAssetCopyResult,
  KnowledgeDocumentWriteInput,
  KnowledgeEntry,
  KnowledgeOutlineInput,
  KnowledgePlanProposalInput,
  KnowledgeReadInput,
  KnowledgeReadResult,
  KnowledgeSnapshot,
} from '@proma/shared'
import type { PersistedAgentEvidenceRecord } from './agent-session-manager'
import { createProjectKnowledgeAgentMaintenance } from './project-knowledge-agent-maintenance'
import { emptyKnowledgeMaintenance } from './project-knowledge-maintenance-types'
import { createProjectKnowledgeService } from './project-knowledge/service'

/** 每个用例使用独立真实知识清单。 */
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** 构造当前扫描来源条目。 */
function sourceEntry(id: string, revision: string, title = 'README'): KnowledgeEntry {
  return {
    id, revision, title, category: 'overview', kind: 'document', state: 'indexed', freshness: 'current', summary: title,
    source: { kind: 'project-file', id: `project-file:${title}`, relativePath: `${title}.md`, revision: `source-${revision}` },
    byteSize: 100, indexedBytes: 100, truncated: false, metadataOnly: false, updatedAt: 1,
  }
}

/** 创建可控制来源版本、权限和运行状态的受控维护器。 */
async function fixture(initialize = true, workflowEnabled = false) {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-agent-maintenance-')); roots.push(root)
  const project = { projectId: 'w1', projectRoot: root, memoryRoot: join(root, 'memory'), cacheRoot: join(root, 'cache') }
  mkdirSync(project.memoryRoot)
  const service = createProjectKnowledgeService({ resolveProject: () => project })
  if (initialize) await service.store.initialize(project, 'w1')
  const state: {
    current: boolean
    mutable: boolean
    reads: number
    sourcePages: Map<string, KnowledgeReadResult>
    userEvidence?: PersistedAgentEvidenceRecord
    beforeWrite(): void
    beforeTransact(): void | Promise<void>
    workflowCalls: string[]
    lastDocumentInput?: KnowledgeDocumentWriteInput
    lastPlanInput?: KnowledgePlanProposalInput
  } = {
    current: true, mutable: true, reads: 0, sourcePages: new Map(),
    beforeWrite: () => undefined, beforeTransact: () => undefined, workflowCalls: [],
  }
  const maintenanceStore = {
    ...service.store,
    transact: async (...args: Parameters<typeof service.store.transact>) => {
      await state.beforeTransact()
      return service.store.transact(...args)
    },
  }
  /** 新流程测试只关心 Agent 边界，核心事务由 service 专项测试覆盖。 */
  const workflow = workflowEnabled ? {
    getSnapshot: (workspaceId: string) => service.getSnapshot(workspaceId),
    proposePlan: async (input: KnowledgePlanProposalInput): Promise<KnowledgeSnapshot> => {
      state.workflowCalls.push(`plan:${input.workspaceId}:${input.groups.length}`)
      state.lastPlanInput = input
      return service.getSnapshot(input.workspaceId)
    },
    saveOutline: async (input: KnowledgeOutlineInput): Promise<KnowledgeSnapshot> => {
      state.workflowCalls.push(`outline:${input.workspaceId}:${input.planRevision}`)
      return service.getSnapshot(input.workspaceId)
    },
    writeDocument: async (input: KnowledgeDocumentWriteInput): Promise<KnowledgeSnapshot> => {
      state.workflowCalls.push(`document:${input.workspaceId}:${input.itemId}`)
      state.lastDocumentInput = input
      return service.getSnapshot(input.workspaceId)
    },
    copyAsset: async (input: KnowledgeAssetCopyInput): Promise<KnowledgeAssetCopyResult> => {
      state.workflowCalls.push(`asset:${input.workspaceId}:${input.itemId}`)
      return { relativePath: input.relativePath, documentRelativePath: `../${input.relativePath}`, contentRevision: 'asset-revision', byteSize: 2 * 1024 * 1024 }
    },
  } : undefined
  const maintenance = createProjectKnowledgeAgentMaintenance({
    workspaceId: 'w1', sessionId: 's1', userMessageId: 'u1', store: maintenanceStore, resolveProject: () => project,
    readSource: async (input: KnowledgeReadInput) => {
      state.reads += 1
      const value = state.sourcePages.get(`${input.entryId}:${input.expectedRevision}:${input.offset ?? 0}`)
      if (!value) throw new Error('测试来源不存在')
      return value
    },
    readUserEvidence: () => state.userEvidence,
    assertCurrent: () => { if (!state.current) throw new Error('运行已取消') },
    canMutate: () => state.mutable,
    runWorkspaceWrite: async (effect) => { state.beforeWrite(); return effect() },
    workflow,
    now: () => 1000,
  })
  const seed = async (entry: KnowledgeEntry, content: string, truncated = false) => {
    await service.store.transact(project, 'w1', () => ({ commits: [{ entry }] }))
    state.sourcePages.set(`${entry.id}:${entry.revision}:0`, {
      entry, content, status: 'readable', offset: 0, truncated,
    })
  }
  return { project, service, state, maintenance, seed }
}

/** 构造引用单一来源的草稿候选。 */
function candidate(entry: KnowledgeEntry, content = '项目采用本地优先。') {
  return {
    title: '项目原则', content, category: 'overview' as const, kind: 'rule' as const,
    evidence: [{ entryId: entry.id, revision: entry.revision, quote: '项目采用本地优先。' }],
  }
}

describe('当前 Agent 受控维护项目知识', () => {
  test('Given 新流程已启用且只有扫描元数据 When Agent提交自由分组清单 Then 无需伪装已读正文', async () => {
    const f = await fixture(true, true)
    const entry = sourceEntry('0'.repeat(32), '0'.repeat(64))
    await f.seed(entry, '尚未读取的正文')

    await f.maintenance.proposePlan!({
      title: '项目知识', rootRelativePath: 'docs/knowledge',
      groups: [{ id: 'product', title: '产品脉络', summary: '整理产品边界', sources: [{ entryId: entry.id, revision: entry.revision }], gaps: [], outputs: ['产品概览'] }],
    })

    expect(f.state.reads).toBe(0)
    expect(f.state.workflowCalls).toEqual(['plan:w1:1'])
    expect(f.state.lastPlanInput?.groups[0]?.sources[0]?.coverage).toBe('discovered')
    /** 真正通过读取观察后才标记已读，不能用模型的 coverage 字段宣称完成。 */
    f.maintenance.observeRead(f.state.sourcePages.get(`${entry.id}:${entry.revision}:0`)!)
    await f.maintenance.proposePlan!({
      title: '项目知识', rootRelativePath: 'docs/knowledge',
      groups: [{ id: 'product', title: '产品脉络', summary: '整理产品边界', sources: [{ entryId: entry.id, revision: entry.revision }], gaps: [], outputs: ['产品概览'] }],
    })
    expect(f.state.lastPlanInput?.groups[0]?.sources[0]?.coverage).toBe('read')
  })

  test('Given 新流程已启用 When 计划模式、运行取消或旧submit尝试写入 Then 全部拒绝', async () => {
    const f = await fixture(true, true)
    const plan = { title: '项目知识', rootRelativePath: 'docs/knowledge', groups: [] }
    f.state.mutable = false
    await expect(f.maintenance.proposePlan!(plan)).rejects.toThrow('权限')
    f.state.mutable = true; f.state.current = false
    await expect(f.maintenance.proposePlan!(plan)).rejects.toThrow('取消')
    f.state.current = true
    await expect(f.maintenance.submit({ conversationCandidates: [] })).rejects.toThrow('两步流程')
    expect(f.state.workflowCalls).toEqual([])
  })

  test('Given 来源页已读且引用真实 When 写大纲文档 Then 租约内复验来源后调用发布端口', async () => {
    const f = await fixture(true, true)
    const entry = sourceEntry('7'.repeat(32), '7'.repeat(64))
    await f.seed(entry, '项目采用本地优先。')
    f.maintenance.observeRead(f.state.sourcePages.get(`${entry.id}:${entry.revision}:0`)!)

    await f.maintenance.writeDocument!({
      planRevision: 1, outlineRevision: 1, itemId: 'overview', expectedRevision: null,
      content: '# 项目概览\n\n项目采用本地优先。', summary: '项目概览', complete: true,
      evidence: [{ entryId: entry.id, revision: entry.revision, quote: '项目采用本地优先。' }],
    })

    expect(f.state.reads).toBe(1)
    expect(f.state.workflowCalls).toEqual(['document:w1:overview'])
  })

  test('Given 引用伪造、来源未读或版本在租约前变化 When 写文档 Then 拒绝发布', async () => {
    const f = await fixture(true, true)
    const entry = sourceEntry('8'.repeat(32), '8'.repeat(64))
    await f.seed(entry, '项目采用本地优先。')
    const base = {
      planRevision: 1, outlineRevision: 1, itemId: 'overview', expectedRevision: null,
      content: '# 项目概览', summary: '项目概览', complete: true,
    }
    await expect(f.maintenance.writeDocument!({ ...base, evidence: [{ entryId: entry.id, revision: entry.revision, quote: '伪造引用' }] })).rejects.toThrow('读取')
    f.maintenance.observeRead(f.state.sourcePages.get(`${entry.id}:${entry.revision}:0`)!)
    await expect(f.maintenance.writeDocument!({ ...base, evidence: [{ entryId: entry.id, revision: entry.revision, quote: '伪造引用' }] })).rejects.toThrow('逐字')
    f.state.beforeWrite = () => {
      f.state.sourcePages.set(`${entry.id}:${entry.revision}:0`, { entry, content: '来源已经变化。', status: 'readable', offset: 0, truncated: false })
    }
    await expect(f.maintenance.writeDocument!({ ...base, evidence: [{ entryId: entry.id, revision: entry.revision, quote: '项目采用本地优先。' }] })).rejects.toThrow('变化')
    expect(f.state.workflowCalls).toEqual([])
  })

  test('Given 当前用户原话可用 When 文档只引用该原话 Then 事务前复验真实消息', async () => {
    const f = await fixture(true, true)
    f.state.userEvidence = { uuid: 'u1', role: 'user', text: '决定：资料库只保存项目事实', sha256: 'user-hash', byteOffset: 0, byteLength: 18 }
    const input = {
      planRevision: 1, outlineRevision: 1, itemId: 'decision', expectedRevision: null,
      content: '# 决策\n\n资料库只保存项目事实。', summary: '资料库边界', complete: true,
      evidence: [], userQuote: '资料库只保存项目事实',
    }
    await f.maintenance.writeDocument!(input)
    expect(f.state.workflowCalls).toEqual(['document:w1:decision'])
    expect(f.state.lastDocumentInput?.userEvidence).toEqual({
      sessionId: 's1', messageId: 'u1', quote: '资料库只保存项目事实',
    })
    f.state.beforeWrite = () => { f.state.userEvidence = { ...f.state.userEvidence!, text: '用户已修改原消息', sha256: 'changed' } }
    await expect(f.maintenance.writeDocument!(input)).rejects.toThrow('证据已变化')
  })

  test('Given 旧受管或对话知识已读取 When 迁移到新大纲文档 Then 可作为本轮真实证据', async () => {
    for (const source of [
      { kind: 'managed' as const, id: 'legacy-managed', revision: 'legacy-source' },
      { kind: 'conversation' as const, id: 'legacy-conversation', revision: 'legacy-user', sessionId: 's0', messageIds: ['u0'] },
    ]) {
      const f = await fixture(true, true)
      const entry = { ...sourceEntry('9'.repeat(32), '9'.repeat(64), source.kind), source, kind: 'fact' as const, state: 'draft' as const }
      await f.service.store.transact(f.project, 'w1', () => ({ commits: [{ entry, content: '历史知识可迁移。' }] }))
      const page = { entry, content: '历史知识可迁移。', status: 'readable' as const, offset: 0, truncated: false }
      f.state.sourcePages.set(`${entry.id}:${entry.revision}:0`, page)
      f.maintenance.observeRead(page)

      await f.maintenance.writeDocument!({
        planRevision: 1, outlineRevision: 1, itemId: `migrate-${source.kind}`, expectedRevision: null,
        content: '# 迁移', summary: '迁移旧知识', complete: false,
        evidence: [{ entryId: entry.id, revision: entry.revision, quote: '历史知识可迁移。' }],
      })

      expect(f.state.workflowCalls).toEqual([`document:w1:migrate-${source.kind}`])
    }
  })

  test('Given 扫描登记metadataOnly资产 When 复制到已确认大纲项 Then 闭包补workspace并沿同一写租约', async () => {
    const f = await fixture(true, true)
    const input = {
      planRevision: 1, outlineRevision: 1, itemId: 'design',
      sourceEntryId: 'asset-entry', sourceRevision: 'asset-source-revision', relativePath: 'assets/design/source.psd',
    }
    const result = await f.maintenance.copyAsset!(input)
    expect(result.documentRelativePath).toBe('../assets/design/source.psd')
    expect(f.state.workflowCalls).toEqual(['asset:w1:design'])
    f.state.mutable = false
    await expect(f.maintenance.copyAsset!(input)).rejects.toThrow('权限')
  })
  test('Given 扫描来源尚未处理 When 请求下一批 Then 只返回优先元数据且不读取正文', async () => {
    const f = await fixture()
    const entry = sourceEntry('1'.repeat(32), 'a'.repeat(64))
    await f.seed(entry, '项目采用本地优先。')
    const batch = await f.maintenance.next()
    expect(batch.refs).toEqual([{ entryId: entry.id, revision: entry.revision, category: 'overview', title: 'README' }])
    expect(f.state.reads).toBe(0)
  })

  test('Given Agent 实际读过来源 When 提交带逐字引用候选 Then 发布草稿并推进来源水位', async () => {
    const f = await fixture()
    const entry = sourceEntry('2'.repeat(32), 'b'.repeat(64))
    await f.seed(entry, '项目采用本地优先。', true)
    const page = await f.state.sourcePages.get(`${entry.id}:${entry.revision}:0`)!
    f.maintenance.observeRead(page)

    const result = await f.maintenance.submit({ processedSourceRefs: [{ entryId: entry.id, revision: entry.revision }], candidates: [candidate(entry)] })

    expect(result).toMatchObject({ published: 1, processedSources: 1 })
    const knowledge = (await f.service.getSnapshot('w1')).entries.find((item) => item.source.kind === 'managed')
    expect(knowledge).toMatchObject({ state: 'draft', truncated: true, evidence: candidate(entry).evidence })
    expect((await f.maintenance.next()).refs).toHaveLength(0)
  })

  test('Given 来源未读或版本错误 When Agent 提交 Then 拒绝且不推进水位', async () => {
    const f = await fixture()
    const entry = sourceEntry('3'.repeat(32), 'c'.repeat(64))
    await f.seed(entry, '项目采用本地优先。')
    await expect(f.maintenance.submit({ processedSourceRefs: [{ entryId: entry.id, revision: entry.revision }], candidates: [candidate(entry)] })).rejects.toThrow('读取')
    f.maintenance.observeRead(f.state.sourcePages.get(`${entry.id}:${entry.revision}:0`)!)
    await expect(f.maintenance.submit({ processedSourceRefs: [{ entryId: entry.id, revision: 'd'.repeat(64) }], candidates: [candidate(entry)] })).rejects.toThrow('版本')
    expect((await f.maintenance.next()).refs).toHaveLength(1)
  })

  test('Given 来源升级但结论不变 When 再次提交 Then 保持知识ID并刷新依据', async () => {
    const f = await fixture()
    const first = sourceEntry('4'.repeat(32), 'd'.repeat(64))
    await f.seed(first, '项目采用本地优先。')
    f.maintenance.observeRead(f.state.sourcePages.get(`${first.id}:${first.revision}:0`)!)
    await f.maintenance.submit({ processedSourceRefs: [{ entryId: first.id, revision: first.revision }], candidates: [candidate(first)] })
    const original = (await f.service.getSnapshot('w1')).entries.find((item) => item.source.kind === 'managed')!
    const second = sourceEntry(first.id, 'e'.repeat(64))
    await f.seed(second, '项目采用本地优先。\n新增无关说明。')
    f.maintenance.observeRead(f.state.sourcePages.get(`${second.id}:${second.revision}:0`)!)

    const result = await f.maintenance.submit({ processedSourceRefs: [{ entryId: second.id, revision: second.revision }], candidates: [candidate(second)] })
    const refreshed = (await f.service.getSnapshot('w1')).entries.find((item) => item.id === original.id)
    expect(result.refreshed).toBe(1)
    expect(refreshed?.evidence?.[0]?.revision).toBe(second.revision)
  })

  test('Given 用户人工改写过受管正文 When 来源升级仍返回旧结论 Then 不覆盖正文也不刷新依据', async () => {
    const f = await fixture()
    const first = sourceEntry('6'.repeat(32), '2'.repeat(64))
    await f.seed(first, '项目采用本地优先。')
    f.maintenance.observeRead(f.state.sourcePages.get(`${first.id}:${first.revision}:0`)!)
    await f.maintenance.submit({ processedSourceRefs: [{ entryId: first.id, revision: first.revision }], candidates: [candidate(first)] })
    const knowledge = (await f.service.getSnapshot('w1')).entries.find((item) => item.source.kind === 'managed')!
    const manualContent = '人工确认：只允许本地加密存储。'
    const manualBase = { ...knowledge, summary: manualContent, byteSize: Buffer.byteLength(manualContent), indexedBytes: Buffer.byteLength(manualContent), updatedAt: 2 }
    const manual = { ...manualBase, revision: createHash('sha256').update(JSON.stringify(manualBase) + manualContent).digest('hex') }
    await f.service.store.transact(f.project, 'w1', () => ({ commits: [{ entry: manual, content: manualContent }] }))
    const second = sourceEntry(first.id, '3'.repeat(64))
    await f.seed(second, '项目采用本地优先。\n新版。')
    f.maintenance.observeRead(f.state.sourcePages.get(`${second.id}:${second.revision}:0`)!)

    await f.maintenance.submit({ processedSourceRefs: [{ entryId: second.id, revision: second.revision }], candidates: [candidate(second)] })

    const manifest = f.service.store.readManifest(f.project)!
    const preserved = f.service.store.readEntry(f.project, manifest, knowledge.id)
    expect(preserved.evidence?.[0]?.revision).toBe(first.revision)
    expect(f.service.store.readContent(f.project, manifest, knowledge.id)).toBe(manualContent)
  })

  test('Given 当前用户明确声明 When Agent 提交对话候选 Then 逐字校验并自动确认', async () => {
    const f = await fixture()
    f.state.userEvidence = { uuid: 'u1', role: 'user', text: '决定：项目只用本地存储', sha256: 'user-hash', byteOffset: 0, byteLength: 20 }
    const result = await f.maintenance.submit({ conversationCandidates: [{
      title: '存储决策', content: '项目只用本地存储', category: 'decisions', kind: 'decision', quote: '决定：项目只用本地存储',
    }] })
    expect(result.published).toBe(1)
    expect((await f.service.getSnapshot('w1')).entries.find((item) => item.source.kind === 'conversation')?.state).toBe('confirmed')
    await expect(f.maintenance.submit({ conversationCandidates: [{
      title: '伪造', content: '错误', category: 'decisions', kind: 'fact', quote: '不存在',
    }] })).rejects.toThrow('引用')
  })

  test('Given 项目尚未建库 When 当前用户明确声明 Then 只初始化空知识库并发布对话知识', async () => {
    const f = await fixture(false)
    f.state.userEvidence = { uuid: 'u1', role: 'user', text: '决定：项目只用本地存储', sha256: 'user-hash', byteOffset: 0, byteLength: 20 }

    const result = await f.maintenance.submit({ conversationCandidates: [{
      title: '存储决策', content: '项目只用本地存储', category: 'decisions', kind: 'decision', quote: '决定：项目只用本地存储',
    }] })

    const snapshot = await f.service.getSnapshot('w1')
    expect(result.published).toBe(1)
    expect(snapshot.initialized).toBe(true)
    expect(snapshot.scan.discovered).toBe(0)
    expect(snapshot.entries).toHaveLength(1)
  })

  test('Given 等待写租约期间用户原文被改写 When 发布对话知识 Then 拒绝迟到证据', async () => {
    const f = await fixture()
    f.state.userEvidence = { uuid: 'u1', role: 'user', text: '决定：项目只用本地存储', sha256: 'old-hash', byteOffset: 0, byteLength: 20 }
    f.state.beforeWrite = () => {
      f.state.userEvidence = { uuid: 'u1', role: 'user', text: '决定：项目使用云端存储', sha256: 'new-hash', byteOffset: 0, byteLength: 22 }
    }

    await expect(f.maintenance.submit({ conversationCandidates: [{
      title: '存储决策', content: '项目只用本地存储', category: 'decisions', kind: 'decision', quote: '决定：项目只用本地存储',
    }] })).rejects.toThrow('证据已变化')
    expect((await f.service.getSnapshot('w1')).entries).toHaveLength(0)
  })

  test('Given 同一用户引文已形成知识 When Agent 改写候选正文再次提交 Then 不覆盖原条目', async () => {
    const f = await fixture()
    f.state.userEvidence = { uuid: 'u1', role: 'user', text: '项目需要坚持本地优先', sha256: 'user-hash', byteOffset: 0, byteLength: 20 }
    const base = { title: '存储原则', category: 'decisions' as const, kind: 'decision' as const, quote: '本地优先' }
    await f.maintenance.submit({ conversationCandidates: [{ ...base, content: '第一版提炼正文' }] })

    const result = await f.maintenance.submit({ conversationCandidates: [{ ...base, content: '第二版改写正文' }] })

    const snapshot = await f.service.getSnapshot('w1')
    const entry = snapshot.entries.find((item) => item.source.kind === 'conversation')!
    const manifest = f.service.store.readManifest(f.project)!
    expect(result).toMatchObject({ published: 0, skipped: 1 })
    expect(f.service.store.readContent(f.project, manifest, entry.id)).toBe('第一版提炼正文')
  })

  test('Given 旧后台对话锚点已被拒绝 When 当前Agent再次提交 Then 不复活旧来源', async () => {
    const f = await fixture()
    const quote = '项目需要坚持本地优先'
    f.state.userEvidence = { uuid: 'u1', role: 'user', text: quote, sha256: 'user-hash', byteOffset: 0, byteLength: 20 }
    const legacyTurn = createHash('sha256').update('w1\0s1\0u1').digest('hex')
    const legacySourceId = createHash('sha256').update(`${legacyTurn}\0u1\0${quote}`).digest('hex')
    await f.service.store.transact(f.project, 'w1', ({ manifest }) => ({
      excludedSources: [...(manifest.excludedSources ?? []), legacySourceId],
    }))

    const result = await f.maintenance.submit({ conversationCandidates: [{
      title: '存储原则', content: '项目坚持本地优先', category: 'decisions', kind: 'decision', quote,
    }] })

    expect(result).toMatchObject({ published: 0, skipped: 1 })
    expect((await f.service.getSnapshot('w1')).entries).toHaveLength(0)
  })

  test('Given 会话已被用户排除 When Agent提交对话候选 Then 拒绝发布', async () => {
    const f = await fixture()
    f.state.userEvidence = { uuid: 'u1', role: 'user', text: '记住：使用中文', sha256: 'user-hash', byteOffset: 0, byteLength: 10 }
    await f.service.store.transact(f.project, 'w1', ({ manifest }) => {
      const maintenance = structuredClone(manifest.maintenance ?? emptyKnowledgeMaintenance())
      maintenance.excludedSessions.push('s1')
      return { maintenance }
    })

    await expect(f.maintenance.submit({ conversationCandidates: [{
      title: '语言偏好', content: '使用中文', category: 'guides', kind: 'preference', quote: '记住：使用中文',
    }] })).rejects.toThrow('排除')
    expect((await f.service.getSnapshot('w1')).entries).toHaveLength(0)
  })

  test('Given 替代目标在等待事务期间被人工更新 When 发布纠正 Then 不把新版目标标记为已替代', async () => {
    const f = await fixture()
    const oldContent = '旧规则正文'
    const oldBase: Omit<KnowledgeEntry, 'revision'> = {
      id: '9'.repeat(32), title: '旧规则', category: 'decisions', kind: 'decision', state: 'confirmed', freshness: 'current',
      summary: oldContent, source: { kind: 'conversation', id: '8'.repeat(64), sessionId: 's0', messageIds: ['u0'], revision: 'old-user' },
      byteSize: Buffer.byteLength(oldContent), indexedBytes: Buffer.byteLength(oldContent), truncated: false, metadataOnly: false, updatedAt: 1,
    }
    const oldEntry = { ...oldBase, revision: createHash('sha256').update(JSON.stringify(oldBase) + oldContent).digest('hex') }
    await f.service.store.transact(f.project, 'w1', () => ({ commits: [{ entry: oldEntry, content: oldContent }] }))
    f.state.userEvidence = { uuid: 'u1', role: 'user', text: '更正：旧规则改为新规则', sha256: 'user-hash', byteOffset: 0, byteLength: 20 }
    f.state.beforeTransact = async () => {
      f.state.beforeTransact = () => undefined
      const manualContent = '人工更新后的旧规则正文'
      const manualBase = { ...oldEntry, summary: manualContent, updatedAt: 2 }
      const manual = { ...manualBase, revision: createHash('sha256').update(JSON.stringify(manualBase) + manualContent).digest('hex') }
      await f.service.store.transact(f.project, 'w1', () => ({ commits: [{ entry: manual, content: manualContent }] }))
    }

    await f.maintenance.submit({ conversationCandidates: [{
      title: '新规则', content: '新规则', category: 'decisions', kind: 'decision', quote: '更正：旧规则改为新规则', replacesEntryId: oldEntry.id,
    }] })

    const old = (await f.service.getSnapshot('w1')).entries.find((entry) => entry.id === oldEntry.id)
    expect(old?.state).toBe('confirmed')
  })

  test('Given 计划模式或运行已取消 When 提交 Then 不发生写入', async () => {
    const f = await fixture()
    f.state.userEvidence = { uuid: 'u1', role: 'user', text: '记住：使用中文', sha256: 'hash', byteOffset: 0, byteLength: 10 }
    f.state.mutable = false
    await expect(f.maintenance.submit({ conversationCandidates: [{ title: '语言', content: '使用中文', category: 'guides', kind: 'preference', quote: '记住：使用中文' }] })).rejects.toThrow('权限')
    f.state.mutable = true; f.state.current = false
    await expect(f.maintenance.submit({ conversationCandidates: [{ title: '语言', content: '使用中文', category: 'guides', kind: 'preference', quote: '记住：使用中文' }] })).rejects.toThrow('取消')
    expect((await f.service.getSnapshot('w1')).entries).toHaveLength(0)
  })

  test('Given 尚未建库且当前模式不可写 When 提交对话候选 Then 不创建知识库', async () => {
    const f = await fixture(false)
    f.state.userEvidence = { uuid: 'u1', role: 'user', text: '记住：使用中文', sha256: 'hash', byteOffset: 0, byteLength: 10 }
    f.state.mutable = false

    await expect(f.maintenance.submit({ conversationCandidates: [{
      title: '语言', content: '使用中文', category: 'guides', kind: 'preference', quote: '记住：使用中文',
    }] })).rejects.toThrow('权限')
    expect((await f.service.getSnapshot('w1')).initialized).toBe(false)
  })

  test('Given 候选锚点已拒绝或正文已人工修改 When 再次提交 Then 不复活也不覆盖', async () => {
    const f = await fixture()
    const first = sourceEntry('5'.repeat(32), 'f'.repeat(64))
    await f.seed(first, '项目采用本地优先。')
    f.maintenance.observeRead(f.state.sourcePages.get(`${first.id}:${first.revision}:0`)!)
    await f.maintenance.submit({ processedSourceRefs: [{ entryId: first.id, revision: first.revision }], candidates: [candidate(first)] })
    const knowledge = (await f.service.getSnapshot('w1')).entries.find((item) => item.source.kind === 'managed')!
    await f.service.store.transact(f.project, 'w1', ({ manifest }) => ({ excludedSources: [...(manifest.excludedSources ?? []), knowledge.source.id] }))
    const second = sourceEntry(first.id, '1'.repeat(64))
    await f.seed(second, '项目采用本地优先。\n改版。')
    f.maintenance.observeRead(f.state.sourcePages.get(`${second.id}:${second.revision}:0`)!)
    const result = await f.maintenance.submit({ processedSourceRefs: [{ entryId: second.id, revision: second.revision }], candidates: [{ ...candidate(second), title: '换标题', content: '改写措辞' }] })
    expect(result.published).toBe(0)
  })
})
