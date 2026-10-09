import '@fontsource-variable/inter/index.css'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { createStore, Provider, useAtomValue } from 'jotai'
import { Toaster } from 'sonner'
import type {
  CapabilityFactoryApi,
  CapabilityFactoryBatch,
  CapabilityFactoryBatchSummary,
  CapabilityFactoryChanged,
  CapabilityFactoryCommandInputs,
  CapabilityFactoryCommandMethod,
  CapabilityFactoryCommandResults,
  CapabilityFactoryBatchRequest,
  CapabilityDataset,
  CapabilityScene,
  PermissionRequest,
} from '@proma/shared'
import { createEmptySceneDefinition } from '@proma/shared'
import { allPendingPermissionRequestsAtom } from '../src/renderer/atoms/agent-atoms'
import { PermissionBanner } from '../src/renderer/components/agent/PermissionBanner'
import { agentSessionsAtom } from '../src/renderer/atoms/agent-atoms'
import { ServerOpsAgentReadAccess } from '../src/renderer/components/server-ops/ServerOpsAgentReadAccess'
import { CapabilityFactoryBatchHistory } from '../src/renderer/components/capability-factory/CapabilityFactoryBatchHistory'
import { CapabilityFactoryEvaluationSection } from '../src/renderer/components/capability-factory/CapabilityFactoryEvaluationSection'
import { useCapabilityFactoryBatches } from '../src/renderer/components/capability-factory/useCapabilityFactoryBatches'
import '../src/renderer/styles/globals.css'

/** 保留普通审批注册过的 Enter handler，用于确定性模拟 React 被动 effect 清理前的竞态。 */
const capturedKeydownHandlers: Array<(event: KeyboardEvent) => void> = []
const addDocumentEventListener = document.addEventListener.bind(document) as (
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
) => void
document.addEventListener = ((
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
): void => {
  if (type === 'keydown' && typeof listener === 'function') {
    capturedKeydownHandlers.push(listener as (event: KeyboardEvent) => void)
  }
  addDocumentEventListener(type, listener, options)
}) as typeof document.addEventListener

/** Smoke 只记录交互计数与内存批次，不接触真实工作区。 */
interface SmokeState {
  runBatchCalls: number
  cancelCalls: number
  getBatchCalls: number
  sessionId: string
  runBatchInput: CapabilityFactoryBatchRequest | null
  permissionCalls: Array<{ requestId: string; behavior: 'allow' | 'deny'; alwaysAllow?: boolean }>
  sceneVersion: number
  failNextPermission: boolean
  modeUpdateCalls: Array<{ sessionId: string; mode: 'standard' | 'server-ops-write' }>
  resourceSetCalls: number
}

/** 生成不带长输出的持久批次；运行证据加载路径仍会执行，但不会请求不存在的 runId。 */
function batch(id: string, sceneId: string, status: CapabilityFactoryBatch['status'], startedAt: number): CapabilityFactoryBatch {
  return {
    id,
    scopeId: 'agent:run',
    sceneId,
    kind: 'evaluation',
    status,
    snapshot: { sceneVersion: 2, datasetId: 'dataset-1', datasetVersion: 1, itemIds: ['case-1'] },
    items: [{ id: 'case-1', name: '用例 1', input: { text: id }, status: status === 'running' ? 'running' : status === 'cancelled' ? 'cancelled' : 'succeeded' }],
    evaluation: { total: 1, completed: status === 'running' ? 0 : 1, valid: status === 'succeeded' ? 1 : 0, reviewed: 0, passedReview: 0 },
    adoptable: false,
    startedAt,
    updatedAt: startedAt,
    finishedAt: status === 'running' ? null : startedAt + 1,
  }
}

/** 完整批次与摘要严格分开，模拟主进程的轻量列表协议。 */
function summary(value: CapabilityFactoryBatch): CapabilityFactoryBatchSummary {
  return {
    id: value.id,
    ...(value.scopeId === undefined ? {} : { scopeId: value.scopeId }),
    sceneId: value.sceneId,
    kind: value.kind,
    status: value.status,
    itemCount: value.items.length,
    completedCount: value.items.filter((item) => item.status !== 'pending' && item.status !== 'running').length,
    ...(value.evaluation === undefined ? {} : { evaluation: value.evaluation }),
    adoptable: value.adoptable,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    finishedAt: value.finishedAt,
  }
}

const sceneId = 'scene-smoke'
const batches = new Map<string, CapabilityFactoryBatch[]>([
  ['session-a', [batch('agent-existing', sceneId, 'succeeded', 300), batch('history-old', sceneId, 'succeeded', 100)]],
  ['session-fast', [batch('fast-batch', sceneId, 'succeeded', 500)]],
  ['session-slow', [batch('slow-batch', sceneId, 'succeeded', 400)]],
])
const listeners = new Set<(event: CapabilityFactoryChanged) => void>()
const state: SmokeState = {
  runBatchCalls: 0,
  cancelCalls: 0,
  getBatchCalls: 0,
  sessionId: 'session-a',
  runBatchInput: null,
  permissionCalls: [],
  sceneVersion: 2,
  failNextPermission: false,
  modeUpdateCalls: [],
  resourceSetCalls: 0,
}
const evaluationDataset: CapabilityDataset = {
  id: 'dataset-twelve',
  name: '十二条回归集',
  version: 12,
  updatedAt: 12,
  cases: Array.from({ length: 12 }, (_, index) => ({
    id: `case-${index + 1}`,
    name: `用例 ${index + 1}`,
    input: { text: `输入 ${index + 1}` },
    source: 'human' as const,
    tags: [],
  })),
}
const evaluationScene: CapabilityScene = {
  id: sceneId,
  definition: createEmptySceneDefinition('批量评测 Smoke'),
  currentVersion: 2,
  draft: null,
  createdAt: 1,
  updatedAt: 2,
}
let releaseSlow: (() => void) | null = null
let finishRun: ((value: CapabilityFactoryBatch) => void) | null = null

/** 发布宿主轻量事件，生产 hook 会重新读取持久数据。 */
function emit(sessionId: string): void {
  for (const listener of listeners) listener({ sessionId, sceneId })
}

/** 内存版 IPC，保留泛型关联以便生产 hook 按真实类型调用。 */
async function invoke<M extends CapabilityFactoryCommandMethod>(
  method: M,
  input: CapabilityFactoryCommandInputs[M],
): Promise<CapabilityFactoryCommandResults[M]> {
  if (method === 'listBatches') {
    const current = input as CapabilityFactoryCommandInputs['listBatches']
    if (current.sessionId === 'session-slow') {
      await new Promise<void>((resolve) => { releaseSlow = resolve })
    }
    return (batches.get(current.sessionId) ?? []).map(summary) as CapabilityFactoryCommandResults[M]
  }
  if (method === 'getBatch') {
    state.getBatchCalls += 1
    const current = input as CapabilityFactoryCommandInputs['getBatch']
    const found = (batches.get(current.sessionId) ?? []).find((item) => item.id === current.batchId) ?? null
    return structuredClone(found) as CapabilityFactoryCommandResults[M]
  }
  if (method === 'runBatch') {
    state.runBatchCalls += 1
    const current = input as CapabilityFactoryCommandInputs['runBatch']
    state.runBatchInput = structuredClone(current)
    if (current.sessionId === 'session-evaluation') {
      const completed = {
        ...batch('evaluation-complete', current.sceneId, 'succeeded', 800),
        snapshot: {
          sceneVersion: 2,
          datasetId: current.datasetId,
          datasetVersion: evaluationDataset.version,
          itemIds: current.caseIds ?? [],
        },
        items: (current.caseIds ?? []).map((caseId) => ({
          id: caseId,
          name: caseId,
          input: { text: caseId },
          status: 'succeeded' as const,
        })),
      }
      batches.set(current.sessionId, [completed])
      return structuredClone(completed) as CapabilityFactoryCommandResults[M]
    }
    const running = batch('manual-running', current.sceneId, 'running', 700)
    batches.set(current.sessionId, [running, ...(batches.get(current.sessionId) ?? [])])
    emit(current.sessionId)
    return await new Promise<CapabilityFactoryCommandResults[M]>((resolve) => {
      finishRun = (value) => resolve(structuredClone(value) as CapabilityFactoryCommandResults[M])
    })
  }
  if (method === 'cancelBatch') {
    state.cancelCalls += 1
    const current = input as CapabilityFactoryCommandInputs['cancelBatch']
    const list = batches.get(current.sessionId) ?? []
    const running = list.find((item) => item.id === current.batchId)
    if (running) {
      const cancelled = { ...running, status: 'cancelled' as const, finishedAt: 701,
        items: running.items.map((item) => ({ ...item, status: 'cancelled' as const })) }
      batches.set(current.sessionId, list.map((item) => item.id === current.batchId ? cancelled : item))
      finishRun?.(cancelled)
      finishRun = null
      emit(current.sessionId)
    }
    return { cancelled: Boolean(running) } as CapabilityFactoryCommandResults[M]
  }
  if (method === 'listDatasets') return [structuredClone(evaluationDataset)] as CapabilityFactoryCommandResults[M]
  if (method === 'listEvaluations' || method === 'listRuns') return [] as CapabilityFactoryCommandResults[M]
  throw new Error(`Smoke 未实现方法：${method}`)
}

const api: CapabilityFactoryApi = {
  invoke,
  onChanged: (callback) => {
    listeners.add(callback)
    return () => { listeners.delete(callback) }
  },
}

Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    capabilityFactory: api,
    respondPermission: async (response: { requestId: string; behavior: 'allow' | 'deny'; alwaysAllow?: boolean }) => {
      state.permissionCalls.push(structuredClone(response))
      if (state.failNextPermission) {
        state.failNextPermission = false
        throw new Error('smoke permission failure')
      }
      if (response.behavior === 'allow') state.sceneVersion = 3
    },
    updateAgentSessionToolMode: async (sessionId: string, mode: 'standard' | 'server-ops-write') => {
      if (state.failNextPermission) throw new Error('smoke mode update failure')
      state.modeUpdateCalls.push({ sessionId, mode })
      const current = accessStore.get(agentSessionsAtom).find((session) => session.id === sessionId)
      if (!current) throw new Error('session missing')
      const updated = { ...current, toolMode: mode, updatedAt: current.updatedAt + 1 }
      return updated
    },
  },
})
Object.defineProperty(window, '__factoryBatchSmoke', {
  configurable: true,
  value: {
    state,
    releaseSlow: () => { releaseSlow?.(); releaseSlow = null },
    addAgentBatch: () => {
      batches.set('session-a', [batch('agent-newest', sceneId, 'succeeded', 600), ...(batches.get('session-a') ?? [])])
      emit('session-a')
    },
  },
})

/** 挂载生产 hook 与历史组件；额外按钮只负责触发 smoke 场景。 */
function Harness(): React.ReactElement {
  const [sessionId, setSessionId] = React.useState('session-a')
  state.sessionId = sessionId
  const factory = useCapabilityFactoryBatches(sessionId, sceneId, 'evaluation')
  React.useEffect(() => { document.body.dataset.smokeReady = 'true' }, [])
  return <main className="p-4">
    <p aria-label="当前会话">{sessionId}</p>
    <p aria-label="当前批次">{factory.batch?.id ?? 'none'}</p>
    <button type="button" onClick={() => { void factory.start({ datasetId: 'dataset-1' }); void factory.start({ datasetId: 'dataset-1' }) }}>双重启动</button>
    <button type="button" onClick={() => setSessionId('session-slow')}>切到慢会话</button>
    <button type="button" onClick={() => setSessionId('session-fast')}>切到快会话</button>
    <button type="button" onClick={() => setSessionId('session-a')}>切回初始会话</button>
    <CapabilityFactoryBatchHistory batches={factory.batches} selectedId={factory.batch?.id}
      running={factory.running} onSelect={factory.select} onCancel={factory.cancel} />
  </main>
}

/** 评测路由挂载真实区块，覆盖超过十条时的选择上限与请求快照。 */
function EvaluationHarness(): React.ReactElement {
  React.useEffect(() => { document.body.dataset.smokeReady = 'true' }, [])
  return <CapabilityFactoryEvaluationSection sessionId="session-evaluation" scene={evaluationScene} />
}

const permissionStore = createStore()
const accessStore = createStore()

/** 生成宿主冻结后的采纳审批快照，内容不依赖模型临时描述。 */
function adoptionRequest(requestId: string, sessionId = 'session-permission', verified = true): PermissionRequest {
  return {
    requestId,
    sessionId,
    toolName: 'factory_apply_operation',
    toolInput: {
      preparedId: `prepared-${requestId}`,
      approval: {
        kind: 'operation',
        tool: 'factory_apply_operation',
        operation: 'adoptDraft',
        title: '采纳测试场景草案',
        lines: ['v2 -> v3'],
        destructive: false,
        appliesImmediately: true,
        adoption: {
          changes: ['把回答约束改为：每条事实必须引用证据编号'],
          rationale: '当前提示词会输出未带证据编号的结论',
          proposal: {
            problem: '旧提示词可能生成无法追溯的结论',
            expectedBenefit: '预计减少无依据引用',
            risk: '可能让回复更保守',
          },
          benefits: verified ? ['候选在同条件测试中修复了错误引用'] : [],
          currentProblems: verified ? ['基线在两个样本中均出现错误引用'] : [],
          remainingRisks: verified ? ['测试样本只有两个'] : [],
          validation: verified ? '2条同条件对比，候选2/2通过' : '未验证：尚未运行同条件批量测试',
        },
      },
    },
    description: '采纳测试场景草案',
    dangerLevel: 'normal',
    allowAlways: true,
  }
}

/** 生成会注册通用 Enter 快捷键的普通审批。 */
function normalPermissionRequest(requestId: string): PermissionRequest {
  return {
    requestId,
    sessionId: 'session-permission',
    toolName: 'read_file',
    toolInput: { path: '/private/tmp/smoke.txt' },
    description: '普通 smoke 请求',
    dangerLevel: 'safe',
    allowAlways: false,
  }
}

/** 先渲染普通审批，让 PermissionBanner 注册真实的 Enter handler。 */
function enqueueNormalPermission(requestId: string): void {
  permissionStore.set(allPendingPermissionRequestsAtom, new Map([
    ['session-permission', [normalPermissionRequest(requestId)]],
  ]))
}

/** 将一条新审批写入真实权限队列，验证每次采纳都必须重新确认。 */
function enqueueAdoption(requestId: string, sessionId = 'session-permission', verified = true): void {
  permissionStore.set(allPendingPermissionRequestsAtom, (current) => {
    const next = new Map(current)
    next.set(sessionId, [adoptionRequest(requestId, sessionId, verified)])
    return next
  })
}

/** 权限路由挂载真实 PermissionBanner 与 Jotai 队列。 */
function PermissionHarness(): React.ReactElement {
  React.useEffect(() => {
    enqueueNormalPermission('normal-before-adoption')
    document.body.dataset.smokeReady = 'true'
  }, [])
  return <Provider store={permissionStore}>
    <main className="p-4">
      <p aria-label="场景版本">v{state.sceneVersion}</p>
      <PermissionBanner sessionId="session-permission" onStop={() => undefined} />
    </main>
  </Provider>
}

const accessProjects: readonly import('@proma/shared').ServerOpsProject[] = [{ id: 'project-access', name: 'Smoke', createdAt: 1, updatedAt: 1 }]
const accessConnections: readonly import('../src/renderer/components/server-ops/server-ops-connections').ServerOpsConnection[] = [{ id: 'ssh:smoke-host', kind: 'ssh', projectId: 'project-access', label: 'Smoke 主机', detail: 'root@127.0.0.1:22', hostId: 'smoke-host', connected: true }]

/** 真实授权弹窗的内存 API；资源保存计数用于确保模式切换不触发授权范围保存。 */
const accessApi = {
  get: async () => ({ sessionId: 'session-access-a', revision: 1, grantedAt: 1, resources: [{ kind: 'ssh' as const, hostId: 'smoke-host' }] }),
  set: async () => { state.resourceSetCalls += 1; throw new Error('资源保存不应被模式切换调用') },
}

/** 挂载运维授权弹窗与其内部 Agent 模式控件，所有数据留在临时 Jotai store。 */
function AccessHarness(): React.ReactElement {
  const targetSession = 'session-access-a'
  /** 订阅真实组件发布后的 atom，不能由模拟 IPC 代替生产组件更新状态。 */
  const sessions = useAtomValue(agentSessionsAtom, { store: accessStore })
  React.useEffect(() => { document.body.dataset.smokeReady = 'true' }, [])
  return <Provider store={accessStore}>
    <main className="p-4">
      <p aria-label="访问会话模式">{sessions.find((session) => session.id === targetSession)?.toolMode ?? 'missing'}</p>
      <p aria-label="其他会话模式">{sessions.find((session) => session.id === 'session-access-b')?.toolMode ?? 'missing'}</p>
      <Toaster />
      <ServerOpsAgentReadAccess
        sessionId={targetSession}
        projectId="project-access"
        projects={accessProjects}
        connections={accessConnections}
        allConnections={accessConnections}
        dataSources={[]}
        dialogOnly
        api={accessApi}
      />
    </main>
  </Provider>
}

Object.assign(window.__factoryBatchSmoke, {
  enqueueAdoption,
  capturedKeydownCount: () => capturedKeydownHandlers.length,
  invokeCapturedEnter: () => {
    const handler = capturedKeydownHandlers.at(-1)
    if (!handler) return false
    handler(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    return true
  },
  pendingPermissionIds: (sessionId: string) => (
    permissionStore.get(allPendingPermissionRequestsAtom).get(sessionId) ?? []
  ).map((request) => request.requestId),
})

const route = new URLSearchParams(window.location.search).get('case')
if (route === 'access' || route === 'access-failure') {
  accessStore.set(agentSessionsAtom, [
    { id: 'session-access-a', title: '写会话 A', workspaceId: 'workspace-access', createdAt: 1, updatedAt: 1, toolMode: 'server-ops-write' },
    { id: 'session-access-b', title: '写会话 B', workspaceId: 'workspace-access', createdAt: 1, updatedAt: 1, toolMode: 'server-ops-write' },
  ])
  if (route === 'access-failure') state.failNextPermission = true
}
createRoot(document.getElementById('root')!).render(
  route === 'evaluation' ? <EvaluationHarness />
    : route === 'permission' ? <PermissionHarness />
      : route === 'access' || route === 'access-failure' ? <AccessHarness />
        : <Harness />,
)
