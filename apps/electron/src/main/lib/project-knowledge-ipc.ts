import { KNOWLEDGE_SOURCE_KINDS, PROJECT_KNOWLEDGE_IPC_CHANNELS } from '@proma/shared'
import type { KnowledgeMemoryOrganizationPreview, KnowledgeCategory, KnowledgeMaintenanceInput, KnowledgePlanConfirmInput, KnowledgeReviewInput, KnowledgeReadInput, KnowledgeReadResult, KnowledgeSearchInput, KnowledgeSearchResult, KnowledgeSnapshot, KnowledgeSourceKind, KnowledgeWorkflowPauseInput } from '@proma/shared'

/** 主进程知识服务的 IPC 最小端口。 */
export interface ProjectKnowledgeIpcService {
  /** 用户确认当前可见的分组清单。 */
  confirmPlan(input: KnowledgePlanConfirmInput): Promise<KnowledgeSnapshot>
  /** 用户暂停或继续已确认的知识生成。 */
  pauseWorkflow(input: KnowledgeWorkflowPauseInput): Promise<KnowledgeSnapshot>
  /** 返回当前项目状态，不隐式扫描。 */
  getSnapshot(workspaceId: string): Promise<KnowledgeSnapshot>
  /** 开始后台扫描并立即返回状态。 */
  startScan(workspaceId: string): Promise<KnowledgeSnapshot>
  /** 请求停止后续扫描批次。 */
  cancelScan(workspaceId: string): Promise<KnowledgeSnapshot>
  /** 搜索已登记内容。 */
  search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult>
  /** 按稳定条目 ID 读取有界正文。 */
  read(input: KnowledgeReadInput): Promise<KnowledgeReadResult>
  /** 显式用户设置；Agent 不具备这些修改端口。 */
  updateMaintenance(input: KnowledgeMaintenanceInput): Promise<KnowledgeSnapshot>
  /** 用户触发失败重试。 */
  retryMaintenance(workspaceId: string): Promise<KnowledgeSnapshot>
  /** 确认或排除当前版本条目。 */
  reviewEntry(input: KnowledgeReviewInput): Promise<KnowledgeSnapshot>
  /** 整理受管资料。 */
  organize(workspaceId: string): Promise<KnowledgeSnapshot>
  /** 撤销指定操作。 */
  undo(workspaceId: string, operationId: string): Promise<KnowledgeSnapshot>
  /** 排除当前项目中的会话。 */
  excludeSession(workspaceId: string, sessionId: string): Promise<KnowledgeSnapshot>
  /** 只读旧记忆整理预览，不调用模型。 */
  previewMemory(workspaceId: string): Promise<KnowledgeMemoryOrganizationPreview>
}

/** IPC 只需要核验发送方身份，不把 Electron 对象传入知识服务。 */
export interface ProjectKnowledgeIpcEvent {
  /** 当前发起窗口。 */
  sender: { id: number }
}

/** 注册器依赖，由宿主提供真实窗口、项目归属和写守卫。 */
export interface ProjectKnowledgeIpcDependencies {
  /** 可释放的 IPC handler 注册端口。 */
  ipc: {
    /** 注册一个只接收结构化参数的异步处理器。 */
    handle(channel: string, handler: (event: ProjectKnowledgeIpcEvent, value: unknown) => Promise<unknown>): void
    /** 释放指定通道。 */
    removeHandler(channel: string): void
  }
  /** 判断调用方是否为仍存活的应用主窗口。 */
  isAuthorizedSender(event: ProjectKnowledgeIpcEvent): boolean
  /** 验证项目仍存在并返回绑定指纹；异步前后必须一致。 */
  assertProject(workspaceId: string): string | void
  /** 阻止迁移和删除期间的写入；扫描租约由宿主持有至任务结束。 */
  assertWritable(workspaceId: string): void
  /** 实际知识服务或运行时包装。 */
  service: ProjectKnowledgeIpcService
}

/** 读取未知输入的窄对象，并拒绝原型对象和数组。 */
function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('知识库参数必须是对象')
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error('知识库参数必须是普通对象')
  }
  return value as Record<string, unknown>
}

/** 仅允许显式列出的字段，阻止把任意路径透传到底层。 */
function allowFields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('知识库参数含未知字段')
}

/** 验证项目或条目的安全稳定身份。 */
function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error(`${label}无效`)
  return value
}

/** 校验可选的整数分页值。 */
function optionalInteger(value: unknown, label: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label}无效`)
  }
  return value
}

/** 校验用户确认的可见计划版本、部分分组和修订名称。 */
export function parseKnowledgePlanConfirmInput(value: unknown): KnowledgePlanConfirmInput {
  const input = requireObject(value)
  allowFields(input, ['workspaceId', 'planId', 'expectedRevision', 'groups'])
  const expectedRevision = optionalInteger(input.expectedRevision, '计划版本', 1, Number.MAX_SAFE_INTEGER)
  if (expectedRevision === undefined) throw new Error('计划版本必填')
  if (!Array.isArray(input.groups) || input.groups.length < 1 || input.groups.length > 100) throw new Error('确认分组无效')
  const seenGroupIds = new Set<string>()
  const groups = input.groups.map((value) => {
    const group = requireObject(value)
    allowFields(group, ['id', 'title'])
    const id = requireId(group.id, '分组 ID')
    if (seenGroupIds.has(id)) throw new Error('确认分组重复')
    seenGroupIds.add(id)
    if (typeof group.title !== 'string' || !group.title.trim() || group.title.length > 200) throw new Error('分组名称无效')
    return { id, title: group.title.trim() }
  })
  return {
    workspaceId: requireId(input.workspaceId, '项目 ID'),
    planId: requireId(input.planId, '计划 ID'),
    expectedRevision,
    groups,
  }
}

/** 校验用户发起的暂停或继续动作。 */
export function parseKnowledgeWorkflowPauseInput(value: unknown): KnowledgeWorkflowPauseInput {
  const input = requireObject(value)
  allowFields(input, ['workspaceId', 'paused'])
  if (typeof input.paused !== 'boolean') throw new Error('暂停状态无效')
  return { workspaceId: requireId(input.workspaceId, '项目 ID'), paused: input.paused }
}

/** 校验搜索参数，不执行任何来源读取。 */
export function parseKnowledgeSearchInput(value: unknown): KnowledgeSearchInput {
  /** 先验证所有字段，再把窄合同交给服务。 */
  const input = requireObject(value)
  allowFields(input, ['workspaceId', 'query', 'scope', 'sourceKind', 'category', 'includeHistory', 'offset', 'limit'])
  if (typeof input.query !== 'string' || input.query.length > 2000) throw new Error('检索词无效或过长')
  if (input.scope !== undefined && input.scope !== 'knowledge' && input.scope !== 'sources' && input.scope !== 'all') {
    throw new Error('知识检索范围无效')
  }
  if (input.sourceKind !== undefined && !KNOWLEDGE_SOURCE_KINDS.includes(input.sourceKind as KnowledgeSourceKind)) {
    throw new Error('知识来源类型无效')
  }
  if (input.category !== undefined && (typeof input.category !== 'string' || !input.category.trim() || input.category.length > 200)) {
    throw new Error('知识分类无效')
  }
  if (input.includeHistory !== undefined && typeof input.includeHistory !== 'boolean') throw new Error('历史筛选无效')
  return {
    workspaceId: requireId(input.workspaceId, '项目 ID'), query: input.query,
    scope: input.scope,
    sourceKind: input.sourceKind as KnowledgeSourceKind | undefined,
    category: typeof input.category === 'string' ? input.category.trim() as KnowledgeCategory : undefined,
    includeHistory: input.includeHistory as boolean | undefined,
    offset: optionalInteger(input.offset, '结果偏移', 0, Number.MAX_SAFE_INTEGER),
    limit: optionalInteger(input.limit, '结果数量', 1, 100),
  }
}

/** 校验正文读取参数；版本只作复核，不可转成磁盘路径。 */
export function parseKnowledgeReadInput(value: unknown): KnowledgeReadInput {
  /** 限定入口为项目与条目身份。 */
  const input = requireObject(value)
  allowFields(input, ['workspaceId', 'entryId', 'offset', 'expectedRevision'])
  if (input.expectedRevision !== undefined && (typeof input.expectedRevision !== 'string' || input.expectedRevision.length > 128)) {
    throw new Error('知识版本无效')
  }
  return {
    workspaceId: requireId(input.workspaceId, '项目 ID'),
    entryId: requireId(input.entryId, '条目 ID'),
    offset: optionalInteger(input.offset, '正文偏移', 0, Number.MAX_SAFE_INTEGER),
    expectedRevision: input.expectedRevision as string | undefined,
  }
}

/** 注册经过授权、参数校验与异步后归属复核的知识库 IPC。 */
export function registerProjectKnowledgeIpc(dependencies: ProjectKnowledgeIpcDependencies): { dispose(): void } {
  /** 所有知识通道共享同一套边界，释放时也使用同一集合。 */
  const channels = Object.values(PROJECT_KNOWLEDGE_IPC_CHANNELS)
  for (const channel of channels) {
    dependencies.ipc.handle(channel, async (event, value) => {
      if (!dependencies.isAuthorizedSender(event)) throw new Error('无权访问项目知识库')
      /** 普通操作只接受工作区身份，不接受原始文件路径。 */
      const input = requireObject(value)
      const workspaceId = requireId(input.workspaceId, '项目 ID')
      /** 保存项目绑定以拒绝迁移后的迟到读取。 */
      const binding = dependencies.assertProject(workspaceId)
      let result: unknown
      if (channel === PROJECT_KNOWLEDGE_IPC_CHANNELS.CONFIRM_PLAN) {
        const confirmInput = parseKnowledgePlanConfirmInput(input)
        dependencies.assertWritable(workspaceId)
        result = await dependencies.service.confirmPlan(confirmInput)
      } else if (channel === PROJECT_KNOWLEDGE_IPC_CHANNELS.PAUSE_WORKFLOW) {
        const pauseInput = parseKnowledgeWorkflowPauseInput(input)
        dependencies.assertWritable(workspaceId)
        result = await dependencies.service.pauseWorkflow(pauseInput)
      } else if (channel === PROJECT_KNOWLEDGE_IPC_CHANNELS.SEARCH) {
        result = await dependencies.service.search(parseKnowledgeSearchInput(input))
      } else if (channel === PROJECT_KNOWLEDGE_IPC_CHANNELS.READ) {
        result = await dependencies.service.read(parseKnowledgeReadInput(input))
      } else if (channel === PROJECT_KNOWLEDGE_IPC_CHANNELS.MAINTENANCE) {
        allowFields(input, ['workspaceId', 'enabled', 'channelId', 'modelId', 'dailyJobLimit'])
        if (typeof input.enabled !== 'boolean') throw new Error('维护开关无效')
        if (input.channelId !== undefined) requireId(input.channelId, '渠道 ID')
        if (input.modelId !== undefined && (typeof input.modelId !== 'string' || !input.modelId.trim() || input.modelId.length > 200)) throw new Error('模型无效')
        const dailyJobLimit = optionalInteger(input.dailyJobLimit, '每日预算', 1, 100)
        if (dailyJobLimit === undefined) throw new Error('每日预算必填')
        dependencies.assertWritable(workspaceId)
        result = await dependencies.service.updateMaintenance({ workspaceId, enabled: input.enabled,
          channelId: input.channelId as string | undefined, modelId: input.modelId as string | undefined, dailyJobLimit })
      } else if (channel === PROJECT_KNOWLEDGE_IPC_CHANNELS.REVIEW) {
        allowFields(input, ['workspaceId', 'entryId', 'expectedRevision', 'action'])
        if (input.action !== 'confirm' && input.action !== 'reject') throw new Error('审核动作无效')
        const entryId = requireId(input.entryId, '条目 ID')
        const expectedRevision = requireId(input.expectedRevision, '条目版本')
        dependencies.assertWritable(workspaceId)
        result = await dependencies.service.reviewEntry({ workspaceId, entryId, expectedRevision, action: input.action })
      } else if (channel === PROJECT_KNOWLEDGE_IPC_CHANNELS.UNDO || channel === PROJECT_KNOWLEDGE_IPC_CHANNELS.EXCLUDE_SESSION) {
        const key = channel === PROJECT_KNOWLEDGE_IPC_CHANNELS.UNDO ? 'operationId' : 'sessionId'
        allowFields(input, ['workspaceId', key])
        const id = requireId(input[key], key)
        dependencies.assertWritable(workspaceId)
        result = channel === PROJECT_KNOWLEDGE_IPC_CHANNELS.UNDO
          ? await dependencies.service.undo(workspaceId, id) : await dependencies.service.excludeSession(workspaceId, id)
      } else {
        allowFields(input, ['workspaceId'])
        if (channel === PROJECT_KNOWLEDGE_IPC_CHANNELS.SNAPSHOT) {
          result = await dependencies.service.getSnapshot(workspaceId)
        } else if (channel === PROJECT_KNOWLEDGE_IPC_CHANNELS.PREVIEW_MEMORY) {
          result = await dependencies.service.previewMemory(workspaceId)
        } else {
          dependencies.assertWritable(workspaceId)
          if (channel === PROJECT_KNOWLEDGE_IPC_CHANNELS.SCAN) result = await dependencies.service.startScan(workspaceId)
          else if (channel === PROJECT_KNOWLEDGE_IPC_CHANNELS.CANCEL_SCAN) result = await dependencies.service.cancelScan(workspaceId)
          else if (channel === PROJECT_KNOWLEDGE_IPC_CHANNELS.ORGANIZE) result = await dependencies.service.organize(workspaceId)
          else if (channel === PROJECT_KNOWLEDGE_IPC_CHANNELS.RETRY) result = await dependencies.service.retryMaintenance(workspaceId)
          else throw new Error('未知知识库操作')
        }
      }
      if (!dependencies.isAuthorizedSender(event)) throw new Error('无权接收项目知识库结果')
      if (dependencies.assertProject(workspaceId) !== binding) throw new Error('项目关联已变化，请重新读取知识库')
      return result
    })
  }
  return { dispose: () => { for (const channel of channels) dependencies.ipc.removeHandler(channel) } }
}
