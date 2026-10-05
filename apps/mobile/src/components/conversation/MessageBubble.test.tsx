import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Message, ToolResultContent } from '../../atoms'
import { MessageBubble } from './MessageBubble'
import { ProcessBlockGroup } from './ProcessBlockGroup'

/** 用空结果映射渲染不含工具结果的普通消息。 */
const emptyResults = new Map<string, ToolResultContent>()

describe('移动端消息视觉结构', () => {
  test('Given AI 正文和用户正文 When 渲染 Then AI 平铺且用户使用克制强调表面', () => {
    /** 用最小 AI 正文检查平铺结构。 */
    const assistant: Message = { id: 'a', role: 'assistant', content: '回答', model: 'gpt-test' }
    /** 用最小用户正文检查右侧强调表面。 */
    const user: Message = { id: 'u', role: 'user', content: '问题' }
    /** AI 静态标记必须适配长内容且不能保留渐变头像。 */
    const assistantMarkup = renderToStaticMarkup(
      <MessageBubble message={assistant} resultMap={emptyResults} />,
    )
    /** 用户静态标记必须使用语义 secondary 表面。 */
    const userMarkup = renderToStaticMarkup(
      <MessageBubble message={user} resultMap={emptyResults} />,
    )

    expect(assistantMarkup).toContain('data-message-role="assistant"')
    expect(assistantMarkup).toContain('break-words')
    expect(assistantMarkup).not.toContain('bg-gradient-to-br')
    expect(userMarkup).toContain('data-message-role="user"')
    expect(userMarkup).toContain('bg-secondary')
  })

  test('Given 思考和工具调用 When 渲染 Then 默认只显示执行摘要并保留展开入口', () => {
    /** 同一 AI 消息同时覆盖思考和工具调用组合。 */
    const message: Message = {
      id: 'tool',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '分析过程' },
        { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/tmp/a.ts' } },
      ],
    }
    /** 组合标记用于验证历史执行过程默认收起且不泄漏长正文。 */
    const markup = renderToStaticMarkup(
      <MessageBubble message={message} resultMap={emptyResults} />,
    )

    expect(markup).toContain('执行过程')
    expect(markup).toContain('1 次工具调用')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).not.toContain('思考过程')
    expect(markup).not.toContain('读取文件 a.ts')
    expect(markup).not.toMatch(/[🧠📄]/u)
  })

  test('Given 执行过程与最终回答 When 渲染 Then 最终回答常显且过程内容仍可折叠', () => {
    /** 思考和工具位于最终文本之前，覆盖同一助手消息中的完整轮次。 */
    const assistant: Message = {
      id: 'assistant-turn',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '检查文件结构' },
        { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/tmp/config.ts' } },
        { type: 'text', text: '配置已确认。' },
      ],
    }
    /** 普通过程结果用于验证工具摘要可由调用 ID 关联。 */
    const resultMap = new Map<string, ToolResultContent>([
      ['read-1', { type: 'tool_result', tool_use_id: 'read-1', content: 'export const ready = true' }],
    ])
    /** 最终回答与过程摘要同时存在，细节仍留在闭合的过程组内。 */
    const markup = renderToStaticMarkup(
      <MessageBubble message={assistant} resultMap={resultMap} />,
    )

    expect(markup).toContain('执行过程')
    expect(markup).toContain('配置已确认。')
    expect(markup).not.toContain('export const ready = true')
  })

  test('Given 用户展开执行过程 When 过程内工具失败 Then 保留思考、工具输入和错误结果', () => {
    /** 有序过程块覆盖思考与失败工具的详情内容。 */
    const blocks = [
      { type: 'thinking', thinking: '需要确认目录' },
      { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'pwd' } },
    ] as const
    /** 失败结果按 tool_use_id 配对并保留错误文本。 */
    const resultMap = new Map<string, ToolResultContent>([
      ['bash-1', { type: 'tool_result', tool_use_id: 'bash-1', content: 'permission denied', is_error: true }],
    ])
    /** 初始展开用于直接覆盖用户主动查看到的完整详情状态。 */
    const markup = renderToStaticMarkup(
      <ProcessBlockGroup blocks={[...blocks]} resultMap={resultMap} defaultExpanded />,
    )

    expect(markup).toContain('需要确认目录')
    expect(markup).toContain('pwd')
    expect(markup).toContain('执行失败')
    expect(markup).toContain('permission denied')
  })
})
