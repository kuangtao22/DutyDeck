/** 运维资源引用的范围。引用只携带稳定身份，凭据与连接串永不进入消息。 */
export type ServerOpsAgentReferenceScope = 'server' | 'connection' | 'database' | 'table'

/** Agent 消息中引用的服务器、数据库连接、数据库或数据表。 */
export interface ServerOpsAgentReference {
  /** 引用范围；database/table 必须同时携带 sourceId 与 database。 */
  scope: ServerOpsAgentReferenceScope
  /** 运维项目身份，用于防止同名资源被混用。 */
  projectId: string
  /** SSH 服务器身份。 */
  hostId?: string
  /** 数据库或 Redis 连接身份。 */
  sourceId?: string
  /** 数据库名称；SQLite 固定为 main。 */
  database?: string
  /** 数据表名称。 */
  table?: string
  /** 仅用于界面展示和消息回显，不参与权限判断。 */
  label: string
}

/** 运维资源引用协议前缀，避免与会话、Todo 和日程引用混淆。 */
export const SERVER_OPS_AGENT_REFERENCE_PREFIX = '&ops:'
