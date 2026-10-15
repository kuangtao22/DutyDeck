import type { PrototypeDraft, PrototypeDocument, PrototypeGroup, PrototypeHandoff } from '@proma/shared'

/** 页面目录树节点；children 只表示分组层级，页面仍由当前 draft.pages 按 groupId 关联。 */
export interface PrototypeGroupTreeNode {
  group: PrototypeGroup
  children: PrototypeGroupTreeNode[]
}

/** 冻结设计正文，避免候选/表单修改已采纳对象。 */
export function copyPrototypeDraft(document: PrototypeDraft): PrototypeDraft {
  return structuredClone({ name: document.name, platform: document.platform, brief: document.brief, groups: document.groups, pages: document.pages, entryPageId: document.entryPageId, flows: document.flows })
}

/** 将扁平分组索引为稳定的多级目录树，保留正文数组顺序。 */
export function buildPrototypeGroupTree(draft: PrototypeDraft): PrototypeGroupTreeNode[] {
  const nodes = new Map(draft.groups.map(group => [group.id, { group, children: [] as PrototypeGroupTreeNode[] }]))
  const roots: PrototypeGroupTreeNode[] = []
  for (const group of draft.groups) {
    const node = nodes.get(group.id)
    if (!node) continue
    const parent = group.parentId ? nodes.get(group.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

/** 删除仅有空子树的分组，避免悄悄丢失页面归属或重写入口。 */
export function deletePrototypeGroup(draft: PrototypeDraft, groupId: string): PrototypeDraft {
  const group = draft.groups.find(item => item.id === groupId)
  if (!group) return copyPrototypeDraft(draft)
  if (draft.groups.length <= 1 || draft.pages.some(page => page.groupId === groupId) || draft.groups.some(item => item.parentId === groupId)) throw new Error('分组非空或仅剩一个分组，不能删除')
  const next = copyPrototypeDraft(draft)
  next.groups = next.groups.filter(item => item.id !== groupId)
  return next
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

/** 将固定交接包压缩为主会话可读的开发约束，正文通过固定 revision 按需读取。 */
export function buildPrototypeHandoffPrompt(handoff: PrototypeHandoff): string {
  const summary = {
    handoffId: handoff.id,
    prototypeId: handoff.prototypeId,
    revision: handoff.revision,
    manifestHash: handoff.manifestHash,
    name: handoff.name,
    platform: handoff.platform,
    brief: handoff.brief,
    viewport: handoff.visualContract.viewport,
    preserve: handoff.visualContract.preserve,
    groups: handoff.groups,
    pages: handoff.pages,
    entryPageId: handoff.entryPageId,
    flows: handoff.flows,
    assets: handoff.assets.map(asset => ({ id: asset.id, name: asset.name, hash: asset.hash, mime: asset.mime, byteSize: asset.byteSize })),
    designTokens: handoff.designTokens,
  }
  return `请根据下面固定的交互设计开发交接包实现 App。先调用 prototype_read_version 读取 prototypeId 对应的完整 revision，保持页面和元素身份；开发完成后在固定 viewport 截图对比并说明偏差。交接包只代表设计基线，不代表业务接口、权限和异常逻辑已经实现。\n\n${JSON.stringify(summary, null, 2)}`
}
