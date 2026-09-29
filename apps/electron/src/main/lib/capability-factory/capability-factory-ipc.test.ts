import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CAPABILITY_FACTORY_CHANNELS } from '@proma/shared'
import { CapabilityFactoryStore } from './capability-factory-store'
import { CapabilityFactoryService } from './capability-factory-service'
import { registerCapabilityFactoryIpc, type CapabilityFactoryIpcEvent } from './capability-factory-ipc'
import type { CapabilityFactoryRunOptions } from './capability-factory-run'

/** 用替身 IPC 捕获 handler，直接调用它来验证四层契约的主进程一侧真的能分派。 */
function fixture(options: {
  authorized?: boolean
  runScene?: (input: {
    sceneId: string
    options?: CapabilityFactoryRunOptions
    onProgress?: (run: never) => void
  }) => Promise<unknown>
  requireSession?: (sessionId: string) => { id: string; workspaceId: string }
} = {}) {
  const handlers = new Map<string, (event: CapabilityFactoryIpcEvent, input: unknown) => Promise<unknown>>()
  const rootDir = mkdtempSync(join(tmpdir(), 'cap-factory-ipc-'))
  const authorized = options.authorized ?? true
  let tick = 0
  let seq = 0
  const registration = registerCapabilityFactoryIpc({
    ipc: {
      handle: (channel, listener) => { handlers.set(channel, listener) },
      removeHandler: (channel) => { handlers.delete(channel) },
    },
    isAuthorizedSender: () => authorized,
    requireSession: options.requireSession ?? ((sessionId) => ({ id: sessionId, workspaceId: 'w1' })),
    resolveRootDir: () => rootDir,
    getService: (dir) => new CapabilityFactoryService({
      store: new CapabilityFactoryStore(dir),
      now: () => (tick += 10),
      createId: () => `ipc-${(seq += 1)}`,
    }),
    /** 运行在这里用替身：真实实现要读渠道、解密凭据、发模型请求，不属于契约测试的范围。 */
    runScene: options.runScene
      ? async (request) => options.runScene?.(request) as never
      : async () => { throw new Error('未接线的运行') },
    runStep: async () => { throw new Error('未接线的单步试跑') },
  })
  const sent: { channel: string; payload: unknown }[] = []
  const event: CapabilityFactoryIpcEvent = {
    sender: { id: 1, send: (channel, payload) => { sent.push({ channel, payload }) } },
  }
  const call = async (input: unknown): Promise<unknown> => {
    const handler = handlers.get(CAPABILITY_FACTORY_CHANNELS.INVOKE)
    if (!handler) throw new Error('handler 未注册')
    return handler(event, input)
  }
  return { call, registration, handlers, sent, rootDir }
}

/** 一份最小可保存的定义。 */
const definition = {
  name: '账号查询',
  description: '',
  inputs: [],
  outputs: [],
  steps: [],
  capabilities: [],
  modelSlots: [{ id: 'main', model: 'gpt-5.4' }],
  acceptance: { criteria: [], judgePrompt: '', metrics: [] },
}

describe('编排工厂 IPC handler', () => {
  test('未授权窗口一律拒绝', async () => {
    const { call } = fixture({ authorized: false })
    await expect(call({ method: 'listScenes', input: { sessionId: 's1' } }))
      .rejects.toThrow(/CAPABILITY_FACTORY_ACCESS_DENIED/)
  })

  test('注册与释放通道', () => {
    const { registration, handlers } = fixture()
    expect(handlers.has(CAPABILITY_FACTORY_CHANNELS.INVOKE)).toBe(true)
    registration.dispose()
    expect(handlers.has(CAPABILITY_FACTORY_CHANNELS.INVOKE)).toBe(false)
  })

  test('建场景 → 存草案（不生效）→ 采纳（生效）走完整条链', async () => {
    const { call } = fixture()
    const scene = await call({ method: 'createScene', input: { sessionId: 's1', name: '账号查询' } }) as { id: string }
    expect(typeof scene.id).toBe('string')

    const drafted = await call({
      method: 'saveDraft',
      input: { sessionId: 's1', sceneId: scene.id, note: '改', definition },
    }) as { currentVersion: number; draft: unknown }
    expect(drafted.currentVersion).toBe(1)
    expect(drafted.draft).not.toBeNull()

    const adopted = await call({
      method: 'adoptDraft',
      input: { sessionId: 's1', sceneId: scene.id },
    }) as { scene: { currentVersion: number } }
    expect(adopted.scene.currentVersion).toBe(2)
  })

  test('保存草案的旧状态经 IPC 透传，旧弹窗不能覆盖期间新增的草案', async () => {
    const { call } = fixture()
    const scene = await call({ method: 'createScene', input: { sessionId: 's1', name: '账号查询' } }) as {
      id: string
      currentVersion: number
    }
    const agentDefinition = { ...definition, description: 'Agent 新草案' }
    await call({
      method: 'saveDraft',
      input: { sessionId: 's1', sceneId: scene.id, note: 'Agent 更新', definition: agentDefinition },
    })

    await expect(call({
      method: 'saveDraft',
      input: {
        sessionId: 's1', sceneId: scene.id, note: '旧弹窗保存', definition,
        expectedState: { currentVersion: scene.currentVersion, draft: null },
      },
    })).rejects.toThrow(/不覆盖.*重新打开后比较/)
    const current = await call({ method: 'getScene', input: { sessionId: 's1', sceneId: scene.id } }) as {
      draft: { definition: { description: string } }
    }
    expect(current.draft.definition.description).toBe('Agent 新草案')
  })

  test('放弃草案的旧状态经 IPC 透传，冲突时保留新草案且旧调用仍可放弃', async () => {
    const { call } = fixture()
    const scene = await call({ method: 'createScene', input: { sessionId: 's1', name: '账号查询' } }) as {
      id: string
      currentVersion: number
    }
    const firstDefinition = { ...definition, description: '用户看到的草案' }
    const first = await call({
      method: 'saveDraft',
      input: { sessionId: 's1', sceneId: scene.id, note: '第一份', definition: firstDefinition },
    }) as { currentVersion: number; draft: { createdAt: number } }
    const replacement = { ...definition, description: 'Agent 新草案' }
    await call({
      method: 'saveDraft',
      input: { sessionId: 's1', sceneId: scene.id, note: '第二份', definition: replacement },
    })

    await expect(call({
      method: 'discardDraft',
      input: {
        sessionId: 's1', sceneId: scene.id,
        expectedState: {
          currentVersion: first.currentVersion,
          draft: { createdAt: first.draft.createdAt, definition: firstDefinition },
        },
      },
    })).rejects.toThrow(/不覆盖.*重新打开后比较/)
    const current = await call({ method: 'getScene', input: { sessionId: 's1', sceneId: scene.id } }) as {
      draft: { definition: { description: string } }
    }
    expect(current.draft.definition.description).toBe('Agent 新草案')

    const discarded = await call({ method: 'discardDraft', input: { sessionId: 's1', sceneId: scene.id } }) as { draft: unknown }
    expect(discarded.draft).toBeNull()
  })

  test('版本历史与导出记录都可到达', async () => {
    const { call } = fixture()
    const scene = await call({ method: 'createScene', input: { sessionId: 's1', name: '账号查询' } }) as { id: string }
    const versions = await call({ method: 'listVersions', input: { sessionId: 's1', sceneId: scene.id } }) as unknown[]
    expect(versions).toHaveLength(1)
    const deliveries = await call({ method: 'listDeliveries', input: { sessionId: 's1' } }) as unknown[]
    expect(deliveries).toHaveLength(0)
  })

  test('未知方法与非法的 workspace 声明都进不来', async () => {
    const { call } = fixture()
    await expect(call({ method: 'dropEverything', input: { sessionId: 's1' } }))
      .rejects.toThrow(/CAPABILITY_FACTORY_INVALID/)
    await expect(call({ method: 'listScenes', input: { sessionId: 's1', workspaceId: 'w2' } }))
      .rejects.toThrow(/workspaceId/)
  })

  test('重命名与删除都能经 IPC 到达（界面侧的人工动作）', async () => {
    const { call } = fixture()
    const scene = await call({ method: 'createScene', input: { sessionId: 's1', name: '账号查询' } }) as { id: string }
    const renamed = await call({
      method: 'renameScene',
      input: { sessionId: 's1', sceneId: scene.id, name: '账号状态查询' },
    }) as { scene: { currentVersion: number; definition: { name: string } } }
    expect(renamed.scene.definition.name).toBe('账号状态查询')
    expect(renamed.scene.currentVersion).toBe(2)

    expect(await call({ method: 'deleteScene', input: { sessionId: 's1', sceneId: scene.id } }))
      .toEqual({ deleted: true })
    expect(await call({ method: 'listScenes', input: { sessionId: 's1' } })).toEqual([])
  })

  test('重命名要求名称非空', async () => {
    const { call } = fixture()
    const scene = await call({ method: 'createScene', input: { sessionId: 's1', name: '账号查询' } }) as { id: string }
    await expect(call({ method: 'renameScene', input: { sessionId: 's1', sceneId: scene.id, name: '' } }))
      .rejects.toThrow(/CAPABILITY_FACTORY_INVALID/)
  })

  test('虚拟接入：绑桩 / 读桩 / 清空都能经 IPC 到达服务层', async () => {
    const { call } = fixture()

    const stub = await call({
      method: 'setStub',
      input: { sessionId: 's1', capabilityId: 'corpus.build', payload: { corpus: '第 1 段' }, source: 'human' },
    }) as { capabilityId: string; payload: unknown; source: string }
    expect(stub.capabilityId).toBe('corpus.build')
    expect(stub.payload).toEqual({ corpus: '第 1 段' })
    expect(stub.source).toBe('human')

    expect(await call({ method: 'listStubs', input: { sessionId: 's1' } })).toHaveLength(1)
    expect(await call({ method: 'deleteStub', input: { sessionId: 's1', capabilityId: 'corpus.build' } }))
      .toEqual({ deleted: true })
    expect(await call({ method: 'listStubs', input: { sessionId: 's1' } })).toEqual([])
  })

  test('运行：跑完的记录经 IPC 返回；提交历史走服务层（与 runner 无关）', async () => {
    const { call } = fixture({
      runScene: async ({ sceneId }) => ({
        id: 'run-1', sceneId, sceneVersion: 1, status: 'succeeded', valid: true,
        input: { chapterText: '第一章' }, outputs: { characters: null }, steps: [],
        startedAt: 0, finishedAt: 10,
      }),
    })
    const scene = await call({ method: 'createScene', input: { sessionId: 's1', name: '小说角色提取' } }) as { id: string }

    const run = await call({
      method: 'runScene', input: { sessionId: 's1', sceneId: scene.id, input: { chapterText: '第一章' } },
    }) as { id: string; status: string }
    expect(run.id).toBe('run-1')
    expect(run.status).toBe('succeeded')

    /** 替身 runner 没有落盘，所以历史为空 —— 这里断言的是"读取走服务层"这条路径。 */
    expect(await call({ method: 'listRuns', input: { sessionId: 's1', sceneId: scene.id } })).toEqual([])
  })

  test('候选对比的定义身份与乐观锁经 IPC 原样传到 runner', async () => {
    const expectedDraftDefinition = {
      ...definition,
      description: '候选提示词',
      acceptance: { criteria: ['结果必须有依据'], judgePrompt: '核对依据', metrics: [] },
    }
    let received: CapabilityFactoryRunOptions | undefined
    const { call } = fixture({
      runScene: async ({ sceneId, options }) => {
        received = options
        return {
          id: 'candidate', sceneId, sceneVersion: 3, status: 'failed', valid: false,
          input: {}, outputs: null, steps: [], startedAt: 0, finishedAt: 1,
        }
      },
    })

    await call({
      method: 'runScene',
      input: {
        sessionId: 's1', sceneId: 'scene-1', input: {}, target: 'draft', expectedVersion: 3,
        expectedDraftCreatedAt: 1234, expectedDraftDefinition,
        comparisonId: 'compare-1', comparisonRole: 'candidate',
      },
    })

    expect(received).toEqual({
      target: 'draft', expectedVersion: 3, expectedDraftCreatedAt: 1234, expectedDraftDefinition,
      comparisonId: 'compare-1', comparisonRole: 'candidate',
    })
  })

  test('已保存任务可按场景经 IPC 读取', async () => {
    const { call, rootDir } = fixture()
    const scene = await call({ method: 'createScene', input: { sessionId: 's1', name: '小说角色提取' } }) as { id: string }
    const service = new CapabilityFactoryService({ store: new CapabilityFactoryStore(rootDir) })
    service.saveTask(scene.id, { chapterText: '第一章' })

    const tasks = await call({ method: 'listTasks', input: { sessionId: 's1', sceneId: scene.id } }) as { input: unknown }[]
    expect(tasks.map((task) => task.input)).toEqual([{ chapterText: '第一章' }])
  })

  test('Given 运行进入评审 When runner 回传中间记录 Then 只发给发起窗口并带原 requestId', async () => {
    const progressRun = {
      id: 'run-progress', sceneId: 'scene-1', sceneVersion: 1, status: 'succeeded', valid: true,
      input: {}, outputs: { characters: [] }, steps: [], startedAt: 0, finishedAt: 10,
      review: {
        status: 'running', passed: null, summary: '正在评审',
        acceptance: { criteria: [], judgePrompt: '评审', metrics: [] },
        criteria: [], metrics: [], suggestions: [], startedAt: 10, finishedAt: null,
      },
    }
    const terminalRun = {
      ...progressRun,
      review: { ...progressRun.review, status: 'succeeded', passed: true, finishedAt: 20 },
    }
    const { call, sent } = fixture({
      runScene: async (request) => {
        request.onProgress?.(progressRun as never)
        return terminalRun
      },
    })

    const result = await call({
      method: 'runScene',
      input: { sessionId: 's1', sceneId: 'scene-1', input: {}, requestId: 'request-1' },
    })

    expect(result).toEqual(terminalRun)
    expect(sent).toEqual([{
      channel: CAPABILITY_FACTORY_CHANNELS.PROGRESS,
      payload: { requestId: 'request-1', run: progressRun },
    }])
  })

  test('Given 运行未声明 requestId When runner 回传进度 Then 不对渲染层广播记录', async () => {
    const { call, sent } = fixture({
      runScene: async (request) => {
        request.onProgress?.({ id: 'ignored' } as never)
        return {
          id: 'run-1', sceneId: 'scene-1', sceneVersion: 1, status: 'succeeded', valid: true,
          input: {}, outputs: {}, steps: [], startedAt: 0, finishedAt: 10,
        }
      },
    })

    await call({ method: 'runScene', input: { sessionId: 's1', sceneId: 'scene-1', input: {} } })
    expect(sent).toEqual([])
  })

  test('Given 等待期间会话迁移到其他工作区 When runner 回传进度 Then 拒绝发送也不返回迟到结果', async () => {
    let workspaceId = 'w1'
    const terminalRun = {
      id: 'run-1', sceneId: 'scene-1', sceneVersion: 1, status: 'succeeded', valid: true,
      input: {}, outputs: {}, steps: [], startedAt: 0, finishedAt: 10,
    }
    const { call, sent } = fixture({
      requireSession: (sessionId) => ({ id: sessionId, workspaceId }),
      runScene: async (request) => {
        workspaceId = 'w2'
        request.onProgress?.(terminalRun as never)
        return terminalRun
      },
    })

    await expect(call({
      method: 'runScene',
      input: { sessionId: 's1', sceneId: 'scene-1', input: {}, requestId: 'request-1' },
    })).rejects.toThrow(/CAPABILITY_FACTORY_ACCESS_DENIED/)
    expect(sent).toEqual([])
  })
})
