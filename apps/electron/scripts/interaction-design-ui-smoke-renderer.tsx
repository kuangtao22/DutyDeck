import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { createStore, Provider } from 'jotai'
import type { InteractionDesignApi, InteractionDesignChanged, InteractionDesignInputs, InteractionDesignMethod, InteractionDesignResults, PrototypeCandidate, PrototypeDocument, PrototypeHandoff, PrototypeSnapshot } from '@proma/shared'
import { agentPendingPromptAtom } from '../src/renderer/atoms/agent-atoms'
import { TooltipProvider } from '../src/renderer/components/ui/tooltip'
import '../src/renderer/styles/globals.css'
/** 内存测试正文，绝不访问真实项目。 */
const initial: PrototypeDocument = { schemaVersion: 1, id: 'proto-a', revision: 1, createdAt: 1, updatedAt: 1, name: '拾光测试', brief: '', platform: 'mobile', groups: [{ id: 'group-a', name: '开始' }, { id: 'group-b', name: '核心', parentId: 'group-a' }], pages: [{ id: 'home', groupId: 'group-a', name: '欢迎', html: '<html><head><style>body{font:18px system-ui;background:#f3f6ed;padding:28px}button{padding:15px;background:#557b60;color:white;border:0;border-radius:12px}</style></head><body><h1 data-prototype-element="title">拾光</h1><input placeholder="你的名字"><button data-prototype-element="next" data-prototype-page="detail">开始体验</button></body></html>' }, { id: 'detail', groupId: 'group-b', name: '今日习惯', html: '<html><body><h1 data-prototype-element="title">今日习惯</h1><button data-prototype-page="home">返回首页</button></body></html>' }], entryPageId: 'home', flows: [] }
/** 候选与 head 不同以检验不自动采用。 */
const candidate: PrototypeCandidate = { id: 'candidate-a', prototypeId: 'proto-a', baseRevision: 1, summary: '明确欢迎文案', status: 'ready', createdAt: 2, draft: { ...structuredClone(initial), pages: initial.pages.map(page => ({ ...page, html: page.html.replace('拾光</h1>', '开始你的第一天</h1>') })) } }
/** 模拟 Agent 在当前项目新建的原型及其导入候选，验证目录不会漏掉其他原型事件。 */
const remoteDocument: PrototypeDocument = { ...structuredClone(initial), id: 'proto-remote', name: '缓存与空间', pages: [{ ...structuredClone(initial.pages[0]!), name: '首页', html: '<html><body><h1>缓存与空间</h1></body></html>' }], entryPageId: 'home' }
const remoteCandidate: PrototypeCandidate = { id: 'candidate-remote', prototypeId: 'proto-remote', baseRevision: 1, summary: '导入缓存页面', status: 'ready', createdAt: 3, draft: { ...structuredClone(remoteDocument), pages: [...remoteDocument.pages, { id: 'cache', groupId: 'group-a', name: '缓存页', html: '<html><body><h1>缓存页</h1></body></html>' }] } }
/** 调用记录和延迟开关只存在 fixture 内存。 */
const state = { snapshot: { document: structuredClone(initial), versions: [{ revision: 1, summary: '初始版本', createdAt: 1 }], candidates: [candidate], assets: [], jobs: [], checks: [] } as PrototypeSnapshot, remoteVisible: false, calls: [] as string[], holdCandidate: false, pendingCandidate: false, failNext: false }
const listeners = new Set<(event: InteractionDesignChanged) => void>()
let releaseCandidate: (() => void) | undefined
let switchHost: (() => void) | undefined
/** 切换到没有任何原型的隔离项目，覆盖新建入口回归。 */
let switchEmpty: (() => void) | undefined
const store = createStore()
/** mock 保留身份和 CAS，未知调用显式失败。 */
const api: InteractionDesignApi = {
  onChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  async invoke<M extends InteractionDesignMethod>(method: M, input: InteractionDesignInputs[M]): Promise<InteractionDesignResults[M]> {
    state.calls.push(`${method}:${input.sessionId}`)
    if (state.failNext) { state.failNext = false; throw new Error('fixture 读取失败') }
    let result: unknown
    /** fixture 当前请求的目标原型；list/create 等命令没有该字段。 */
    const requestedPrototypeId = 'prototypeId' in input ? input.prototypeId : undefined
    const current = input.sessionId === 'session-b' ? { ...state.snapshot, document: { ...initial, id: 'proto-b', name: '新项目原型' }, candidates: [] } : input.sessionId === 'session-a' && requestedPrototypeId === 'proto-remote' ? { document: structuredClone(remoteDocument), versions: [{ revision: 1, summary: '创建原型', createdAt: 3 }], candidates: [structuredClone(remoteCandidate)], assets: [], jobs: [], checks: [] } : state.snapshot
    switch (method) {
      case 'list': result = input.sessionId === 'session-c' ? [] : input.sessionId === 'session-a' && state.remoteVisible ? [{ id: state.snapshot.document.id, name: state.snapshot.document.name, platform: 'mobile', revision: state.snapshot.document.revision, pageCount: 2, updatedAt: 1 }, { id: remoteDocument.id, name: remoteDocument.name, platform: 'mobile', revision: remoteDocument.revision, pageCount: remoteCandidate.draft.pages.length, updatedAt: 3 }] : [{ id: current.document.id, name: current.document.name, platform: 'mobile', revision: current.document.revision, pageCount: 2, updatedAt: 1 }]; break
      case 'load': result = structuredClone(current); break
      case 'create': {
        const request = input as InteractionDesignInputs['create']
        /** 新建结果模拟主进程返回的空原型首个版本。 */
        const created = { ...structuredClone(initial), id: 'proto-created', name: request.name, platform: request.platform, revision: 1, pages: [{ ...structuredClone(initial.pages[0]!), name: request.pageName ?? initial.pages[0]!.name }], entryPageId: 'home' }
        state.snapshot = { ...state.snapshot, document: created, versions: [{ revision: 1, summary: '创建原型', createdAt: 3 }], candidates: [] }
        result = structuredClone(state.snapshot)
        break
      }
      case 'getCandidate': if (state.holdCandidate) { state.pendingCandidate = true; await new Promise<void>(resolve => { releaseCandidate = resolve }); state.pendingCandidate = false } result = structuredClone(candidate); break
      case 'save': { const request = input as InteractionDesignInputs['save']; if (request.baseRevision !== state.snapshot.document.revision) throw new Error('fixture 版本冲突'); state.snapshot.document = { ...state.snapshot.document, ...request.draft, revision: request.baseRevision + 1 }; state.snapshot.versions.push({ revision: state.snapshot.document.revision, summary: request.summary, createdAt: 3 }); result = structuredClone(state.snapshot); break }
      case 'adopt': state.snapshot.document = { ...state.snapshot.document, ...candidate.draft, revision: state.snapshot.document.revision + 1 }; state.snapshot.candidates = [{ ...candidate, status: 'adopted' }]; state.snapshot.versions.push({ revision: state.snapshot.document.revision, summary: '采纳候选', createdAt: 4 }); result = structuredClone(state.snapshot); break
      case 'restore': state.snapshot.document = { ...structuredClone(initial), revision: 1 }; result = structuredClone(state.snapshot); break
      case 'deleteVersion': {
        /** 删除请求使用打开确认时冻结的基线；模拟真实服务的冲突校验。 */
        const request = input as InteractionDesignInputs['deleteVersion']
        if (request.baseRevision !== state.snapshot.document.revision) throw new Error('fixture 版本冲突')
        if (request.revision === state.snapshot.document.revision) throw new Error('当前版本不能删除')
        state.snapshot.versions = state.snapshot.versions.filter(version => version.revision !== request.revision)
        result = structuredClone(state.snapshot)
        break
      }
      case 'createHandoff': {
        const request = input as InteractionDesignInputs['createHandoff']
        const handoff: PrototypeHandoff = {
          schemaVersion: 1, id: 'handoff-a', prototypeId: request.prototypeId, revision: request.revision, createdAt: 4, name: initial.name, platform: 'mobile', brief: '主路径',
          groups: [{ id: 'group-a', name: '开始', path: '开始' }, { id: 'group-b', name: '核心', parentId: 'group-a', path: '开始 / 核心' }],
          pages: [{ id: 'home', name: '欢迎', groupId: 'group-a', groupPath: '开始', elementIds: ['title', 'next'], flowIds: [] }, { id: 'detail', name: '今日习惯', groupId: 'group-b', groupPath: '开始 / 核心', elementIds: ['title'], flowIds: [] }],
          entryPageId: 'home', flows: [], assets: [], designTokens: {}, visualContract: { viewport: { width: 390, height: 844 }, preserve: ['布局比例'] }, manifestHash: 'a'.repeat(64),
        }
        result = handoff
        break
      }
      case 'inspectProject': result = { projectName: '当前项目', frameworks: ['React'], files: [{ path: 'src/App.tsx', kind: 'code', byteSize: 120 }], warnings: [], truncated: false }; break
      default: throw new Error(`fixture 未实现命令：${method}`)
    }
    return result as InteractionDesignResults[M]
  },
}
Object.defineProperty(window, 'electronAPI', { value: { interactionDesign: api }, configurable: true })
Object.defineProperty(window, '__interactionSmoke', { value: { state, switchHost: () => switchHost?.(), switchEmpty: () => switchEmpty?.(), release: () => { state.holdCandidate = false; releaseCandidate?.() }, prompt: () => store.get(agentPendingPromptAtom), change: (workspaceId = 'workspace-a', prototypeId?: string) => { if (workspaceId === 'workspace-a' && prototypeId === 'proto-remote') state.remoteVisible = true; for (const listener of listeners) listener({ workspaceId, prototypeId }) } } })
/** API 安装后再载入真实组件。 */
const { InteractionDesignWorkspace } = await import('../src/renderer/components/interaction-design/InteractionDesignWorkspace')
function Fixture(): React.ReactElement {
  const [host, setHost] = React.useState('a')
  switchHost = () => setHost('b')
  switchEmpty = () => setHost('c')
  return <Provider store={store}><TooltipProvider><div style={{ height: '100vh', display: 'flex', padding: 12 }}><InteractionDesignWorkspace projectId={`workspace-${host}`} sessionId={`session-${host}`} /></div></TooltipProvider></Provider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
