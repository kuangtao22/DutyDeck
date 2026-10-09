import type { PromaPermissionMode } from '@proma/shared'
import type { CapabilityFactoryAgentApproval } from './capability-factory-agent-facade'

/** 按宿主真实快照决定写操作权限；自动优化可连续执行，采纳始终交给用户。 */
export function getCapabilityFactoryMutationPolicy(
  mode: PromaPermissionMode,
  approval: CapabilityFactoryAgentApproval | null,
): 'allow' | 'ask' | 'deny' {
  if (mode === 'plan' || !approval) return 'deny'
  if (approval.kind === 'operation' && (approval.operation === 'adoptDraft' || approval.destructive)) return 'ask'
  return 'allow'
}
