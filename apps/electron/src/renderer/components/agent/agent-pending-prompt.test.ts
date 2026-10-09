import { describe, expect, test } from 'bun:test'
import { buildAutoPendingPromptSubmission, claimAgentPendingPrompt } from './agent-pending-prompt'

describe('Agent 自动提示词', () => {
  test('Given 知识维护任务 When 构造提交参数 Then 不打断当前任务并保留 Skill 引用', () => {
    const result = buildAutoPendingPromptSubmission({
      sessionId: 'agent-1',
      message: '更新项目知识库',
      autoSend: true,
      mentionedSkills: ['knowledge-maintenance'],
    }, {
      channelId: 'channel-1',
      modelId: 'model-1',
      workspaceId: 'workspace-1',
      toolMode: 'standard',
      permissionMode: 'bypassPermissions',
      queueMessageId: 'queue-1',
    })

    expect(result).toMatchObject({
      sessionId: 'agent-1',
      dispatch: 'after_current',
      interrupt: false,
      mentionedSkills: ['knowledge-maintenance'],
    })
  })

  test('Given 首次挂载已领取任务 When AgentView 重新挂载 Then 同一任务不能再次领取', () => {
    const prompt = { sessionId: 'agent-1', message: '更新项目知识库', autoSend: true }
    const first = claimAgentPendingPrompt(prompt, prompt)
    const second = claimAgentPendingPrompt(first.next, prompt)

    expect(first.claimed).toBe(true)
    expect(first.next).toBeNull()
    expect(second.claimed).toBe(false)
  })
})
