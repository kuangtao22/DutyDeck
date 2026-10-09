import { describe, expect, test } from 'bun:test'
import { PROMA_PERMISSION_MODES } from '@proma/shared'
import type { CapabilityFactoryAgentApproval } from './capability-factory-agent-facade'
import { getCapabilityFactoryMutationPolicy } from './capability-factory-permission-policy'

/** 构造宿主签发的操作快照，模拟自动优化中需要经过的权限节点。 */
function operation(kind: 'adoptDraft' | 'createDataset' | 'addDatasetCases' | 'deleteScene'): CapabilityFactoryAgentApproval {
  return { kind: 'operation', tool: 'factory_apply_operation', operation: kind, title: kind,
    lines: [], destructive: kind === 'deleteScene', appliesImmediately: kind === 'adoptDraft' }
}

describe('工厂自主优化与采纳审核', () => {
  test('Given 任意执行权限模式 When 采纳草案 Then 始终需要单次用户审核', () => {
    for (const mode of PROMA_PERMISSION_MODES.filter((item) => item !== 'plan')) {
      expect(getCapabilityFactoryMutationPolicy(mode, operation('adoptDraft'))).toBe('ask')
    }
  })
  test('Given 正常执行模式 When 修改候选或准备数据 Then 不逐轮打断自动优化', () => {
    const draft: CapabilityFactoryAgentApproval = { kind: 'draft', tool: 'factory_save_draft', sceneId: 's', sceneName: '场景', currentVersion: 1, changes: [], appliesImmediately: false, note: '候选' }
    for (const snapshot of [draft, operation('createDataset'), operation('addDatasetCases')]) {
      expect(getCapabilityFactoryMutationPolicy('bypassPermissions', snapshot)).toBe('allow')
    }
  })
  test('Given 计划模式或缺少真实快照 When 申请写入 Then 拒绝且不能绕过审核', () => {
    expect(getCapabilityFactoryMutationPolicy('plan', operation('adoptDraft'))).toBe('deny')
    expect(getCapabilityFactoryMutationPolicy('plan', operation('createDataset'))).toBe('deny')
    expect(getCapabilityFactoryMutationPolicy('bypassPermissions', null)).toBe('deny')
  })
  test('Given 无需逐次确认的模式 When 删除内容 Then 仍然等待审核', () => {
    expect(getCapabilityFactoryMutationPolicy('bypassPermissions', operation('deleteScene'))).toBe('ask')
  })
})
