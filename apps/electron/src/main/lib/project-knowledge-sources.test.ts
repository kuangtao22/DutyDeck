import { describe, expect, test } from 'bun:test'
import { createApiRequestDraft, createEmptyCanvasDocument } from '@proma/shared'
import type { ApiCatalog, CanvasDocument, CanvasSessionMeta } from '@proma/shared'
import {
  createProjectKnowledgeSources,
  PROJECT_KNOWLEDGE_CONTROLLED_CONTENT_BYTES,
  PROJECT_KNOWLEDGE_CONTROLLED_SOURCE_LIMIT,
} from './project-knowledge-sources'

/** 构造只含当前测试节点的 Canvas 文档。 */
function createCanvasDocument(projectId: string, canvasId: string, revision: number): CanvasDocument {
  return {
    ...createEmptyCanvasDocument(projectId, canvasId, 1),
    revision,
    nodes: [{
      id: 'node-doc',
      kind: 'document',
      title: '登录交互说明',
      position: { x: 0, y: 0 },
      documentId: 'document-login',
      contentRevision: 3,
    }],
  }
}

/** 构造包含敏感请求值的接口目录，适配器只应读取结构。 */
function createCatalog(revision = 7, requestRevision = 2): ApiCatalog {
  return {
    version: 1,
    revision,
    collections: [],
    environments: [{
      id: 'env-prod',
      name: '生产',
      kind: 'production',
      variables: [{ id: 'token', name: 'TOKEN', enabled: true, value: 'environment-secret' }],
    }],
    requests: [{
      ...createApiRequestDraft(),
      id: 'request-login',
      revision: requestRevision,
      updatedAt: 50,
      name: '登录接口',
      description: '签发登录令牌',
      method: 'POST',
      url: 'https://secret.example.test/login?token=url-secret',
      query: [{ id: 'tenant', name: 'tenantId', enabled: true, value: 'query-secret' }],
      headers: [{ id: 'authorization', name: 'Authorization', enabled: true, value: 'header-secret' }],
      body: {
        kind: 'multipart',
        text: 'body-secret',
        fields: [{ id: 'username', name: 'username', enabled: true, value: 'body-field-secret' }],
        files: [{ id: 'avatar', name: 'avatar', fileName: 'private.png', sizeBytes: 12, ref: 'file-secret' }],
      },
      auth: { type: 'bearer', value: { value: 'auth-secret' } },
    }],
    workspaceVariables: [{ id: 'global', name: 'GLOBAL_TOKEN', enabled: true, value: 'workspace-secret' }],
    cryptoProfiles: [{
      id: 'crypto',
      name: '签名',
      description: '不得进入知识库',
      scope: 'workspace',
      appliesTo: 'all',
      requestSteps: [{ id: 'sign', kind: 'sign', enabled: true, algo: 'hmac-sha256', keyRef: 'PRIVATE_KEY' }],
      responseSteps: [],
      revision: 1,
      updatedAt: 1,
    }],
  }
}

describe('项目知识库受控业务来源适配器', () => {
  test('Given Canvas 与 API 属于当前项目 When 列出来源 Then Canvas 诚实标为仅元数据且 API 只保留业务说明和工作台入口', async () => {
    /** 当前项目的 Canvas 会话。 */
    const session: CanvasSessionMeta = {
      id: 'canvas-main', projectId: 'project-1', title: '登录设计', archived: false, createdAt: 1, updatedAt: 10,
    }
    /** 当前 Canvas 图文档。 */
    const document = createCanvasDocument('project-1', session.id, 5)
    /** 带完整秘密字段的接口目录。 */
    const catalog = createCatalog()
    /** 使用窄服务替身验证适配器只调用纯读方法。 */
    const sources = createProjectKnowledgeSources({
      canvasSessions: {
        list: ({ projectId }) => projectId === 'project-1' ? [session] : [],
        requireNative: (projectId, canvasId) => {
          if (projectId !== session.projectId || canvasId !== session.id) throw new Error('Canvas 会话不存在')
          return session
        },
      },
      canvasDocuments: {
        readSnapshot: (target) => {
          if (target.projectId !== 'project-1' || target.canvasId !== session.id) throw new Error('Canvas 不存在')
          return { document, writable: true, nodeIssues: [] }
        },
      },
      apiWorkbench: { getCatalog: async (projectId) => projectId === 'project-1' ? catalog : createCatalog(0, 0) },
    })

    /** 当前项目的所有受控来源。 */
    const result = await sources.list('project-1')
    /** Canvas 节点只能进行元数据索引。 */
    const canvas = result.sources.find((source) => source.kind === 'canvas')
    /** API 请求可以读取脱敏后的结构正文。 */
    const api = result.sources.find((source) => source.kind === 'api')
    /** API 安全投影的完整序列化，用于排除所有秘密值。 */
    const serialized = JSON.stringify(api)

    expect(canvas).toMatchObject({
      sourceId: 'canvas:canvas-main:node-doc',
      title: '登录交互说明',
      metadataOnly: true,
      content: '',
    })
    expect(api).toMatchObject({
      sourceId: 'api:request-login',
      title: '登录接口',
      metadataOnly: false,
    })
    expect(api?.content).toContain('签发登录令牌')
    expect(api?.content).toContain('接口工作台引用：api:request-login')
    expect(api?.content).not.toContain('tenantId')
    expect(api?.content).not.toContain('Authorization')
    expect(api?.content).not.toContain('username')
    for (const secret of [
      'secret.example.test', 'url-secret', 'query-secret', 'header-secret', 'body-secret',
      'body-field-secret', 'private.png', 'file-secret', 'auth-secret', 'environment-secret',
      'workspace-secret', 'PRIVATE_KEY',
    ]) expect(serialized).not.toContain(secret)
  })

  test('Given 来源属于另一个项目 When 当前项目列出或读取 Then 不跨项目返回内容', async () => {
    /** 记录每次服务接收的项目 ID，证明调用方不能替换为其他路径。 */
    const requestedProjects: string[] = []
    /** 只为另一个项目返回资料的服务替身。 */
    const sources = createProjectKnowledgeSources({
      canvasSessions: {
        list: ({ projectId }) => {
          requestedProjects.push(projectId)
          return []
        },
        requireNative: (projectId) => {
          requestedProjects.push(projectId)
          throw new Error('Canvas 会话不存在')
        },
      },
      canvasDocuments: { readSnapshot: () => { throw new Error('不应读取') } },
      apiWorkbench: {
        getCatalog: async (projectId) => {
          requestedProjects.push(projectId)
          return projectId === 'project-2' ? createCatalog() : { ...createCatalog(0, 0), requests: [] }
        },
      },
    })

    expect((await sources.list('project-1')).sources).toEqual([])
    await expect(sources.read({ projectId: 'project-1', sourceId: 'api:request-login' }))
      .resolves.toEqual({ status: 'unavailable', content: '', truncated: false })
    await expect(sources.read({ projectId: 'project-1', sourceId: 'canvas:canvas-main:node-doc' }))
      .resolves.toEqual({ status: 'unavailable', content: '', truncated: false })
    expect(requestedProjects.every((projectId) => projectId === 'project-1')).toBe(true)
  })

  test('Given API 来源版本已变化或删除 When 按旧版本读取 Then 返回变化或不可用且不冒充旧正文', async () => {
    /** 可在测试中推进或删除请求的当前目录。 */
    let catalog = createCatalog()
    /** 只包含 API 来源的适配器。 */
    const sources = createProjectKnowledgeSources({
      canvasSessions: { list: () => [], requireNative: () => { throw new Error('Canvas 会话不存在') } },
      canvasDocuments: { readSnapshot: () => { throw new Error('Canvas 不存在') } },
      apiWorkbench: { getCatalog: async () => catalog },
    })
    /** 首次列出的不可变来源版本。 */
    const original = (await sources.list('project-1')).sources[0]
    if (!original) throw new Error('测试来源缺失')

    catalog = createCatalog(8, 3)
    expect(await sources.read({
      projectId: 'project-1', sourceId: original.sourceId, expectedRevision: original.revision,
    })).toMatchObject({ status: 'changed', content: '' })

    catalog = { ...catalog, revision: 9, requests: [] }
    expect(await sources.read({
      projectId: 'project-1', sourceId: original.sourceId, expectedRevision: original.revision,
    })).toEqual({ status: 'unavailable', content: '', truncated: false })
  })

  test('Given Canvas 节点仍存在 When 读取当前或旧版本 Then 当前返回仅元数据、旧版返回变化', async () => {
    /** 当前 Canvas 会话元数据。 */
    const session: CanvasSessionMeta = {
      id: 'canvas-main', projectId: 'project-1', title: '主画布', archived: false, createdAt: 1, updatedAt: 2,
    }
    /** 可推进 revision 的当前文档。 */
    let document = createCanvasDocument('project-1', session.id, 5)
    /** 使用真实图类型的纯读替身。 */
    const sources = createProjectKnowledgeSources({
      canvasSessions: {
        list: () => [session],
        requireNative: (projectId, canvasId) => {
          if (projectId !== session.projectId || canvasId !== session.id) throw new Error('Canvas 会话不存在')
          return session
        },
      },
      canvasDocuments: { readSnapshot: () => ({ document, writable: true, nodeIssues: [] }) },
      apiWorkbench: { getCatalog: async () => ({ ...createCatalog(0, 0), requests: [] }) },
    })
    /** 第一次登记的 Canvas 节点版本。 */
    const original = (await sources.list('project-1')).sources[0]
    if (!original) throw new Error('测试来源缺失')

    expect(await sources.read({ projectId: 'project-1', sourceId: original.sourceId }))
      .toMatchObject({ status: 'metadata-only', source: { revision: original.revision }, content: '' })
    document = { ...document, revision: 6 }
    expect(await sources.read({
      projectId: 'project-1', sourceId: original.sourceId, expectedRevision: original.revision,
    })).toMatchObject({ status: 'changed', content: '' })
  })

  test('Given Canvas 文档正文可纯读 When 列出和读取 Then 索引精确 revision 正文且不再标记仅元数据', async () => {
    /** 当前 Canvas 会话元数据。 */
    const session: CanvasSessionMeta = {
      id: 'canvas-main', projectId: 'project-1', title: '主画布', archived: false, createdAt: 1, updatedAt: 2,
    }
    /** 当前图采用文档正文 revision 3。 */
    const document = createCanvasDocument('project-1', session.id, 5)
    /** 记录知识适配器请求的精确正文目标。 */
    const artifactTargets: string[] = []
    /** 注入只读 Canvas 正文能力的来源适配器。 */
    const sources = createProjectKnowledgeSources({
      canvasSessions: {
        list: () => [session],
        requireNative: () => session,
      },
      canvasDocuments: { readSnapshot: () => ({ document, writable: true, nodeIssues: [] }) },
      canvasArtifacts: {
        readForKnowledge: async (target) => {
          artifactTargets.push(`${target.kind}:${target.contentId}:${target.contentRevision}`)
          return {
            target,
            revision: {
              kind: target.kind, contentId: target.contentId, revision: target.contentRevision,
              parentRevision: 2, contentHash: 'a'.repeat(64), createdBy: { type: 'user' }, createdAt: 1,
            },
            content: '# 登录流程\n使用一次性验证码完成登录。',
          }
        },
      },
      apiWorkbench: { getCatalog: async () => ({ ...createCatalog(0, 0), requests: [] }) },
    })

    /** 扫描阶段取得的 Canvas 正文来源。 */
    const source = (await sources.list('project-1')).sources[0]
    if (!source) throw new Error('测试来源缺失')
    /** 按来源当前版本再次读取的结果。 */
    const read = await sources.read({
      projectId: 'project-1', sourceId: source.sourceId, expectedRevision: source.revision,
    })

    expect(source).toMatchObject({ metadataOnly: false, content: '# 登录流程\n使用一次性验证码完成登录。' })
    expect(read).toMatchObject({ status: 'readable', content: '# 登录流程\n使用一次性验证码完成登录。' })
    expect(artifactTargets).toEqual(['document:document-login:3', 'document:document-login:3'])
  })

  test('Given 来源和说明超过预算 When 列出目录 Then 总数与正文都被有界裁剪并明确标记', async () => {
    /** 生成超过目录预算的一组接口定义。 */
    const requests = Array.from({ length: PROJECT_KNOWLEDGE_CONTROLLED_SOURCE_LIMIT + 1 }, (_, index) => ({
      ...createCatalog().requests[0]!,
      id: `request-${String(index).padStart(3, '0')}`,
      name: `接口 ${index}`,
      description: index === 0 ? '很长的公开说明。'.repeat(4_000) : '',
    }))
    /** 返回超量安全目录的适配器。 */
    const sources = createProjectKnowledgeSources({
      canvasSessions: { list: () => [], requireNative: () => { throw new Error('Canvas 会话不存在') } },
      canvasDocuments: { readSnapshot: () => { throw new Error('Canvas 不存在') } },
      apiWorkbench: { getCatalog: async () => ({ ...createCatalog(), requests }) },
    })

    /** 应用统一来源和单项正文预算后的结果。 */
    const result = await sources.list('project-1')
    /** 超长说明对应的第一项。 */
    const oversized = result.sources.find((source) => source.sourceId === 'api:request-000')

    expect(result.sources).toHaveLength(PROJECT_KNOWLEDGE_CONTROLLED_SOURCE_LIMIT)
    expect(result.total).toBe(PROJECT_KNOWLEDGE_CONTROLLED_SOURCE_LIMIT + 1)
    expect(result.truncated).toBe(true)
    expect(oversized?.truncated).toBe(true)
    expect(Buffer.byteLength(oversized?.content ?? '', 'utf8'))
      .toBeLessThanOrEqual(PROJECT_KNOWLEDGE_CONTROLLED_CONTENT_BYTES)
  })
})
