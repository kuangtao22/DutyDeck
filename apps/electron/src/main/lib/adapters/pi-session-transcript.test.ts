import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt } from '@earendil-works/pi-ai'
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai'
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import {
  installPendingSystemPromptTranscript,
  omitTrailingAbortedAssistantFromSession,
} from './pi-session-transcript'

/** 测试生成的真实 Pi 会话目录，逐例清理，避免读取用户正式会话。 */
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** 创建完全隔离的真实 SessionManager，不接触 ~/.proma。 */
function createSessionManager(): SessionManager {
  /** 每个测试独占的持久化目录。 */
  const directory = mkdtempSync(join(tmpdir(), 'proma-pi-session-transcript-'))
  temporaryDirectories.push(directory)
  return SessionManager.create(directory, directory)
}

/** 用 faux provider 构造真实 Pi AgentSession，覆盖内部投影、事件持久化和连续 prompt。 */
async function createRealAgentSession(
  provider: ReturnType<typeof fauxProvider>,
  customTools: ToolDefinition[] = [],
  sessionManager: SessionManager = createSessionManager(),
) {
  /** 会话、资源和模型配置全部写入测试临时目录。 */
  /** Pi ModelRuntime 使用内置 faux provider，不访问网络或真实凭据。 */
  const modelRuntime = await ModelRuntime.create({
    authPath: join(sessionManager.getSessionDir(), 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  })
  modelRuntime.registerNativeProvider(provider.provider)
  /** 测试显式关闭缓存预热，防止引入额外 provider 调用。 */
  const settingsManager = SettingsManager.inMemory({ cacheWarming: 'off' })
  /** 固定基础提示词，便于精确验证同轮 system transcript 增量。 */
  const resourceLoader = new DefaultResourceLoader({
    cwd: sessionManager.getCwd(),
    agentDir: sessionManager.getSessionDir(),
    settingsManager,
    systemPromptOverride: () => 'BASE',
  })
  await resourceLoader.reload()
  return createAgentSession({
    cwd: sessionManager.getCwd(),
    agentDir: sessionManager.getSessionDir(),
    modelRuntime,
    settingsManager,
    resourceLoader,
    sessionManager,
    model: provider.models[0],
    thinkingLevel: 'off',
    noTools: 'builtin',
    customTools,
  })
}

/** 构造 Pi 可持久化的用户消息。 */
function userMessage(text: string): UserMessage {
  return { role: 'user', content: text, timestamp: Date.now() }
}

/** 构造 Pi 可持久化的 assistant 消息。 */
function assistantMessage(stopReason: AssistantMessage['stopReason'], text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: text ? [{ type: 'text', text }] : [],
    api: 'openai-responses',
    provider: 'openai',
    model: 'test-model',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  }
}

/** 构造与 assistant 工具调用配对的结果消息。 */
function toolResultMessage(toolCallId: string): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName: 'inspect_scope',
    content: [{ type: 'text', text: 'blocked pending instruction activation' }],
    details: {},
    isError: true,
    timestamp: Date.now(),
  }
}

describe('Pi 0.87 会话投影中的中断恢复', () => {
  test('Given 尾部 aborted assistant When 清理 Then 只追加 context_edit 并在重开后保持隐藏', () => {
    /** 使用真实 0.87 SessionManager 写入用户、工具对和中断消息。 */
    const manager = createSessionManager()
    manager.appendMessage(userMessage('检查项目'))
    manager.appendMessage({
      ...assistantMessage('toolUse', ''),
      content: [{ type: 'toolCall', id: 'tool-1', name: 'inspect_scope', arguments: {} }],
    })
    manager.appendMessage(toolResultMessage('tool-1'))
    manager.appendMessage(assistantMessage('aborted', '未完成的回复'))

    expect(omitTrailingAbortedAssistantFromSession(manager)).toBe(true)
    /** 清理应是幂等的，第二次不会再写 context_edit。 */
    expect(omitTrailingAbortedAssistantFromSession(manager)).toBe(false)
    expect(manager.buildSessionProjection().messages.map((message) => message.role)).toEqual([
      'user', 'assistant', 'toolResult',
    ])
    expect(manager.getBranch().filter((entry) => entry.type === 'context_edit')).toHaveLength(1)

    /** 重新打开文件验证不是仅修改当前 Agent 内存。 */
    const sessionFile = manager.getSessionFile()
    if (!sessionFile) throw new Error('测试会话没有持久化文件')
    const reopened = SessionManager.open(sessionFile, manager.getSessionDir(), manager.getCwd())
    expect(reopened.buildSessionProjection().messages.map((message) => message.role)).toEqual([
      'user', 'assistant', 'toolResult',
    ])
  })

  test('Given aborted assistant 后已有用户消息 When 清理 Then 不误删历史中断条目', () => {
    const manager = createSessionManager()
    manager.appendMessage(userMessage('第一条'))
    manager.appendMessage(assistantMessage('aborted', '中断'))
    manager.appendMessage(userMessage('继续'))

    expect(omitTrailingAbortedAssistantFromSession(manager)).toBe(false)
    expect(manager.buildSessionProjection().messages).toHaveLength(3)
    expect(manager.getBranch().some((entry) => entry.type === 'context_edit')).toBe(false)
  })

  test('Given 真实 AgentSession 首轮被中断 When 清理后立即继续 Then live、请求与重开投影均无 aborted', async () => {
    /** 第二轮响应工厂会保存 provider 实际收到的 transcript。 */
    const providerContexts: string[] = []
    const provider = fauxProvider()
    provider.setResponses([
      fauxAssistantMessage('未完成', { stopReason: 'aborted' }),
      (context) => {
        providerContexts.push(JSON.stringify(context.messages))
        return fauxAssistantMessage('已继续')
      },
    ])
    const { session } = await createRealAgentSession(provider)
    try {
      await session.prompt('第一条')
      expect(session.agent.state.messages.some((message) => message.role === 'assistant'
        && message.stopReason === 'aborted')).toBe(true)

      expect(omitTrailingAbortedAssistantFromSession(session.sessionManager)).toBe(true)
      session.refreshContext()
      expect(session.agent.state.messages.some((message) => message.role === 'assistant'
        && message.stopReason === 'aborted')).toBe(false)

      await session.prompt('继续')
      expect(providerContexts).toHaveLength(1)
      expect(providerContexts[0]).not.toContain('"stopReason":"aborted"')
      expect(providerContexts[0]).toContain('继续')

      /** 重开文件确认第二轮完成后 canonical projection 仍排除了中断消息。 */
      const sessionFile = session.sessionManager.getSessionFile()
      if (!sessionFile) throw new Error('测试会话没有持久化文件')
      const reopened = SessionManager.open(
        sessionFile,
        session.sessionManager.getSessionDir(),
        session.sessionManager.getCwd(),
      )
      expect(reopened.buildSessionProjection().messages.some((message) => message.role === 'assistant'
        && message.stopReason === 'aborted')).toBe(false)
    } finally {
      session.dispose()
    }
  })
})

describe('Pi 0.87 同一工具循环的动态项目指令', () => {
  test('Given 工具轮发现新规则 When 连续 prompt 与磁盘恢复 Then provider 始终按 BASE 后动态规则发送', async () => {
    /** faux provider 记录真实 Agent 每轮收到的 transcript。 */
    const provider = fauxProvider()
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall('inspect_scope', {}, { id: 'scope-1' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('规则已生效'),
    ])
    /** 每次 provider 调用实际收到的完整系统提示词。 */
    const providerSystemPrompts: string[] = []
    /** 模拟连续访问子目录与更深目录时依次发现两层规则。 */
    let pendingInstruction: string | undefined
    let discoveredInstructionCount = 0
    /** 自定义工具在执行时模拟路径守卫发现新的子目录规则。 */
    const scopeTool = {
      name: 'inspect_scope',
      label: '检查目录',
      description: '触发子目录项目指令',
      parameters: Type.Object({}),
      execute: async () => {
        discoveredInstructionCount += 1
        pendingInstruction = discoveredInstructionCount === 1
          ? 'CHILD_AGENTS_RULE'
          : 'GRANDCHILD_AGENTS_RULE'
        return { content: [{ type: 'text' as const, text: '等待规则激活' }], details: {} }
      },
    } as unknown as ToolDefinition
    const { session } = await createRealAgentSession(provider, [scopeTool])
    /** 包住 AgentSession 已安装的 next-turn refresh，验证组合顺序而非孤立 callback。 */
    installPendingSystemPromptTranscript(session.agent, session.sessionManager, (currentSystemPrompt) => {
      if (!pendingInstruction) return currentSystemPrompt
      const instruction = pendingInstruction
      pendingInstruction = undefined
      return `${currentSystemPrompt}\n\n${instruction}`
    })
    session.agent.streamFunction = (model, context, options) => {
      providerSystemPrompts.push(getCurrentSystemPrompt(context.messages))
      return provider.provider.streamSimple(model, context, options)
    }

    try {
      await session.prompt('访问子目录')

      expect(providerSystemPrompts[0]).toContain('BASE')
      expect(providerSystemPrompts[0]).not.toContain('CHILD_AGENTS_RULE')
      expect(providerSystemPrompts[1]).toContain('BASE')
      expect(providerSystemPrompts[1]).toContain('CHILD_AGENTS_RULE')
      expect(providerSystemPrompts[1]!.indexOf('BASE')).toBeLessThan(
        providerSystemPrompts[1]!.indexOf('CHILD_AGENTS_RULE'),
      )
      expect(session.sessionManager.buildSessionProjection().messages.some((message) => message.role === 'system'
        && Object.values(message.sections ?? {}).includes('CHILD_AGENTS_RULE'))).toBe(true)
      expect(provider.state.callCount).toBe(2)

      /** 第二个 prompt 的首请求先读取旧规则，工具续轮再累积更深目录规则。 */
      provider.appendResponses([
        fauxAssistantMessage(fauxToolCall('inspect_scope', {}, { id: 'scope-2' }), { stopReason: 'toolUse' }),
        fauxAssistantMessage('更深目录规则已生效'),
      ])
      await session.prompt('继续访问子目录')
      expect(providerSystemPrompts).toHaveLength(4)
      expect(providerSystemPrompts[2]).toContain('CHILD_AGENTS_RULE')
      expect(providerSystemPrompts[2]).not.toContain('GRANDCHILD_AGENTS_RULE')
      expect(providerSystemPrompts[2]!.indexOf('BASE')).toBeLessThan(
        providerSystemPrompts[2]!.indexOf('CHILD_AGENTS_RULE'),
      )
      expect(providerSystemPrompts[3]).toContain('CHILD_AGENTS_RULE')
      expect(providerSystemPrompts[3]).toContain('GRANDCHILD_AGENTS_RULE')
      expect(providerSystemPrompts[3]!.indexOf('BASE')).toBeLessThan(
        providerSystemPrompts[3]!.indexOf('CHILD_AGENTS_RULE'),
      )
      expect(providerSystemPrompts[3]!.indexOf('CHILD_AGENTS_RULE')).toBeLessThan(
        providerSystemPrompts[3]!.indexOf('GRANDCHILD_AGENTS_RULE'),
      )

      /** 关闭并重新打开会话，以新的真实 AgentSession 验证磁盘恢复后的首个 provider 请求。 */
      const sessionFile = session.sessionManager.getSessionFile()
      if (!sessionFile) throw new Error('测试会话没有持久化文件')
      const sessionDirectory = session.sessionManager.getSessionDir()
      const sessionCwd = session.sessionManager.getCwd()
      session.dispose()
      const reopened = SessionManager.open(
        sessionFile,
        sessionDirectory,
        sessionCwd,
      )
      provider.appendResponses([fauxAssistantMessage('恢复完成')])
      const { session: resumedSession } = await createRealAgentSession(provider, [], reopened)
      installPendingSystemPromptTranscript(
        resumedSession.agent,
        resumedSession.sessionManager,
        (currentSystemPrompt) => currentSystemPrompt,
      )
      resumedSession.agent.streamFunction = (model, context, options) => {
        providerSystemPrompts.push(getCurrentSystemPrompt(context.messages))
        return provider.provider.streamSimple(model, context, options)
      }
      try {
        await resumedSession.prompt('恢复后继续')
        expect(providerSystemPrompts).toHaveLength(5)
        expect(providerSystemPrompts[4]).toContain('BASE')
        expect(providerSystemPrompts[4]).toContain('CHILD_AGENTS_RULE')
        expect(providerSystemPrompts[4]).toContain('GRANDCHILD_AGENTS_RULE')
        expect(providerSystemPrompts[4]!.indexOf('BASE')).toBeLessThan(
          providerSystemPrompts[4]!.indexOf('CHILD_AGENTS_RULE'),
        )
        expect(providerSystemPrompts[4]!.indexOf('CHILD_AGENTS_RULE')).toBeLessThan(
          providerSystemPrompts[4]!.indexOf('GRANDCHILD_AGENTS_RULE'),
        )
      } finally {
        resumedSession.dispose()
      }
    } finally {
      session.dispose()
    }
  })
})
