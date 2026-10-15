import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionMeta } from '@proma/shared'
import type { PersistedAgentEvidenceRecord, SDKMessageAppendReceipt } from './agent-session-manager'
import { createProjectKnowledgeStore } from './project-knowledge/store'
import { emptyKnowledgeMaintenance } from './project-knowledge-maintenance-types'

/** 每例创建独立数据根，运行时缓存不会跨用例复用实例。 */
let configRoot = ''
/** 当前可信项目和会话可在用例中模拟迁移。 */
let projectRoot = ''
let session: AgentSessionMeta
/** 只模拟消息存储端口，来源扫描、知识发布和索引使用真实文件。 */
let userEvidence: PersistedAgentEvidenceRecord | undefined
/** 补充按钮产生的控制提示与真实用户事实分别保存。 */
let supplementControl: PersistedAgentEvidenceRecord | undefined
let deleting = false
let active = true
let writable = true
let leases = 0
let receiptLookups: string[] = []

mock.module('./agent-workspace-manager', () => ({
  getAgentWorkspace: (id: string) => id === 'w1' ? { id, slug: 'project', projectRootPath: projectRoot } : undefined,
}))
mock.module('./config-paths', () => ({ getConfigDir: () => configRoot, resolveWorkspaceFilesDir: () => projectRoot }))
mock.module('./workspace-operation-lock', () => ({
  getWorkspaceOperationBlockReason: () => undefined,
  acquireWorkspaceWriteLease: () => { leases += 1; return () => { leases -= 1 } },
}))
mock.module('./agent-session-manager', () => ({
  getAgentSessionMeta: (id: string) => id === session.id ? session : undefined,
  isAgentSessionDeleting: () => deleting,
  getPersistedAgentMessageReceipt: (id: string, uuid: string): SDKMessageAppendReceipt | undefined => {
    receiptLookups.push(`${id}:${uuid}`)
    return userEvidence || supplementControl ? { sessionId: id, status: 'written' } : undefined
  },
  getLatestPersistedUserEvidence: () => supplementControl ? userEvidence : undefined,
  readPersistedAgentEvidence: (id: string) => ({ sessionId: id, records: [userEvidence, supplementControl].filter((record): record is PersistedAgentEvidenceRecord => Boolean(record)), truncated: false, skipped: 0 }),
}))

const { getProjectKnowledgeService, recoverProjectKnowledge, getProjectKnowledgeBinding, registerKnowledgeExecutionHost, registerKnowledgeImportSelector, registerProjectKnowledgeSources } = await import('./project-knowledge-runtime')
const { createProjectKnowledgeAgent } = await import('./project-knowledge-agent')

beforeEach(() => {
  configRoot = realpathSync(mkdtempSync(join(tmpdir(), 'knowledge-runtime-agent-')))
  projectRoot = join(configRoot, 'project')
  mkdirSync(projectRoot)
  session = { id: 's1', title: '项目对话', workspaceId: 'w1', createdAt: 1, updatedAt: 1 }
  deleting = false; active = true; writable = true; leases = 0; receiptLookups = []
  registerProjectKnowledgeSources({ list: async () => ({ sources: [], total: 0, truncated: false, skipped: 0 }), read: async () => ({ status: 'unavailable', content: '', truncated: false }) })
  supplementControl = undefined
  /** 固定用户原文及真实内容散列。 */
  const text = '决定：项目数据保存在本地。'
  userEvidence = { uuid: 'u1', role: 'user', text, sha256: createHash('sha256').update(text).digest('hex'), byteOffset: 0, byteLength: Buffer.byteLength(text) }
})
afterEach(() => { rmSync(configRoot, { recursive: true, force: true }) })

/** 通过生产 runtime 创建当前回合能力，不配置任何维护渠道或模型。 */
function currentAgent() {
  const service = getProjectKnowledgeService()
  /** 运行生命周期与计划模式在测试中可动态切换。 */
  const assertRunActive = (): void => { if (!active) throw new Error('运行已停止') }
  const agent = createProjectKnowledgeAgent({
    sessionId: 's1', toolMode: 'standard', getSession: () => session,
    getBinding: getProjectKnowledgeBinding, assertRunActive, service,
    maintenance: () => service.createAgentMaintenance({ sessionId: 's1', userMessageId: 'u1', assertRunActive, canMutate: () => writable }),
  })!
  return { service, agent }
}

describe('知识库 runtime 与当前 Agent Skill 链路', () => {
  for (const mode of ['conversation', 'entry']) {
    test(`Given ${mode} 补充控制消息 When 规划和写入 Then 引用按钮之前的真实用户事实并拒绝控制提示`, async () => {
      /** 控制提示模拟点击按钮后落盘的用户形态消息，不得成为事实来源。 */
      const text = `[knowledge-supplement:${mode}]\n请维护知识库`
      supplementControl = { uuid: 'supplement-control', role: 'user', text, sha256: createHash('sha256').update(text).digest('hex'), byteOffset: 100, byteLength: Buffer.byteLength(text) }
      const service = getProjectKnowledgeService()
      const maintenance = service.createAgentMaintenance({ sessionId: 's1', userMessageId: supplementControl.uuid, assertRunActive: () => undefined, canMutate: () => true })
      const proposed = await maintenance.proposePlan!({ title: '数据知识', rootRelativePath: 'knowledge',
        groups: [{ id: 'g', title: '数据', summary: '用户决定', sources: [], gaps: [], outputs: ['存储规则'] }] })
      expect((await service.getSnapshot('w1')).workflow?.userEvidence?.map((evidence) => evidence.messageId)).toEqual(['u1'])
      await service.confirmPlan({ workspaceId: 'w1', planId: proposed.proposal!.id, expectedRevision: 1, groups: [{ id: 'g', title: '数据' }] })
      const outlined = await maintenance.saveOutline!({ planRevision: 1, expectedRevision: 0,
        items: [{ id: 'rules', groupId: 'g', title: '规则', relativePath: 'rules.md', summary: '存储规则', sections: ['存储'] }] })
      const input = { planRevision: 1, outlineRevision: outlined.outline!.revision, itemId: 'rules', expectedRevision: null,
        content: '项目数据保存在本地。', summary: '数据位置', complete: true, evidence: [] }
      await expect(maintenance.writeDocument!({ ...input, userQuote: text })).rejects.toThrow()
      await maintenance.writeDocument!({ ...input, userQuote: userEvidence!.text })
      expect((await service.getSnapshot('w1')).entries.find((entry) => entry.document)?.userEvidence?.messageId).toBe('u1')
    })
  }

  test('Given 未配置维护模型 When Agent提案且用户确认后按大纲写文档 Then 发布知识且下一回合可检索', async () => {
    writeFileSync(join(projectRoot, 'README.md'), '# 项目规则\n项目数据保存在本地，使用 JSON 文件。\n')
    const { service, agent } = currentAgent()
    await service.startScan('w1')
    await service.waitForScan('w1')
    const scanned = await service.getSnapshot('w1')
    expect(scanned.knowledgeCount).toBe(0)
    const ref = scanned.entries.find((entry) => entry.source.kind === 'project-file')!
    const proposed = await agent.proposeKnowledgePlan!({
      title: '项目知识', rootRelativePath: 'docs/knowledge',
      groups: [{ id: 'project', title: '项目', summary: '项目规则', sources: [{ entryId: ref.id, revision: ref.revision }], gaps: [], outputs: ['项目规则'] }],
    })
    expect(agent.submitMaintenance).toBeUndefined()
    const proposal = proposed.proposal!
    await service.confirmPlan({ workspaceId: 'w1', planId: proposal.id, expectedRevision: proposal.revision, groups: [{ id: 'project', title: '项目' }] })
    const outlined = await agent.saveKnowledgeOutline!({
      planRevision: proposal.revision, expectedRevision: 0,
      items: [{ id: 'project-rules', groupId: 'project', title: '项目规则', relativePath: 'project/rules.md', summary: '项目规则', sections: ['存储'] }],
    })
    expect((await agent.read(ref.id, 0, ref.revision)).status).toBe('readable')
    await agent.writeKnowledgeDocument!({
      planRevision: proposal.revision, outlineRevision: outlined.outline!.revision,
      itemId: 'project-rules', expectedRevision: null, content: '# 项目规则\n\n项目使用本地 JSON 文件保存数据。',
      summary: '本地存储规则', complete: true,
      evidence: [{ entryId: ref.id, revision: ref.revision, quote: '项目数据保存在本地，使用 JSON 文件。' }],
      admission: { contentType: 'rule', importance: 'high', purpose: '确定数据保存方式', scope: '当前项目',
        claims: [{ statement: '项目使用本地 JSON 文件保存数据。', evidenceIndexes: [0] }],
        coverage: [{ topic: '存储方式', status: 'covered', reason: '来源明确本地JSON' }], issues: [], outcome: 'eligible' },
    })
    expect((await currentAgent().agent.search('本地')).items[0]?.entry.source.kind).toBe('managed')
    expect(leases).toBe(0)
  })

  test('Given 新流程尚未建立approved范围 When 当前用户有决定 Then 不能通过旧submit绕过确认', async () => {
    const { service, agent } = currentAgent()
    expect((await service.getSnapshot('w1')).initialized).toBe(false)
    expect(agent.submitMaintenance).toBeUndefined()
    expect(agent.writeKnowledgeDocument).toBeFunction()
    await expect(agent.writeKnowledgeDocument!({
      planRevision: 1, outlineRevision: 1, itemId: 'decision', expectedRevision: null,
      content: '# 决定', summary: '数据位置', complete: true, evidence: [], userQuote: userEvidence!.text,
    })).rejects.toThrow('尚未初始化')
    expect(receiptLookups.every((lookup) => lookup === 's1:u1')).toBe(true)
    expect((await service.getSnapshot('w1')).initialized).toBe(false)
    expect(leases).toBe(0)
  })

  test('Given 当前回合停止或进入计划模式 When 提交知识 Then 拒绝且不初始化知识库', async () => {
    const { service, agent } = currentAgent()
    const input = { title: '项目知识', rootRelativePath: 'docs/knowledge', groups: [] }
    writable = false
    await expect(agent.proposeKnowledgePlan!(input)).rejects.toThrow('权限')
    writable = true; active = false
    await expect(agent.proposeKnowledgePlan!(input)).rejects.toThrow('停止')
    expect((await service.getSnapshot('w1')).initialized).toBe(false)
    expect(leases).toBe(0)
  })

  test('Given 旧独立维护队列启用 When 应用恢复 Then 停用旧队列并保留已完成水位与排除记录', async () => {
    const project = { projectId: 'w1', projectRoot, memoryRoot: join(configRoot, 'agent-workspaces', 'project', 'memory'), cacheRoot: join(configRoot, 'knowledge-cache', 'w1') }
    const store = createProjectKnowledgeStore({ resolveProject: () => project })
    await store.initialize(project, 'w1')
    const maintenance = emptyKnowledgeMaintenance()
    maintenance.settings = { enabled: true, channelId: 'old', modelId: 'old-model', dailyJobLimit: 20, generation: 1 }
    maintenance.completedSources = ['completed-source']
    maintenance.excludedSessions = ['excluded-session']
    maintenance.jobs = [{ id: 'old-job', sessionId: 's1', userMessageId: 'u1', startedAt: 1, receipts: [], status: 'pending', generation: 1, attempts: 0 }]
    await store.transact(project, 'w1', () => ({ maintenance }))
    await recoverProjectKnowledge('w1')
    const retired = store.readManifest(project)!
    expect(retired.maintenance?.settings.enabled).toBe(false)
    expect(retired.maintenance?.jobs[0]?.status).toBe('excluded')
    expect(retired.maintenance?.completedSources).toEqual(['completed-source'])
    expect(retired.maintenance?.excludedSessions).toEqual(['excluded-session'])
    await recoverProjectKnowledge('w1')
    expect(store.readManifest(project)?.revision).toBe(retired.revision)
    await expect(getProjectKnowledgeService().retryMaintenance('w1')).rejects.toThrow('Agent')
  })

  test('Given 原始用户事实与宿主控制消息 When 自动续接 Then 只引用登记原话并复验变化', async () => {
    const { service, agent } = currentAgent()
    const messages: string[] = []
    registerKnowledgeExecutionHost({ enqueue: async (_sessionId, prompt) => { messages.push(prompt) }, changed: () => undefined })
    await service.startScan('w1'); await service.waitForScan('w1')
    const proposed = await agent.proposeKnowledgePlan!({ title: '规则', rootRelativePath: 'knowledge',
      groups: [{ id: 'g', title: '规则', summary: '用户数据决定', sources: [], gaps: [], outputs: ['数据决定'] }] })
    await service.confirmPlan({ workspaceId: 'w1', planId: proposed.proposal!.id, expectedRevision: 1, groups: [{ id: 'g', title: '规则' }] })
    await service.startExecution({ workspaceId: 'w1', sessionId: 's1', planRevision: 1 })
    await expect(agent.saveKnowledgeOutline!({ planRevision: 1, expectedRevision: 0, items: [] })).rejects.toThrow('权限')
    const run = (await service.claimExecution('s1', messages[0]!, 1, () => undefined))!
    const resumed = createProjectKnowledgeAgent({ sessionId: 's1', toolMode: 'standard', getSession: () => session,
      getBinding: getProjectKnowledgeBinding, assertRunActive: () => undefined, service,
      taskUserEvidence: () => service.getTaskUserEvidence('s1'),
      maintenance: () => service.createAgentMaintenance({ sessionId: 's1', userMessageId: 'control-message',
        execution: run, assertRunActive: () => undefined, canMutate: () => true }),
    })!
    const context = await resumed.buildContext('数据规则')
    expect(context).toContain('决定：项目数据保存在本地。')
    const outlined = await resumed.saveKnowledgeOutline!({ planRevision: 1, expectedRevision: 0,
      items: [{ id: 'rules', groupId: 'g', title: '规则', relativePath: 'rules.md', summary: '数据位置', sections: ['存储'],
        dependencyState: 'known', userEvidenceIds: ['u1'], sources: [] }] })
    await resumed.writeKnowledgeDocument!({ planRevision: 1, outlineRevision: outlined.outline!.revision,
      itemId: 'rules', expectedRevision: null, content: '项目数据保存在本地。', summary: '数据位置', complete: true,
      evidence: [], userEvidenceId: 'u1', userQuote: '项目数据保存在本地。',
      admission: { contentType: 'decision', importance: 'high', purpose: '保存数据决定', scope: '当前项目',
        claims: [{ statement: '项目数据保存在本地。', evidenceIndexes: [], usesUserEvidence: true }],
        coverage: [{ topic: '数据位置', status: 'covered', reason: '用户明确决定' }], issues: [], outcome: 'eligible' },
    })
    const written = (await service.getSnapshot('w1')).entries.find((entry) => entry.document)
    expect(written?.userEvidence?.messageId).toBe('u1')
    expect(written?.admission?.status).toBe('eligible')
    expect((await service.search({ workspaceId: 'w1', query: '本地' })).items).toHaveLength(1)
    userEvidence = { ...userEvidence!, sha256: 'changed' }
    expect(service.getTaskUserEvidence('s1')).toEqual([])
    userEvidence = { ...userEvidence, text: '决定：改为云端保存。' }
    expect((await service.read({ workspaceId: 'w1', entryId: written!.id })).entry.admission?.status).toBe('invalidated')
    expect((await service.search({ workspaceId: 'w1', query: '本地' })).items).toHaveLength(0)
    await service.pauseWorkflow({ workspaceId: 'w1', paused: true })
    await run.finish({ stopped: true })
    expect((await service.getSnapshot('w1')).workflow?.execution?.status).toBe('paused')
    expect(leases).toBe(0)
  })
})


describe('Agent 来源扫描与保真导入', () => {
  test('Given 未建库项目 When Agent 扫描 Then 建立来源且返回有界摘要', async () => {
    writeFileSync(join(projectRoot, 'README.md'), '# 项目概览')
    const { agent } = currentAgent()
    const result = await agent.scanSources!()
    expect(result.initialized).toBe(true)
    expect(result.scan.status).toBe('completed')
    expect(result.scan.indexed).toBeGreaterThan(0)
    expect(await agent.search('', 0, 'sources')).toHaveProperty('total', 1)
    expect(leases).toBe(0)
  })
  for (const mode of ['files', 'folder'] as const) {
    test(`Given 用户选择 ${mode} When Agent 导入 Then 保留来源并完成扫描`, async () => {
      const source = join(configRoot, 'old-library')
      mkdirSync(source)
      writeFileSync(join(source, 'old.md'), '# 旧知识正文')
      registerKnowledgeImportSelector(async (requested) => { expect(requested).toBe(mode); return [mode === 'files' ? join(source, 'old.md') : source] })
      const { agent } = currentAgent()
      const result = await agent.importSources!(mode)
      expect(result.imported).toBe(1)
      expect(result.scan?.status).toBe('completed')
      expect((await agent.search('', 0, 'sources')).total).toBeGreaterThan(0)
      expect(leases).toBe(0)
    })
  }
  test('Given 取消原生选择 When Agent 导入 Then 不建库不扫描', async () => {
    registerKnowledgeImportSelector(async () => [])
    const { agent, service } = currentAgent()
    expect((await agent.importSources!('files')).cancelled).toBe(true)
    expect((await service.getSnapshot('w1')).initialized).toBe(false)
    expect(leases).toBe(0)
  })
  for (const change of ['permission', 'project', 'cancel', 'session'] as const) {
    test(`Given 选择期间发生 ${change} When 返回文件 Then 拒绝迟到导入`, async () => {
      const source = join(configRoot, 'old.md')
      writeFileSync(source, '# 旧库')
      registerKnowledgeImportSelector(async () => {
        if (change === 'permission') writable = false
        if (change === 'project') session = { ...session, workspaceId: 'other' }
        if (change === 'cancel') active = false
        if (change === 'session') session = { ...session, toolMode: 'server-ops-read' }
        return [source]
      })
      const { agent } = currentAgent()
      await expect(agent.importSources!('files')).rejects.toThrow()
      expect(leases).toBe(0)
    })
  }
  test('Given 计划模式 When 扫描或导入 Then 不执行选择器或初始化', async () => {
    let selected = false
    registerKnowledgeImportSelector(async () => { selected = true; return [] })
    const { agent, service } = currentAgent()
    writable = false
    await expect(agent.scanSources!()).rejects.toThrow('权限')
    await expect(agent.importSources!('folder')).rejects.toThrow('权限')
    expect(selected).toBe(false)
    expect((await service.getSnapshot('w1')).initialized).toBe(false)
  })
})


test('Given 扫描期间撤权 When 后台准备提交 Then 不发布来源且释放租约', async () => {
  writeFileSync(join(projectRoot, 'README.md'), '# 不应发布')
  registerProjectKnowledgeSources({
    list: async () => { writable = false; return { sources: [], total: 0, truncated: false, skipped: 0 } },
    read: async () => ({ status: 'unavailable', content: '', truncated: false }),
  })
  const { agent, service } = currentAgent()
  await expect(agent.scanSources!()).rejects.toThrow('权限')
  expect((await service.getSnapshot('w1')).totalEntries).toBe(0)
  expect(leases).toBe(0)
})

test('Given 单个工具取消 When 选择器返回 Then 不导入且不重新弹框', async () => {
  const controller = new AbortController()
  let calls = 0
  registerKnowledgeImportSelector(async () => { calls += 1; controller.abort(); return [join(configRoot, 'old.md')] })
  const { agent, service } = currentAgent()
  await expect(agent.importSources!('files', controller.signal)).rejects.toThrow()
  expect(calls).toBe(1)
  expect((await service.getSnapshot('w1')).initialized).toBe(false)
})

test('Given 来源工具预算耗尽 When 再次请求导入 Then 不打开选择器', async () => {
  let calls = 0
  registerKnowledgeImportSelector(async () => { calls += 1; return [] })
  const { agent } = currentAgent()
  for (let index = 0; index < 12; index += 1) await agent.importSources!('files')
  await expect(agent.importSources!('files')).rejects.toThrow('预算')
  expect(calls).toBe(12)
})


test('Given 面板已有扫描 When 等待它的 Agent 取消 Then 共享扫描仍完成', async () => {
  writeFileSync(join(projectRoot, 'README.md'), '# 面板扫描来源')
  let releaseScan!: () => void
  const waiting = new Promise<void>((resolve) => { releaseScan = resolve })
  registerProjectKnowledgeSources({
    list: async () => { await waiting; return { sources: [], total: 0, truncated: false, skipped: 0 } },
    read: async () => ({ status: 'unavailable', content: '', truncated: false }),
  })
  const { agent, service } = currentAgent()
  await service.startScan('w1')
  const controller = new AbortController()
  const attempt = agent.scanSources!(controller.signal).then(() => null, (error: unknown) => error)
  await new Promise<void>((resolve) => setImmediate(resolve))
  controller.abort()
  /** 未释放共享扫描前，Agent 自己的等待和写租约已结束。 */
  expect(await attempt).toBeInstanceOf(Error)
  expect(leases).toBe(1)
  releaseScan()
  await service.waitForScan('w1')
  const result = await service.getSnapshot('w1')
  expect(result.scan.status).toBe('completed')
  expect(result.totalEntries).toBeGreaterThan(0)
  expect(leases).toBe(0)
})

test('Given 非普通顶层会话 When 创建来源工具能力 Then 拒绝准入', () => {
  session = { ...session, toolMode: 'server-ops-read' }
  const service = getProjectKnowledgeService()
  expect(() => service.createAgentMaintenance({ sessionId: 's1', userMessageId: 'u1', assertRunActive: () => undefined, canMutate: () => true })).toThrow()
})


test('Given 原生选择器仍打开 When 工具取消 Then 立即退出等待并忽略迟到路径', async () => {
  let releaseDialog!: (paths: string[]) => void
  let opened!: () => void
  const ready = new Promise<void>((resolve) => { opened = resolve })
  registerKnowledgeImportSelector(async () => { opened(); return new Promise<string[]>((resolve) => { releaseDialog = resolve }) })
  const { agent, service } = currentAgent()
  const controller = new AbortController()
  const attempt = agent.importSources!('files', controller.signal).then(() => null, (error: unknown) => error)
  await ready
  controller.abort()
  expect(await attempt).toBeInstanceOf(Error)
  expect(leases).toBe(0)
  releaseDialog([join(configRoot, 'late.md')])
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect((await service.getSnapshot('w1')).initialized).toBe(false)
})

test('Given 导入时已有扫描 When 旧扫描完成 Then 新一轮扫描包含本次导入', async () => {
  const source = join(configRoot, 'old.md')
  writeFileSync(source, '# 新导入资料')
  let releaseScan!: () => void
  let began!: () => void
  let scans = 0
  const ready = new Promise<void>((resolve) => { began = resolve })
  const waiting = new Promise<void>((resolve) => { releaseScan = resolve })
  registerProjectKnowledgeSources({
    list: async () => { scans += 1; if (scans === 1) { began(); await waiting }; return { sources: [], total: 0, truncated: false, skipped: 0 } },
    read: async () => ({ status: 'unavailable', content: '', truncated: false }),
  })
  registerKnowledgeImportSelector(async () => [source])
  const { agent, service } = currentAgent()
  await service.startScan('w1')
  await ready
  const importing = agent.importSources!('files')
  /** 让导入异步 I/O 有机会完成，然后结束旧扫描；仍必须新扫一次。 */
  await new Promise<void>((resolve) => setTimeout(resolve, 30))
  releaseScan()
  const result = await importing
  expect(result.imported).toBe(1)
  expect(result.scan?.status).toBe('completed')
  expect(scans).toBe(2)
  expect((await agent.search('', 0, 'sources')).total).toBeGreaterThan(0)
})


test('Given 首次初始化等待写门禁时撤权 When 获得锁内权限 Then 不发布空清单', async () => {
  let allowed = true
  const project = { projectId: 'w1', projectRoot, memoryRoot: join(configRoot, 'memory'), cacheRoot: join(configRoot, 'cache') }
  const store = createProjectKnowledgeStore({ resolveProject: () => project, assertWritable: async () => { allowed = false } })
  await expect(store.initialize(project, 'w1', () => { if (!allowed) throw new Error('已撤权') })).rejects.toThrow('已撤权')
  expect(store.readManifest(project)).toBeNull()
})
