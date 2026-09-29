import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServerOpsScriptStore } from './server-ops-script-store'
import type { ServerOpsScriptSaveInput } from '@proma/shared'

/** 本次用例创建的临时配置根，统一在 afterEach 清理。 */
const temporaryRoots: string[] = []

/** 创建隔离的临时配置根。 */
function createConfigRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'proma-script-store-'))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  while (temporaryRoots.length) rmSync(temporaryRoots.pop()!, { recursive: true, force: true })
})

/** 构造一条最小合法 SSH 脚本保存输入。 */
function createInput(overrides: Partial<ServerOpsScriptSaveInput> = {}): ServerOpsScriptSaveInput {
  return {
    projectId: 'project-1', name: '磁盘检查', kind: 'ssh-command', usage: 'one-off', risk: 'read-only',
    hostId: 'host-1', body: 'df -h', parameters: [], enabled: true, ...overrides,
  }
}

describe('运维脚本库持久化', () => {
  test('Given 空目录 When 新建脚本 Then 落盘并可再次读取', () => {
    const root = createConfigRoot()
    const store = new ServerOpsScriptStore(root)
    expect(store.list()).toEqual([])

    const saved = store.save(createInput(), 'agent', { usage: 'one-off', reason: '写死了日期' })
    expect(saved.origin).toBe('agent')
    expect(saved.suggestedUsageReason).toBe('写死了日期')

    /** 新实例必须能从同一份文件里恢复同一条脚本。 */
    const reopened = new ServerOpsScriptStore(root)
    expect(reopened.get(saved.id)?.body).toBe('df -h')
    expect(reopened.list('project-1')).toHaveLength(1)
  })

  test('Given 已存在脚本 When 用过期版本更新 Then 拒绝覆盖', () => {
    const store = new ServerOpsScriptStore(createConfigRoot())
    const saved = store.save(createInput(), 'user')
    expect(() => store.save(createInput({ scriptId: saved.id, name: '改名', expectedUpdatedAt: saved.updatedAt - 1 }), 'user'))
      .toThrow('SERVER_OPS_SCRIPT_CONFLICT')
    const updated = store.save(createInput({ scriptId: saved.id, name: '改名', expectedUpdatedAt: saved.updatedAt }), 'user')
    expect(updated.name).toBe('改名')
    /** 更新保留首次落盘来源，不把 Agent 提议改写成用户自建。 */
    expect(updated.origin).toBe('user')
    expect(updated.createdAt).toBe(saved.createdAt)
  })

  test('Given 已有归属 When 尝试跨项目迁移 Then 拒绝', () => {
    const store = new ServerOpsScriptStore(createConfigRoot())
    const saved = store.save(createInput(), 'user')
    expect(() => store.save(createInput({ scriptId: saved.id, projectId: 'project-2' }), 'user'))
      .toThrow('SERVER_OPS_SCRIPT_PROJECT_MISMATCH')
  })

  test('Given 目标脚本不存在 When 更新或删除 Then 更新报错而删除返回未命中', () => {
    const store = new ServerOpsScriptStore(createConfigRoot())
    expect(() => store.save(createInput({ scriptId: 'missing-1' }), 'user')).toThrow('SERVER_OPS_SCRIPT_NOT_FOUND')
    expect(store.remove('missing-1')).toBe(false)
  })

  test('Given 项目下仍有脚本 When 查询归属 Then 报告引用', () => {
    const store = new ServerOpsScriptStore(createConfigRoot())
    store.save(createInput(), 'user')
    expect(store.hasProjectReferences('project-1')).toBe(true)
    expect(store.hasProjectReferences('project-2')).toBe(false)
  })

  test('Given 坏脚本文件 When 读取 Then 抛错而不是当成空库', () => {
    const root = createConfigRoot()
    const store = new ServerOpsScriptStore(root)
    store.save(createInput(), 'user')
    const filePath = join(root, 'server-ops', 'scripts.json')
    writeFileSync(filePath, '{"version":1,"scripts":[{"id":"x"}]}', 'utf8')
    expect(() => new ServerOpsScriptStore(root).list()).toThrow()
  })

  test('Given 合法脚本 When 落盘 Then 文件里不含凭据或路径类字段', () => {
    const root = createConfigRoot()
    const store = new ServerOpsScriptStore(root)
    store.save(createInput(), 'user')
    const raw = readFileSync(join(root, 'server-ops', 'scripts.json'), 'utf8')
    for (const forbidden of ['credentialRef', 'password', 'filePath']) {
      expect(raw).not.toContain(forbidden)
    }
  })
})
