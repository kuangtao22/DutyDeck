import '@fontsource-variable/inter/index.css'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import type {
  TokenUsageAPI,
  TokenUsageQuery,
  TokenUsageRecord,
} from '@proma/shared'
import { TokenUsageSettings } from '../src/renderer/components/settings/TokenUsageSettings'
import '../src/renderer/styles/globals.css'
import { aggregateTokenUsage, tokenUsageTaskDetail, tokenUsageExportRecords } from '../src/main/lib/token-usage-query'

/** 隔离样本只存内存；真实用户数据、模型、配置完全不参与。 */
const records: TokenUsageRecord[] = Array.from({ length: 30 }, (_, index) => ({
  id: `fixture-call-${index}`,
  taskId: `fixture-task-${index % 12}`,
  taskTitle: `验收任务 ${(index % 12) + 1}：检查统计与来源`,
  projectId: index % 2 ? 'project-b' : 'project-a',
  projectName: index % 2 ? '小说工作台' : 'DutyDeck',
  channelId: 'channel-a',
  channelName: '验收渠道',
  modelId: index % 2 ? 'Fixture Model B' : 'Fixture Model A',
  source: index % 3 ? 'agent' : 'title',
  startedAt: Date.now() - (index % 7) * 86400000,
  finishedAt: Date.now() - (index % 7) * 86400000 + 1000,
  status: index % 7 ? 'completed' : 'cancelled',
  origin: 'live',
  inputTokens: index % 5 ? 1000 + index * 90 : null,
  outputTokens: index % 5 ? 100 + index * 20 : null,
  cacheReadTokens: index % 5 ? 100 : null,
  cacheWriteTokens: index % 5 ? 0 : null,
}))
/** 仅 fixture 的计数器用于可读验收，不暴露生产数据。 */
const smoke = { queries: [] as TokenUsageQuery[], exports: [] as TokenUsageQuery[], mode: 'normal' }
/** 内存 API 同时模拟异步、错误、空结果，供真实组件交互验收。 */
const api: TokenUsageAPI = {
  getTokenUsage: async (query) => {
    smoke.queries.push({ ...query })
    await new Promise((resolve) => setTimeout(resolve, smoke.mode === 'loading' ? 60000 : 150))
    if (smoke.mode === 'error') throw new Error('验收模拟失败')
    return aggregateTokenUsage(smoke.mode === 'empty' ? [] : records, query, {
      trackingStartedAt: Date.now() - 86400000 * 7,
      historyImportedAt: null,
      historyRecords: 0,
      notes: ['此页为隔离验收，只使用内存样本。'],
    })
  },
  getTokenUsageTask: async (id, query) => tokenUsageTaskDetail(records, id, query),
  exportTokenUsage: async (query) => {
    smoke.exports.push({ ...query })
    return { saved: true, count: tokenUsageExportRecords(records, query).length }
  },
}
Object.assign(window, {
  electronAPI: { updateSettings: async () => undefined, browserSetModalVisible: async () => undefined },
  __tokenUsageSmoke: smoke,
})
/** URL 参数切换深浅主题与错误边界，无需修改生产页面。 */
const params = new URLSearchParams(location.search)
smoke.mode = params.get('mode') ?? 'normal'
document.documentElement.classList.toggle('dark', params.get('theme') !== 'light')
createRoot(document.getElementById('root')!).render(
  <div className="min-h-screen bg-content-area text-foreground">
    <div className="mx-auto max-w-[1080px] px-8 py-8">
      <TokenUsageSettings api={api} />
    </div>
  </div>,
)
