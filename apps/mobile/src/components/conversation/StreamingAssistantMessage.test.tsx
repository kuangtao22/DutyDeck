import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MobileStreamSegments } from '../../atoms'
import { StreamingAssistantMessage } from './StreamingAssistantMessage'

describe('移动端助手实时消息', () => {
  test('Given 只有思考增量 When 渲染 Then 显示思考状态且内容收在次级区域', () => {
    /** 无正文快照模拟模型仍处于思考阶段。 */
    const segments: MobileStreamSegments = { answer: '', reasoning: '正在检查输入' }
    /** 实时消息静态输出用于验证思考与回答语义分离。 */
    const markup = renderToStaticMarkup(<StreamingAssistantMessage segments={segments} />)

    expect(markup).toContain('思考中')
    expect(markup).toContain('思考过程')
    expect(markup).toContain('正在检查输入')
    expect(markup).not.toContain('回答中')
  })

  test('Given 思考与回答均有增量 When 渲染 Then 回答成为主内容且思考仍可访问', () => {
    /** 双通道快照模拟流式思考结束并开始生成回答。 */
    const segments: MobileStreamSegments = { answer: '检查完成。', reasoning: '正在检查输入' }
    /** 主内容与次级思考区域共同覆盖完整生成状态。 */
    const markup = renderToStaticMarkup(<StreamingAssistantMessage segments={segments} />)

    expect(markup).toContain('回答中')
    expect(markup).toContain('思考过程')
    expect(markup).toContain('检查完成。')
    expect(markup).toContain('正在检查输入')
  })
})
