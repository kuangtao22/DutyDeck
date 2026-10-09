import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSystemPrompt, createWorkspacePromptContextProvider } from './agent-prompt-builder'
import { DataRootLocator } from './data-root-locator'

/** 当前测试创建的临时目录，测试结束后统一清理。 */
const temporaryDirs: string[] = []

test('Given 当前 Agent 可维护知识 When 构建提示词 Then 遵循proposal确认后大纲再文档且计划模式不注入写入流程', () => {
  /** 模拟已完成能力准入的普通项目会话，不接触真实用户设置。 */
  const context = {
    sessionId: 'knowledge-session', permissionMode: 'bypassPermissions' as const,
    dependencies: { resolveWorkspaceContext: () => ({ workspaceRoot: '/tmp/workspace', projectRoot: '/tmp/project', isLocalProject: true }),
      getUserName: () => '测试用户' },
  }
  /** 详细提炼交给 Skill，系统只保留调度与证据边界。 */
  const prompt = buildSystemPrompt({ ...context, projectKnowledgeAvailable: true })
  expect(prompt).toContain('当前回合加载 `knowledge-maintenance` Skill')
  expect(prompt).toContain('proma_knowledge_plan')
  expect(prompt).toContain('等待用户在界面确认')
  expect(prompt).toContain('proma_knowledge_outline')
  expect(prompt).toContain('proma_knowledge_document')
  expect(prompt).toContain('未处理来源')
  expect(prompt).toContain('持续更新')
  expect(prompt).toContain('不要求用户再配置维护渠道、模型或开关')
  expect(buildSystemPrompt(context)).not.toContain('proma_knowledge_plan')
  expect(buildSystemPrompt({ ...context, projectKnowledgeAvailable: true, permissionMode: 'plan' })).not.toContain('proma_knowledge_plan')
})

test('Given 运维工具可用 When 构建提示词 Then 数据库写入使用原生审批且仍明确代码证据要求', () => {
  /** 纯提示词依赖不会读取真实用户配置或项目文件。 */
  const context = {
    sessionId: 'ops-session', permissionMode: 'bypassPermissions' as const,
    dependencies: { resolveWorkspaceContext: () => ({ workspaceRoot: '/tmp/workspace', projectRoot: '/tmp/project', isLocalProject: true }),
      getUserName: () => '测试用户' },
  }
  const prompt = buildSystemPrompt({ ...context, serverOpsAvailable: true })
  expect(prompt).toContain('ops_database_change_context')
  expect(prompt).toContain('业务校验')
  expect(prompt).toContain('不得执行变更脚本')
  expect(prompt).toContain('不承诺事务回滚')
  expect(prompt).toContain('不得把生产事务回滚当作无副作用测试')
  expect(prompt).toContain('未读取程序时明确标记缺失')
  /** 数据库写入改为普通会话可见，但真实执行前必须弹出 Agent 原生确认卡。 */
  expect(prompt).toContain('ops_database_write')
  expect(prompt).toContain('Agent 原生确认弹窗')
  expect(prompt).toContain('不需要额外的服务器 Agent 授权')
  expect(prompt).toContain('写入仅支持直连 MySQL 和本地 SQLite')
  expect(prompt).not.toContain('写库由用户手工执行，不提供给你任何写工具')
  expect(prompt).toContain('只有当前工具集中提供 `ops_database_write` 时')
  expect(prompt).toContain('断线、超时或取消可能返回「结果未知」')
  expect(prompt).not.toContain('失败自动回滚')
  expect(prompt).toContain('SSH、Redis 和日志不需要额外的板块授权')
  const operationsPrompt = buildSystemPrompt({ ...context, serverOpsAvailable: true, serverOpsWriteAvailable: true })
  expect(operationsPrompt).toContain('ops_redis_read / ops_redis_write')
  expect(operationsPrompt).toContain('完全自动模式不能跳过或永久授权')
  expect(buildSystemPrompt(context)).not.toContain('ops_database_change_context')
})

test('Given 编排工厂可用 When 构建系统提示词 Then 注入不变量并指向场景设计 Skill（且不增加执行权限）', () => {
  const context = {
    sessionId: 'factory-session', permissionMode: 'bypassPermissions' as const,
    dependencies: { resolveWorkspaceContext: () => ({ workspaceRoot: '/tmp/workspace', projectRoot: '/tmp/project', isLocalProject: true }),
      getUserName: () => '测试用户' },
  }
  const prompt = buildSystemPrompt({ ...context, capabilityFactoryAvailable: true })

  /** 不变量留在系统提示里：这类约束不能"等着被加载"。 */
  expect(prompt).toContain('只编排模型必须做的那部分')
  expect(prompt).toContain('是**边界**，不是流程')
  expect(prompt).toContain('是否由模型决定"要不要做、以及用什么参数做"')
  /** 详细流程交给 Skill：长文与例子不占用每次会话的固定成本。 */
  expect(prompt).toContain('capability-factory-scene-design')
  expect(prompt).toContain('先加载并遵循')
  /** Agent 能代操作，修改仍需要通过宿主提供的快照与权限校验。 */
  expect(prompt).toContain('代为操作')
  expect(prompt).toContain('factory_prepare_operation')
  expect(prompt).toContain('factory_run_batch')
  expect(prompt).toContain('草案不生效')
  expect(prompt).toContain('采纳始终需要用户在 Agent 原有审批卡确认')
  expect(prompt).toContain('bypassPermissions')
  expect(prompt).toContain('不能放宽标准制造改善')
  /** 不要把桩当成为跑通而绑的东西。 */
  expect(prompt).toContain('不要为了"让整条链跑通"去绑虚拟接入')
  /** 常驻成本要低：详细流程（含反例）不在系统提示里重复一遍。 */
  expect(prompt).not.toContain('正确形状：输入 `corpusText`')

  /** 不具备工厂能力时一个字都不注入。 */
  expect(buildSystemPrompt(context)).not.toContain('只编排模型必须做的那部分')
})

afterEach(() => {
  for (const directory of temporaryDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Given 自定义数据根 When 构建系统提示词 Then 工作区 AGENTS 路径不再指向默认根', () => {
  /** 为定位文件隔离的临时 home 目录。 */
  const homeDir = mkdtempSync(join(tmpdir(), 'proma-prompt-home-'))
  /** 模拟带空格的外部数据根。 */
  const customRoot = mkdtempSync(join(tmpdir(), 'Proma Data-'))
  /** 同 slug 在默认根元数据中指向的另一项目路径，用于发现混根。 */
  const defaultRootProject = join(homeDir, '.proma', 'default-root-project')
  /** 注入数据根对应的本地项目路径。 */
  const customRootProject = join(customRoot, 'custom-root-project')
  temporaryDirs.push(homeDir, customRoot)
  writeFileSync(
    join(homeDir, '.proma-location.json'),
    JSON.stringify({ version: 1, activeRoot: customRoot }),
    'utf-8',
  )
  mkdirSync(customRoot, { recursive: true })
  mkdirSync(join(homeDir, '.proma'), { recursive: true })
  /** 两个数据根保存相同 slug、不同项目路径，模拟迁移切换后的真实冲突。 */
  writeFileSync(
    join(homeDir, '.proma', 'agent-workspaces.json'),
    JSON.stringify({ version: 2, workspaces: [{ slug: 'proma', projectRootPath: defaultRootProject }] }),
    'utf-8',
  )
  writeFileSync(
    join(customRoot, 'agent-workspaces.json'),
    JSON.stringify({ version: 2, workspaces: [{ slug: 'proma', projectRootPath: customRootProject }] }),
    'utf-8',
  )

  /** 生产 provider factory 通过真实 locator 从同一活动根解析路径和元数据。 */
  const resolveWorkspaceContext = createWorkspacePromptContextProvider(new DataRootLocator({ homeDir }))
  const prompt = buildSystemPrompt({
    workspaceSlug: 'proma',
    sessionId: 'session-1',
    permissionMode: 'bypassPermissions',
    dependencies: {
      resolveWorkspaceContext,
      getUserName: () => '测试用户',
    },
  })

  expect(prompt).toContain(join(customRoot, 'agent-workspaces', 'proma', 'AGENTS.md'))
  expect(prompt).toContain(customRootProject)
  expect(prompt).not.toContain(defaultRootProject)
  expect(prompt).not.toContain('/Users/test/.proma/agent-workspaces')
})

test('Given 用户提出画布视觉需求 When 构建系统提示词 Then Agent 必须在当前会话直接使用画布能力', () => {
  const prompt = buildSystemPrompt({
    sessionId: 'session-design-intent',
    permissionMode: 'bypassPermissions',
    dependencies: {
      resolveWorkspaceContext: () => ({
        workspaceRoot: '/tmp/workspace',
        projectRoot: '/tmp/project',
        isLocalProject: true,
      }),
      getUserName: () => '测试用户',
    },
  })

  expect(prompt).toContain('视觉设计、画布与代码实现')
  expect(prompt).toContain('明确要求使用画布')
  expect(prompt).toContain('canvas-production')
  expect(prompt).toContain('canvas_*')
  expect(prompt).toContain('不得要求用户切换到另一个 Design/Canvas')
  expect(prompt).not.toContain('先询问用户是否打开 Design')
  expect(prompt).not.toContain('用户选择 Design')
})

test('Given 用户已给出具体目标后追问能否执行 When 构建系统提示词 Then Agent 立即进入工具读取阶段', () => {
  const prompt = buildSystemPrompt({
    sessionId: 'session-execution-intent',
    permissionMode: 'bypassPermissions',
    dependencies: {
      resolveWorkspaceContext: () => ({
        workspaceRoot: '/tmp/workspace',
        projectRoot: '/tmp/project',
        isLocalProject: true,
      }),
      getUserName: () => '测试用户',
    },
  })

  expect(prompt).toContain('依据任务目标与已有授权选择行动，不依赖特定措辞触发')
  expect(prompt).toContain('使用当前可用工具取得事实、完成修改并验证结果')
  expect(prompt).toContain('不为了工具调用而调用工具')
  expect(prompt).toContain('不要只回复能力说明、重复计划或等待用户再次催促')
})

test('Given 用户明确要求记录记忆 When 构建工作区提示词 Then Agent 使用专用追加工具并说明保存结果', () => {
  /** 当前工作区提示词应明确把用户的记录意图路由到受限工具。 */
  const prompt = buildSystemPrompt({
    workspaceSlug: 'memory-project',
    sessionId: 'session-memory',
    permissionMode: 'bypassPermissions',
    workspaceMemoryRecordAvailable: true,
    dependencies: {
      resolveWorkspaceContext: () => ({
        workspaceRoot: '/tmp/workspace',
        projectRoot: '/tmp/project',
        isLocalProject: true,
      }),
      getUserName: () => '测试用户',
    },
  })

  expect(prompt).toContain('用户明确要求记录或记住时，调用 `proma_memory_record`')
  expect(prompt).toContain('追加，不覆盖已有记忆')
  expect(prompt).toContain('告知保存的文件路径')

  /** 缺少专用写工具的会话不应收到无法执行的记忆写入指引。 */
  const restrictedPrompt = buildSystemPrompt({
    workspaceSlug: 'memory-project',
    sessionId: 'session-restricted',
    permissionMode: 'bypassPermissions',
    dependencies: {
      resolveWorkspaceContext: () => ({
        workspaceRoot: '/tmp/workspace',
        projectRoot: '/tmp/project',
        isLocalProject: true,
      }),
      getUserName: () => '测试用户',
    },
  })
  expect(restrictedPrompt).not.toContain('proma_memory_record')
})

test('Given 知识库流程可用且记忆需要维护 When 构建提示词 Then 两类资料按所有权独立维护', () => {
  /** 画像缺口与历史复查在生产编排中互斥，分别验证两条真实可达路径。 */
  const collaborationProfilePrompt = buildSystemPrompt({
    workspaceSlug: 'memory-project', sessionId: 'session-workflow', permissionMode: 'bypassPermissions',
    projectKnowledgeAvailable: true, workspaceMemoryRecordAvailable: true,
    memoryGuidance: { needsCollaborationProfile: true },
    dependencies: {
      resolveWorkspaceContext: () => ({ workspaceRoot: '/tmp/workspace', projectRoot: '/tmp/project', isLocalProject: true }),
      getUserName: () => '测试用户',
    },
  })
  const historyReviewPrompt = buildSystemPrompt({
    workspaceSlug: 'memory-project', sessionId: 'session-review', permissionMode: 'bypassPermissions',
    projectKnowledgeAvailable: true, workspaceMemoryRecordAvailable: true,
    memoryGuidance: { needsCollaborationProfile: false },
    memoryRefreshOpportunity: { newestSessionAt: 2, newerSessionCount: 3 },
    dependencies: {
      resolveWorkspaceContext: () => ({ workspaceRoot: '/tmp/workspace', projectRoot: '/tmp/project', isLocalProject: true }),
      getUserName: () => '测试用户',
    },
  })

  expect(collaborationProfilePrompt).toContain('调用 `proma_memory_record`')
  expect(collaborationProfilePrompt).toContain('当前尚未建立 `memory/user-profile.md`')
  expect(historyReviewPrompt).toContain('项目记忆复查邀请')
  expect(collaborationProfilePrompt).toContain('普通写入直接完成后告知')
  expect(collaborationProfilePrompt).toContain('用户画像、协作偏好、纠错、经验与会影响未来判断的决策理由')
  expect(collaborationProfilePrompt).toContain('结构化项目事实、规划、规则、调研与设计文档')
  expect(collaborationProfilePrompt).toContain('只按需建立相对引用，不复制整篇正文')
  expect(collaborationProfilePrompt).not.toContain('只读迁移来源')
  expect(historyReviewPrompt).not.toContain('只读迁移来源')
})
