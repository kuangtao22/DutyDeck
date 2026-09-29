/** 复用正式组件的隔离预览：模拟调用只改内存，不读取用户项目或调用模型。 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { getDefaultStore } from 'jotai'
import { createEmptySceneDefinition, getStepAcceptance } from '@proma/shared'
import type { CapabilityRun, CapabilitySavedTask, CapabilityScene, CapabilitySceneDefinition } from '@proma/shared'
import { CapabilityFactoryPanel } from '@/components/capability-factory/CapabilityFactoryPanel'
import { RichTextInput, type RichTextInputHandle } from '@/components/ai-elements/rich-text-input'
import { bindAgentInputText } from '@/lib/agent-input-text'
import { applyThemeToDOM, themeModeAtom } from '@/atoms/theme'
import '@/styles/globals.css'

/** 示例场景只包含需要训练的提示词步骤。 */
let scene: CapabilityScene = {
  id: 'preview-scene', currentVersion: 2, createdAt: 1, updatedAt: 2, draft: null,
  definition: {
    ...createEmptySceneDefinition('角色识别'),
    description: '从小说正文提取角色及其证据，输出供阅读应用使用的角色信息。',
    steps: [{
      id: 'characters', type: 'extract', title: '识别角色', modelSlot: 'main',
      prompt: '阅读以下正文，提取其中出现的角色。\n\n正文：{{text}}\n\n仅返回 JSON，包含 characters 数组。每个角色必须包含 name、description 和 evidence；没有证据的信息留空。',
      inputs: { text: { from: 'workflow-input', field: 'text' } },
      judgeFields: [{ name: 'characters', type: 'array' }],
    }, {
      id: 'profiles', type: 'llm', title: '整理人物信息', modelSlot: 'main',
      prompt: '根据角色候选整理人物信息：{{characters}}。只保留有证据的信息，不推断未出现的关系。',
      inputs: { characters: { from: 'step-output', stepId: 'characters' } },
    }],
    inputs: [{ name: 'text', type: 'string', required: true }],
    stepAcceptances: { characters: {
      criteria: ['每个角色都有原文证据', '不得把无姓名的路人当成主要角色'],
      judgePrompt: '根据原文证据评审角色提取结果，指出误报、遗漏和证据问题。',
      metrics: [{ name: 'evidenceCoverage', weight: 1, direction: 'positive' }],
    }, profiles: {
      criteria: ['每份人物信息对应已识别角色', '不得补造原文没有的人物关系'],
      judgePrompt: '只评人物信息整理步骤：对照输入候选，核对归属、事实及关系依据。',
      metrics: [],
    } },
  },
}
/** 测试输入特意较长，用于检查输入与弹窗的滚动边界。 */
const sampleText = '林舟推开书店的门。掌柜陈伯放下账本，向他点了点头。\n'.repeat(80)
/** 返回固定模型示例，使 UI 验证可重复且不产生模型费用。 */
const output = { characters: [{ name: '林舟', description: '来到书店', evidence: '林舟推开书店的门。' }, { name: '陈伯', description: '书店掌柜', evidence: '掌柜陈伯放下账本。' }] }
/** 生成隔离运行记录，记录编辑中的提示词和输入供断言验证。 */
function makeRun(id: string, input: Record<string, unknown>, definition: CapabilitySceneDefinition, singleStepId?: string): CapabilityRun {
  /** 单步夹具取指定步骤；整链夹具包含全部声明步骤。 */
  const step = definition.steps.find((item) => item.id === singleStepId) ?? definition.steps[0]!
  /** 保留模板和替换后的提示词两份证据。 */
  const prompt = 'prompt' in step ? step.prompt : ''
  return {
    id, sceneId: scene.id, sceneVersion: scene.currentVersion, kind: singleStepId ? 'step' : 'full',
    ...(singleStepId ? { stepId: step.id } : {}),
    definitionSnapshot: structuredClone(definition),
    status: 'succeeded', valid: true, input, outputs: output, stepPrompt: prompt,
    startedAt: Date.now(), finishedAt: Date.now() + 1200,
    steps: definition.steps.filter((item) => !singleStepId || item.id === singleStepId).map((item) => ({ stepId: item.id, title: item.title, type: item.type, status: 'succeeded', attempts: 1,
      input, prompt: 'prompt' in item ? item.prompt.replace('{{text}}', String(input.text ?? '')) : '', rawOutput: JSON.stringify(output, null, 2),
      parsedOutput: output, startedAt: Date.now(), finishedAt: Date.now() + 1200 })),
  }
}
/** 历史只存在页面内存，刷新后恢复。 */
let runs = [makeRun('previous', { text: sampleText }, scene.definition), makeRun('baseline', { text: sampleText }, scene.definition)]
/** 预览任务只存在页面内存；正式程序通过主进程文件存储。 */
let savedTasks: CapabilitySavedTask[] = []
/** 供 smoke 断言保存策略，不影响正式程序。 */
const calls: string[] = []
/** 模拟 preload 的请求级进度订阅。 */
const progressListeners = new Set<(event: { requestId: string; run: CapabilityRun }) => void>()
Object.defineProperty(window, 'electronAPI', { value: {
  capabilityFactory: {
    onRunProgress: (listener: (event: { requestId: string; run: CapabilityRun }) => void) => {
      progressListeners.add(listener)
      return () => { progressListeners.delete(listener) }
    },
    invoke: async (method: string, input: Record<string, unknown>) => {
    calls.push(method)
    switch (method) {
      case 'listScenes': return [scene]
      case 'getScene': return scene
      case 'listTasks': return savedTasks
      case 'listRuns': {
        /** 在调用时拍快照，可模拟历史读取晚于新试跑返回。 */
        const history = input.kind === 'full' ? runs.filter((run) => run.kind === 'full') : [...runs]
        if (params.has('historyDelay')) await new Promise((resolve) => setTimeout(resolve, 1800))
        return history
      }
      case 'listStubs': case 'listVersions': case 'listDatasets': case 'listEvaluations': case 'listDeliveries': return []
      case 'runStep': case 'runScene': {
        if (method === 'runScene' && !input.comparisonId) {
          /** 保存发生在模拟模型调用前，失败也可再次选择。 */
          const taskInput = structuredClone(input.input as Record<string, unknown>)
          const previous = savedTasks.find((task) => JSON.stringify(task.input) === JSON.stringify(taskInput))
          const task: CapabilitySavedTask = {
            id: previous?.id ?? crypto.randomUUID(), sceneId: scene.id, input: taskInput,
            createdAt: previous?.createdAt ?? Date.now(), updatedAt: Date.now(),
          }
          savedTasks = [task, ...savedTasks.filter((item) => item.id !== task.id)]
        }
        /** 隔离预览的启动延迟；正式程序完全由 runner 事件驱动。 */
        await new Promise((resolve) => setTimeout(resolve, 400))
        /** 试跑读取编辑定义，整链读取已采纳的定义。 */
        const trialDefinition = input.target === 'draft' ? scene.draft!.definition : (input.definition as CapabilitySceneDefinition | undefined) ?? scene.definition
        const run = makeRun(`preview-${runs.length}`, input.input as Record<string, unknown>, trialDefinition, method === 'runStep' ? String(input.stepId) : undefined)
        run.definitionTarget = input.target === 'draft' ? 'draft' : 'current'
        run.definitionSnapshot = structuredClone(trialDefinition)
        run.draftCreatedAt = input.target === 'draft' ? scene.draft!.createdAt : undefined
        run.comparisonId = typeof input.comparisonId === 'string' ? input.comparisonId : undefined
        run.comparisonRole = input.comparisonRole === 'candidate' ? 'candidate' : input.comparisonRole === 'baseline' ? 'baseline' : undefined
        run.modelBindings = [{ slotId: 'main', declaredModel: 'preview', channelId: 'preview', channelName: '隔离模拟', modelId: 'preview', substituted: false }]
        if (input.comparisonRole === 'baseline') {
          /** 故意加入误报，确保示例评审证据与展示的基线输出一致。 */
          const baselineOutput = { characters: [...output.characters, { name: '路人', description: '经过门口', evidence: '一位路人经过门口' }] }
          run.outputs = baselineOutput
          run.steps[0]!.parsedOutput = baselineOutput
          run.steps[0]!.rawOutput = JSON.stringify(baselineOutput, null, 2)
        }
        if (method === 'runScene') run.kind = 'full'
        /** 每次发送独立快照，复现真实 IPC 的结构化复制边界。 */
        const requestId = typeof input.requestId === 'string' ? input.requestId : ''
        const publish = (snapshot: CapabilityRun): void => {
          if (requestId) for (const listener of progressListeners) listener({ requestId, run: structuredClone(snapshot) })
        }
        /** 只为隔离预览保留可观察延迟，不改变正式运行的速度与顺序。 */
        const stepDelay = Math.max(0, Number(params.get('stepDelay') ?? 800) || 0)
        for (let index = 0; index < run.steps.length; index += 1) {
          const step = run.steps[index]!
          step.startedAt = Date.now()
          publish({ ...run, status: 'running', valid: false, outputs: null, finishedAt: null,
            steps: run.steps.slice(0, index), activeStepIds: [step.stepId] })
          await new Promise((resolve) => setTimeout(resolve, stepDelay))
          if (params.has('fail')) throw new Error('模拟模型暂时不可用')
          step.finishedAt = Date.now()
          publish({ ...run, status: 'running', valid: false, outputs: null, finishedAt: null,
            steps: run.steps.slice(0, index + 1), activeStepIds: [] })
        }
        run.finishedAt = Date.now()
        const reviewing: CapabilityRun = {
          ...run,
          review: {
            status: 'running', passed: null, summary: '正在检查证据与角色身份',
            acceptance: getStepAcceptance(trialDefinition, 'characters')!,
            criteria: [], metrics: [], suggestions: [], startedAt: Date.now(), finishedAt: null,
          },
        }
        const reviewFailed = params.has('reviewFail')
        const reviewed: CapabilityRun = {
          ...reviewing,
          review: reviewFailed ? {
            ...reviewing.review!, status: 'failed', summary: '评测服务未完成', error: '模拟评测失败', finishedAt: Date.now(),
          } : {
            ...reviewing.review!, status: 'succeeded', passed: input.target === 'draft', summary: input.target === 'draft' ? '模拟对比：候选已排除无名路人。' : '模拟对比：输出结构正确，但误报规则仍需收紧。',
            criteria: [
              { criterion: '每个角色都有原文证据', passed: true, evidence: '两个角色均引用了原文。' },
              { criterion: '不得把无姓名的路人当成主要角色', passed: input.target === 'draft', evidence: input.target === 'draft' ? '模拟证据：候选只保留具名人物。' : '模拟证据：基线误报了一名无姓名路人。' },
            ],
            metrics: [{ name: 'evidenceCoverage', value: 1, evidence: '2/2 角色包含证据。' }],
            suggestions: ['在提示词中要求区分“出现人物”与“主要角色”。'],
            finishedAt: Date.now(),
          },
        }
        /** 各步骤使用自己的规则与结果，隔离示例不触发真实评审模型。 */
        reviewed.stepReviews = Object.fromEntries(run.steps.map((step) => {
          const acceptance = getStepAcceptance(trialDefinition, step.stepId)!
          return [step.stepId, { ...reviewed.review!, acceptance,
            summary: step.stepId === 'characters' ? reviewed.review!.summary : '人物信息整理符合输入证据。',
            passed: reviewFailed ? null : step.stepId === 'characters' ? reviewed.review!.passed : true,
            criteria: acceptance.criteria.map((criterion, index) => ({ criterion, passed: reviewFailed ? null : step.stepId === 'characters' && index === 1 ? input.target === 'draft' : true, evidence: '隔离示例：按本步骤输入与输出核对。' })),
            metrics: [],
          }]
        }))
        const stepReviewList = Object.values(reviewed.stepReviews)
        reviewed.review = { ...reviewed.review!,
          passed: stepReviewList.every((item) => item.passed === true),
          summary: `已评审 ${stepReviewList.length} 个流程步骤：${stepReviewList.filter((item) => item.passed === true).length} 个通过。`,
          acceptance: { criteria: stepReviewList.flatMap((item) => item.acceptance.criteria), judgePrompt: '', metrics: [] },
          criteria: stepReviewList.flatMap((item) => item.criteria), metrics: stepReviewList.flatMap((item) => item.metrics),
          suggestions: stepReviewList.flatMap((item) => item.suggestions),
        }
        /** 依次发出步骤评审开始与完成，方便观察等待、执行、完成的切换。 */
        const reviewDelay = Math.max(0, Number(params.get('reviewDelay') ?? 900) || 0)
        const stepReviews: NonNullable<CapabilityRun['stepReviews']> = {}
        for (const step of run.steps) {
          const result = reviewed.stepReviews[step.stepId]!
          stepReviews[step.stepId] = { ...result, status: 'running', passed: null, criteria: [], metrics: [], suggestions: [],
            summary: `正在评审「${step.title}」`, startedAt: Date.now(), finishedAt: null }
          publish({ ...reviewing, stepReviews: { ...stepReviews }, review: { ...reviewing.review!, summary: `正在评审「${step.title}」` } })
          await new Promise((resolve) => setTimeout(resolve, reviewDelay))
          stepReviews[step.stepId] = { ...result, startedAt: stepReviews[step.stepId]!.startedAt, finishedAt: Date.now() }
        }
        reviewed.stepReviews = stepReviews
        reviewed.review.finishedAt = Date.now()
        runs = [reviewed, ...runs]
        return reviewed
      }
      case 'saveDraft':
        scene = { ...scene, draft: { definition: input.definition as CapabilitySceneDefinition, source: 'human', note: '调整识别角色的提示词', createdAt: Date.now() } }
        return scene
      case 'adoptDraft':
        scene = { ...scene, definition: scene.draft!.definition, draft: null, currentVersion: scene.currentVersion + 1 }
        return { scene, version: { sceneId: scene.id, version: scene.currentVersion, definition: scene.definition, source: 'human', note: '采纳候选', createdAt: Date.now() } }
      case 'discardDraft': scene = { ...scene, draft: null }; return scene
      default: throw new Error(`预览未模拟此操作：${method}`)
    }
    },
  },
} })
Object.defineProperty(window, 'factoryPreview', { value: { snapshot: () => ({ scene, runs, calls }) } })
/** 用查询参数覆盖窄面板和深浅主题。 */
const params = new URLSearchParams(location.search)
/** 长标题、两个输入和长字段说明的回归夹具，只使用合成正文，不访问真实任务。 */
if (params.has('longTask')) {
  scene.definition.inputs = [
    { name: 'text', type: 'string', description: '输入包含 paragraphRef 和 text 的正文片段。'.repeat(8) },
    { name: 'knownCharacters', type: 'object', required: false, description: '已有角色信息，仅供消歧。' },
  ]
  savedTasks = [{
    id: 'long-task', sceneId: scene.id, createdAt: 1, updatedAt: 1,
    input: { text: sampleText, knownCharacters: { names: ['林舟', '陈伯'] } },
  }]
}
/** 优化闭环夹具：固定两条任务与一份未采纳草案，调用仍完全在内存模拟。 */
if (params.has('optimize')) {
  const candidate = structuredClone(scene.definition)
  const step = candidate.steps[0]
  if (step && 'prompt' in step) step.prompt += '\n只收录具名角色，排除无名路人与泛称。'
  scene.draft = { definition: candidate, source: 'agent', note: '收紧角色边界，排除无名路人；评审标准保持一致。', createdAt: 3 }
  savedTasks = [
    { id: 'sample-a', sceneId: scene.id, input: { text: '林舟推开书店的门。掌柜陈伯放下账本。' }, createdAt: 1, updatedAt: 2 },
    { id: 'sample-b', sceneId: scene.id, input: { text: '一位路人经过门口，林舟向陈伯打招呼。' }, createdAt: 1, updatedAt: 1 },
  ]
}
/** 长运行结果夹具：验证标题固定和编辑器滚动，所有内容仅为合成数据。 */
if (params.has('longResult') && runs[0]) {
  const longOutput = { characters: Array.from({ length: 120 }, (_, index) => ({ name: `示例人物${index + 1}`, evidence: `第${index + 1}段合成正文，仅用于检查滚动。` })) }
  const latest = runs[0]
  runs[0] = { ...latest, kind: 'full', outputs: longOutput,
    steps: latest.steps.map((step) => ({ ...step, parsedOutput: longOutput, rawOutput: JSON.stringify(longOutput, null, 2), prompt: sampleText })),
    modelBindings: Array.from({ length: 40 }, (_, index) => ({ slotId: `sample-${index}`, declaredModel: 'preview', channelId: 'preview', channelName: '隔离示例', modelId: 'preview', substituted: false })),
    review: { status: 'succeeded', passed: false, summary: '滚动测试的示例评审。',
      acceptance: { ...getStepAcceptance(scene.definition, 'characters')!, criteria: Array.from({ length: 40 }, (_, index) => `模拟标准${index + 1}：必须来自原文证据。`) },
      criteria: [{ criterion: '模拟失败判据', passed: false, evidence: '这是一条用于验证长内容滚动的合成证据。'.repeat(100) }],
      metrics: [], suggestions: [], startedAt: 1, finishedAt: 2 },
  }
  /** 长结果也保留每个步骤的不同评审，便于检查切换和滚动。 */
  runs[0].stepReviews = Object.fromEntries(scene.definition.steps.map((step) => [step.id, {
    ...runs[0]!.review!, acceptance: getStepAcceptance(scene.definition, step.id)!,
    summary: `${step.title}的示例评审`, criteria: getStepAcceptance(scene.definition, step.id)!.criteria.map((criterion) => ({ criterion, passed: false, evidence: '合成证据，仅用于检查步骤评审。' })),
  }]))
}
/** 预览的 DOM 与编辑器共用同一主题，不写入用户主题缓存或正式设置。 */
const previewTheme = params.get('theme') === 'dark' ? 'dark' : 'light'
getDefaultStore().set(themeModeAtom, previewTheme)
applyThemeToDOM(previewTheme)
/** 可选的真实编辑器夹具：验证跨面板追加与撤销，不装载 Agent 或发送模型请求。 */
function PreviewComposer(): React.ReactElement {
  const editor = React.useRef<RichTextInputHandle>(null)
  const [draft, setDraft] = React.useState('我已有的补充要求，请保留。')
  React.useEffect(() => bindAgentInputText('preview', (text) => editor.current?.appendPlainText(text) ?? false), [])
  return <section aria-label="当前会话输入预览" className="max-h-60 shrink-0 overflow-auto border-t border-border p-3">
    <p className="mb-2 text-xs text-muted-foreground">当前会话输入 · 预览不发送</p>
    <RichTextInput ref={editor} value={draft} onChange={setDraft} placeholder="补充优化要求" sessionId="preview" />
  </section>
}
/** 预览容器模拟右侧工作区宽度，不引入另一套组件样式。 */
createRoot(document.getElementById('root')!).render(
  <main style={{ height: '100dvh', display: 'flex', flexDirection: 'column', maxWidth: Number(params.get('width')) || 605, margin: 'auto', borderInline: '1px solid hsl(var(--border))' }}>
    <div style={{ padding: '8px 12px', fontSize: 11, color: 'hsl(var(--muted-foreground))', borderBottom: '1px solid hsl(var(--border))' }}>交互预览 · 示例数据 · 不调用模型</div>
    <CapabilityFactoryPanel sessionId="preview" workspaceLabel="小说阅读项目" />
    {params.has('composer') ? <PreviewComposer /> : null}
  </main>,
)
