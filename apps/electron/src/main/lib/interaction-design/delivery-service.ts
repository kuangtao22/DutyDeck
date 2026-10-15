import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { PrototypeDocument, InteractionDesignResults, PrototypeHandoff, PrototypeHandoffGroup } from '@proma/shared'
import { buildPrototypeExport } from '@proma/shared'
import { writeJsonFileAtomicSecure } from '../safe-file'
import type { InteractionAssetService } from './asset-service'
import { interactionHash } from './source-service'

/** 固定版本生成可离线打开的单 HTML，所有引用图片都复制为内嵌数据。 */
export function createInteractionDelivery(document: PrototypeDocument, assets: InteractionAssetService, directory: string): InteractionDesignResults['exportHtml'] {
  /** 本版本实际使用的图片字节；不扫描或导出无关素材。 */
  const imageData: Record<string, string> = {}
  /** 去重后的逻辑图片身份。 */
  const ids = new Set(document.pages.flatMap(page => [...page.html.matchAll(/prototype-asset:([A-Za-z0-9_-]+)/g)].map(match => match[1]!)))
  /** 内嵌图片最大总量，避免主进程无界分配。 */
  let bytes = 0
  for (const id of ids) {
    /** 已经再次校验 hash 的图片内容。 */
    const content = assets.content(id)
    bytes += content.dataUrl.length
    if (bytes > 64 * 1024 * 1024) throw new Error('交付图片总量超过 64 MiB，请减少图片')
    imageData[id] = content.dataUrl
  }
  /** 离线 HTML 只来自当前读取的固定版本。 */
  const html = buildPrototypeExport(document, imageData)
  /** 独立交付身份。 */
  const deliveryId = randomUUID()
  /** 安全可下载文件名。 */
  const fileName = `${document.name.replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 80) || 'prototype'}-v${document.revision}.html`
  writeJsonFileAtomicSecure(join(directory, `${deliveryId}.json`), { schemaVersion: 1, id: deliveryId, prototypeId: document.id, revision: document.revision, htmlHash: interactionHash(html), assetIds: [...ids], createdAt: Date.now(), fileName }, { expectedDestination: { kind: 'missing' } })
  return { deliveryId, fileName, html, revision: document.revision }
}

/** 从固定版本生成开发交接包；只写元数据和页面结构，不复制图片字节。 */
export function createInteractionHandoff(document: PrototypeDocument, assets: InteractionAssetService, directory: string): PrototypeHandoff {
  /** 计算分组的完整显示路径，防止开发时同名分组产生歧义。 */
  const groupsById = new Map(document.groups.map(group => [group.id, group]))
  const pathCache = new Map<string, string>()
  const groupPath = (groupId: string): string => {
    const cached = pathCache.get(groupId)
    if (cached) return cached
    const names: string[] = []
    const seen = new Set<string>()
    let current = groupsById.get(groupId)
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      names.unshift(current.name)
      current = current.parentId ? groupsById.get(current.parentId) : undefined
    }
    const path = names.join(' / ')
    pathCache.set(groupId, path)
    return path
  }
  /** 只暴露页面声明的稳定元素，不把任意 DOM 文本当作元素身份。 */
  const elementIds = (html: string): string[] => {
    const ids = new Set<string>()
    for (const match of html.matchAll(/data-prototype-element\s*=\s*["']([^"']+)["']/gi)) {
      if (match[1]) ids.add(match[1])
    }
    return [...ids]
  }
  /** CSS 自定义属性是当前原型可复用的最小视觉 token 集合。 */
  const designTokens: Record<string, string> = {}
  for (const page of document.pages) {
    for (const match of page.html.matchAll(/--([A-Za-z0-9_-]+)\s*:\s*([^;}{]+)/g)) {
      const key = `--${match[1]}`
      const value = match[2]!.trim()
      if (!value) continue
      designTokens[key] = designTokens[key] && designTokens[key] !== value ? '<multiple values>' : value
    }
  }
  /** 只收集当前版本页面实际引用的素材，避免交接包带出无关资源。 */
  const referencedAssetIds = new Set(document.pages.flatMap(page => [...page.html.matchAll(/prototype-asset:([A-Za-z0-9_-]+)/g)].map(match => match[1]!)))
  const knownAssets = assets.list()
  const referencedAssets = knownAssets.filter(asset => referencedAssetIds.has(asset.id))
  if (referencedAssets.length !== referencedAssetIds.size) throw new Error('原型引用了不存在的项目素材，无法生成开发交接包')
  const groups: PrototypeHandoffGroup[] = document.groups.map(group => ({
    id: group.id,
    name: group.name,
    ...(group.parentId ? { parentId: group.parentId } : {}),
    path: groupPath(group.id),
  }))
  const pages = document.pages.map(page => ({
    id: page.id,
    name: page.name,
    groupId: page.groupId,
    groupPath: groupPath(page.groupId),
    elementIds: elementIds(page.html),
    flowIds: document.flows.filter(flow => flow.fromPageId === page.id).map(flow => flow.id),
  }))
  const viewport = document.platform === 'mobile' ? { width: 390, height: 844 } : { width: 1280, height: 800 }
  const visualContract: PrototypeHandoff['visualContract'] = {
    viewport,
    preserve: ['页面布局比例与层级', '字体层级、颜色、间距、圆角和组件尺寸', '页面之间的交互路径与入口关系', '加载、空态、失败和恢复状态的表达'],
  }
  /** hash 不包含交接包身份和生成时间，便于同一版本重复交接时稳定比较。 */
  const manifest = {
    schemaVersion: 1 as const,
    prototypeId: document.id,
    revision: document.revision,
    name: document.name,
    platform: document.platform,
    brief: document.brief,
    groups,
    pages,
    entryPageId: document.entryPageId,
    flows: document.flows,
    assets: referencedAssets,
    designTokens,
    visualContract,
  }
  const manifestHash = interactionHash(JSON.stringify(manifest))
  const handoff: PrototypeHandoff = { ...manifest, id: randomUUID(), createdAt: Date.now(), manifestHash }
  /** 交接包按不可变 delivery 记录保存，后续版本不会改变本次交接事实。 */
  writeJsonFileAtomicSecure(join(directory, `${handoff.id}.handoff.json`), handoff, { expectedDestination: { kind: 'missing' } })
  return handoff
}
