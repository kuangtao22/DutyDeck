import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LocalModelAsset } from '@proma/shared'
import { getLocalModelsManifestPath } from './config-paths'
import { LocalModelStore } from './local-model-store'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function createStore(): { root: string; store: LocalModelStore } {
  const root = mkdtempSync(join(tmpdir(), 'proma-local-model-store-'))
  temporaryRoots.push(root)
  return { root, store: new LocalModelStore({ configDir: root, now: () => 100 }) }
}

function asset(overrides: Partial<LocalModelAsset> = {}): Omit<LocalModelAsset, 'status' | 'updatedAt'> {
  return {
    assetId: 'qwen3-8b-q4km-r1', modelId: 'qwen3-8b', name: 'Qwen3 8B', family: 'qwen',
    revision: 'r1', fileName: 'qwen3-8b.gguf', sha256: createHash('sha256').update('test-model').digest('hex'), sizeBytes: 10,
    enabled: false, capability: { state: 'unknown' }, ...overrides,
  }
}

describe('LocalModelStore', () => {
  test('首次读取返回空清单并把目录固定在业务根下', () => {
    const { root, store } = createStore()
    expect(store.listAssets()).toEqual([])
    expect(store.ensureModelsDir()).toBe(join(root, 'models'))
    expect(existsSync(join(root, 'models'))).toBe(true)
  })

  test('原子登记后可重启复读，未知字段不会被清理', async () => {
    const { root, store } = createStore()
    prepareFile(store)
    const installed = await store.markInstalled(asset())
    expect(installed.status).toBe('installed')
    const manifestPath = getLocalModelsManifestPath(root)
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    raw.extra = { retained: true }
    writeFileSync(manifestPath, JSON.stringify(raw), 'utf8')

    const restarted = new LocalModelStore({ configDir: root, now: () => 200 })
    expect(restarted.getAsset(installed.assetId)?.status).toBe('installed')
    expect(JSON.parse(readFileSync(manifestPath, 'utf8')).extra).toEqual({ retained: true })
  })

  test('状态与能力更新保持启用开关独立', async () => {
    const { store } = createStore()
    prepareFile(store)
    const installed = await store.markInstalled(asset({ enabled: true }))
    const running = store.updateStatus(installed.assetId, 'running')
    expect(running.enabled).toBe(true)
    const checked = store.updateCapability(installed.assetId, { state: 'available', assetSha256: installed.sha256, probeVersion: 1 })
    expect(checked.enabled).toBe(true)
    expect(checked.status).toBe('running')
  })

  test('拒绝跨目录资产 ID 和文件名', () => {
    const { store } = createStore()
    expect(() => store.resolveAssetFilePath('../escape', 'model.gguf')).toThrow('非法路径片段')
    expect(() => store.resolveAssetFilePath('asset', '../escape.gguf')).toThrow('非法路径片段')
  })

  test('损坏清单 fail closed，符号链接不被当作正常清单', async () => {
    const { root, store } = createStore()
    prepareFile(store)
    await store.markInstalled(asset())
    const manifestPath = getLocalModelsManifestPath(root)
    const outside = join(root, 'outside.json')
    writeFileSync(outside, '{"schemaVersion":1,"assets":[]}', 'utf8')
    expect(() => {
      writeFileSync(manifestPath, '{broken', 'utf8')
      store.listAssets()
    }).toThrow('清单损坏')
  })
})

test('Given 没有真实模型 When 直接登记 Then 拒绝伪造安装', async () => {
  const { store } = createStore()
  await expect(store.markInstalled(asset())).rejects.toThrow()
})

/** 创建与测试清单哈希一致的最小磁盘资产。 */
function prepareFile(store: LocalModelStore): void {
  mkdirSync(join(store.ensureModelsDir(), asset().assetId), { recursive: true })
  writeFileSync(store.resolveAssetFilePath(asset().assetId, asset().fileName), 'test-model')
}

test('Given 模型目录链接到外部 When 登记文件 Then 拒绝跟随符号链接', async () => {
  const { root, store } = createStore()
  const { symlinkSync } = await import('node:fs')
  const outside = join(root, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, asset().fileName), 'test-model')
  symlinkSync(outside, join(store.ensureModelsDir(), asset().assetId), 'dir')
  await expect(store.markInstalled(asset())).rejects.toThrow('符号链接')
})

test('Given 模型文件内容伪造 When 登记 Then 哈希失败且清单保持为空', async () => {
  const { store } = createStore()
  prepareFile(store)
  await expect(store.markInstalled(asset({ sha256: 'b'.repeat(64) }))).rejects.toThrow('SHA-256')
  expect(store.listAssets()).toEqual([])
})
