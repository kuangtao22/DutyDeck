import { describe, expect, test } from 'bun:test'
import {
  createTokenUsageQuery,
  drillIntoTokenUsage,
  formatTokenAmount,
  tokenCoverageLabel,
  validateTokenDates,
} from '../../atoms/token-usage'

describe('Token 统计交互口径', () => {
  test('给定不同数量级的用量，显示千进位单位并保留最多两位小数', () => {
    expect(formatTokenAmount(999)).toBe('999')
    expect(formatTokenAmount(1_000)).toBe('1K')
    expect(formatTokenAmount(12_345)).toBe('12.35K')
    expect(formatTokenAmount(1_234_567)).toBe('1.23M')
    expect(formatTokenAmount(1_234_567_890)).toBe('1.23B')
    expect(formatTokenAmount(1_000_000_000_000)).toBe('1T')
  })
  test('给定单位临界值，舍入后自动进位而不显示 1000K 或 1000M', () => {
    expect(formatTokenAmount(999_994)).toBe('999.99K')
    expect(formatTokenAmount(999_995)).toBe('1M')
    expect(formatTokenAmount(999_995_000)).toBe('1B')
    expect(formatTokenAmount(999_995_000_000)).toBe('1T')
  })
  test('给定精确显示请求，保留完整数字、零和未知', () => {
    expect(formatTokenAmount(1_234_567, 'exact')).toBe('1,234,567')
    expect(formatTokenAmount(0, 'exact')).toBe('0')
    expect(formatTokenAmount(null, 'exact')).toBe('未知')
  })
  test('给定跨月日期，近七天包含今天和前六个自然日', () => {
    expect(createTokenUsageQuery('week', new Date(2026, 9, 3)).from).toBe('2026-09-27')
    expect(createTokenUsageQuery('month', new Date(2026, 9, 3)).from).toBe('2026-10-01')
  })
  test('从排行进入任务时清空旧搜索、未知限制和页码，保留全局筛选', () => {
    const query = {
      ...createTokenUsageQuery('week'),
      search: '旧任务',
      unknownOnly: true,
      page: 4,
      channelId: 'channel',
    }
    expect(drillIntoTokenUsage(query, { modelId: 'model' })).toMatchObject({
      search: undefined,
      unknownOnly: false,
      page: 1,
      modelId: 'model',
      channelId: 'channel',
    })
  })
  test('未知不能显示为零；部分报告不能冒充完整覆盖', () => {
    expect(formatTokenAmount(null)).toBe('未知')
    expect(formatTokenAmount(0)).toBe('0')
    expect(tokenCoverageLabel({ calls: 10, knownCalls: 6, partialCalls: 2, unknownCalls: 2 })).toBe(
      '6 / 10 次完整报告 · 2 次部分报告 · 2 次未知',
    )
  })
  test('自定义范围拒绝颠倒、无效日期以及超过一年', () => {
    expect(validateTokenDates('2026-10-13', '2026-10-01')).toBe(false)
    expect(validateTokenDates('2026-02-30', '2026-03-01')).toBe(false)
    expect(validateTokenDates('2025-01-01', '2026-10-13')).toBe(false)
    expect(validateTokenDates('2026-10-01', '2026-10-13')).toBe(true)
  })
})

import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  TokenUsageDataStatus,
  TokenUsageMetrics,
  TokenUsageSettings,
  TokenUsageTaskDetailStatus,
} from './TokenUsageSettings'
import { formatTokenUsageTotal } from '../../atoms/token-usage'
import type { TokenUsageAPI, TokenUsageTotals } from '@proma/shared'

/** 不可触发真实桥接的测试替身；服务端渲染阶段不会执行 effect。 */
const neverApi: TokenUsageAPI = {
  getTokenUsage: async () => {
    throw new Error('不应在渲染时调用')
  },
  getTokenUsageTask: async () => null,
  exportTokenUsage: async () => ({ saved: false, count: 0 }),
}

describe('Token 统计页面渲染', () => {
  test('给定百万级小计，指标缩写且悬停显示精确用量，调用数保留原值', () => {
    /** 已知输入和部分未知输出的样本，验证缩写不会改变覆盖语义。 */
    const totals: TokenUsageTotals = {
      inputTokens: 1_234_567, outputTokens: 0, totalTokens: 1_234_567,
      cacheReadTokens: 1_000_000, cacheWriteTokens: 0,
      calls: 1_234, knownCalls: 0, partialCalls: 1_234, unknownCalls: 0,
      reportedFields: { inputTokens: 1_234, outputTokens: 0, cacheReadTokens: 1_234, cacheWriteTokens: 0 },
    }
    /** 真实指标组件的输出用于核对可见缩写与精确提示。 */
    const markup = renderToStaticMarkup(<TokenUsageMetrics totals={totals} />)
    expect(markup).toContain('>1.23M</p>')
    expect(markup).toContain('title="1,234,567 Token"')
    expect(markup).toContain('>1,234</p>')
    expect(markup).toContain('>未知</p>')
    expect(formatTokenUsageTotal(totals, 'inputTokens', 'exact')).toBe('1,234,567')
    expect(formatTokenUsageTotal(totals, 'outputTokens', 'exact')).toBe('未知')
    expect(formatTokenUsageTotal(totals, 'cacheWriteTokens')).toBe('未知')
  })
  test('给定所有输入未知或完全未知的任务，小计也不能冒充实际零用量', () => {
    const totals: TokenUsageTotals = { inputTokens: 0, outputTokens: 4, totalTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1, knownCalls: 0, partialCalls: 1, unknownCalls: 0, reportedFields: { inputTokens: 0, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    expect(formatTokenUsageTotal(totals, 'inputTokens')).toBe('未知')
    expect(formatTokenUsageTotal(totals, 'outputTokens')).toBe('4')
    expect(formatTokenUsageTotal(totals, 'cacheReadTokens')).toBe('未知')
    expect(formatTokenUsageTotal({ ...totals, partialCalls: 0, unknownCalls: 1, totalTokens: 0 }, 'totalTokens')).toBe('未知')
    expect(formatTokenUsageTotal({ ...totals, calls: 0, totalTokens: 0 }, 'totalTokens')).toBe('0')
  })
  test('给定首次进入，显示加载反馈且禁止空导出，使用统一 combobox', () => {
    const markup = renderToStaticMarkup(<TokenUsageSettings api={neverApi} />)
    expect(markup).toContain('正在读取统计')
    expect(markup).toContain('role="combobox"')
    expect(markup).toMatch(/disabled=""[^>]*>.*?导出 CSV/)
    expect(markup).toContain('统计口径')
  })
  test('给定已有快照，刷新只显示局部状态并保留旧统计内容', () => {
    const refreshing = renderToStaticMarkup(
      <>
        <TokenUsageDataStatus hasSnapshot loading error="" onRetry={() => undefined} />
        <p>旧统计内容</p>
      </>,
    )
    expect(refreshing).toContain('正在刷新统计数据')
    expect(refreshing).toContain('旧统计内容')
    expect(refreshing).not.toContain('animate-pulse')

    const failed = renderToStaticMarkup(
      <>
        <TokenUsageDataStatus hasSnapshot={true} loading={false} error="读取失败" onRetry={() => undefined} />
        <p>旧统计内容</p>
      </>,
    )
    expect(failed).toContain('刷新统计失败，已保留上次数据')
    expect(failed).toContain('旧统计内容')
  })
  test('给定已有任务详情，刷新只显示行内提示并保留详情内容', () => {
    const refreshing = renderToStaticMarkup(
      <>
        <TokenUsageTaskDetailStatus hasDetail loading error="" onRetry={() => undefined} />
        <p>已展开的调用</p>
      </>,
    )
    expect(refreshing).toContain('当前内容仍可查看')
    expect(refreshing).toContain('已展开的调用')
    expect(refreshing).not.toContain('正在读取任务详情')

    const failed = renderToStaticMarkup(
      <>
        <TokenUsageTaskDetailStatus hasDetail loading={false} error="读取失败" onRetry={() => undefined} />
        <p>已展开的调用</p>
      </>,
    )
    expect(failed).toContain('刷新任务详情失败，已保留上次数据')
    expect(failed).toContain('已展开的调用')
  })
  test('给定含缓存的已知小计，不把缓存再次加进累计数字', () => {
    const totals: TokenUsageTotals = {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cacheReadTokens: 70,
      cacheWriteTokens: 10,
      calls: 4,
      knownCalls: 2,
      partialCalls: 1,
      unknownCalls: 1,
    }
    const markup = renderToStaticMarkup(<TokenUsageMetrics totals={totals} />)
    expect(markup).toContain('>120</p>')
    expect(markup).toContain('已报告用量小计')
    expect(markup).toContain('含缓存读取与缓存写入')
  })
})

import { loadTokenUsageSnapshot } from '../../atoms/token-usage'
import type { TokenUsageLoadState } from '../../atoms/token-usage'
import { TokenUsageFeedback } from './TokenUsageSettings'
import type { TokenUsageSnapshot } from '@proma/shared'

/** 完整空快照验证真实零调用与读取失败是不同状态。 */
const emptySnapshot: TokenUsageSnapshot = {
  totals: {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    calls: 0,
    knownCalls: 0,
    partialCalls: 0,
    unknownCalls: 0,
  },
  trend: [],
  ranking: { project: [], model: [], source: [] },
  tasks: [],
  taskCount: 0,
  page: 1,
  pageSize: 8,
  options: { projects: [], models: [], channels: [] },
  coverage: { trackingStartedAt: 1, historyImportedAt: null, historyRecords: 0, notes: [] },
}
/** 将 Promise 微任务清空，避免以时间延迟猜测请求完成。 */
async function settleRequests(): Promise<void> {
  for (let index = 0; index < 6; index++) await Promise.resolve()
}

describe('Token 统计异步与反馈边界', () => {
  test('历史恢复期间不使用渲染层定时器反复刷新页面', async () => {
    const source = await Bun.file(new URL('./TokenUsageSettings.tsx', import.meta.url)).text()
    expect(source).not.toContain('window.setTimeout(() => setRefresh')
  })
  test('加载、读取失败、空匹配保持不同文案和辅助技术角色', () => {
    expect(renderToStaticMarkup(<TokenUsageFeedback kind="loading" />)).toContain('role="status"')
    const failure = renderToStaticMarkup(<TokenUsageFeedback kind="error" />)
    expect(failure).toContain('role="alert"')
    expect(failure).toContain('重新加载')
    expect(failure).toContain('当前筛选已保留')
    const empty = renderToStaticMarkup(<TokenUsageFeedback kind="empty" />)
    expect(empty).toContain('当前范围没有匹配任务')
    expect(empty).not.toContain('读取失败')
  })
  test('给定有效空快照，请求从加载进入成功，失败请求进入错误', async () => {
    const states: TokenUsageLoadState[] = []
    loadTokenUsageSnapshot(
      async () => emptySnapshot,
      (state) => states.push(state),
    )
    expect(states).toEqual([{ status: 'loading' }])
    await settleRequests()
    expect(states.at(-1)).toEqual({ status: 'ready', snapshot: emptySnapshot })
    loadTokenUsageSnapshot(
      async () => {
        throw new Error('fixture')
      },
      (state) => states.push(state),
    )
    await settleRequests()
    expect(states.at(-1)).toEqual({ status: 'error' })
  })
  test('切换筛选后旧成功响应不能覆盖新快照', async () => {
    let release: (snapshot: TokenUsageSnapshot) => void = () => undefined
    const oldRequest = new Promise<TokenUsageSnapshot>((resolve) => {
      release = resolve
    })
    const states: TokenUsageLoadState[] = []
    const cancel = loadTokenUsageSnapshot(
      () => oldRequest,
      (state) => states.push(state),
    )
    await settleRequests()
    cancel()
    loadTokenUsageSnapshot(
      async () => emptySnapshot,
      (state) => states.push(state),
    )
    await settleRequests()
    const count = states.length
    release({ ...emptySnapshot, taskCount: 99 })
    await settleRequests()
    expect(states.length).toBe(count)
    expect(states.at(-1)).toEqual({ status: 'ready', snapshot: emptySnapshot })
  })
  test('组件卸载后旧失败响应不能制造错误提示', async () => {
    let rejectOld: (error: Error) => void = () => undefined
    const oldRequest = new Promise<TokenUsageSnapshot>((_resolve, reject) => {
      rejectOld = reject
    })
    const states: TokenUsageLoadState[] = []
    const cancel = loadTokenUsageSnapshot(
      () => oldRequest,
      (state) => states.push(state),
    )
    await settleRequests()
    cancel()
    rejectOld(new Error('迟到错误'))
    await settleRequests()
    expect(states).toEqual([{ status: 'loading' }])
  })
})
