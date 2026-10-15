import { expect, test } from 'bun:test'
import type { Agent, AgentMessage } from '@earendil-works/pi-agent-core'
import { installPiAttachmentPathProjection } from './pi-attachment-path-projection'

test('Given Pi 恢复历史附档 When 准备模型请求 Then 使用当前绝对路径且保留 transcript 与工具命令', async () => {
  /** 模拟 Pi 原始 transcript，正文中同时包含附档协议和普通路径。 */
  const messages: AgentMessage[] = [
    { role: 'user', timestamp: 1, content: [{ type: 'text', text: '<attached_files>\n- 图片.png: /old/agent-workspaces/w/s/attachments/a.png\n</attached_files>\n原记录 /old/agent-workspaces/w/s/attachments/a.png' }] },
    { role: 'user', timestamp: 2, content: '<attached_files>\n- b.png: dutydeck-data:/attachments/s/b.png\n</attached_files>' },
  ]
  /** 上游转换仍应执行，其新增消息不能丢失。 */
  const upstream: AgentMessage = { role: 'user', timestamp: 3, content: 'cat /old/agent-workspaces/w/s/attachments/a.png' }
  const agent: Pick<Agent, 'transformContext'> = { transformContext: async (input) => [...input, upstream] }
  const original = JSON.stringify(messages)
  installPiAttachmentPathProjection(agent, { activeRoot: '/new', historicalRoots: ['/old'] })
  const projected = await agent.transformContext!(messages)
  expect(JSON.stringify(projected)).toContain('- 图片.png: /new/agent-workspaces/w/s/attachments/a.png')
  expect(JSON.stringify(projected)).toContain('- b.png: /new/attachments/s/b.png')
  expect(JSON.stringify(projected)).toContain('原记录 /old/agent-workspaces/w/s/attachments/a.png')
  expect(projected[2]).toBe(upstream)
  expect(JSON.stringify(messages)).toBe(original)
})

test('Given 未提供宿主根快照 When 安装兼容投影 Then 保持既有 transformContext', () => {
  /** 旧适配器调用方缺少快照时不能从 utility 的 cwd 猜测数据根。 */
  const agent: Pick<Agent, 'transformContext'> = { transformContext: async (messages) => messages }
  const previous = agent.transformContext
  installPiAttachmentPathProjection(agent, undefined)
  expect(agent.transformContext).toBe(previous)
})
