import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
    return userEvidence ? { sessionId: id, status: 'written' } : undefined
  },
  readPersistedAgentEvidence: (id: string) => ({ sessionId: id, records: userEvidence ? [userEvidence] : [], truncated: false, skipped: 0 }),
}))

const { getProjectKnowledgeService, recoverProjectKnowledge, getProjectKnowledgeBinding } = await import('./project-knowledge-runtime')
const { createProjectKnowledgeAgent } = await import('./project-knowledge-agent')

beforeEach(() => {
  configRoot = mkdtempSync(join(tmpdir(), 'knowledge-runtime-agent-'))
  projectRoot = join(configRoot, 'project')
  mkdirSync(projectRoot)
  session = { id: 's1', title: '项目对话', workspaceId: 'w1', createdAt: 1, updatedAt: 1 }
  deleting = false; active = true; writable = true; leases = 0; receiptLookups = []
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
})
