import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { createStore, Provider } from 'jotai'
import { createEmptySceneDefinition } from '@proma/shared'
import type { Channel, CapabilityScene, CapabilityFactoryCommandInputs } from '@proma/shared'
import { channelsAtom, channelsLoadedAtom, selectedModelAtom } from '../src/renderer/atoms/chat-atoms'
import { settingsOpenAtom, settingsTabAtom } from '../src/renderer/atoms/settings-tab'
import { applyThemeToDOM, themeModeAtom, themeStyleAtom } from '../src/renderer/atoms/theme'
import { CapabilityFactoryPanel } from '../src/renderer/components/capability-factory/CapabilityFactoryPanel'
import '../src/renderer/styles/globals.css'

/** 隔离渠道仅存在内存，不读取用户设置。 */
const channels: Channel[] = [{ id: 'test-channel', name: '测试渠道', provider: 'openai', enabled: true, baseUrl: 'https://example.invalid', apiKey: '',
  // 目标模型放在长列表末尾，确保真实滚动通过后才能选到，不能只靠脚本定位。
  models: [...Array.from({ length: 40 }, (_, index) => ({ id: `scroll-model-${index}`, name: `滚动验证模型 ${index + 1}`, enabled: true })),
    { id: 'test-model', name: '测试模型', enabled: true }], createdAt: 1, updatedAt: 1 }]
/** 宿主桩记录精确请求与失败开关。 */
const state = { calls: [] as Array<{ command: string; input: CapabilityFactoryCommandInputs['setModelSelection'] }>, fail: false, refreshes: 0, conversationWrites: 0 }
/** 使用独立 store 验证场景选择没有改变全局模型。 */
const store = createStore()
store.set(channelsAtom, channels)
store.set(channelsLoadedAtom, true)
store.set(selectedModelAtom, { channelId: 'global-channel', modelId: 'global-model' })
/** 固定基线用于验证并发保护请求内容。 */
const initial: CapabilityScene = { id: 'scene', currentVersion: 7, createdAt: 1, updatedAt: 1, draft: null, definition: createEmptySceneDefinition('测试') }
/** 内存模拟持久化后的场景。 */
let saved = initial
Object.defineProperty(window, 'electronAPI', { value: {
  listChannels: async () => channels,
  updateConversationModel: async () => { state.conversationWrites += 1 },
  capabilityFactory: { onChanged: () => () => undefined, invoke: async (command: string, input: CapabilityFactoryCommandInputs['setModelSelection']) => {
    if (command === 'listScenes') {
      if (saved !== initial) state.refreshes += 1
      return [saved]
    }
    if (command === 'listRuns') return []
    if (command !== 'setModelSelection') throw new Error(`未预期的 smoke 命令：${command}`)
    state.calls.push({ command, input })
    if (state.fail) throw new Error('模拟保存失败')
    saved = { ...saved, currentVersion: saved.currentVersion + 1, definition: { ...saved.definition, modelSelection: input.selection } }
    return saved
  } },
} })
Object.assign(window, { __factoryModelSmoke: {
  state,
  /** 读取模型与设置 atom，确认工厂设置不污染会话且可跳转渠道页。 */
  globalModel: () => store.get(selectedModelAtom),
  settings: () => ({ open: store.get(settingsOpenAtom), tab: store.get(settingsTabAtom) }),
  /** 模拟所有渠道被删除，验证失效引用仍显示在弹窗内。 */
  removeChannels: () => store.set(channelsAtom, []),
  /** 隔离预览同步主题 atom 与 DOM，不写用户主题配置。 */
  setTheme: (mode: 'light' | 'dark') => {
    store.set(themeModeAtom, mode)
    store.set(themeStyleAtom, 'default')
    applyThemeToDOM(mode, 'default')
  },
} })
/** 挂载完整工厂面板，验证实际标题栏入口及保存后刷新。 */
function Fixture(): React.ReactElement {
  React.useEffect(() => { document.body.dataset.smokeReady = 'true' }, [])
  return <Provider store={store}><div className="flex h-screen flex-col"><CapabilityFactoryPanel sessionId="session" /></div></Provider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
