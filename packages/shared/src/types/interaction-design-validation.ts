import type { InteractionDesignCommand, InteractionDesignInputs, InteractionDesignMethod, PrototypeDraft, PrototypeJobMode, PrototypePageManifestItem, PrototypePlan, PrototypePlanEvidence, PrototypePlanPage, PrototypePlanState } from './interaction-design'

/** 页面数量与正文预算避免不可信 IPC 触发无界复制。 */
export const PROTOTYPE_LIMITS = { pages: 200, statesPerPage: 12, groups: 100, flows: 2000, planEvidencePerPage: 24, planUnresolved: 100, pageChars: 512 * 1024, totalChars: 8 * 1024 * 1024 } as const

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

/** 判断任务指令是否明确要求从现有项目还原多页面。 */
export function isProjectRestoreInstruction(instruction: string): boolean {
  return /现有项目|根据源码|源码.*页面|还原.*页面|拆分.*页面|拆分.*App|多路由|多页面|整套\s*App|完整\s*App/i.test(instruction)
}

/** 为旧调用补齐任务模式；有 pageId 的请求默认是单页修改。 */
export function inferPrototypeJobMode(instruction: string, pageId?: string): PrototypeJobMode {
  if (pageId) return 'page-edit'
  return isProjectRestoreInstruction(instruction) ? 'project-restore' : 'design'
}

/** 校验任务模式字段并返回规范值。 */
function jobMode(value: unknown, instruction: string, pageId?: string): PrototypeJobMode {
  if (value === undefined) return inferPrototypeJobMode(instruction, pageId)
  if (value !== 'design' && value !== 'page-edit' && value !== 'project-restore') return invalid('生成任务模式')
  return value
}

/** 解析页面清单，拒绝重复身份和未命名业务页。 */
function pageManifest(value: unknown): PrototypePageManifestItem[] | undefined {
  if (value === undefined) return undefined
  const values = array(value, '页面清单', PROTOTYPE_LIMITS.pages, 1).map(item => {
    const entry = record(item, '页面清单项')
    return { id: id(entry.id), name: string(entry.name, '页面清单名称', 120) }
  })
  unique(values.map(item => item.id), '页面清单身份重复')
  return values
}

/** 解析规划中的单条源码或素材证据，并限制为项目相对路径和内容 hash。 */
function planEvidence(value: unknown): PrototypePlanEvidence {
  const evidence = record(value, '规划证据')
  const hash = string(evidence.hash, '规划证据 hash', 64)
  if (!/^[a-f0-9]{64}$/.test(hash)) invalid('规划证据 hash')
  const sourceKind = evidence.sourceKind
  if (sourceKind !== 'html' && sourceKind !== 'code' && sourceKind !== 'style' && sourceKind !== 'image') invalid('规划证据类型')
  const relation = evidence.relation
  if (relation !== 'route' && relation !== 'layout' && relation !== 'component' && relation !== 'style' && relation !== 'asset' && relation !== 'interaction' && relation !== 'state') invalid('规划证据关系')
  return {
    path: parsePrototypeRelativePath(evidence.path),
    hash,
    sourceKind,
    relation,
    ...(evidence.note === undefined ? {} : { note: string(evidence.note, '规划证据说明', 500, true) }),
  }
}

/** 解析规划状态；状态只声明身份和名称，不携带页面正文。 */
function planState(value: unknown): PrototypePlanState {
  const state = record(value, '规划状态')
  return { id: id(state.id), name: string(state.name, '规划状态名称', 120) }
}

/** 解析完整规划并校验分组、页面、状态、流程和证据之间的引用关系。 */
export function parsePrototypePlan(value: unknown): PrototypePlan {
  const plan = record(value, '页面规划')
  if (plan.schemaVersion !== 1) invalid('页面规划版本')
  const groups = array(plan.groups, '规划分组', PROTOTYPE_LIMITS.groups, 1).map(value => {
    const group = record(value, '规划分组')
    const parentId = group.parentId === undefined || group.parentId === null ? undefined : id(group.parentId)
    return { id: id(group.id), name: string(group.name, '规划分组名称', 120), ...(parentId ? { parentId } : {}) }
  })
  unique(groups.map(group => group.id), '规划分组身份重复')
  const groupIds = new Set(groups.map(group => group.id))
  const groupsById = new Map(groups.map(group => [group.id, group]))
  for (const group of groups) {
    const seen = new Set<string>([group.id])
    let parentId = group.parentId
    while (parentId) {
      if (!groupIds.has(parentId) || seen.has(parentId)) invalid('规划分组父级无效')
      seen.add(parentId)
      parentId = groupsById.get(parentId)?.parentId
    }
  }
  const pages = array(plan.pages, '规划页面集合', PROTOTYPE_LIMITS.pages, 1).map(value => {
    const page = record(value, '规划页面')
    const states = array(page.states, '规划状态集合', PROTOTYPE_LIMITS.statesPerPage).map(planState)
    unique(states.map(state => state.id), '规划状态身份重复')
    const evidence = array(page.evidence, '规划证据集合', PROTOTYPE_LIMITS.planEvidencePerPage).map(planEvidence)
    const entry = page.entry === undefined ? undefined : page.entry
    if (entry !== undefined && typeof entry !== 'boolean') invalid('规划入口标记')
    return {
      id: id(page.id),
      name: string(page.name, '规划页面名称', 120),
      groupId: id(page.groupId),
      ...(page.route === undefined ? {} : { route: string(page.route, '规划页面路由', 512) }),
      role: string(page.role, '规划页面职责', 240),
      ...(entry === undefined ? {} : { entry }),
      ...(page.defaultStateName === undefined ? {} : { defaultStateName: string(page.defaultStateName, '规划默认状态名称', 120) }),
      states,
      evidence,
    } satisfies PrototypePlanPage
  })
  unique(pages.map(page => page.id), '规划页面身份重复')
  for (const page of pages) if (!groupIds.has(page.groupId)) invalid('规划页面所属分组不存在')
  const pageIds = new Set(pages.map(page => page.id))
  const entryPageId = id(plan.entryPageId)
  if (!pageIds.has(entryPageId)) invalid('规划入口页面不存在')
  if (pages.filter(page => page.entry === true).length > 1 || (pages.some(page => page.entry === true) && !pages.find(page => page.id === entryPageId)?.entry)) invalid('规划入口页面不唯一')
  const flows = array(plan.flows, '规划页面连接', PROTOTYPE_LIMITS.flows).map(value => {
    const flow = record(value, '规划页面连接')
    const fromPageId = id(flow.fromPageId)
    const targetPageId = id(flow.targetPageId)
    if (!pageIds.has(fromPageId) || !pageIds.has(targetPageId)) invalid('规划连接指向不存在的页面')
    return { id: id(flow.id), fromPageId, targetPageId, elementId: id(flow.elementId) }
  })
  unique(flows.map(flow => flow.id), '规划连接身份重复')
  unique(flows.map(flow => `${flow.fromPageId}:${flow.elementId}`), '规划同一元素存在多个跳转目标')
  const unresolved = array(plan.unresolved, '规划待确认项', PROTOTYPE_LIMITS.planUnresolved).map(value => string(value, '规划待确认项', 500))
  return { schemaVersion: 1, summary: string(plan.summary, '规划说明', 4000, true), groups, pages, entryPageId, flows, unresolved }
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
    /** 附加状态保持可选，旧文档不能因补默认字段改变历史内容身份。 */
    const states = page.states === undefined ? undefined : array(page.states, '页面状态集合', PROTOTYPE_LIMITS.statesPerPage).map(value => {
      /** 状态只接受身份、名称和正文白名单。 */
      const state = record(value, '页面状态')
      return { id: id(state.id), name: string(state.name, '状态名称', 120), html: string(state.html, '状态 HTML', PROTOTYPE_LIMITS.pageChars, true) }
    })
    if (states) unique(states.map(state => state.id), '页面状态身份重复')
    totalChars += html.length + (states?.reduce((size, state) => size + state.html.length, 0) ?? 0)
    if (totalChars > PROTOTYPE_LIMITS.totalChars) invalid('原型内容超出预算')
    const groupId = id(page.groupId)
    if (!groupIds.has(groupId)) invalid('页面所属分组不存在')
    const source = page.source === undefined ? undefined : record(page.source, '页面来源')
    if (source && (source.kind !== 'html' && source.kind !== 'code' || typeof source.hash !== 'string' || !/^[a-f0-9]{64}$/.test(source.hash))) invalid('来源内容身份')
    return {
      id: id(page.id), groupId, name: string(page.name, '页面名称', 120), html,
      ...(page.defaultStateName === undefined ? {} : { defaultStateName: string(page.defaultStateName, '默认状态名称', 120) }),
      ...(states === undefined ? {} : { states }),
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

/** 识别项目还原中不应冒充业务页面的导览、来源参考和完整 App 页面。 */
function isPrototypeGuidePage(pageName: string): boolean {
  return /导航|导览|页面清单|覆盖范围|来源参考|完整\s*App|整套\s*App|原始\s*App|source\s*reference|full\s*app/i.test(pageName)
}

/** 判断来源是否像把多路由 App 整体导入成了单页。 */
function isFullAppSourcePage(page: PrototypeDraft['pages'][number]): boolean {
  /** 页面来源可能来自独立静态页；只有明确的 App/原型命名才视为整套来源。 */
  const source = page.source
  if (!source || source.kind !== 'html') return false
  return /导航|导览|完整|整套|原型|(?:^|[^a-z])app(?:[^a-z]|$)/i.test(`${page.name} ${source.path}`)
}

/**
 * 校验现有项目还原候选是否真的按业务页面拆分。
 * @param draft 待提交的完整原型草稿。
 * @param boundary 任务开始时冻结的完整页面规划或兼容页面清单。
 * @returns 可读的阻断原因；空数组表示通过。
 */
export function validateProjectRestoreDraft(draft: PrototypeDraft, boundary: PrototypePageManifestItem[] | PrototypePlan | undefined): string[] {
  /** 汇总所有阻断原因，但宿主只向调用方返回第一条，避免泄漏多余正文。 */
  const issues: string[] = []
  const plan = boundary && !Array.isArray(boundary) ? boundary : undefined
  const manifest: PrototypePageManifestItem[] | undefined = Array.isArray(boundary) ? boundary : boundary ? boundary.pages.map(page => ({ id: page.id, name: page.name })) : undefined
  if (!manifest?.length) return ['项目还原任务缺少页面清单，必须先声明业务页面再生成']
  /** 先排除导览和来源参考页，避免它们占用业务页面名额。 */
  const guidePages = draft.pages.filter(page => isPrototypeGuidePage(page.name))
  if (guidePages.length) issues.push(`页面拆分候选不能包含导览或来源参考页：${guidePages.map(page => page.name).join('、')}`)
  /** 识别仍保留整套 App HTML 的来源页。 */
  const fullAppPages = draft.pages.filter(isFullAppSourcePage)
  if (fullAppPages.length) issues.push(`页面拆分候选不能把完整 App HTML 作为单页：${fullAppPages.map(page => page.name).join('、')}`)
  /** 可与冻结清单比较的实际业务页面集合。 */
  const businessPages = draft.pages.filter(page => !isPrototypeGuidePage(page.name) && !isFullAppSourcePage(page))
  /** 页面身份集合用于快速检查清单缺页。 */
  const pageIds = new Set(businessPages.map(page => page.id))
  /** 清单中既没有匹配身份也没有匹配名称的页面。 */
  const missing = manifest.filter(item => !pageIds.has(item.id) && !businessPages.some(page => page.name === item.name))
  if (missing.length) issues.push(`页面拆分候选缺少业务页面：${missing.map(item => item.name).join('、')}`)
  if (businessPages.length < manifest.length) issues.push(`页面拆分候选只有 ${businessPages.length} 个业务页面，但页面清单声明了 ${manifest.length} 个`)
  if (manifest.length > 1 && businessPages.length === 1) issues.push('页面拆分候选不能用一个业务页面覆盖多个页面')
  if (manifest.length > 1) {
    /** 相同正文计数用于识别复制整套 HTML 的伪拆分。 */
    const htmlCounts = new Map<string, number>()
    for (const page of businessPages) htmlCounts.set(page.html, (htmlCounts.get(page.html) ?? 0) + 1)
    if ([...htmlCounts.values()].some(count => count > 1)) issues.push('页面拆分候选的多个业务页面正文完全相同，疑似仍复用了整套 App HTML')
  }
  if (plan) {
    /** 规划冻结分组身份和父子关系，生成阶段不能临时创建目录。 */
    const plannedGroups = new Map(plan.groups.map(group => [group.id, group]))
    const unexpectedGroups = draft.groups.filter(group => !plannedGroups.has(group.id))
    if (unexpectedGroups.length) issues.push(`页面拆分候选包含未规划分组：${unexpectedGroups.map(group => group.name).join('、')}`)
    const changedGroups = draft.groups.filter(group => {
      const planned = plannedGroups.get(group.id)
      return planned !== undefined && (planned.name !== group.name || planned.parentId !== group.parentId)
    })
    if (changedGroups.length) issues.push(`页面拆分候选修改了规划分组：${changedGroups.map(group => group.name).join('、')}`)
    /** 规划冻结页面身份、名称和所属分组，防止生成结果再次合并或漂移。 */
    const plannedPages = new Map(plan.pages.map(page => [page.id, page]))
    const unexpectedPages = businessPages.filter(page => !plannedPages.has(page.id))
    if (unexpectedPages.length) issues.push(`页面拆分候选包含未规划页面：${unexpectedPages.map(page => page.name).join('、')}`)
    for (const page of businessPages) {
      const planned = plannedPages.get(page.id)
      if (!planned) continue
      if (page.name !== planned.name || page.groupId !== planned.groupId) issues.push(`页面 ${page.name} 偏离页面规划`)
      if (page.defaultStateName !== planned.defaultStateName) issues.push(`页面 ${page.name} 的默认状态偏离页面规划`)
      const plannedStates = new Map(planned.states.map(state => [state.id, state]))
      const actualStates = page.states ?? []
      const missingStates = planned.states.filter(state => !actualStates.some(value => value.id === state.id))
      const unexpectedStates = actualStates.filter(state => !plannedStates.has(state.id))
      const renamedStates = actualStates.filter(state => plannedStates.get(state.id)?.name !== undefined && plannedStates.get(state.id)?.name !== state.name)
      if (missingStates.length) issues.push(`页面 ${page.name} 缺少规划状态：${missingStates.map(state => state.name).join('、')}`)
      if (unexpectedStates.length) issues.push(`页面 ${page.name} 包含未规划状态：${unexpectedStates.map(state => state.name).join('、')}`)
      if (renamedStates.length) issues.push(`页面 ${page.name} 修改了规划状态名称：${renamedStates.map(state => state.name).join('、')}`)
      if (page.source && !planned.evidence.some(evidence => evidence.path === page.source?.path)) issues.push(`页面 ${page.name} 的来源未出现在规划证据中`)
    }
    if (draft.entryPageId !== plan.entryPageId) issues.push('候选入口页面偏离页面规划')
    const plannedFlows = new Map(plan.flows.map(flow => [flow.id, flow]))
    const unexpectedFlows = draft.flows.filter(flow => !plannedFlows.has(flow.id))
    if (unexpectedFlows.length) issues.push('候选包含未规划页面连接')
    const missingFlows = plan.flows.filter(flow => !draft.flows.some(value => value.id === flow.id && value.fromPageId === flow.fromPageId && value.elementId === flow.elementId && value.targetPageId === flow.targetPageId))
    if (missingFlows.length) issues.push('候选缺少规划页面连接')
  }
  return issues
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
    case 'beginJob': {
      /** 规范化用户要求，供宿主推断任务边界。 */
      const instruction = string(input.instruction, '生成要求', 16000)
      /** 单页任务的目标页面身份。 */
      const pageId = input.pageId === undefined ? undefined : id(input.pageId)
      /** 明确或兼容推断出的生成模式。 */
      const mode = jobMode(input.mode, instruction, pageId)
      /** 生成任务冻结的业务页面清单。 */
      const manifest = pageManifest(input.pageManifest)
      /** 新合同将分组、状态、流程和证据一起冻结；旧 manifest 仍只为历史任务兼容。 */
      const plan = input.plan === undefined ? undefined : parsePrototypePlan(input.plan)
      if (manifest && plan) {
        const planManifest = plan.pages.map(page => ({ id: page.id, name: page.name }))
        if (JSON.stringify(planManifest) !== JSON.stringify(manifest)) invalid('页面规划与页面清单不一致')
      }
      return result(method, { ...base, baseRevision: revision(input.baseRevision), instruction, ...(pageId === undefined ? {} : { pageId }), ...(input.elementId === undefined ? {} : { elementId: id(input.elementId) }), mode, ...(manifest ? { pageManifest: manifest } : {}), ...(plan ? { plan } : {}) })
    }
    case 'cancelJob': return result(method, { ...base, jobId: id(input.jobId) })
    case 'failJob': return result(method, { ...base, jobId: id(input.jobId), message: string(input.message, '失败原因', 2000) })
    case 'importAsset': return result(method, { ...base, relativePath: parsePrototypeRelativePath(input.relativePath) })
    case 'assetContent': return result(method, { ...base, assetId: id(input.assetId) })
    case 'importMediaAsset': {
      const hash = string(input.hash, '素材哈希', 64)
      if (!/^[a-f0-9]{64}$/.test(hash)) return invalid('素材哈希')
      return result(method, { ...base, assetId: id(input.assetId), revision: revision(input.revision), hash })
    }
    case 'importHtml': return result(method, { ...base, baseRevision: revision(input.baseRevision), relativePath: parsePrototypeRelativePath(input.relativePath), ...(input.groupId === undefined ? {} : { groupId: id(input.groupId) }), ...(input.jobId === undefined ? {} : { jobId: id(input.jobId) }) })
    case 'recordExperience': return result(method, { ...base, revision: revision(input.revision), visitedPageIds: array(input.visitedPageIds, '体验路径', 1000, 1).map(id) })
    default: return invalid('不支持的命令')
  }
}
