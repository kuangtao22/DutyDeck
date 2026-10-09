import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKnowledgeMaintenance } from './project-knowledge-maintenance'
import { createProjectKnowledgeService } from './project-knowledge/service'
import { createProjectKnowledgeAgent } from './project-knowledge-agent'
import type { KnowledgeSourceMaterial } from './project-knowledge-source-distillation'

/** 每个完整链路测试的独立文件根，退出后清理。 */
const fixtureRoots: string[] = []
afterEach(() => { for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('真实项目文件到提炼知识闭环', () => {
  test('Given 真实文档和代码 When 扫描并启用提炼 Then 新对话读取带原文依据的知识且源变更重新提炼', async () => {
    /** 与用户项目完全隔离的临时目录。 */
    const root = mkdtempSync(join(tmpdir(), 'knowledge-distillation-integration-'))
    fixtureRoots.push(root)
    /** 真实可信项目、记忆与缓存边界。 */
    const project = { projectId: 'project-1', projectRoot: join(root, 'project'), memoryRoot: join(root, 'memory'), cacheRoot: join(root, 'cache') }
    mkdirSync(project.projectRoot)
    mkdirSync(project.memoryRoot)
    mkdirSync(join(project.projectRoot, 'docs'))
    writeFileSync(join(project.projectRoot, 'docs/product.md'), '# 退款规则\n退款时必须核对订单状态。')
    writeFileSync(join(project.projectRoot, 'core.mjs'), 'export const internalCodeOnly = 1')
    /** 存储、扫描、分页读取和索引均使用真实实现。 */
    const service = createProjectKnowledgeService({ resolveProject: () => project })
    await service.startScan(project.projectId)
    await service.waitForScan(project.projectId)
    expect((await service.search({ workspaceId: project.projectId, query: '', scope: 'knowledge' })).items).toHaveLength(0)
    /** 只替代远端模型调用，引用来自真实模型输入，不预造来源版本。 */
    let modelCalls = 0
    const maintenance = createKnowledgeMaintenance({
      store: service.store,
      resolveProject: () => project,
      getSession: () => undefined,
      readEvidence: () => ({ sessionId: '', records: [], truncated: false, skipped: 0 }),
      readSource: async (workspaceId, ref) => {
        /** 与真实运行时相同的受控服务读取。 */
        const result = await service.read({ workspaceId, entryId: ref.entryId, expectedRevision: ref.revision })
        return result.status === 'readable' ? { ref, content: result.content, truncated: result.truncated } : null
      },
      validateModel: () => undefined,
      callModel: async ({ prompt }) => {
        modelCalls += 1
        expect(prompt).not.toContain('internalCodeOnly')
        /** 从模型协议中的实际材料取得来源身份。 */
        const materials = JSON.parse(prompt.split('来源资料：')[1]!) as KnowledgeSourceMaterial[]
        const material = materials.find((item) => item.content.includes('退款时必须核对订单状态。'))!
        return JSON.stringify({ candidates: [{
          title: '退款的前置检查', content: '处理退款前应核对订单状态。', category: 'business', kind: 'rule',
          evidence: [{ entryId: material.ref.entryId, revision: material.ref.revision, quote: '退款时必须核对订单状态。' }],
        }] })
      },
    })
    await maintenance.updateSettings({ workspaceId: project.projectId, enabled: true, channelId: 'fixture', modelId: 'deterministic', dailyJobLimit: 10 })
    await maintenance.wait(project.projectId)
    /** 默认知识结果只有提炼内容，原代码仍在来源目录可按需查找。 */
    const knowledge = await service.search({ workspaceId: project.projectId, query: '退款', scope: 'knowledge' })
    expect(knowledge.total).toBe(1)
    expect(knowledge.items[0]?.entry).toMatchObject({ state: 'draft', source: { kind: 'managed' } })
    expect(knowledge.items[0]?.entry.evidence).toHaveLength(1)
    const entry = knowledge.items[0]!.entry
    expect((await service.read({ workspaceId: project.projectId, entryId: entry.id })).content).toContain('核对订单状态')
    expect((await service.search({ workspaceId: project.projectId, query: '', scope: 'sources' })).total).toBe(2)
    /** 新普通会话只获取提炼知识片段和有界引用。 */
    const agent = createProjectKnowledgeAgent({
      sessionId: 'new-session', toolMode: 'standard', getBinding: () => project.projectRoot,
      getSession: () => ({ id: 'new-session', workspaceId: project.projectId, title: '新会话', createdAt: 1, updatedAt: 1 }),
      assertRunActive: () => undefined, service,
    })!
    const context = await agent.buildContext('退款有哪些规则')
    expect(context).toContain('处理退款前应核对订单状态')
    expect(context).not.toContain('internalCodeOnly')
    await maintenance.enqueueSources(project.projectId)
    await maintenance.wait(project.projectId)
    expect(modelCalls).toBe(1)
    /** 不改变结论的来源更新也必须刷新证据版本，不能因内容去重永久失效。 */
    writeFileSync(join(project.projectRoot, 'docs/product.md'), '# 退款规则\n退款时必须核对订单状态。\n新增说明：业务联系人由项目方维护。')
    expect((await service.read({ workspaceId: project.projectId, entryId: entry.id })).status).toBe('changed')
    await service.startScan(project.projectId)
    await service.waitForScan(project.projectId)
    await maintenance.enqueueSources(project.projectId)
    await maintenance.wait(project.projectId)
    expect(modelCalls).toBe(2)
    expect((await service.read({ workspaceId: project.projectId, entryId: entry.id })).status).toBe('readable')
    expect((await service.search({ workspaceId: project.projectId, query: '退款', scope: 'knowledge' })).total).toBe(1)
  })
})
