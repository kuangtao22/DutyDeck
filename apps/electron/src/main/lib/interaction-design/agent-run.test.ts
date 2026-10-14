import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInteractionDesignAccess } from './access'
import { InteractionDesignService } from './store'
import { createInteractionDesignRun } from './agent-run'

/** 独立临时项目避免接触真实会话和资料。 */
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'prototype-run-')); roots.push(root)
  const access = createInteractionDesignAccess('session-1', {
    resolveSession: () => ({ workspaceId: 'project-1', projectRoot: root }),
    acquireWriteLease: () => () => undefined,
    createService: context => new InteractionDesignService(context),
  })
  const snapshot = await access.execute('create', { sessionId: 'session-1', name: '测试', platform: 'desktop' })
  const input = { sessionId: 'session-1', prototypeId: snapshot.document.id, baseRevision: 1, instruction: '生成页面' }
  return { access, snapshot, input, run: createInteractionDesignRun('session-1', access, access) }
}

describe('交互设计单轮任务收尾', () => {
  test('Given 本轮与其他运行各有任务 When 本轮结束未交候选 Then 只标记本轮失败', async () => {
    const { run, access, input } = await fixture()
    const owned = await run.execute('beginJob', input)
    const other = await access.execute('beginJob', input)
    await run.finish(false)
    const result = await access.execute('load', input)
    expect(result.jobs.find(job => job.id === owned.id)?.status).toBe('failed')
    expect(result.jobs.find(job => job.id === other.id)?.status).toBe('running')
  })
  test('Given 已生成候选及仍在等待的任务 When 停止本轮 Then 保留候选并取消未完成任务', async () => {
    const { run, access, input, snapshot } = await fixture()
    const complete = await run.execute('beginJob', input)
    await run.execute('propose', { ...input, jobId: complete.id, draft: snapshot.document, summary: '可预览候选' })
    const pending = await run.execute('beginJob', input)
    await run.finish(true)
    const result = await access.execute('load', input)
    expect(result.jobs.find(job => job.id === complete.id)?.status).toBe('candidate')
    expect(result.jobs.find(job => job.id === pending.id)?.status).toBe('cancelled')
    expect(result.candidates[0]?.status).toBe('ready')
    await run.finish(true)
    expect((await access.execute('load', input)).document.revision).toBe(1)
  })
})
