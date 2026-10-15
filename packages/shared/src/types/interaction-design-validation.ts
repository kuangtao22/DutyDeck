import type { InteractionDesignCommand, InteractionDesignInputs, InteractionDesignMethod, PrototypeDraft } from './interaction-design'

/** 页面数量与正文预算避免不可信 IPC 触发无界复制。 */
export const PROTOTYPE_LIMITS = { pages: 200, groups: 100, flows: 2000, pageChars: 512 * 1024, totalChars: 8 * 1024 * 1024 } as const

/** 读取操作不改变原型或生成可计费任务。 */
export const INTERACTION_DESIGN_READ_METHODS: readonly InteractionDesignMethod[] = ['list', 'load', 'getVersion', 'getCandidate', 'assetContent', 'inspectProject', 'readSource']

/** 稳定错误文案，不回显未经检查的输入。 */
function invalid(field: string): never { throw new Error(`INTERACTION_DESIGN_INVALID: ${field}`) }

/** 将未知 JSON 限制为普通对象；入参为边界值，返回可验证字段表。 */
function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(field)
  return value as Record<string, unknown>
}

/** 有界字符串校验，正文允许空串，身份与名称要求非空。 */
function string(value: unknown, field: string, max = 128, empty = false): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (!empty && !value.trim())) return invalid(field)
  return value
}

/** ID 同时用于文件路径和对象索引，因此拒绝保留属性名。 */
export function assertPrototypeId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) invalid('对象 ID 无效')
}

/** 检查身份后返回原值，便于构造白名单对象。 */
function id(value: unknown): string { assertPrototypeId(value); return value }

/** 版本必须是正安全整数；不把浮点和字符串自动转为版本。 */
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid('版本无效')
  return value as number
}

/** 路径始终是项目相对路径，拒绝隐藏秘密配置和任意上行。 */
export function parsePrototypeRelativePath(value: unknown): string {
  const path = string(value, '相对路径', 1024)
  if (/[\\:\0?#]/.test(path) || path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) invalid('只能引用项目内可见的相对文件')
  return path
}

/** 校验数组长度再进入逐项验证，禁止单次注入无限条目。 */
function array(value: unknown, field: string, max: number, min = 0): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) return invalid(field)
  return value
}

/** 验证集合身份唯一性，防同一个 ID 指向两个页面。 */
function unique(values: string[], field: string): void {
  if (new Set(values).size !== values.length) invalid(field)
}

/**
 * 解析原型完整内容并丢弃派生/权限字段。
 * @param value 用户或模型提供的原型正文。
 * @returns 经边界、目录和路由引用验证的规范草稿。
 */
export function parsePrototypeDraft(value: unknown): PrototypeDraft {
  const draft = record(value, '原型正文')
  const platform = draft.platform
  if (platform !== 'mobile' && platform !== 'desktop') return invalid('设备类型')
  const groups = array(draft.groups, '页面分组', PROTOTYPE_LIMITS.groups, 1).map((value) => {
    const group = record(value, '分组')
    const parentId = group.parentId === undefined || group.parentId === null ? undefined : id(group.parentId)
    return { id: id(group.id), name: string(group.name, '分组名称', 120), ...(parentId ? { parentId } : {}) }
  })
  unique(groups.map((group) => group.id), '分组身份重复')
  const groupIds = new Set(groups.map((group) => group.id))
  /** 父链必须指向当前版本中的分组且不能形成循环，避免目录树递归失控。 */
  const groupsById = new Map(groups.map((group) => [group.id, group]))
  for (const group of groups) {
    const seen = new Set<string>([group.id])
    let parentId = group.parentId
    while (parentId) {
      if (!groupIds.has(parentId) || seen.has(parentId)) invalid('页面分组父级无效')
      seen.add(parentId)
      parentId = groupsById.get(parentId)?.parentId
    }
  }
  let totalChars = 0
  const pages = array(draft.pages, '页面集合', PROTOTYPE_LIMITS.pages, 1).map((value) => {
    const page = record(value, '页面')
    const html = string(page.html, '页面 HTML', PROTOTYPE_LIMITS.pageChars, true)
    totalChars += html.length
    if (totalChars > PROTOTYPE_LIMITS.totalChars) invalid('原型内容超出预算')
    const groupId = id(page.groupId)
    if (!groupIds.has(groupId)) invalid('页面所属分组不存在')
    const source = page.source === undefined ? undefined : record(page.source, '页面来源')
    if (source && (source.kind !== 'html' && source.kind !== 'code' || typeof source.hash !== 'string' || !/^[a-f0-9]{64}$/.test(source.hash))) invalid('来源内容身份')
    return {
      id: id(page.id), groupId, name: string(page.name, '页面名称', 120), html,
      ...(source ? { source: { path: parsePrototypeRelativePath(source.path), hash: source.hash as string, kind: source.kind as 'html' | 'code' } } : {}),
    }
  })
  unique(pages.map((page) => page.id), '页面身份重复')
  const pageIds = new Set(pages.map((page) => page.id))
  const entryPageId = id(draft.entryPageId)
  if (!pageIds.has(entryPageId)) invalid('入口页面不存在')
  const flows = array(draft.flows, '页面连接', PROTOTYPE_LIMITS.flows).map((value) => {
    const flow = record(value, '页面连接')
    const fromPageId = id(flow.fromPageId)
    const targetPageId = id(flow.targetPageId)
    if (!pageIds.has(fromPageId) || !pageIds.has(targetPageId)) invalid('连接指向不存在的页面')
    return { id: id(flow.id), fromPageId, targetPageId, elementId: id(flow.elementId) }
  })
  unique(flows.map((flow) => flow.id), '连接身份重复')
  unique(flows.map((flow) => `${flow.fromPageId}:${flow.elementId}`), '同一元素存在多个跳转目标')
  return { name: string(draft.name, '原型名称', 120), platform, brief: string(draft.brief, '原型说明', 16000, true), groups, pages, entryPageId, flows }
}

/** 不需要规范副本时使用的验证入口，返回校验错误而非静默修复。 */
export function assertPrototypeDraft(value: unknown): asserts value is PrototypeDraft { parsePrototypeDraft(value) }

/**
 * IPC 与 Agent 直调共用命令白名单。
 * @param value 由调用方发送的 method/input 信封。
 * @returns 只含该命令合法字段的类型安全请求。
 */
export function parseInteractionDesignCommand(value: unknown): InteractionDesignCommand {
  const command = record(value, '命令')
  const input = record(command.input, '命令参数')
  const sessionId = id(input.sessionId)
  const method = string(command.method, '命令名') as InteractionDesignMethod
  /** 统一包装保留映射的命令和参数类型。 */
  const result = <M extends InteractionDesignMethod>(name: M, data: InteractionDesignInputs[M]): InteractionDesignCommand => ({ method: name, input: data }) as InteractionDesignCommand
  if (method === 'list' || method === 'inspectProject') return result(method, { sessionId })
  if (method === 'create') {
    if (input.platform !== 'mobile' && input.platform !== 'desktop') return invalid('设备类型')
    return result(method, { sessionId, name: string(input.name, '原型名称', 120), platform: input.platform, ...(input.pageName === undefined ? {} : { pageName: string(input.pageName, '页面名称', 120) }) })
  }
  if (method === 'readSource') return result(method, { sessionId, paths: array(input.paths, '来源文件', 12, 1).map(parsePrototypeRelativePath) })
  const prototypeId = id(input.prototypeId)
  const base = { sessionId, prototypeId }
  switch (method) {
    case 'load': return result(method, base)
    case 'save': return result(method, { ...base, baseRevision: revision(input.baseRevision), draft: parsePrototypeDraft(input.draft), summary: string(input.summary, '保存说明', 2000) })
    case 'getVersion': case 'validate': case 'exportHtml': case 'createHandoff': return result(method, { ...base, revision: revision(input.revision) })
    case 'restore': case 'deleteVersion': return result(method, { ...base, revision: revision(input.revision), baseRevision: revision(input.baseRevision) })
    case 'propose': return result(method, { ...base, baseRevision: revision(input.baseRevision), draft: parsePrototypeDraft(input.draft), summary: string(input.summary, '候选说明', 2000), ...(input.jobId === undefined ? {} : { jobId: id(input.jobId) }) })
    case 'getCandidate': case 'discardCandidate': return result(method, { ...base, candidateId: id(input.candidateId) })
    case 'adopt': return result(method, { ...base, candidateId: id(input.candidateId), baseRevision: revision(input.baseRevision) })
    case 'beginJob': return result(method, { ...base, baseRevision: revision(input.baseRevision), instruction: string(input.instruction, '生成要求', 16000), ...(input.pageId === undefined ? {} : { pageId: id(input.pageId) }), ...(input.elementId === undefined ? {} : { elementId: id(input.elementId) }) })
    case 'cancelJob': return result(method, { ...base, jobId: id(input.jobId) })
    case 'failJob': return result(method, { ...base, jobId: id(input.jobId), message: string(input.message, '失败原因', 2000) })
    case 'importAsset': return result(method, { ...base, relativePath: parsePrototypeRelativePath(input.relativePath) })
    case 'assetContent': return result(method, { ...base, assetId: id(input.assetId) })
    case 'importMediaAsset': {
      const hash = string(input.hash, '素材哈希', 64)
      if (!/^[a-f0-9]{64}$/.test(hash)) return invalid('素材哈希')
      return result(method, { ...base, assetId: id(input.assetId), revision: revision(input.revision), hash })
    }
    case 'importHtml': return result(method, { ...base, baseRevision: revision(input.baseRevision), relativePath: parsePrototypeRelativePath(input.relativePath), ...(input.groupId === undefined ? {} : { groupId: id(input.groupId) }) })
    case 'recordExperience': return result(method, { ...base, revision: revision(input.revision), visitedPageIds: array(input.visitedPageIds, '体验路径', 1000, 1).map(id) })
    default: return invalid('不支持的命令')
  }
}
