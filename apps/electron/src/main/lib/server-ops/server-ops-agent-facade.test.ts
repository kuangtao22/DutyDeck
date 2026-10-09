import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta, ServerOpsAuditAppendInput, ServerOpsAuditRecord, ServerOpsConnectionState, ServerOpsFileListResult, ServerOpsHost } from '@proma/shared'
import {
  createServerOpsAgentFacade,
  type ServerOpsAgentFacadeDependencies,
} from './server-ops-agent-facade'

function host(overrides: Partial<ServerOpsHost> = {}): ServerOpsHost {
  return {
    id: 'host-1',
    name: '生产机',
    address: '10.0.0.1',
    port: 22,
    username: 'deploy',
    authMethod: 'password',
    tags: ['prod'],
    credentialRef: 'secret-ref',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

function dependencies(options: {
  session?: Partial<AgentSessionMeta>
  state?: ServerOpsConnectionState
  auditAppend?: (input: ServerOpsAuditAppendInput) => ServerOpsAuditRecord | void
  prepareAudit?: () => Promise<void>
} = {}): ServerOpsAgentFacadeDependencies {
  const savedHost = host()
  return {
    getSession: () => ({ id: 'session-1', title: '普通会话', createdAt: 1, updatedAt: 1, ...options.session } as AgentSessionMeta),
    services: {
      hosts: {
        list: () => [savedHost],
        get: (hostId) => hostId === savedHost.id ? savedHost : undefined,
      },
      credentials: { getVersion: () => 'credential-version-1' },
      connections: {
        getState: () => options.state ?? { hostId: savedHost.id, phase: 'connected', connectionId: 'connection-secret' },
        exec: async () => ({ stdout: 'Linux\n', stderr: '', exitCode: 0, truncated: false }),
        disconnect: () => ({ hostId: savedHost.id, phase: 'disconnected' }),
      },
      audit: {
        prepareForWrites: options.prepareAudit,
        append: (input) => {
          /** 自定义审计实现未返回记录时仍提供确定时间戳。 */
          const result = options.auditAppend?.(input)
          return result ?? { id: 'audit-1', timestamp: 1, ...input }
        },
      },
    },
  }
}

describe('Server Ops Agent Facade 安全边界', () => {
  test('Given 目录紧凑 JSON 未超限但实际正文超过 64 KiB When Agent 读取 Then 拒绝结果并释放 owner', async () => {
    /** 两百个长文件名模拟合法分页，缩进后的真实工具正文会越过预算。 */
    const page: ServerOpsFileListResult = {
      hostId: 'host-1', path: '/',
      entries: Array.from({ length: 200 }, (_, index) => ({
        name: `${index}-${'a'.repeat(100)}`, path: `/${index}-${'a'.repeat(100)}`,
        kind: 'file', size: 0, mtime: 1, mode: 33188,
      })),
    }
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThan(65_536)
    expect(Buffer.byteLength(JSON.stringify(page, null, 2), 'utf8')).toBeGreaterThan(65_536)
    /** 记录无论结果是否可发送都必须释放的读取 owner。 */
    const released: string[] = []
    const deps = dependencies()
    deps.services.files = {
      list: async () => page,
      preview: async () => { throw new Error('unused') },
      mutateForAgent: async () => { throw new Error('unused') },
      releaseReader: (ownerKey) => { released.push(ownerKey) },
    }
    const facade = createServerOpsAgentFacade({ sessionId: 'session-1', dependencies: deps })!
    await expect(facade.filesList!({ hostId: 'host-1', path: '/' })).rejects.toThrow('SERVER_OPS_AGENT_RESULT_TOO_LARGE')
    expect(released).toHaveLength(1)
  })

  test('Given 文件读取期间连接被替换 When 内容到达 Then 拒绝内容并释放本次读取 owner', async () => {
    const deps = dependencies()
    let connectionId = 'connection-secret'
    const released: string[] = []
    deps.services.connections.getState = () => ({ hostId: 'host-1', phase: 'connected', connectionId })
    deps.services.files = {
      list: async () => { throw new Error('unused') },
      preview: async () => { connectionId = 'connection-replaced'; return { hostId: 'host-1', path: '/large', kind: 'too-large', bytesRead: 0, stat: { size: 2_000_000, mode: 33188, mtime: 1 } } },
      mutateForAgent: async () => { throw new Error('unused') },
      releaseReader: (ownerKey) => { released.push(ownerKey) },
    }
    const facade = createServerOpsAgentFacade({ sessionId: 'session-1', dependencies: deps })!
    await expect(facade.filesRead!({ hostId: 'host-1', path: '/large' })).rejects.toThrow('SERVER_OPS_CONNECTION_CHANGED')
    expect(released).toHaveLength(1)
    expect(released[0]).toStartWith('agent-read:session-1:')
  })
  test('Given Agent 有界目录读取 When 目录存在下一页 Then 不泄漏已释放的游标并标明截断', async () => {
    const deps = dependencies()
    const released: string[] = []
    deps.services.files = {
      list: async () => ({ hostId: 'host-1', path: '/', entries: [], cursor: 'cursor-1' }),
      preview: async () => { throw new Error('unused') },
      mutateForAgent: async () => { throw new Error('unused') },
      releaseReader: (ownerKey) => { released.push(ownerKey) },
    }
    const facade = createServerOpsAgentFacade({ sessionId: 'session-1', dependencies: deps })!
    await expect(facade.filesList!({ hostId: 'host-1', path: '/' })).resolves.toEqual({ hostId: 'host-1', path: '/', entries: [], truncatedReason: 'item-limit' })
    expect(released).toHaveLength(1)
    await expect(facade.filesList!({ hostId: 'host-2', path: '/' })).rejects.toThrow('SERVER_OPS_CONNECTION_NOT_ACTIVE')
    expect(released).toHaveLength(1)
  })
  test('Given Docker 查询期间连接被替换 When 回复到达 Then 不向 Agent 返回服务器数据', async () => {
    const deps = dependencies()
    let connectionId = 'connection-secret'
    deps.services.connections.getState = () => ({ hostId: 'host-1', phase: 'connected', connectionId })
    deps.services.docker = {
      listResources: async () => { connectionId = 'connection-replaced'; return { hostId: 'host-1', capability: 'available', containers: [], images: [], networks: [], volumes: [], warnings: [] } },
      getContainerDetail: async () => { throw new Error('unused') },
      runAgentAction: async () => { throw new Error('unused') },
    }
    const facade = createServerOpsAgentFacade({ sessionId: 'session-1', dependencies: deps })!
    await expect(facade.dockerResources!({ hostId: 'host-1' })).rejects.toThrow('SERVER_OPS_CONNECTION_CHANGED')
  })
  test.each(['exec', 'disconnect'] as const)(
    'Given 审计 schema guard 等待期间连接被替换 When Agent %s Then 不执行远程副作用',
    async (operation) => {
      let resolvePrepare!: () => void
      const preparePromise = new Promise<void>((resolve) => { resolvePrepare = resolve })
      let connectionId = 'connection-secret'
      let remoteCalls = 0
      const deps = dependencies({
        state: { hostId: 'host-1', phase: 'connected', connectionId: 'connection-secret' },
        prepareAudit: () => preparePromise,
      })
      deps.services.connections.getState = () => ({ hostId: 'host-1', phase: 'connected', connectionId })
      deps.services.connections.exec = async () => { remoteCalls += 1; return { stdout: '', stderr: '', exitCode: 0, truncated: false } }
      deps.services.connections.disconnect = () => { remoteCalls += 1; return { hostId: 'host-1', phase: 'disconnected' } }
      const facade = createServerOpsAgentFacade({ sessionId: 'session-1', dependencies: deps })!

      const pending = operation === 'exec'
        ? facade.exec({ hostId: 'host-1', command: 'true' })
        : facade.disconnect({ hostId: 'host-1' })
      connectionId = 'connection-replaced'
      resolvePrepare()

      await expect(Promise.resolve(pending)).rejects.toThrow('SERVER_OPS_CONNECTION_CHANGED')
      expect(remoteCalls).toBe(0)
    },
  )

  test('Given 普通会话创建时已有连接 When 列出服务器 Then 只返回唯一主机公开字段与状态', () => {
    const facade = createServerOpsAgentFacade({ sessionId: 'session-1', dependencies: dependencies() })

    expect(facade?.list()).toEqual([{
      id: 'host-1', name: '生产机', address: '10.0.0.1', port: 22,
      username: 'deploy', authMethod: 'password', tags: ['prod'], phase: 'connected',
    }])
    expect(JSON.stringify(facade?.list())).not.toContain('credentialRef')
  })

  test('Given 主机在本轮创建后重连 When 列目录或执行 Then 旧闭包不继承新 connectionId', async () => {
    const deps = dependencies()
    let connectionId = 'connection-secret'
    deps.services.connections.getState = () => ({ hostId: 'host-1', phase: 'connected', connectionId })
    const facade = createServerOpsAgentFacade({ sessionId: 'session-1', dependencies: deps })!
    connectionId = 'connection-replaced'

    expect(facade.list()).toEqual([])
    await expect(facade.exec({ hostId: 'host-1', command: 'true' })).rejects.toThrow('SERVER_OPS_CONNECTION_CHANGED')
  })

  test('Given 一个已保存主机身份损坏 When 创建本轮 Then 其它已连接主机仍可列出', () => {
    const good = host()
    const broken = host({ id: 'host-2', address: '10.0.0.2', credentialRef: 'broken-ref' })
    const deps = dependencies()
    deps.services.hosts = {
      list: () => [broken, good],
      get: (hostId) => hostId === broken.id ? broken : hostId === good.id ? good : undefined,
    }
    deps.services.credentials = {
      getVersion: (hostId) => {
        if (hostId === broken.id) throw new Error('broken credential metadata')
        return 'credential-version-1'
      },
    }
    deps.services.connections.getState = (hostId) => ({ hostId, phase: 'connected', connectionId: `connection-${hostId}` })
    const facade = createServerOpsAgentFacade({ sessionId: 'session-1', dependencies: deps })!

    expect(facade.list().map(entry => entry.id)).toEqual(['host-1'])
  })

  test('Given 命令发出后连接身份变化 When 返回 Then 审计 unknown 且不发布旧结果', async () => {
    const records: ServerOpsAuditAppendInput[] = []
    const deps = dependencies({ auditAppend: input => { records.push(input) } })
    let connectionId = 'connection-secret'
    deps.services.connections.getState = () => ({ hostId: 'host-1', phase: 'connected', connectionId })
    deps.services.connections.exec = async () => {
      connectionId = 'connection-replaced'
      return { stdout: 'stale output', stderr: '', exitCode: 0, truncated: false }
    }
    const facade = createServerOpsAgentFacade({ sessionId: 'session-1', dependencies: deps })!

    await expect(facade.exec({ hostId: 'host-1', command: 'touch /srv/app/restart' }))
      .rejects.toThrow('SERVER_OPS_REMOTE_OUTCOME_UNKNOWN')
    expect(records.at(-1)).toMatchObject({ operation: 'exec', phase: 'result', outcome: 'unknown', errorCode: 'SERVER_OPS_REMOTE_OUTCOME_UNKNOWN' })
    expect(JSON.stringify(records)).not.toContain('stale output')
  })

  test('Given 本轮取消、代次失效或会话归档 When 再次调用 Then 旧闭包立即拒绝', () => {
    const controller = new AbortController()
    let active = true
    let archived = false
    const deps = dependencies()
    deps.getSession = () => ({
      id: 'session-1', title: '普通会话', createdAt: 1, updatedAt: 1,
      ...(archived ? { archived: true } : {}),
    } as AgentSessionMeta)
    const facade = createServerOpsAgentFacade({
      sessionId: 'session-1', dependencies: deps, runSignal: controller.signal,
      assertRunActive: () => { if (!active) throw new Error('SERVER_OPS_AGENT_RUN_STALE') },
    })!

    active = false
    expect(() => facade.status({ hostId: 'host-1' })).toThrow('SERVER_OPS_AGENT_RUN_STALE')
    active = true
    archived = true
    expect(() => facade.status({ hostId: 'host-1' })).toThrow('SERVER_OPS_AGENT_SESSION_NOT_ALLOWED')
    archived = false
    controller.abort()
    expect(() => facade.status({ hostId: 'host-1' })).toThrow('SERVER_OPS_AGENT_RUN_CANCELLED')
  })

  test('Given 没有 Agent 授权但主机已保存并连接 When 调用服务器工具 Then 直接使用本轮连接快照', async () => {
    const deps = dependencies({ state: { hostId: 'host-1', phase: 'connected', connectionId: 'connection-secret' } })
    const facade = createServerOpsAgentFacade({ sessionId: 'session-1', dependencies: deps })!

    expect(facade.list().map((entry) => entry.id)).toEqual(['host-1'])
    await expect(facade.exec({ hostId: 'host-1', command: 'uname -a' })).resolves.toMatchObject({ exitCode: 0 })
  })

  test('Given SSH 配置或凭据身份在本轮中变化 When Agent 操作 Then 旧闭包拒绝访问', () => {
    const deps = dependencies()
    let credentialVersion = 'credential-version-1'
    deps.services.credentials = { getVersion: () => credentialVersion }
    const facade = createServerOpsAgentFacade({ sessionId: 'session-1', dependencies: deps })!
    credentialVersion = 'credential-version-2'

    expect(() => facade.status({ hostId: 'host-1' })).toThrow('SERVER_OPS_AGENT_RESOURCE_CHANGED')
  })

  test('Given 创建本轮时未连接或目标不在快照 When 调用工具 Then 稳定拒绝且不建立连接', async () => {
    const facade = createServerOpsAgentFacade({
      sessionId: 'session-1',
      dependencies: dependencies({ state: { hostId: 'host-1', phase: 'disconnected' } }),
    })!

    expect(facade.list()).toEqual([])
    expect(() => facade.status({ hostId: 'host-2' })).toThrow('SERVER_OPS_CONNECTION_NOT_ACTIVE')
    await expect(facade.connect({ hostId: 'host-1' })).rejects.toThrow('SERVER_OPS_CONNECTION_NOT_ACTIVE')
  })

  test('Given Host Key 仍待确认 When 查询状态 Then 不把未连接目标暴露给 Agent', () => {
    const facade = createServerOpsAgentFacade({
      sessionId: 'session-1',
      dependencies: dependencies({
        state: {
          hostId: 'host-1', phase: 'host-key-required', connectionId: 'connection-secret',
          candidate: { candidateId: 'candidate-secret', algorithm: 'ssh-ed25519', fingerprint: 'SHA256:abc' },
        },
      }),
    })

    expect(() => facade?.status({ hostId: 'host-1' })).toThrow('SERVER_OPS_CONNECTION_NOT_ACTIVE')
  })

  test('Given 会话在本轮创建后变为内部会话 When 再次调用 Then fresh 校验拒绝执行', async () => {
    let currentSession: Partial<AgentSessionMeta> = { id: 'session-1', title: '普通会话' }
    const deps = dependencies()
    deps.getSession = () => ({ createdAt: 1, updatedAt: 1, ...currentSession } as AgentSessionMeta)
    const facade = createServerOpsAgentFacade({ sessionId: 'session-1', dependencies: deps })
    currentSession = { ...currentSession, sourceAutomationId: 'automation-1' }

    expect(() => facade?.status({ hostId: 'host-1' })).toThrow('SERVER_OPS_AGENT_SESSION_NOT_ALLOWED')
  })

  test.each([
    { sourceDesignProjectId: 'project-1' },
    { sourceDesignJobId: 'job-1' },
    { sourceCanvasProjectId: 'project-1' },
    { sourceCanvasId: 'canvas-1' },
    { sourceCanvasNodeId: 'node-1' },
    { sourceAutomationId: 'automation-1' },
    { automationGraduated: true },
    { parentSessionId: 'parent-1' },
    { rootSessionId: 'root-1' },
    { sourceDelegationId: 'delegation-1' },
    { delegationRole: 'explore' as const },
    { delegationStatus: 'running' as const },
    { delegationDepth: 1 },
    { delegationGoal: '排查服务' },
  ])('Given 会话带有内部来源或父子残留 %# When 调用 Facade Then fail closed', (session) => {
    const facade = createServerOpsAgentFacade({
      sessionId: 'session-1',
      dependencies: dependencies({ session }),
    })

    expect(() => facade?.status({ hostId: 'host-1' })).toThrow('SERVER_OPS_AGENT_SESSION_NOT_ALLOWED')
  })

  test.each(['automation', 'delegation', 'external'] as const)(
    'Given %s 来源 When 创建 facade Then 不注册且强制构造也会拒绝执行',
    (triggeredBy) => {
      expect(createServerOpsAgentFacade({ sessionId: 'session-1', triggeredBy, dependencies: dependencies() })).toBeNull()
    },
  )

  test('Given 已连接主机 When 执行命令并断开 Then 使用本轮冻结的内部 connectionId', async () => {
    const calls: unknown[] = []
    const deps = dependencies({ state: { hostId: 'host-1', phase: 'connected', connectionId: 'connection-secret' } })
    deps.services.connections.exec = async (...args) => {
      calls.push(args)
      return { stdout: 'ok', stderr: '', exitCode: 0, truncated: false }
    }
    deps.services.connections.disconnect = () => {
      calls.push(['disconnect', 'host-1'])
      return { hostId: 'host-1', phase: 'disconnected' }
    }
    const facade = createServerOpsAgentFacade({ sessionId: 'session-1', dependencies: deps })!

    expect(await facade.exec({ hostId: 'host-1', command: 'uname -a' })).toEqual({
      stdout: 'ok', stderr: '', exitCode: 0, truncated: false,
    })
    expect(calls[0]).toEqual(['host-1', 'connection-secret', 'uname -a', 30000])
    expect(await facade.disconnect({ hostId: 'host-1' })).toEqual({ hostId: 'host-1', phase: 'disconnected' })
    expect(calls[1]).toEqual(['disconnect', 'host-1'])
  })

  test('Given 底层断开抛错 When Agent 断开服务器 Then 向上抛原错误且不依赖授权清理', async () => {
    const calls: string[] = []
    const disconnectError = new Error('SSH_DISCONNECT_FAILED')
    const deps = dependencies()
    deps.services.connections.disconnect = () => {
      calls.push('disconnect')
      throw disconnectError
    }
    const facade = createServerOpsAgentFacade({ sessionId: 'session-1', dependencies: deps })!

    await expect(facade.disconnect({ hostId: 'host-1' })).rejects.toBe(disconnectError)
    expect(calls).toEqual(['disconnect'])
  })

  test('Given exec 与 disconnect 成功 When Agent 操作 Then 每次远程动作前后写 start/result 且不记录输出和内部标识', async () => {
    /** 捕获 Facade 交给 Store 的公开审计输入。 */
    const auditCalls: ServerOpsAuditAppendInput[] = []
    const deps = dependencies({
      state: { hostId: 'host-1', phase: 'connected', connectionId: 'connection-secret' },
      auditAppend: (input) => { auditCalls.push(input) },
    })
    const facade = createServerOpsAgentFacade({ sessionId: 'session-1', dependencies: deps })!

    await facade.connect({ hostId: 'host-1' })
    await facade.exec({ hostId: 'host-1', command: 'echo password=secret' })
    await facade.disconnect({ hostId: 'host-1' })

    expect(auditCalls.map(({ actor, operation, phase, outcome }) => ({ actor, operation, phase, outcome }))).toEqual([
      { actor: 'agent', operation: 'exec', phase: 'start', outcome: 'pending' },
      { actor: 'agent', operation: 'exec', phase: 'result', outcome: 'success' },
      { actor: 'agent', operation: 'disconnect', phase: 'start', outcome: 'pending' },
      { actor: 'agent', operation: 'disconnect', phase: 'result', outcome: 'success' },
    ])
    /** 每次操作的开始与结果共享身份，不同操作之间身份必须隔离。 */
    const [execStart, execResult, disconnectStart, disconnectResult] = auditCalls
    if (!execStart || !execResult || !disconnectStart || !disconnectResult) {
      throw new Error('审计记录数量不完整')
    }
    expect(execStart.operationId).toBe(execResult.operationId)
    expect(disconnectStart.operationId).toBe(disconnectResult.operationId)
    expect(new Set([execStart.operationId, disconnectStart.operationId]).size).toBe(2)
    expect(auditCalls.every((record) => record.sessionId === 'session-1' && record.windowId === undefined)).toBe(true)
    expect(JSON.stringify(auditCalls)).not.toMatch(/Linux|connection-secret|credentialRef|stdout|stderr/)
    expect(auditCalls[1]).toMatchObject({ operation: 'exec', phase: 'result', outcome: 'success', exitCode: 0 })
    expect(auditCalls[1]).not.toHaveProperty('resultCode')
    expect(auditCalls[3]).not.toHaveProperty('resultCode')
  })

  test.each([
    { result: { stdout: '', stderr: '', exitCode: 0, truncated: false }, expected: { outcome: 'success', exitCode: 0 } },
    { result: { stdout: '', stderr: 'failed', exitCode: 23, truncated: false }, expected: { outcome: 'error', exitCode: 23 } },
    { result: { stdout: '', stderr: '', signal: 'SIGTERM', truncated: false }, expected: { outcome: 'error', signal: 'SIGTERM' } },
  ])('Given exec resolve 为 $expected When Agent 执行 Then 审计 outcome 与终止语义独立记录', async ({ result, expected }) => {
    const auditCalls: ServerOpsAuditAppendInput[] = []
    const deps = dependencies({
      state: { hostId: 'host-1', phase: 'connected', connectionId: 'connection-secret' },
      auditAppend: (input) => { auditCalls.push(input) },
    })
    deps.services.connections.exec = async () => result
    const facade = createServerOpsAgentFacade({ sessionId: 'session-1', dependencies: deps })!

    await facade.exec({ hostId: 'host-1', command: 'run task' })

    expect(auditCalls[1]).toMatchObject({ operation: 'exec', phase: 'result', ...expected })
    expect(auditCalls[1]).not.toHaveProperty('resultCode')
  })

  test('Given exec transport error When Agent 执行 Then 审计记录稳定 errorCode 并保留原错误', async () => {
    const auditCalls: ServerOpsAuditAppendInput[] = []
    const remoteError = Object.assign(new Error('socket details'), { code: 'SERVER_OPS_EXEC_TIMEOUT' })
    const deps = dependencies({
      state: { hostId: 'host-1', phase: 'connected', connectionId: 'connection-secret' },
      auditAppend: (input) => { auditCalls.push(input) },
    })
    deps.services.connections.exec = async () => { throw remoteError }
    const facade = createServerOpsAgentFacade({ sessionId: 'session-1', dependencies: deps })!

    await expect(facade.exec({ hostId: 'host-1', command: 'run task' })).rejects.toBe(remoteError)
    expect(auditCalls[1]).toMatchObject({ operation: 'exec', phase: 'result', outcome: 'error', errorCode: 'SERVER_OPS_EXEC_TIMEOUT' })
    expect(auditCalls[1]).not.toHaveProperty('resultCode')
  })

  test('Given 命令包含 NUL When Agent 执行 Then 在审计与 runtime 前立即拒绝', async () => {
    let auditCalls = 0
    let remoteCalls = 0
    const deps = dependencies({
      state: { hostId: 'host-1', phase: 'connected', connectionId: 'connection-secret' },
      auditAppend: () => { auditCalls += 1 },
    })
    deps.services.connections.exec = async () => {
      remoteCalls += 1
      return { stdout: '', stderr: '', truncated: false }
    }
    const facade = createServerOpsAgentFacade({ sessionId: 'session-1', dependencies: deps })!

    await expect(facade.exec({ hostId: 'host-1', command: 'uname\0-a' }))
      .rejects.toThrow('SERVER_OPS_EXEC_COMMAND_INVALID')
    expect(auditCalls).toBe(0)
    expect(remoteCalls).toBe(0)
  })

  test('Given start 审计写入失败 When Agent 执行命令 Then 稳定 fail closed 且远程方法零调用', async () => {
    let remoteCalls = 0
    const deps = dependencies({ auditAppend: () => { throw new Error('disk secret') } })
    deps.services.connections.exec = async () => {
      remoteCalls += 1
      return { stdout: '', stderr: '', exitCode: 0, truncated: false }
    }
    const facade = createServerOpsAgentFacade({ sessionId: 'session-1', dependencies: deps })!

    await expect(facade.exec({ hostId: 'host-1', command: 'true' })).rejects.toThrow('SERVER_OPS_AUDIT_START_WRITE_FAILED')
    expect(remoteCalls).toBe(0)
  })

  test('Given 远程成功但 result 审计失败 When 返回 Then 保留真实结果并附公开 warning', async () => {
    let appendCount = 0
    const deps = dependencies({
      state: { hostId: 'host-1', phase: 'connected', connectionId: 'connection-secret' },
      auditAppend: () => {
        appendCount += 1
        if (appendCount === 2) throw new Error('audit result failed')
      },
    })
    const facade = createServerOpsAgentFacade({ sessionId: 'session-1', dependencies: deps })!

    expect(await facade.exec({ hostId: 'host-1', command: 'uname' })).toEqual({
      stdout: 'Linux\n', stderr: '', exitCode: 0, truncated: false,
      warnings: ['SERVER_OPS_AUDIT_RESULT_WRITE_FAILED'],
    })
  })

  test.each(['exec', 'disconnect'] as const)(
    'Given %s 远程失败且 result 审计也失败 When 返回 Then 保留远程错误并附公开 warning',
    async (operation) => {
      const remoteError = Object.assign(new Error(`REMOTE_${operation.toUpperCase()}_FAILED`), {
        code: 'SERVER_OPS_CONNECTION_CLOSED',
      })
      let appendCount = 0
      const deps = dependencies({
        state: { hostId: 'host-1', phase: 'connected', connectionId: 'connection-secret' },
        auditAppend: () => {
          appendCount += 1
          if (appendCount === 2) throw new Error('AUDIT_RESULT_FAILED')
        },
      })
      if (operation === 'exec') deps.services.connections.exec = async () => { throw remoteError }
      if (operation === 'disconnect') deps.services.connections.disconnect = () => { throw remoteError }
      const facade = createServerOpsAgentFacade({ sessionId: 'session-1', dependencies: deps })!

      /** 统一调用不同返回类型的 Facade 方法，便于检查其公开错误。 */
      const invoke = async (): Promise<unknown> => {
        if (operation === 'exec') return facade.exec({ hostId: 'host-1', command: 'false' })
        return facade.disconnect({ hostId: 'host-1' })
      }
      /** 被测 Facade 实际拒绝的公开错误。 */
      const rejected = await invoke().catch((error: unknown) => error)
      expect(rejected).toMatchObject({
        code: 'SERVER_OPS_CONNECTION_CLOSED',
        cause: remoteError,
        warnings: ['SERVER_OPS_AUDIT_RESULT_WRITE_FAILED'],
      })
      expect(rejected).toHaveProperty('message', expect.stringContaining('SERVER_OPS_AUDIT_RESULT_WRITE_FAILED'))
    },
  )
})
