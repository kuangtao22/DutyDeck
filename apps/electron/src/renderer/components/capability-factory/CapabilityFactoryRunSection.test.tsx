import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CapabilityDeclaration, CapabilityFactoryApi, CapabilityRun, CapabilityScene } from '@proma/shared'
import {
  CapabilityFactoryRunSection, invokeCapabilityFactoryRunWithProgress, mergeCapabilityFactoryRuns,
} from './CapabilityFactoryRunSection'

/** 构造最小场景，覆盖运行页是否需要显示虚拟接入。 */
function scene(capabilities: CapabilityDeclaration[] = []): CapabilityScene {
  return {
    id: 'scene-1', currentVersion: 1, draft: null, createdAt: 1, updatedAt: 1,
    definition: {
      name: '人物识别', description: '', inputs: [], outputs: [], steps: [], capabilities, modelSlots: [],
      acceptance: { criteria: [], judgePrompt: '', metrics: [] },
    },
  }
}

/** 服务端渲染初始运行页，副作用不会执行，适合验证首屏信息层级。 */
function render(record: CapabilityScene): string {
  return renderToStaticMarkup(<CapabilityFactoryRunSection sessionId="session-1" scene={record} />)
}

describe('运行页初始布局', () => {
  test('Given 普通提示词场景 When 打开运行页 Then 本轮与顶层历史分开且不显示无关虚拟接入', () => {
    const html = render(scene())

    expect(html).toContain('本轮')
    expect(html).not.toContain('历史')
    expect(html).toContain('优化对比')
    expect(html).toContain('批量测试')
    expect(html).toContain('开始运行')
    expect(html).not.toContain('提交任务')
    expect(html).toContain('正在读取运行记录')
    expect(html).not.toContain('虚拟接入')
  })

  test('Given 运行页首次打开 When 展示本轮 Then 开始运行位于页签内容之后，而不是外层页签之前', () => {
    const html = render(scene())
    const tabsEnd = html.indexOf('批量测试')
    const action = html.indexOf('开始运行')

    expect(tabsEnd).toBeGreaterThanOrEqual(0)
    expect(action).toBeGreaterThan(tabsEnd)
  })

  test('Given 场景声明外部能力且桩仍在加载 When 打开运行页 Then 虚拟接入默认收起且不误报缺失', () => {
    const html = render(scene([{
      id: 'account.query', description: '返回虚拟账号资料',
      inputSchema: [], outputSchema: [], sideEffect: 'read',
    }]))

    expect(html).toContain('虚拟接入 · 正在读取')
    expect(html).not.toContain('缺 1')
    expect(html).not.toContain('返回值 JSON')
  })
})

/** 构造一条可识别的运行记录。 */
function run(id: string): CapabilityRun {
  return {
    id, sceneId: 'scene-1', sceneVersion: 1, status: 'succeeded', valid: true,
    input: {}, outputs: {}, steps: [], startedAt: 0, finishedAt: 1,
  }
}

describe('运行进度订阅', () => {
  test('Given 历史读取晚于本轮进度 When 合并 Then 新运行不被迟到历史覆盖', () => {
    expect(mergeCapabilityFactoryRuns([run('progress')], [run('history')]).map((item) => item.id))
      .toEqual(['progress', 'history'])
    expect(mergeCapabilityFactoryRuns([run('same')], [{ ...run('same'), review: {
      status: 'running', passed: null, summary: '正在评测',
      acceptance: { criteria: [], judgePrompt: '', metrics: [] },
      criteria: [], metrics: [], suggestions: [], startedAt: 1, finishedAt: null,
    } }]).map((item) => item.review?.status ?? 'none')).toEqual(['none'])
  })

  test('Given 并发进度 When 发起一次运行 Then 只接收本请求并在终态后清理订阅', async () => {
    let listener: ((event: { requestId: string; run: CapabilityRun }) => void) | undefined
    let cleaned = false
    const seen: string[] = []
    const api: CapabilityFactoryApi = {
      onRunProgress: (next) => { listener = next; return () => { cleaned = true; listener = undefined } },
      invoke: async (_method, input) => {
        const requestId = (input as { requestId?: string }).requestId
        listener?.({ requestId: 'other-request', run: run('other') })
        listener?.({ requestId: requestId ?? '', run: run('progress') })
        return run('terminal') as never
      },
    }

    const result = await invokeCapabilityFactoryRunWithProgress(
      api, 'runScene', { sessionId: 'session-1', sceneId: 'scene-1', input: {} },
      (record) => { seen.push(record.id) },
    )

    expect(result.id).toBe('terminal')
    expect(seen).toEqual(['progress'])
    expect(cleaned).toBe(true)
    expect(listener).toBeUndefined()
  })

  test('Given invoke 失败 When 运行结束 Then 仍然清理进度订阅', async () => {
    let cleaned = false
    const api: CapabilityFactoryApi = {
      onRunProgress: () => () => { cleaned = true },
      invoke: async () => { throw new Error('模型不可用') },
    }

    await expect(invokeCapabilityFactoryRunWithProgress(
      api, 'runScene', { sessionId: 'session-1', sceneId: 'scene-1', input: {} }, () => undefined,
    )).rejects.toThrow('模型不可用')
    expect(cleaned).toBe(true)
  })
})
