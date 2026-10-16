import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrototypeDocument } from '@proma/shared'
import type { InteractionAssetService } from './asset-service'
import { createInteractionDelivery, createInteractionHandoff } from './delivery-service'

test('Given 仅附加状态引用素材与token When 导出交接 Then 包含状态资源与元素', () => {
  /** 隔离临时交付目录，避免写入真实项目数据。 */
  const directory = mkdtempSync(join(tmpdir(), 'prototype-state-delivery-'))
  const document: PrototypeDocument = {
    schemaVersion: 1, id: 'p', revision: 1, createdAt: 1, updatedAt: 1, name: '测试', platform: 'mobile', brief: '', groups: [{ id: 'g', name: '页面' }], entryPageId: 'home', flows: [],
    pages: [{ id: 'home', groupId: 'g', name: '首页', html: '<p>默认</p>', defaultStateName: '有数据', states: [{ id: 'empty', name: '无数据', html: '<style>:root{--empty-color:red}</style><img data-prototype-element="empty-image" src="prototype-asset:empty">' }] }],
  }
  /** 只模拟已授权资源读取边界，断言请求资源身份。 */
  const requested: string[] = []
  const assets = {
    content(id: string) { requested.push(id); return { dataUrl: 'data:image/png;base64,AAAA' } },
    list() { return [{ id: 'empty' }] },
  } as unknown as InteractionAssetService
  try {
    const delivery = createInteractionDelivery(document, assets, directory)
    expect(requested).toEqual(['empty'])
    expect(delivery.html).toContain('data:image/png;base64,AAAA')
    const handoff = createInteractionHandoff(document, assets, directory)
    expect(handoff.designTokens['--empty-color']).toBe('red')
    expect(handoff.assets.map(asset => asset.id)).toEqual(['empty'])
    expect(handoff.pages[0]!.elementIds).toEqual(['empty-image'])
    expect(handoff.pages[0]!.states).toEqual([{ name: '有数据', elementIds: [] }, { id: 'empty', name: '无数据', elementIds: ['empty-image'] }])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
