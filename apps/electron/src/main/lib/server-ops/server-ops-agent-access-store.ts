import { isServerOpsId, parseServerOpsAgentReadAccess, parseServerOpsAgentReadGrant, serverOpsReadResourceKey } from '@proma/shared'
import type { ServerOpsAgentAccess, ServerOpsAgentReadAccess, ServerOpsAgentReadChanged, ServerOpsAgentReadGrant } from '@proma/shared'
import type { ServerOpsAgentReadAccessPersistence } from './server-ops-agent-read-access-persistence'

/** 仅主进程持有的配置身份摘要；hostId 同时标明 SSH 网络路径的撤权依赖。 */
export interface ServerOpsAgentReadBinding {
  key: string
  fingerprint: string
  hostId?: string
}

/** 授权时间来自注入时钟；旧测试时钟字段保留但不再参与权限截止。 */
export interface ServerOpsReadClock {
  now(): number
  monotonicNow?(): number
  setTimeout?(callback: () => void, delay: number): unknown
  clearTimeout?(handle: unknown): void
}

/** 一个永久授权快照与只由主进程使用的连接身份绑定。 */
interface ReadAuthorization {
  access: ServerOpsAgentReadAccess
  bindings: Map<string, ServerOpsAgentReadBinding>
}

/** 磁盘文件中用于跨进程比较与恢复的版本化状态。 */
interface PersistedReadAuthorizationState {
  version: 1
  revision: number
  accesses: Array<{ access: ServerOpsAgentReadAccess; bindings: ServerOpsAgentReadBinding[] }>
}

/** 限制可恢复的会话授权数量，避免配置膨胀；单文件还受字节上限保护。 */
const MAX_READ_SESSIONS = 32

/** 主进程服务器 Agent 授权 Store；新旧 SSH 授权并存以兼容旧会话，用户撤销时按资源收回。 */
export class ServerOpsAgentAccessStore {
  /** 旧版 SSH 授权仍使用全局单槽，保留到旧版会话明确撤销。 */
  private current: ServerOpsAgentAccess | undefined
  /** 会话隔离的持久只读授权；最多三十二个会话。 */
  private readonly readAccesses = new Map<string, ReadAuthorization>()
  /** 全局单调代次持久保存，防止重启后撤权再授接纳旧结果。 */
  private readRevision = 0
  /** 公开事件订阅者；每个订阅者得到独立快照。 */
  private readonly readListeners = new Set<(event: ServerOpsAgentReadChanged) => void>()

  /** 注入授权时间和持久层；应用启动时恢复并校验已有授权。 */
  constructor(
    private readonly clock: ServerOpsReadClock = { now: () => Date.now() },
    private readonly persistence?: ServerOpsAgentReadAccessPersistence,
  ) {
    this.refreshFromPersistence()
  }

  /** 查询指定会话与服务器的精确操作授权。 */
  get(sessionId: string, hostId: string): ServerOpsAgentAccess | undefined {
    if (this.current?.sessionId !== sessionId || this.current.hostId !== hostId) return undefined
    return { ...this.current }
  }

  /** 返回当前唯一旧操作授权快照。 */
  getCurrent(): ServerOpsAgentAccess | undefined {
    return this.current ? { ...this.current } : undefined
  }

  /** 授予旧操作权限，先持久撤销所有只读授权再发布新状态。 */
  grant(access: ServerOpsAgentAccess): void {
    this.refreshFromPersistence()
    /** 旧入口沿用全局替换语义，撤销原子写入共享配置；后续统一授权仍可独立新增。 */
    this.replaceReadAccesses(new Map([...this.readAccesses.keys()].map((sessionId) => [sessionId, undefined])), () => {
      this.current = { ...access, granted: true }
    })
  }

  /** 查询会话永久只读快照；每次从共享配置 fresh-read 以感知其它实例撤权。 */
  getReadAccess(sessionId: string): ServerOpsAgentReadAccess | undefined {
    this.refreshFromPersistence()
    const access = this.readAccesses.get(sessionId)?.access
    return access ? structuredClone(access) : undefined
  }

  /** 枚举所有持久授权，只返回深复制的公开字段。 */
  listReadAccesses(): ServerOpsAgentReadAccess[] {
    this.refreshFromPersistence()
    return [...this.readAccesses.values()].map(({ access }) => structuredClone(access))
  }

  /** 只可在指定会话中读取配置绑定，禁止跨会话同名资源串用。 */
  getReadBinding(sessionId: string, key: string): ServerOpsAgentReadBinding | undefined {
    this.refreshFromPersistence()
    const binding = this.readAccesses.get(sessionId)?.bindings.get(key)
    return binding ? { ...binding } : undefined
  }

  /** 原子保存用户选择与可信主进程捕获的身份；空集合仅撤销该会话。 */
  grantRead(input: ServerOpsAgentReadGrant, bindings: ServerOpsAgentReadBinding[]): ServerOpsAgentReadAccess | undefined {
    this.refreshFromPersistence()
    const grant = parseServerOpsAgentReadGrant(input)
    if (grant.resources.length === 0) {
      this.replaceRead(grant.sessionId)
      return undefined
    }
    const keys = new Set(grant.resources.map(serverOpsReadResourceKey))
    if (bindings.length !== keys.size || new Set(bindings.map((binding) => binding.key)).size !== keys.size
      || bindings.some((binding) => !keys.has(binding.key) || !binding.fingerprint)) throw new Error('SERVER_OPS_READ_BINDING_INVALID')
    if (!this.readAccesses.has(grant.sessionId) && this.readAccesses.size >= MAX_READ_SESSIONS) throw new Error('SERVER_OPS_READ_SESSION_LIMIT')
    const grantedAt = this.clock.now()
    if (!Number.isSafeInteger(grantedAt) || grantedAt < 0) throw new Error('SERVER_OPS_READ_CLOCK_INVALID')
    const access: ServerOpsAgentReadAccess = { ...grant, revision: 0, grantedAt }
    const authorization: ReadAuthorization = {
      access,
      bindings: new Map(bindings.map((binding) => [binding.key, { ...binding }])),
    }
    this.replaceRead(grant.sessionId, authorization)
    return this.getReadAccess(grant.sessionId)
  }

  /** 订阅只读权限变化；观察者异常不得打断撤权。 */
  onReadChanged(listener: (event: ServerOpsAgentReadChanged) => void): () => void {
    this.readListeners.add(listener)
    return () => { this.readListeners.delete(listener) }
  }

  /** 配置复核只缩减所检查的会话与代次，不误撤其它会话已确认的新身份。 */
  revokeReadResource(sessionId: string, key: string, expectedRevision: number): boolean {
    this.refreshFromPersistence()
    const authorization = this.readAccesses.get(sessionId)
    if (!authorization || authorization.access.revision !== expectedRevision) return false
    const resources = authorization.access.resources.filter((resource) => serverOpsReadResourceKey(resource) !== key)
    if (resources.length === authorization.access.resources.length) return false
    const bindings = new Map(authorization.bindings)
    bindings.delete(key)
    this.replaceRead(sessionId, resources.length ? { access: { ...authorization.access, resources }, bindings } : undefined)
    return true
  }

  /** 撤销所有会话中的指定数据连接，不影响其它资源。 */
  revokeSource(sourceId: string): boolean {
    return this.removeReadResources(new Set([`data:${sourceId}`]))
  }

  /** 从每个会话移除指定资源，并用一次原子写入提交全部缩权。 */
  private removeReadResources(keys: Set<string>): boolean {
    this.refreshFromPersistence()
    const changes = new Map<string, ReadAuthorization | undefined>()
    for (const [sessionId, authorization] of this.readAccesses) {
      const resources = authorization.access.resources.filter((resource) => !keys.has(serverOpsReadResourceKey(resource)))
      if (resources.length === authorization.access.resources.length) continue
      if (resources.length === 0) {
        changes.set(sessionId, undefined)
      } else {
        const bindings = new Map(authorization.bindings)
        for (const key of keys) bindings.delete(key)
        changes.set(sessionId, { access: { ...authorization.access, resources }, bindings })
      }
    }
    if (changes.size === 0) return false
    this.replaceReadAccesses(changes)
    return true
  }

  /** 重新读取持久状态，跨运行实例撤销后当前进程也会立即采用新代次。 */
  private refreshFromPersistence(): void {
    if (!this.persistence) return
    const next = parsePersistedReadAuthorizationState(this.persistence.load())
    if (next.revision < this.readRevision) throw new Error('SERVER_OPS_AGENT_ACCESS_STORE_ROLLBACK')
    const current = serializeReadAuthorizationState(this.readAccesses, this.readRevision)
    const normalizedNext = serializeReadAuthorizationState(new Map(next.accesses.map(({ access, bindings }) => [access.sessionId, {
      access,
      bindings: new Map(bindings.map((binding) => [binding.key, binding])),
    }])), next.revision)
    if (next.revision === this.readRevision) {
      if (JSON.stringify(current) !== JSON.stringify(normalizedNext)) throw new Error('SERVER_OPS_AGENT_ACCESS_REVISION_INVALID')
      return
    }
    const previous = new Map(this.readAccesses)
    this.readAccesses.clear()
    for (const entry of next.accesses) {
      this.readAccesses.set(entry.access.sessionId, {
        access: entry.access,
        bindings: new Map(entry.bindings.map((binding) => [binding.key, binding])),
      })
    }
    this.readRevision = next.revision
    for (const sessionId of new Set([...previous.keys(), ...this.readAccesses.keys()])) {
      const before = previous.get(sessionId)?.access ?? null
      const after = this.readAccesses.get(sessionId)?.access ?? null
      if (JSON.stringify(before) === JSON.stringify(after)) continue
      this.notifyReadChanged(before, after)
    }
  }

  /** 兼容无持久层测试，并统一单会话替换与资源缩权逻辑。 */
  private replaceRead(sessionId: string, next?: ReadAuthorization, beforeNotify?: () => void): void {
    this.replaceReadAccesses(new Map([[sessionId, next]]), beforeNotify)
  }

  /** 先持久提交整组状态，再更新内存和广播，持久写失败时保持旧授权。 */
  private replaceReadAccesses(changes: Map<string, ReadAuthorization | undefined>, beforeNotify?: () => void): void {
    const nextAccesses = new Map(this.readAccesses)
    const events: Array<{ previous: ServerOpsAgentReadAccess | null; current: ServerOpsAgentReadAccess | null }> = []
    let nextRevision = this.readRevision
    for (const [sessionId, next] of changes) {
      const previous = nextAccesses.get(sessionId)
      if (!previous && !next) continue
      nextRevision += 1
      if (next) {
        const committed = { ...next, access: { ...next.access, revision: nextRevision } }
        nextAccesses.set(sessionId, committed)
        events.push({ previous: previous ? structuredClone(previous.access) : null, current: structuredClone(committed.access) })
      } else {
        nextAccesses.delete(sessionId)
        events.push({ previous: structuredClone(previous!.access), current: null })
      }
    }
    if (events.length > 0) {
      this.persistence?.save(serializeReadAuthorizationState(nextAccesses, nextRevision), this.readRevision)
      this.readAccesses.clear()
      for (const [sessionId, authorization] of nextAccesses) this.readAccesses.set(sessionId, authorization)
      this.readRevision = nextRevision
    }
    beforeNotify?.()
    for (const event of events) this.notifyReadChanged(event.previous, event.current)
  }

  /** 让每个订阅者收到独立快照，避免监听异常打断后续撤权通知。 */
  private notifyReadChanged(previous: ServerOpsAgentReadAccess | null, current: ServerOpsAgentReadAccess | null): void {
    for (const listener of this.readListeners) {
      try { listener({ previous: previous ? structuredClone(previous) : null, current: current ? structuredClone(current) : null }) } catch { /* 撤权优先。 */ }
    }
  }

  /** 仅撤销完全匹配的旧会话与服务器组合。 */
  revoke(sessionId: string, hostId: string): boolean {
    if (this.current?.sessionId !== sessionId || this.current.hostId !== hostId) return false
    this.current = undefined
    return true
  }

  /** 只撤销旧 SSH 操作授权，不触碰持久只读授权。 */
  revokeLegacySession(sessionId: string): boolean {
    if (this.current?.sessionId !== sessionId) return false
    this.current = undefined
    return true
  }

  /** 撤销指定会话的旧操作权限与持久只读授权。 */
  revokeSession(sessionId: string): boolean {
    this.refreshFromPersistence()
    const hasRead = this.readAccesses.has(sessionId)
    if (hasRead) this.replaceRead(sessionId)
    const legacy = this.revokeLegacySession(sessionId)
    return legacy || hasRead
  }

  /** 撤销指定服务器旧权限及所有依赖它的持久只读资源。 */
  revokeHost(hostId: string): boolean {
    this.refreshFromPersistence()
    const keys = new Set<string>()
    for (const authorization of this.readAccesses.values()) {
      for (const binding of authorization.bindings.values()) if (binding.hostId === hostId) keys.add(binding.key)
    }
    const read = keys.size > 0 && this.removeReadResources(keys)
    const legacy = this.current?.hostId === hostId
    if (legacy) this.current = undefined
    return read || legacy
  }

  /** 服务上下文拆卸时撤销旧操作权限但保留用户明确授予的持久只读权限。 */
  clearTransientAccess(): void {
    this.current = undefined
  }

  /** 显式清除全部授权并持久写入空状态。 */
  clear(): void {
    this.refreshFromPersistence()
    const changes = new Map([...this.readAccesses.keys()].map((sessionId) => [sessionId, undefined]))
    this.replaceReadAccesses(changes, () => { this.current = undefined })
  }
}

/** 严格解析持久授权并验证资源与内部身份绑定一一对应。 */
function parsePersistedReadAuthorizationState(value: unknown): PersistedReadAuthorizationState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('SERVER_OPS_AGENT_ACCESS_STORE_INVALID')
  const state = value as Record<string, unknown>
  if (Object.keys(state).length !== 3 || state.version !== 1 || typeof state.revision !== 'number'
    || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.accesses)
    || state.accesses.length > MAX_READ_SESSIONS) throw new Error('SERVER_OPS_AGENT_ACCESS_STORE_INVALID')
  /** 已验证的授权代次供后续闭包安全比较。 */
  const revision = state.revision
  const sessions = new Set<string>()
  const accesses = state.accesses.map((raw): PersistedReadAuthorizationState['accesses'][number] => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('SERVER_OPS_AGENT_ACCESS_STORE_INVALID')
    const entry = raw as Record<string, unknown>
    if (Object.keys(entry).length !== 2 || !('access' in entry) || !('bindings' in entry) || !Array.isArray(entry.bindings)) {
      throw new Error('SERVER_OPS_AGENT_ACCESS_STORE_INVALID')
    }
    const access = parseServerOpsAgentReadAccess(entry.access)
    if (!access || access.expiresAt !== undefined || access.revision > revision || sessions.has(access.sessionId)) {
      throw new Error('SERVER_OPS_AGENT_ACCESS_STORE_INVALID')
    }
    sessions.add(access.sessionId)
    const keys = new Set(access.resources.map(serverOpsReadResourceKey))
    if (entry.bindings.length !== keys.size) throw new Error('SERVER_OPS_AGENT_ACCESS_STORE_INVALID')
    const bindingKeys = new Set<string>()
    const bindings = entry.bindings.map((rawBinding): ServerOpsAgentReadBinding => {
      if (typeof rawBinding !== 'object' || rawBinding === null || Array.isArray(rawBinding)) throw new Error('SERVER_OPS_AGENT_ACCESS_STORE_INVALID')
      const binding = rawBinding as Record<string, unknown>
      const allowed = binding.hostId === undefined ? ['key', 'fingerprint'] : ['key', 'fingerprint', 'hostId']
      if (Object.keys(binding).length !== allowed.length || Object.keys(binding).some((key) => !allowed.includes(key))
        || typeof binding.key !== 'string' || !keys.has(binding.key) || bindingKeys.has(binding.key)
        || typeof binding.fingerprint !== 'string' || !/^[a-f\d]{64}$/u.test(binding.fingerprint)
        || (binding.hostId !== undefined && (typeof binding.hostId !== 'string' || !isServerOpsId(binding.hostId)))) {
        throw new Error('SERVER_OPS_AGENT_ACCESS_STORE_INVALID')
      }
      bindingKeys.add(binding.key)
      return { key: binding.key, fingerprint: binding.fingerprint, ...(typeof binding.hostId === 'string' ? { hostId: binding.hostId } : {}) }
    })
    return { access, bindings }
  })
  return { version: 1, revision, accesses }
}

/** 将授权 Map 转成稳定字段顺序的 JSON 快照。 */
function serializeReadAuthorizationState(
  accesses: Map<string, ReadAuthorization>,
  revision: number,
): PersistedReadAuthorizationState {
  return {
    version: 1,
    revision,
    accesses: [...accesses.values()].map(({ access, bindings }) => ({ access: structuredClone(access), bindings: [...bindings.values()].map((binding) => ({ ...binding })) })),
  }
}
