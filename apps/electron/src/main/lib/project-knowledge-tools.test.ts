import { describe, expect, test } from 'bun:test'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ProjectKnowledgeAgent } from './project-knowledge-agent'
import { buildProjectKnowledgeTools } from './project-knowledge-tools'

/** 只保留工具注册测试需要的 Pi SDK 表面。 */
function sdkFixture(): Parameters<typeof buildProjectKnowledgeTools>[0] {
  return {
    defineTool: (definition: ToolDefinition) => definition,
  } as unknown as Parameters<typeof buildProjectKnowledgeTools>[0]
}

/** 构造不访问真实项目文件的知识 facade。 */
function knowledgeFixture(): ProjectKnowledgeAgent {
  return {
    search: async () => ({ revision: 1, items: [], total: 0, indexStatus: 'ready' }),
    read: async (entryId) => ({
      entry: {
        id: entryId, revision: 'a'.repeat(64), title: '测试', category: 'overview', kind: 'fact',
        state: 'draft', freshness: 'current', summary: '测试', source: { kind: 'managed', id: 'b'.repeat(64), revision: 'c'.repeat(64) },
        byteSize: 0, indexedBytes: 0, truncated: false, metadataOnly: false, updatedAt: 1,
      },
      content: '', status: 'readable', offset: 0, truncated: false,
    }),
    buildContext: async () => '',
  }
}

describe('Agent 项目知识工具注册', () => {
  test('Given 只有只读知识能力 When 注册工具 Then 不暴露维护写入入口', () => {
    const tools = buildProjectKnowledgeTools(sdkFixture(), knowledgeFixture())
    expect(tools.map((tool) => tool.name)).toEqual(['proma_knowledge_search', 'proma_knowledge_read'])
  })

  test('Given 当前回合具备维护能力 When 注册工具 Then 追加小批来源与受控提交入口', () => {
    const knowledge = knowledgeFixture()
    knowledge.nextMaintenanceSources = async () => ({ refs: [], remaining: 0 })
    knowledge.submitMaintenance = async () => ({
      status: 'unchanged', published: 0, refreshed: 0, skipped: 0, processedSources: 0, entryIds: [],
    })

    const tools = buildProjectKnowledgeTools(sdkFixture(), knowledge)

    expect(tools.map((tool) => tool.name)).toEqual([
      'proma_knowledge_search', 'proma_knowledge_read', 'proma_knowledge_maintenance_next', 'proma_knowledge_submit',
    ])
  })

  test('Given production启用两步流程 When 注册工具 Then 只暴露计划大纲文档状态且模型不能确认或指定workspace', () => {
    const knowledge = knowledgeFixture()
    knowledge.getWorkflowStatus = async () => ({
      initialized: true, revision: 1, paused: false, offset: 0,
    })
    knowledge.proposeKnowledgePlan = async () => knowledge.getWorkflowStatus!()
    knowledge.saveKnowledgeOutline = async () => knowledge.getWorkflowStatus!()
    knowledge.writeKnowledgeDocument = async () => knowledge.getWorkflowStatus!()
    knowledge.copyKnowledgeAsset = async (input) => ({
      relativePath: input.relativePath, documentRelativePath: `../${input.relativePath}`,
      contentRevision: 'asset-revision', byteSize: 2 * 1024 * 1024,
    })

    const tools = buildProjectKnowledgeTools(sdkFixture(), knowledge)
    const names = tools.map((tool) => tool.name)

    expect(names).toEqual([
      'proma_knowledge_search', 'proma_knowledge_read', 'proma_knowledge_status',
      'proma_knowledge_plan', 'proma_knowledge_outline', 'proma_knowledge_document', 'proma_knowledge_asset',
    ])
    expect(names.some((name) => name.includes('confirm'))).toBe(false)
    const schemas = tools.slice(2).map((tool) => JSON.stringify(tool.parameters))
    expect(schemas.every((schema) => !schema.includes('workspaceId'))).toBe(true)
    expect(schemas.join('\n')).not.toContain('overview","planning","business')
  })
})
