import { describe, expect, test } from 'bun:test'
import type { ContentBlock } from '../../atoms'
import { splitAssistantProcessBlocks, summarizeAssistantProcessBlocks } from './process-blocks'

describe('移动端 Agent 执行过程分组', () => {
  test('Given 思考、工具和过程说明后接最终回复 When 分组 Then 保留顺序并把末尾回复独立展示', () => {
    /** 同一助手消息覆盖桌面端执行过程组的典型块顺序。 */
    const blocks: ContentBlock[] = [
      { type: 'thinking', thinking: '先检查文件' },
      { type: 'text', text: '正在读取配置' },
      { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/tmp/a.ts' } },
      { type: 'text', text: '配置已确认' },
    ]
    /** 分组结果用于验证过程与最终回答的职责边界。 */
    const result = splitAssistantProcessBlocks(blocks)

    expect(result.processBlocks.map((block) => block.type)).toEqual(['thinking', 'text', 'tool_use'])
    expect(result.answerBlocks).toEqual([{ type: 'text', text: '配置已确认' }])
    expect(summarizeAssistantProcessBlocks(result.processBlocks)).toEqual({ toolCount: 1, messageCount: 2 })
  })

  test('Given 只有普通文本 When 分组 Then 不制造执行过程区', () => {
    /** 普通回复不得因新过程组逻辑改变原有平铺展示。 */
    const blocks: ContentBlock[] = [{ type: 'text', text: '普通回答' }]
    /** 纯文本分组结果用于锁定默认消息行为。 */
    const result = splitAssistantProcessBlocks(blocks)

    expect(result.processBlocks).toEqual([])
    expect(result.answerBlocks).toEqual(blocks)
  })

  test('Given 没有最终文本的思考与工具块 When 分组 Then 整段过程仍可查看', () => {
    /** 无最终回答的中断/运行中历史仍保留全部过程证据。 */
    const blocks: ContentBlock[] = [
      { type: 'thinking', thinking: '正在判断' },
      { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'pwd' } },
    ]
    /** 过程独占消息不得被分组逻辑丢弃。 */
    const result = splitAssistantProcessBlocks(blocks)

    expect(result.processBlocks).toEqual(blocks)
    expect(result.answerBlocks).toEqual([])
  })
})
