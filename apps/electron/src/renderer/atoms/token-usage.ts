import { atom } from 'jotai'
import type { TokenUsageQuery, TokenUsageTotals, TokenUsageSnapshot } from '@proma/shared'

/** 预设时间范围；自定义日期由页面显式提交。 */
export type TokenUsageRange = 'today' | 'week' | 'month' | 'custom'
/** 按本地日期生成 YYYY-MM-DD，不使用 UTC 截断避免跨日。 */
function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
/** 输入时间预设和当前日期，返回本地自然日查询。 */
export function createTokenUsageQuery(range: TokenUsageRange, now = new Date()): TokenUsageQuery {
  const start = new Date(now)
  if (range === 'week') start.setDate(start.getDate() - 6)
  if (range === 'month') start.setDate(1)
  return {
    from: localDay(start),
    to: localDay(now),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    page: 1,
    pageSize: 8,
    sort: 'recent',
  }
}
/** 下钻时移除任务局部限制，防止旧搜索隐藏新来源。 */
export function drillIntoTokenUsage(
  query: TokenUsageQuery,
  patch: Partial<TokenUsageQuery>,
): TokenUsageQuery {
  return { ...query, ...patch, search: undefined, unknownOnly: false, page: 1 }
}
/** 复用千进位格式化器，提供 K/M/B/T 缩写、两位小数及舍入进位。 */
const compactTokenFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 2,
})
/** 精确数字用于悬停提示和调用次数，不丢失整数位。 */
const exactTokenFormatter = new Intl.NumberFormat('zh-CN')
/** 输入原始用量及显示模式，返回缩写或精确数字；未知与真实零保持区别。 */
export function formatTokenAmount(value: number | null, notation: 'compact' | 'exact' = 'compact'): string {
  if (value === null) return '未知'
  return (notation === 'exact' ? exactTokenFormatter : compactTokenFormatter).format(value)
}
/** 输入汇总、字段及显示模式，返回对应用量；没有报告时显示未知，真实零与空范围仍为零。 */
export function formatTokenUsageTotal(
  totals: TokenUsageTotals,
  field: keyof NonNullable<TokenUsageTotals['reportedFields']> | 'totalTokens',
  notation: 'compact' | 'exact' = 'compact',
): string {
  /** 报告数量决定当前字段是否有依据，不使用小计为零推断已知。 */
  const reported = field === 'totalTokens' ? totals.knownCalls + totals.partialCalls : totals.reportedFields?.[field] ?? totals.knownCalls + totals.partialCalls
  return formatTokenAmount(totals.calls > 0 && reported === 0 ? null : totals[field], notation)
}
/** 覆盖说明只把输入、输出完整报告的调用列入分子。 */
export function tokenCoverageLabel(
  totals: Pick<TokenUsageTotals, 'calls' | 'knownCalls' | 'partialCalls' | 'unknownCalls'>,
): string {
  return `${totals.knownCalls} / ${totals.calls} 次完整报告 · ${totals.partialCalls} 次部分报告 · ${totals.unknownCalls} 次未知`
}
/** 校验真实自然日、先后顺序及一年上限，避免意外无界查询。 */
export function validateTokenDates(from: string, to: string): boolean {
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(from) &&
    /^\d{4}-\d{2}-\d{2}$/.test(to) &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    new Date(start).toISOString().slice(0, 10) === from &&
    new Date(end).toISOString().slice(0, 10) === to &&
    end >= start &&
    end - start < 366 * 86400000
  )
}
/** 设置页切换后保留筛选与当前视图，不写入磁盘。 */
export const tokenUsageQueryAtom = atom<TokenUsageQuery>(createTokenUsageQuery('week'))
export const tokenUsageRangeAtom = atom<TokenUsageRange>('week')
export const tokenUsageViewAtom = atom<'overview' | 'tasks'>('overview')
export const tokenUsageDimensionAtom = atom<'project' | 'model' | 'source'>('project')

/** 请求状态只携带当前响应；取消后成功和失败都不能回写页面。 */
export type TokenUsageLoadState =
  | { status: 'loading' }
  | { status: 'ready'; snapshot: TokenUsageSnapshot }
  | { status: 'error' }

/** 输入异步查询与状态接收器，返回失效函数；用于切换筛选和卸载时隔离旧响应。 */
export function loadTokenUsageSnapshot(
  request: () => Promise<TokenUsageSnapshot>,
  receive: (state: TokenUsageLoadState) => void,
): () => void {
  /** 当前 effect 的有效性，不依赖响应顺序。 */
  let active = true
  receive({ status: 'loading' })
  void Promise.resolve()
    .then(request)
    .then(
      (snapshot) => {
        if (active) receive({ status: 'ready', snapshot })
      },
      () => {
        if (active) receive({ status: 'error' })
      },
    )
  return () => {
    active = false
  }
}
