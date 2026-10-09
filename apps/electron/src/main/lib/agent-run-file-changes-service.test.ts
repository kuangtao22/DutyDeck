import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRunFileChangesSnapshot } from '@proma/shared'
import { createAgentRunFileChanges } from './agent-run-file-changes-service'
import { publishAgentFileObservation } from './agent-file-observation-bus'

/** 隔离测试目录和仍未结束的采集器。 */
const directories: string[] = []
const runs: ReturnType<typeof createAgentRunFileChanges>[] = []
afterEach(async () => {
  for (const run of runs.splice(0)) await run.finish()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
/** 创建不依赖真实会话或用户配置的运行夹具。 */
async function fixture(startedAt = 1, root?: string) {
  const cwd = root ?? await mkdtemp(join(tmpdir(), 'run-stat-service-'))
  if (!root) directories.push(cwd)
  const saved: AgentRunFileChangesSnapshot[] = []
  const run = createAgentRunFileChanges({ cwd, roots: [cwd], startedAt,
    persist: snapshot => { saved.push(structuredClone(snapshot)) }, publish: () => {}, isValid: () => true })
  runs.push(run)
  return { cwd, run, saved }
}

describe('本轮统计生命周期', () => {
  test('Given 写入和原始监听 When 完成 Then 自写不会被监听降级且终态持久化', async () => {
    const { cwd, run, saved } = await fixture()
    const path = join(cwd, 'a.ts')
    await run.capture({ phase: 'before', path })
    await writeFile(path, 'hello\n')
    publishAgentFileObservation(path)
    await run.capture({ phase: 'after', path })
    await run.finish()
    expect(saved.at(-1)?.files).toEqual([{ path, status: 'added', statsState: 'complete', additions: 1, deletions: 0 }])
    expect(saved.at(-1)?.endedAt).toBeNumber()
    expect(saved.at(-1)?.revision).toBeGreaterThan(0)
  })
  test('Given 终端仅监听证据 When 完成且之后外部修改 Then 保存未知并保持历史不变', async () => {
    const { cwd, run, saved } = await fixture()
    const path = join(cwd, 'script.txt')
    await writeFile(path, 'one\n')
    publishAgentFileObservation(path)
    await run.finish()
    await writeFile(path, 'other\n')
    expect(saved.at(-1)?.files[0]).toMatchObject({ path, statsState: 'unavailable' })
    expect(saved.at(-1)?.files[0]?.additions).toBeUndefined()
  })
  test('Given 两个运行共享目录且无写工具证据 When 监听 Then 双方标记无法归属', async () => {
    const first = await fixture()
    const second = await fixture(2, first.cwd)
    const path = join(first.cwd, 'x.txt')
    await writeFile(path, 'x')
    publishAgentFileObservation(path)
    await first.run.finish(); await second.run.finish()
    expect(first.saved.at(-1)?.hasUnattributedChanges).toBe(true)
    expect(second.saved.at(-1)?.hasUnattributedChanges).toBe(true)
    expect(first.saved.at(-1)?.files).toEqual([])
  })

  test('Given 宿主知识写入与普通 .proma 源码变化 When watcher 上报 Then 只记录普通源码', async () => {
    const { cwd, run, saved } = await fixture()
    const internal = join(cwd, '.proma', 'knowledge', '.knowledge.lock.owner-123')
    const source = join(cwd, '.proma', 'project-config', 'source.ts')
    await mkdir(join(cwd, '.proma', 'knowledge'), { recursive: true })
    await mkdir(join(cwd, '.proma', 'project-config'), { recursive: true })
    await writeFile(internal, 'owner')
    await writeFile(source, 'export const value = 1\n')

    publishAgentFileObservation(internal)
    publishAgentFileObservation(source)
    await run.finish()

    expect(saved.at(-1)?.files).toEqual([{ path: source, status: 'unknown', statsState: 'unavailable' }])
    expect(saved.at(-1)?.hasUnattributedChanges).toBeUndefined()
  })

  test('Given 写工具显式触碰宿主知识文件 When 采集 Then 不进入本轮文件快照', async () => {
    const { cwd, run, saved } = await fixture()
    const internal = join(cwd, '.proma', 'knowledge', 'manifest.json')
    await mkdir(join(cwd, '.proma', 'knowledge'), { recursive: true })

    await run.capture({ phase: 'before', path: internal })
    await writeFile(internal, '{}')
    await run.capture({ phase: 'after', path: internal })
    await run.finish()

    expect(saved.at(-1)?.files).toEqual([])
    expect(saved.at(-1)?.hasUnattributedChanges).toBeUndefined()
  })
})


test('Given 前采集超时后迟到 When 标记 invalidate Then 不允许重新显示精确数字', async () => {
  const { cwd, run, saved } = await fixture()
  const path = join(cwd, 'late.txt')
  await run.capture({ phase: 'before', path })
  await writeFile(path, 'actual\n')
  await run.capture({ phase: 'invalidate', path })
  await run.capture({ phase: 'after', path })
  await run.finish()
  expect(saved.at(-1)?.files[0]?.statsState).toBe('unavailable')
  expect(saved.at(-1)?.files[0]?.additions).toBeUndefined()
})


test('Given 新轮已接管 When 旧轮收尾 Then 保存旧轮未知状态且不读取新轮作为旧结果', async () => {
  const base = await fixture()
  await base.run.finish()
  const saved: AgentRunFileChangesSnapshot[] = []
  let current = true
  const run = createAgentRunFileChanges({ cwd: base.cwd, roots: [base.cwd], startedAt: 3,
    persist: snapshot => { saved.push(snapshot) }, publish: () => {}, isValid: () => true, isCurrent: () => current })
  runs.push(run)
  const path = join(base.cwd, 'shared.txt')
  await run.capture({ phase: 'before', path })
  await writeFile(path, 'old run\n')
  await run.capture({ phase: 'after', path })
  current = false
  await writeFile(path, 'new run\nnew content\n')
  await run.finish()
  expect(saved.at(-1)?.runId).toBe('3')
  expect(saved.at(-1)?.endedAt).toBeNumber()
  expect(saved.at(-1)?.files[0]?.statsState).toBe('unavailable')
  expect(saved.at(-1)?.files[0]?.additions).toBeUndefined()
})


test('Given 两轮都受控写同一文件 When watcher 无法确定写入者 Then 两轮都不能保留精确数字', async () => {
  const first = await fixture()
  const second = await fixture(2, first.cwd)
  const path = join(first.cwd, 'contended.ts')
  await first.run.capture({ phase: 'before', path })
  await second.run.capture({ phase: 'before', path })
  await writeFile(path, 'concurrent\n')
  publishAgentFileObservation(path)
  await first.run.capture({ phase: 'after', path })
  await second.run.capture({ phase: 'after', path })
  await first.run.finish(); await second.run.finish()
  expect(first.saved.at(-1)?.files[0]?.statsState).toBe('external_change')
  expect(second.saved.at(-1)?.files[0]?.statsState).toBe('external_change')
  expect(first.saved.at(-1)?.files[0]?.additions).toBeUndefined()
})
