import { describe, expect, test } from 'bun:test'
import type { Message } from '../../atoms'
import { groupAssistantMessages } from './process-blocks'

describe('移动端 Assistant turn 聚合', () => {
  test('Given 多条连续助手消息和工具结果 When 聚合 Then 合并为一条完整执行过程', () => {
    /** 模拟桌面端一个用户 turn 被拆成思考、工具、结果、最终回答多条消息。 */
    const messages: Message[] = [
      { id: 'a-1', role: 'assistant', content: [{ type: 'thinking', thinking: '检查文件' }] },
      { id: 'a-2', role: 'assistant', content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: {} }] },
      { id: 'r-1', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'ok' }] },
      { id: 'a-3', role: 'assistant', content: [{ type: 'text', text: '检查完成' }] },
    ]
    /** 工具回传不切断 turn，最终只保留一个 Assistant 组。 */
    const grouped = groupAssistantMessages(messages)

    expect(grouped).toHaveLength(1)
    expect(grouped[0]?.id).toBe('assistant-group:a-1')
    expect(grouped[0]?.content).toEqual([
      { type: 'thinking', thinking: '检查文件' },
      { type: 'tool_use', id: 'read-1', name: 'Read', input: {} },
      { type: 'text', text: '检查完成' },
    ])
  })

  test('Given 两次用户输入之间有助手回复 When 聚合 Then 用户消息保持 turn 边界', () => {
    /** 两个用户问题用于锁定连续助手合并的边界。 */
    const messages: Message[] = [
      { id: 'u-1', role: 'user', content: '第一个问题' },
      { id: 'a-1', role: 'assistant', content: '第一个回答' },
      { id: 'u-2', role: 'user', content: '第二个问题' },
      { id: 'a-2', role: 'assistant', content: '第二个回答' },
    ]
    /** 用户消息顺序不被聚合层改写。 */
    const grouped = groupAssistantMessages(messages)

    expect(grouped.map((message) => message.id)).toEqual(['u-1', 'assistant-group:a-1', 'u-2', 'assistant-group:a-2'])
  })
})
