import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { PrototypeDocument, InteractionDesignResults } from '@proma/shared'
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
