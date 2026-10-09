import type {
  ApiCatalog,
  ApiRequestDefinition,
  CanvasDocument,
  CanvasNode,
  CanvasSessionMeta,
  CanvasTarget,
  CanvasTextArtifactSnapshot,
  CanvasTextArtifactTarget,
  CanvasWorkspaceSnapshot,
  ListCanvasSessionsInput,
} from '@proma/shared'
import { containsKnowledgeSecret } from './project-knowledge/sensitive-text'

/** 单次最多返回的受控业务来源，避免 Canvas 或接口目录无界占用主进程。 */
export const PROJECT_KNOWLEDGE_CONTROLLED_SOURCE_LIMIT = 500
/** 单项进入知识索引或按需读取的 UTF-8 正文上限。 */
export const PROJECT_KNOWLEDGE_CONTROLLED_CONTENT_BYTES = 24 * 1024
/** 项目、Canvas、节点与接口使用的稳定业务 ID 规则。 */
const STABLE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/** Canvas 会话只开放按项目列举与双身份核验。 */
export interface ProjectKnowledgeCanvasSessions {
  list: (input: ListCanvasSessionsInput) => CanvasSessionMeta[]
  requireNative: (projectId: string, canvasId: string) => CanvasSessionMeta
}

/** Canvas 文档只开放无恢复副作用的稳定快照读取。 */
export interface ProjectKnowledgeCanvasDocuments {
  readSnapshot: (target: CanvasTarget) => CanvasWorkspaceSnapshot
}

/** 接口工作台只开放当前项目的脱敏目录读取。 */
export interface ProjectKnowledgeApiWorkbench {
  getCatalog: (projectId: string) => Promise<ApiCatalog>
}

/** Canvas 文本产物只开放不会触发恢复写入的知识读取方法。 */
export interface ProjectKnowledgeCanvasArtifacts {
  readForKnowledge: (target: CanvasTextArtifactTarget) => Promise<CanvasTextArtifactSnapshot>
}

/** 受控业务来源适配器的依赖，由主进程从已有服务实例注入。 */
export interface ProjectKnowledgeSourcesDependencies {
  canvasSessions: ProjectKnowledgeCanvasSessions
  canvasDocuments: ProjectKnowledgeCanvasDocuments
  canvasArtifacts?: ProjectKnowledgeCanvasArtifacts
  apiWorkbench: ProjectKnowledgeApiWorkbench
}

/** 可登记进项目知识库的业务来源快照。 */
export interface ProjectKnowledgeControlledSource {
  /** 原服务类型，同时用于构造 KnowledgeSource.kind。 */
  kind: 'canvas' | 'api'
  /** 适配器签发的稳定来源身份，不包含绝对路径。 */
  sourceId: string
  /** 用户可识别的来源标题。 */
  title: string
  /** 原服务当前权威 revision 组合。 */
  revision: string
  /** 只包含可公开结构的有界摘要。 */
  summary: string
  /** 可索引正文；Canvas 暂无纯读正文能力时固定为空。 */
  content: string
  /** 为真时只能用标题与摘要检索，不能伪装已经提取正文。 */
  metadataOnly: boolean
  /** 安全投影裁剪前的 UTF-8 字节数。 */
  byteSize: number
  /** 实际返回给索引的 UTF-8 字节数。 */
  indexedBytes: number
  /** 安全投影是否仍有未返回内容。 */
  truncated: boolean
  /** 原服务记录的最近更新时间。 */
  updatedAt: number
}

/** 有界来源目录及其覆盖事实。 */
export interface ProjectKnowledgeControlledSourceList {
  sources: ProjectKnowledgeControlledSource[]
  /** 适配器实际观察到的来源数量，可能大于返回上限。 */
  total: number
  /** 是否因来源数量预算省略了目录项。 */
  truncated: boolean
  /** 因权限、损坏或恢复阻断未能读取的来源数量。 */
  skipped: number
}

/** 按适配器来源身份读取时的固定输入。 */
export interface ProjectKnowledgeControlledSourceReadInput {
  projectId: string
  sourceId: string
  expectedRevision?: string
}

/** 读取结果明确区分当前、变化、删除与仅元数据。 */
export interface ProjectKnowledgeControlledSourceReadResult {
  status: 'readable' | 'changed' | 'unavailable' | 'metadata-only'
  source?: ProjectKnowledgeControlledSource
  content: string
  truncated: boolean
}

/** Canvas/API 受控来源统一入口。 */
export interface ProjectKnowledgeSources {
  list: (projectId: string) => Promise<ProjectKnowledgeControlledSourceList>
  read: (input: ProjectKnowledgeControlledSourceReadInput) => Promise<ProjectKnowledgeControlledSourceReadResult>
}

/** 校验只用于业务身份的稳定 ID，拒绝路径与分隔符。 */
function requireStableId(value: string, label: string): string {
  if (!STABLE_ID_PATTERN.test(value)) throw new Error(`${label}非法`)
  return value
}

/** 按 UTF-8 字符边界裁剪受控来源正文。 */
function truncateUtf8(content: string): { content: string; byteSize: number; truncated: boolean } {
  /** 裁剪前的安全投影字节。 */
  const bytes = Buffer.from(content, 'utf8')
  if (bytes.length <= PROJECT_KNOWLEDGE_CONTROLLED_CONTENT_BYTES) {
    return { content, byteSize: bytes.length, truncated: false }
  }
  for (
    let length = PROJECT_KNOWLEDGE_CONTROLLED_CONTENT_BYTES;
    length >= PROJECT_KNOWLEDGE_CONTROLLED_CONTENT_BYTES - 4;
    length -= 1
  ) {
    try {
      /** 当前候选必须能被严格解码，避免把半个字符写进索引。 */
      const truncated = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
      return { content: truncated, byteSize: bytes.length, truncated: true }
    } catch {
      // 继续回退到完整 UTF-8 字符边界。
    }
  }
  return { content: '', byteSize: bytes.length, truncated: true }
}

/** 返回 Canvas 节点可公开的内容 revision；无正文版本时使用图 revision。 */
function canvasNodeRevision(document: CanvasDocument, node: CanvasNode): string {
  /** 文档和 WebView 拥有真实正文 revision。 */
  const contentRevision = node.kind === 'document' || node.kind === 'webview'
    ? node.contentRevision
    : document.revision
  return `canvas:${document.revision}:content:${contentRevision}`
}

/** 从已核验 Canvas 图构造不含正文的来源头。 */
function projectCanvasNode(
  session: CanvasSessionMeta,
  document: CanvasDocument,
  node: CanvasNode,
): ProjectKnowledgeControlledSource {
  /** 节点类别的用户可读标签。 */
  const kindLabel: Record<CanvasNode['kind'], string> = {
    agent: 'Agent', image: '图片', audio: '音频', video: '视频', document: '文档', webview: '交互原型',
  }
  return {
    kind: 'canvas',
    sourceId: `canvas:${session.id}:${node.id}`,
    title: node.title,
    revision: canvasNodeRevision(document, node),
    summary: `Canvas「${session.title}」中的${kindLabel[node.kind]}节点`,
    content: '',
    metadataOnly: true,
    byteSize: 0,
    indexedBytes: 0,
    truncated: false,
    updatedAt: session.updatedAt,
  }
}

/** 从文本节点构造受控正文目标；其它节点没有文本 revision。 */
function canvasTextTarget(
  projectId: string,
  canvasId: string,
  node: CanvasNode,
): CanvasTextArtifactTarget | null {
  if (node.kind === 'document') {
    return {
      projectId, canvasId, nodeId: node.id, kind: node.kind,
      contentId: node.documentId, contentRevision: node.contentRevision,
    }
  }
  if (node.kind === 'webview') {
    return {
      projectId, canvasId, nodeId: node.id, kind: node.kind,
      contentId: node.prototypeId, contentRevision: node.contentRevision,
    }
  }
  return null
}

/** 将纯读正文加入 Canvas 来源；秘密或零版本继续保持仅元数据。 */
async function attachCanvasText(
  dependencies: ProjectKnowledgeSourcesDependencies,
  source: ProjectKnowledgeControlledSource,
  target: CanvasTextArtifactTarget | null,
): Promise<ProjectKnowledgeControlledSource> {
  if (!target || target.contentRevision < 1 || !dependencies.canvasArtifacts) return source
  /** 精确 revision 的纯读正文快照。 */
  const artifact = await dependencies.canvasArtifacts.readForKnowledge(target)
  if (containsKnowledgeSecret(artifact.content)) return source
  /** Canvas 正文与接口投影共用单项 24 KiB 预算。 */
  const projected = truncateUtf8(artifact.content)
  return {
    ...source,
    content: projected.content,
    metadataOnly: false,
    byteSize: projected.byteSize,
    indexedBytes: Buffer.byteLength(projected.content, 'utf8'),
    truncated: projected.truncated,
  }
}

/** 知识库只保留业务说明和稳定入口，完整参数文档归接口工作台。 */
function projectApiRequest(catalog: ApiCatalog, request: ApiRequestDefinition): ProjectKnowledgeControlledSource {
  /** 描述可能被用户误填凭据；命中秘密规则时整个字段不进入投影。 */
  const description = containsKnowledgeSecret(request.description) ? '' : request.description.trim()
  /** 项目内稳定业务引用供宿主定位，不冒充可在系统浏览器打开的 URL。 */
  const lines = [
    `# ${request.name}`,
    description ? `说明：${description}` : '',
    `接口工作台引用：api:${request.id}`,
    '参数、请求体与接口文档请在当前项目的接口工作台查看。',
  ].filter(Boolean)
  /** 应用统一单项预算后的投影正文。 */
  const projected = truncateUtf8(lines.join('\n'))
  return {
    kind: 'api',
    sourceId: `api:${request.id}`,
    title: request.name,
    revision: `catalog:${catalog.revision}:request:${request.revision}`,
    summary: description || '接口工作台业务入口',
    content: projected.content,
    metadataOnly: false,
    byteSize: projected.byteSize,
    indexedBytes: Buffer.byteLength(projected.content, 'utf8'),
    truncated: projected.truncated,
    updatedAt: request.updatedAt,
  }
}

/** 解析 Canvas 来源身份，不接受路径或额外片段。 */
function parseCanvasSourceId(sourceId: string): { canvasId: string; nodeId: string } | null {
  /** 来源身份固定为三个片段。 */
  const parts = sourceId.split(':')
  if (parts.length !== 3 || parts[0] !== 'canvas') return null
  try {
    return { canvasId: requireStableId(parts[1] ?? '', 'Canvas ID'), nodeId: requireStableId(parts[2] ?? '', '节点 ID') }
  } catch {
    return null
  }
}

/** 解析接口来源身份，不接受路径或额外片段。 */
function parseApiSourceId(sourceId: string): { requestId: string } | null {
  /** 来源身份固定为两个片段。 */
  const parts = sourceId.split(':')
  if (parts.length !== 2 || parts[0] !== 'api') return null
  try {
    return { requestId: requireStableId(parts[1] ?? '', '接口 ID') }
  } catch {
    return null
  }
}

/** 创建不扫描内部目录、只调用原服务纯读 API 的知识来源适配器。 */
export function createProjectKnowledgeSources(
  dependencies: ProjectKnowledgeSourcesDependencies,
): ProjectKnowledgeSources {
  /** 列出当前项目的 Canvas 节点，单个损坏画布不阻断其它来源。 */
  async function listCanvas(projectId: string): Promise<{
    sources: ProjectKnowledgeControlledSource[]
    total: number
    skipped: number
  }> {
    /** 当前项目未归档的会话。 */
    const sessions = dependencies.canvasSessions.list({ projectId, archived: false })
    /** 当前已投影 Canvas 来源。 */
    const candidates: Array<{
      source: ProjectKnowledgeControlledSource
      target: CanvasTextArtifactTarget | null
    }> = []
    /** 实际观察到的节点总数。 */
    let total = 0
    /** 无法纯读的 Canvas 数量。 */
    let skipped = 0
    for (const session of sessions) {
      try {
        /** 双身份核验拒绝 legacy 或跨项目会话。 */
        const authorized = dependencies.canvasSessions.requireNative(projectId, session.id)
        /** readSnapshot 在需要恢复时明确失败，不产生隐式写入。 */
        const document = dependencies.canvasDocuments.readSnapshot({ projectId, canvasId: authorized.id }).document
        total += document.nodes.length
        for (const node of document.nodes) {
          if (candidates.length < PROJECT_KNOWLEDGE_CONTROLLED_SOURCE_LIMIT) {
            candidates.push({
              source: projectCanvasNode(authorized, document, node),
              target: canvasTextTarget(projectId, authorized.id, node),
            })
          }
        }
      } catch {
        skipped += 1
      }
    }
    /** 正文读取最多八并发，避免大量 Canvas 同时打开受管 revision 文件。 */
    const sources: ProjectKnowledgeControlledSource[] = []
    for (let offset = 0; offset < candidates.length; offset += 8) {
      /** 当前有限并发批次。 */
      const batch = candidates.slice(offset, offset + 8)
      /** 单个正文失败时保留诚实的 metadata-only 来源。 */
      const projected = await Promise.all(batch.map(async (candidate) => {
        try {
          return await attachCanvasText(dependencies, candidate.source, candidate.target)
        } catch {
          skipped += 1
          return candidate.source
        }
      }))
      sources.push(...projected)
    }
    return { sources, total, skipped }
  }

  /** 列出当前项目接口定义的安全结构投影。 */
  async function listApi(projectId: string): Promise<{ sources: ProjectKnowledgeControlledSource[]; total: number; skipped: number }> {
    try {
      /** 原服务按项目身份返回权威目录，不接受路径。 */
      const catalog = await dependencies.apiWorkbench.getCatalog(projectId)
      return {
        sources: catalog.requests.slice(0, PROJECT_KNOWLEDGE_CONTROLLED_SOURCE_LIMIT)
          .map((request) => projectApiRequest(catalog, request)),
        total: catalog.requests.length,
        skipped: 0,
      }
    } catch {
      return { sources: [], total: 0, skipped: 1 }
    }
  }

  /** 返回版本变化结果，不把当前正文冒充调用方请求的旧版本。 */
  function finalizeRead(
    source: ProjectKnowledgeControlledSource,
    expectedRevision?: string,
  ): ProjectKnowledgeControlledSourceReadResult {
    if (expectedRevision !== undefined && expectedRevision !== source.revision) {
      return { status: 'changed', source, content: '', truncated: false }
    }
    return {
      status: source.metadataOnly ? 'metadata-only' : 'readable',
      source,
      content: source.content,
      truncated: source.truncated,
    }
  }

  return {
    async list(projectId) {
      requireStableId(projectId, '项目 ID')
      /** 两种服务读取相互独立，同时等待以缩短前台扫描时间。 */
      const [canvas, api] = await Promise.all([listCanvas(projectId), listApi(projectId)])
      /** 稳定排序后施加统一总量预算，避免服务顺序决定长期索引结果。 */
      const combined = [...canvas.sources, ...api.sources]
        .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
      /** 两服务实际观察到的来源总数。 */
      const total = canvas.total + api.total
      return {
        sources: combined.slice(0, PROJECT_KNOWLEDGE_CONTROLLED_SOURCE_LIMIT),
        total,
        truncated: total > PROJECT_KNOWLEDGE_CONTROLLED_SOURCE_LIMIT,
        skipped: canvas.skipped + api.skipped,
      }
    },

    async read(input) {
      requireStableId(input.projectId, '项目 ID')
      /** Canvas 来源只能用双身份回到当前项目的权威图。 */
      const canvasIdentity = parseCanvasSourceId(input.sourceId)
      if (canvasIdentity) {
        try {
          const session = dependencies.canvasSessions.requireNative(input.projectId, canvasIdentity.canvasId)
          const document = dependencies.canvasDocuments.readSnapshot({
            projectId: input.projectId,
            canvasId: canvasIdentity.canvasId,
          }).document
          /** 节点必须仍存在于当前权威图。 */
          const node = document.nodes.find((candidate) => candidate.id === canvasIdentity.nodeId)
          if (!node) return { status: 'unavailable', content: '', truncated: false }
          /** 先核验图和节点 revision，旧版本不得退回当前正文。 */
          const source = projectCanvasNode(session, document, node)
          if (input.expectedRevision !== undefined && input.expectedRevision !== source.revision) {
            return { status: 'changed', source, content: '', truncated: false }
          }
          /** 非文本节点及 revision 0 没有可纯读正文。 */
          const target = canvasTextTarget(input.projectId, canvasIdentity.canvasId, node)
          if (!target || target.contentRevision < 1 || !dependencies.canvasArtifacts) {
            return finalizeRead(source, input.expectedRevision)
          }
          try {
            /** 纯读正文失败时明确不可用，不把空串冒充正文。 */
            const enriched = await attachCanvasText(dependencies, source, target)
            return finalizeRead(enriched, input.expectedRevision)
          } catch {
            return { status: 'unavailable', source, content: '', truncated: false }
          }
        } catch {
          return { status: 'unavailable', content: '', truncated: false }
        }
      }

      /** API 来源每次 fresh-read 当前项目目录并核验请求身份和组合 revision。 */
      const apiIdentity = parseApiSourceId(input.sourceId)
      if (apiIdentity) {
        try {
          const catalog = await dependencies.apiWorkbench.getCatalog(input.projectId)
          /** 已删除请求不得回退到目录中的其它定义。 */
          const request = catalog.requests.find((candidate) => candidate.id === apiIdentity.requestId)
          if (!request) return { status: 'unavailable', content: '', truncated: false }
          return finalizeRead(projectApiRequest(catalog, request), input.expectedRevision)
        } catch {
          return { status: 'unavailable', content: '', truncated: false }
        }
      }

      return { status: 'unavailable', content: '', truncated: false }
    },
  }
}
