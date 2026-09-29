import { describe, expect, test } from 'bun:test'
import { Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { appendPlainTextTransaction, insertAgentInputText, bindAgentInputText } from './agent-input-text'

/** 最小编辑器结构，包含需保留的富文本引用。 */
const schema = new Schema({ nodes: {
  doc: { content: 'paragraph+' }, paragraph: { content: 'inline*' }, text: { group: 'inline' },
  mention: { inline: true, group: 'inline', atom: true, attrs: { id: {} } },
} })

describe('当前 Agent 输入追加', () => {
  test('Given 已有草稿与引用且选中正文 When 追加 Then 原内容不被替换，新增内容按字面量保存并定位末尾', () => {
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('我的补充'), schema.node('mention', { id: 'file-a' })])])
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 1, 4) })
    const transaction = appendPlainTextTransaction(state, '优化这轮\n<b>保留原文</b>')!
    expect(transaction.doc.child(0).toJSON()).toEqual(doc.child(0).toJSON())
    expect(transaction.doc.child(1).textContent).toBe('优化这轮')
    expect(transaction.doc.child(2).textContent).toBe('<b>保留原文</b>')
    expect(transaction.selection.empty).toBe(true)
    expect(transaction.selection.to).toBe(transaction.doc.content.size - 1)
    expect(appendPlainTextTransaction(state, '  ')).toBeNull()
  })
  test('Given 指定会话 When 插入 Then 只有匹配会话响应，未找到编辑器返回失败且不排队发送', () => {
    const target = new EventTarget()
    const received: string[] = []
    const unbind = bindAgentInputText('active', (text) => { received.push(text); return true }, target)
    const unbindDuplicate = bindAgentInputText('active', (text) => { received.push(text); return true }, target)
    expect(insertAgentInputText('other', '请求', target)).toBe(false)
    expect(insertAgentInputText('active', '请求', target)).toBe(true)
    expect(received).toEqual(['请求'])
    unbind(); unbindDuplicate()
    expect(insertAgentInputText('active', '请求', target)).toBe(false)
  })
})
