import { TextSelection } from '@tiptap/pm/state'
import type { EditorState, Transaction } from '@tiptap/pm/state'

/** 外部面板只向指定会话的编辑器追加草稿，不触发发送或创建会话。 */
export const INSERT_AGENT_INPUT_TEXT_EVENT = 'proma:insert-agent-input-text'

/** 同步应答由持有编辑器的会话填写，避免误报插入成功。 */
export interface InsertAgentInputTextDetail {
  sessionId: string
  text: string
  inserted: boolean
}

/** 根据最新编辑器状态追加纯文本段落；保留已有节点和选区内容，返回单次可撤销事务。 */
export function appendPlainTextTransaction(state: EditorState, text: string): Transaction | null {
  if (!text.trim()) return null
  /** 直接创建文本节点，避免场景名中的 HTML 或 Markdown 被当作编辑器命令。 */
  const paragraphs = text.split(/\r?\n/).map((line) => state.schema.nodes.paragraph!.create(null, line ? state.schema.text(line) : undefined))
  const transaction = state.tr.insert(state.doc.content.size, paragraphs)
  return transaction.setSelection(TextSelection.atEnd(transaction.doc)).scrollIntoView()
}

/** 请求追加并返回真实应答；没有对应编辑器时不保留延迟队列，不影响其他会话。 */
export function insertAgentInputText(sessionId: string, text: string, target: EventTarget = window): boolean {
  const detail: InsertAgentInputTextDetail = { sessionId, text, inserted: false }
  target.dispatchEvent(new CustomEvent<InsertAgentInputTextDetail>(INSERT_AGENT_INPUT_TEXT_EVENT, { detail }))
  return detail.inserted
}

/** 绑定一个会话的编辑器，返回卸载清理函数；首次成功后其他同会话视图不重复插入。 */
export function bindAgentInputText(sessionId: string, append: (text: string) => boolean, target: EventTarget = window): () => void {
  const receive = (event: Event): void => {
    const detail = (event as CustomEvent<InsertAgentInputTextDetail>).detail
    if (!detail || detail.sessionId !== sessionId || detail.inserted) return
    detail.inserted = append(detail.text)
  }
  target.addEventListener(INSERT_AGENT_INPUT_TEXT_EVENT, receive)
  return () => target.removeEventListener(INSERT_AGENT_INPUT_TEXT_EVENT, receive)
}
