import type { ServerOpsAgentReference, ServerOpsAgentReferenceScope } from '@proma/shared'

/** 运维资源引用事件；AgentView 负责把引用插入当前会话编辑器。 */
export const INSERT_SERVER_OPS_REFERENCE_EVENT = 'proma:insert-server-ops-reference'

export interface InsertServerOpsReferenceDetail {
  targetSessionId: string
  reference: ServerOpsAgentReference
  inserted: boolean
}

/** 将稳定身份编码为 mention 文本，避免地址、用户名、密码或连接串进入协议。 */
export function serializeServerOpsReference(reference: ServerOpsAgentReference): string {
  const identity = {
    scope: reference.scope,
    projectId: reference.projectId,
    ...(reference.hostId ? { hostId: reference.hostId } : {}),
    ...(reference.sourceId ? { sourceId: reference.sourceId } : {}),
    ...(reference.database ? { database: reference.database } : {}),
    ...(reference.table ? { table: reference.table } : {}),
  }
  return `&ops:${encodeURIComponent(JSON.stringify(identity))}::${encodeURIComponent(reference.label)}`
}

/** 从 mention 文本中解析引用身份；非法或缺少范围必需字段时返回 null。 */
export function parseServerOpsReference(value: string): ServerOpsAgentReference | null {
  const match = value.match(/^&ops:([^:]+)(?:::(.*))?$/u)
  if (!match) return null
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(match[1]!))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const identity = parsed as Record<string, unknown>
    const scope = identity.scope
    const projectId = identity.projectId
    if (!isScope(scope) || !isSafeIdentifier(projectId)) return null
    const reference: ServerOpsAgentReference = {
      scope,
      projectId,
      ...(isSafeIdentifier(identity.hostId) ? { hostId: identity.hostId } : {}),
      ...(isSafeIdentifier(identity.sourceId) ? { sourceId: identity.sourceId } : {}),
      ...(isSafeIdentifier(identity.database) ? { database: identity.database } : {}),
      ...(isSafeIdentifier(identity.table) ? { table: identity.table } : {}),
      label: match[2] ? decodeURIComponent(match[2]) : '运维资源',
    }
    if (scope === 'server' && !reference.hostId) return null
    if (scope !== 'server' && !reference.sourceId) return null
    if ((scope === 'database' || scope === 'table') && !reference.database) return null
    if (scope === 'table' && !reference.table) return null
    return reference
  } catch {
    return null
  }
}

/** 触发当前 Agent 会话插入资源引用；没有对应会话时由调用方提示用户。 */
export function insertServerOpsReferenceMention(
  targetSessionId: string,
  reference: ServerOpsAgentReference,
): boolean {
  const detail: InsertServerOpsReferenceDetail = { targetSessionId, reference, inserted: false }
  window.dispatchEvent(new CustomEvent<InsertServerOpsReferenceDetail>(INSERT_SERVER_OPS_REFERENCE_EVENT, { detail }))
  return detail.inserted
}

function isScope(value: unknown): value is ServerOpsAgentReferenceScope {
  return value === 'server' || value === 'connection' || value === 'database' || value === 'table'
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value)
}
