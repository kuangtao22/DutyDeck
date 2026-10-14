import type { PrototypeDraft, PrototypeDocument } from '@proma/shared'

/** 冻结设计正文，避免候选/表单修改已采纳对象。 */
export function copyPrototypeDraft(document: PrototypeDraft): PrototypeDraft {
  return structuredClone({ name: document.name, platform: document.platform, brief: document.brief, groups: document.groups, pages: document.pages, entryPageId: document.entryPageId, flows: document.flows })
}

/** 每次上下文切换递增代次，旧请求不可提交 UI 状态。 */
export class PrototypeRequestGate {
  /** 当前上下文与请求代次。 */
  private generation = 0
  /** 使先前发出的请求全部失效，返回本次票据。 */
  next(): number { return ++this.generation }
  /** 仅接纳当前代次的结果。 */
  accepts(ticket: number): boolean { return ticket === this.generation }
}

/** 页面目录移动只改变顺序和分组，不改变交互路由。 */
export function movePrototypePage(draft: PrototypeDraft, pageId: string, groupId: string, beforePageId?: string): PrototypeDraft {
  const next = copyPrototypeDraft(draft)
  const page = next.pages.find(item => item.id === pageId)
  if (!page || !next.groups.some(item => item.id === groupId) || beforePageId === pageId) return next
  next.pages = next.pages.filter(item => item.id !== pageId)
  page.groupId = groupId
  const index = beforePageId ? next.pages.findIndex(item => item.id === beforePageId && item.groupId === groupId) : -1
  next.pages.splice(index < 0 ? next.pages.length : index, 0, page)
  return next
}

/** 删除页面同时清理其所有连接；入口与最后一页必须先保留。 */
export function deletePrototypePage(draft: PrototypeDraft, pageId: string): PrototypeDraft {
  if (draft.entryPageId === pageId || draft.pages.length <= 1) throw new Error('入口页或最后一个页面不能删除，请先设置其他入口。')
  const next = copyPrototypeDraft(draft)
  next.pages = next.pages.filter(item => item.id !== pageId)
  next.flows = next.flows.filter(item => item.fromPageId !== pageId && item.targetPageId !== pageId)
  return next
}

/** 引用冻结原型基线和选区；正文不会伪装成已经生成的回复。 */
export function buildPrototypePrompt(document: PrototypeDocument, instruction: string, pageId?: string, elementId?: string): string {
  return `请使用交互设计工具处理以下任务，先读取当前原型，生成候选，勿直接采纳。\nprototypeId: ${document.id}\nbaseRevision: ${document.revision}${pageId ? `\npageId: ${pageId}` : ''}${elementId ? `\nelementId: ${elementId}` : ''}\n\n${instruction}`
}
