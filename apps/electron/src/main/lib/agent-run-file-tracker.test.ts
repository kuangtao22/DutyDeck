import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRunFileTracker, AGENT_RUN_FILE_TRACKER_LIMITS } from './agent-run-file-tracker'

const cleanupPaths: string[] = []

/** 创建每个用例独占的真实临时目录，避免 macOS `/var` 软链影响路径断言。 */
async function createFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'proma-run-files-'))
  cleanupPaths.push(directory)
  return realpath(directory)
}

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('AgentRunFileTracker', () => {
  test('Given 文件在本轮前已有修改 When 再编辑 Then 只统计本轮净变化', async () => {
    const root = await createFixture()
    const file = join(root, 'source.ts')
    await writeFile(file, 'old worktree change\n')
    const tracker = new AgentRunFileTracker({ cwd: root, roots: [root] })

    await tracker.before('source.ts')
    await writeFile(file, 'old worktree change\nnew line\n')
    await tracker.after('source.ts')

    expect(tracker.snapshot()).toEqual([{
      path: file,
      status: 'modified',
      statsState: 'complete',
      additions: 1,
      deletions: 0,
    }])
  })

  test('Given 同一文件重复编辑 When 获取快照 Then 使用首次基线和最终内容', async () => {
    const root = await createFixture()
    const file = join(root, 'repeat.txt')
    await writeFile(file, 'a\nb\n')
    const tracker = new AgentRunFileTracker({ cwd: root, roots: [root] })

    await tracker.before(file)
    await writeFile(file, 'a\nb\nc\n')
    await tracker.after(file)
    await tracker.before(file)
    await writeFile(file, 'a\nx\nc\n')
    await tracker.after(file)

    expect(tracker.snapshot()[0]).toMatchObject({ status: 'modified', additions: 2, deletions: 1 })
  })

  test('Given 文件改后还原 When 获取快照 Then 明确标记 unchanged', async () => {
    const root = await createFixture()
    const file = join(root, 'restore.txt')
    await writeFile(file, 'same\n')
    const tracker = new AgentRunFileTracker({ cwd: root, roots: [root] })

    await tracker.before(file)
    await writeFile(file, 'different\n')
    await tracker.after(file)
    await tracker.before(file)
    await writeFile(file, 'same\n')
    await tracker.after(file)

    expect(tracker.snapshot()[0]).toMatchObject({ status: 'unchanged', statsState: 'complete', additions: 0, deletions: 0 })
  })

  test('Given 工具失败但已部分落盘 When after 仍执行 Then 记录真实变化', async () => {
    const root = await createFixture()
    const file = join(root, 'partial.txt')
    await writeFile(file, 'before\n')
    const tracker = new AgentRunFileTracker({ cwd: root, roots: [root] })

    await tracker.before(file)
    await writeFile(file, 'before\npartial\n')
    await tracker.after(file)

    expect(tracker.snapshot()[0]).toMatchObject({ status: 'modified', additions: 1, deletions: 0 })
  })

  test('Given 已跟踪文件被外部修改 When 下次写入或校验 Then 永久降级为 external_change', async () => {
    const root = await createFixture()
    const file = join(root, 'polluted.txt')
    await writeFile(file, 'a\n')
    const tracker = new AgentRunFileTracker({ cwd: root, roots: [root] })

    await tracker.before(file)
    await writeFile(file, 'a\nb\n')
    await tracker.after(file)
    await writeFile(file, 'external\n')
    await tracker.verify()
    await tracker.before(file)
    await writeFile(file, 'agent final\n')
    await tracker.after(file)

    expect(tracker.snapshot()[0]).toMatchObject({ status: 'modified', statsState: 'external_change' })
    expect(tracker.snapshot()[0]).not.toHaveProperty('additions')
  })

  test('Given watcher 只有事后路径 When observe Then 不伪造旧基线', async () => {
    const root = await createFixture()
    const file = join(root, 'terminal-created.txt')
    const tracker = new AgentRunFileTracker({ cwd: root, roots: [root] })

    tracker.observe([file])

    expect(tracker.snapshot()).toEqual([{ path: file, status: 'unknown', statsState: 'unavailable' }])

    await tracker.before(file)
    await writeFile(file, 'later controlled write\n')
    await tracker.after(file)
    expect(tracker.snapshot()).toEqual([{ path: file, status: 'unknown', statsState: 'unavailable' }])
  })

  test('Given 新建和删除文件 When 工具执行 Then 不依赖 Git 也能识别操作类型', async () => {
    const root = await createFixture()
    const created = join(root, 'created.txt')
    const deleted = join(root, 'deleted.txt')
    await writeFile(deleted, 'one\ntwo\n')
    const tracker = new AgentRunFileTracker({ cwd: root, roots: [root] })

    await tracker.before(created)
    await writeFile(created, 'one\ntwo\n')
    await tracker.after(created)
    await tracker.before(deleted)
    await unlink(deleted)
    await tracker.after(deleted)

    expect(tracker.snapshot()).toEqual([
      { path: created, status: 'added', statsState: 'complete', additions: 2, deletions: 0 },
      { path: deleted, status: 'deleted', statsState: 'complete', additions: 0, deletions: 2 },
    ])
  })

  test('Given 二进制和超大文件 When 采集 Then 返回明确不可统计原因', async () => {
    const root = await createFixture()
    const binary = join(root, 'asset.bin')
    const large = join(root, 'large.txt')
    await writeFile(binary, Buffer.from([0x41, 0, 0x42]))
    await writeFile(large, 'x'.repeat(AGENT_RUN_FILE_TRACKER_LIMITS.maxFileBytes + 1))
    const tracker = new AgentRunFileTracker({ cwd: root, roots: [root] })

    await tracker.before(binary)
    await writeFile(binary, Buffer.from([0x41, 0, 0x43]))
    await tracker.after(binary)
    await tracker.before(large)
    await writeFile(large, 'y'.repeat(AGENT_RUN_FILE_TRACKER_LIMITS.maxFileBytes + 1))
    await tracker.after(large)

    expect(tracker.snapshot()).toEqual([
      { path: binary, status: 'modified', statsState: 'binary' },
      { path: large, status: 'modified', statsState: 'too_large' },
    ])
  })

  test('Given 根外路径或逃逸软链 When 采集 Then 拒绝读取', async () => {
    const root = await createFixture()
    const outside = await createFixture()
    const outsideFile = join(outside, 'secret.txt')
    const link = join(root, 'escape')
    await writeFile(outsideFile, 'secret\n')
    await symlink(outside, link)
    const tracker = new AgentRunFileTracker({ cwd: root, roots: [root] })

    await expect(tracker.before(outsideFile)).rejects.toThrow('允许范围')
    await expect(tracker.before(join(link, 'secret.txt'))).rejects.toThrow('允许范围')
  })

  test('Given 精确附加文件 When 不在目录根内 Then 仅允许该文件', async () => {
    const root = await createFixture()
    const outside = await createFixture()
    const allowed = join(outside, 'allowed.txt')
    const denied = join(outside, 'denied.txt')
    await writeFile(allowed, 'a\n')
    await writeFile(denied, 'b\n')
    const tracker = new AgentRunFileTracker({ cwd: root, roots: [root], files: [allowed] })

    await tracker.before(allowed)
    await expect(tracker.before(denied)).rejects.toThrow('允许范围')
  })

  test('Given 目录作为文件路径 When 采集 Then 标记 unavailable 且不中断运行', async () => {
    const root = await createFixture()
    const directory = join(root, 'folder')
    await mkdir(directory)
    const tracker = new AgentRunFileTracker({ cwd: root, roots: [root] })

    await tracker.before(directory)
    await tracker.after(directory)

    expect(tracker.snapshot()[0]).toMatchObject({ status: 'unknown', statsState: 'unavailable' })
  })

  test('Given 只有末尾换行发生变化 When 统计 Then 仍按一行替换处理', async () => {
    const root = await createFixture()
    const file = join(root, 'newline.txt')
    await writeFile(file, 'line')
    const tracker = new AgentRunFileTracker({ cwd: root, roots: [root] })

    await tracker.before(file)
    await writeFile(file, 'line\n')
    await tracker.after(file)

    expect(tracker.snapshot()[0]).toMatchObject({ additions: 1, deletions: 1 })
  })

  test('Given 改动差异计算超过预算 When 获取快照 Then 快速降级而非执行二次方比较', async () => {
    const root = await createFixture()
    const file = join(root, 'rewritten.txt')
    const before = Array.from({ length: 800 }, (_, index) => `before-${index}`).join('\n')
    const after = Array.from({ length: 800 }, (_, index) => `after-${index}`).join('\n')
    await writeFile(file, before)
    const tracker = new AgentRunFileTracker({ cwd: root, roots: [root] })

    await tracker.before(file)
    await writeFile(file, after)
    await tracker.after(file)

    expect(tracker.snapshot()[0]).toMatchObject({ status: 'modified', statsState: 'budget_exceeded' })
  })
})


test('Given 配置含尚未创建的附加目录 When 创建记录器 Then 不阻断现有项目写入', async () => {
  const root = await createFixture()
  const tracker = new AgentRunFileTracker({ cwd: root, roots: [root, join(root, 'missing-root')] })
  await tracker.before('new.txt')
  await writeFile(join(root, 'new.txt'), 'x\n')
  await tracker.after('new.txt')
  expect(tracker.snapshot()[0]?.additions).toBe(1)
})
test('Given 换行密集文本 When 计算 Then 行数组预算明确降级', async () => {
  const root = await createFixture()
  const file = join(root, 'dense.txt')
  await writeFile(file, '\n'.repeat(60_000))
  const tracker = new AgentRunFileTracker({ cwd: root, roots: [root] })
  await tracker.before(file)
  await writeFile(file, 'x\n'.repeat(60_000))
  await tracker.after(file)
  expect(tracker.snapshot()[0]?.statsState).toBe('budget_exceeded')
})
test('Given 文件数量超限 When watcher 继续报告 Then 标记不完整且内存不增长', async () => {
  const root = await createFixture()
  const tracker = new AgentRunFileTracker({ cwd: root, roots: [root] })
  tracker.observe(Array.from({ length: 300 }, (_, index) => join(root, `${index}.txt`)))
  expect(tracker.snapshot()).toHaveLength(256)
  expect(tracker.truncated).toBe(true)
})


test('Given 授权根是软链别名 When 工具和 watcher 使用两种路径 Then 只记录同一文件一次', async () => {
  const root = await createFixture()
  const actual = join(root, 'actual')
  const alias = join(root, 'alias')
  await mkdir(actual)
  await symlink(actual, alias, 'dir')
  const tracker = new AgentRunFileTracker({ cwd: alias, roots: [alias] })
  const file = join(actual, 'same.ts')
  await tracker.before(file)
  await writeFile(file, 'x\n')
  tracker.observe([join(alias, 'same.ts')])
  await tracker.after(file)
  expect(tracker.owns(file)).toBe(true)
  expect(tracker.hasControlledPath(join(alias, 'same.ts'))).toBe(true)
  expect(tracker.snapshot()).toHaveLength(1)
  expect(tracker.snapshot()[0]?.additions).toBe(1)
})
