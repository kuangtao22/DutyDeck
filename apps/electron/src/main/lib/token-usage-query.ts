/** Token 统计纯聚合：所有视图、详情和导出共用筛选与未知口径。 */
import { TOKEN_USAGE_SOURCE_LABELS } from '@proma/shared'
import type { TokenUsageCoverage, TokenUsageQuery, TokenUsageRecord, TokenUsageSnapshot, TokenUsageTotals, TokenUsageTask, TokenUsageTaskDetail, TokenUsageRank, TokenUsageOption } from '@proma/shared'

/** 单次查询最多一年，避免主进程接受无界日期枚举。 */
const MAX_RANGE_DAYS = 366
/** 对象读取仅接受普通 DTO，不接受数组或 null。 */
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Token 统计查询参数无效')
  return value as Record<string, unknown>
}
/** 验证真实自然日，拒绝 Date 自动进位的 2 月 31 日等输入。 */
export function isUsageDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
}
/** 在读盘前校验查询字段、时间跨度与分页预算。 */
export function validateTokenUsageQuery(input: unknown): TokenUsageQuery {
  const value = object(input)
  const allowed = ['from', 'to', 'timeZone', 'projectId', 'channelId', 'modelId', 'source', 'day', 'search', 'unknownOnly', 'sort', 'page', 'pageSize']
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Token 统计查询包含未知字段')
  if (!isUsageDate(value.from) || !isUsageDate(value.to) || value.from > value.to || (Date.parse(value.to) - Date.parse(value.from)) / 86400000 >= MAX_RANGE_DAYS) throw new Error('请选择有效的日期范围（最多 366 天）')
  if (typeof value.timeZone !== 'string' || value.timeZone.length > 100) throw new Error('统计时区无效')
  try { new Intl.DateTimeFormat('en-CA', { timeZone: value.timeZone }).format(0) } catch { throw new Error('统计时区无效') }
  for (const key of ['projectId', 'channelId', 'modelId', 'search']) if (value[key] !== undefined && (typeof value[key] !== 'string' || (value[key] as string).length > 500)) throw new Error('筛选条件过长或无效')
  if (value.source !== undefined && (typeof value.source !== 'string' || !Object.hasOwn(TOKEN_USAGE_SOURCE_LABELS, value.source))) throw new Error('任务来源无效')
  if (value.day !== undefined && (!isUsageDate(value.day) || value.day < value.from || value.day > value.to)) throw new Error('筛选日期不在范围内')
  if (value.sort !== undefined && value.sort !== 'recent' && value.sort !== 'tokens') throw new Error('排序方式无效')
  if (value.unknownOnly !== undefined && typeof value.unknownOnly !== 'boolean') throw new Error('未知用量筛选无效')
  for (const [key, max] of [['page', 1_000_000], ['pageSize', 100]] as const) if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || (value[key] as number) < 1 || (value[key] as number) > max)) throw new Error('分页参数无效')
  return { ...value, page: value.page ?? 1, pageSize: value.pageSize ?? 8, sort: value.sort ?? 'recent' } as unknown as TokenUsageQuery
}
/** 按查询时区格式化自然日；显式字段拼接避免依赖宿主区域格式。 */
export function usageDayFormatter(timeZone: string): (timestamp: number) => string {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  return (timestamp) => {
    const parts = formatter.formatToParts(timestamp)
    return `${parts.find(part => part.type === 'year')!.value}-${parts.find(part => part.type === 'month')!.value}-${parts.find(part => part.type === 'day')!.value}`
  }
}
/** 创建纯零汇总；零仅表示已知小计，不代表缺失报告的实际消耗。 */
export function emptyUsageTotals(): TokenUsageTotals {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0, knownCalls: 0, partialCalls: 0, unknownCalls: 0, reportedFields: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }
}
/** 累计一个独立调用；输入已经含缓存，不再二次相加。 */
function addCall(total: TokenUsageTotals, call: TokenUsageRecord): void {
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) if (call[field] !== null && total.reportedFields) total.reportedFields[field] += 1
  total.calls += 1
  total.inputTokens += call.inputTokens ?? 0
  total.outputTokens += call.outputTokens ?? 0
  total.totalTokens += (call.inputTokens ?? 0) + (call.outputTokens ?? 0)
  total.cacheReadTokens += call.cacheReadTokens ?? 0
  total.cacheWriteTokens += call.cacheWriteTokens ?? 0
  if (call.inputTokens !== null && call.outputTokens !== null) total.knownCalls += 1
  else if (call.inputTokens !== null || call.outputTokens !== null) total.partialCalls += 1
  else total.unknownCalls += 1
}
/** 对可见调用计算同一套汇总。 */
export function sumTokenUsage(records: readonly TokenUsageRecord[]): TokenUsageTotals {
  const totals = emptyUsageTotals()
  for (const record of records) addCall(totals, record)
  return totals
}
/** 历史归属无法确认不等于已知未关联项目，两种来源需独立筛选。 */
function dimensionIdentity(record: TokenUsageRecord, dimension: 'project' | 'channel'): string {
  const identity = dimension === 'project' ? record.projectId : record.channelId
  return identity ?? (record.origin === 'history' ? '__history_unknown__' : '__none__')
}
/** 全局筛选不包含任务搜索，以免输入任务名时改写总览。 */
export function filterTokenUsage(records: readonly TokenUsageRecord[], query: TokenUsageQuery): TokenUsageRecord[] {
  const day = usageDayFormatter(query.timeZone)
  return records.filter(record => {
    const date = day(record.startedAt)
    return date >= query.from && date <= query.to && (!query.day || query.day === date)
      && (!query.projectId || query.projectId === dimensionIdentity(record, 'project'))
      && (!query.channelId || query.channelId === dimensionIdentity(record, 'channel'))
      && (!query.modelId || query.modelId === record.modelId)
      && (!query.source || query.source === record.source)
  })
}
/** 根任务聚合不再额外合计父记录，子调用只出现一次。 */
export function groupTokenUsageTasks(records: readonly TokenUsageRecord[]): TokenUsageTask[] {
  const tasks = new Map<string, TokenUsageTask>()
  for (const record of records) {
    let task = tasks.get(record.taskId)
    if (!task) {
      task = { ...emptyUsageTotals(), id: record.taskId, title: record.taskTitle, projectNames: [], modelIds: [], sources: [], lastCalledAt: 0, sessionId: record.sessionId, sessionType: record.sessionType }
      tasks.set(record.taskId, task)
    }
    addCall(task, record)
    for (const [values, value] of [[task.projectNames, record.projectName], [task.modelIds, record.modelId]] as const) if (!values.includes(value)) values.push(value)
    if (!task.sources.includes(record.source)) task.sources.push(record.source)
    if (record.startedAt >= task.lastCalledAt) { task.lastCalledAt = record.startedAt; task.title = record.taskTitle }
    /** 能定位主会话时优先导航根会话，而不是任意子 Agent。 */
    if (record.taskId === `${record.sessionType}:${record.sessionId}`) { task.sessionId = record.sessionId; task.sessionType = record.sessionType }
  }
  return [...tasks.values()]
}
/** 任务搜索和未知过滤只影响任务列表及相应导出。 */
export function matchingUsageTasks(tasks: TokenUsageTask[], query: TokenUsageQuery): TokenUsageTask[] {
  const search = query.search?.trim().toLocaleLowerCase()
  return tasks.filter(task => (!query.unknownOnly || task.partialCalls + task.unknownCalls > 0)
    && (!search || [task.title, ...task.projectNames, ...task.modelIds].join(' ').toLocaleLowerCase().includes(search)))
    .sort((a, b) => (query.sort === 'tokens' ? b.totalTokens - a.totalTokens : b.lastCalledAt - a.lastCalledAt) || a.id.localeCompare(b.id))
}
/** 导出当前任务过滤中的全部匹配调用，分页不截断导出。 */
export function tokenUsageExportRecords(records: readonly TokenUsageRecord[], query: TokenUsageQuery): TokenUsageRecord[] {
  const filtered = filterTokenUsage(records, query)
  const tasks = new Set(matchingUsageTasks(groupTokenUsageTasks(filtered), query).map(task => task.id))
  return filtered.filter(record => tasks.has(record.taskId)).sort((a, b) => b.startedAt - a.startedAt)
}
/** 按稳定身份构造选项，名称使用最近调用快照。 */
function options(records: readonly TokenUsageRecord[], dimension: 'project' | 'model' | 'channel'): TokenUsageOption[] {
  const values = new Map<string, TokenUsageOption>()
  for (const record of [...records].sort((a, b) => a.startedAt - b.startedAt)) {
    const id = dimension === 'model' ? record.modelId : dimensionIdentity(record, dimension)
    values.set(id, { id, name: dimension === 'model' ? record.modelId : dimension === 'project' ? record.projectName : record.channelName })
  }
  return [...values.values()].sort((a, b) => a.name.localeCompare(b.name))
}
/** 单次遍历产生按维度的来源排行。 */
function ranking(records: readonly TokenUsageRecord[], dimension: 'project' | 'model' | 'source'): TokenUsageRank[] {
  const groups = new Map<string, TokenUsageRank>()
  for (const record of records) {
    const id = dimension === 'project' ? dimensionIdentity(record, 'project') : dimension === 'model' ? record.modelId : record.source
    const name = dimension === 'project' ? record.projectName : dimension === 'model' ? record.modelId : TOKEN_USAGE_SOURCE_LABELS[record.source]
    const entry = groups.get(id) ?? { id, name, ...emptyUsageTotals() }
    addCall(entry, record)
    groups.set(id, entry)
  }
  return [...groups.values()].sort((a, b) => b.totalTokens - a.totalTokens || b.calls - a.calls || a.id.localeCompare(b.id))
}
/** 聚合查询返回分页任务与全部来源小计；UI 不需要载入所有调用正文。 */
export function aggregateTokenUsage(records: readonly TokenUsageRecord[], query: TokenUsageQuery, coverage: TokenUsageCoverage): TokenUsageSnapshot {
  const filtered = filterTokenUsage(records, query)
  const dates = filterTokenUsage(records, { from: query.from, to: query.to, timeZone: query.timeZone })
  const tasks = matchingUsageTasks(groupTokenUsageTasks(filtered), query)
  const day = usageDayFormatter(query.timeZone)
  const trend = new Map<string, TokenUsageTotals>()
  for (let timestamp = Date.parse(query.from); timestamp <= Date.parse(query.to); timestamp += 86400000) trend.set(new Date(timestamp).toISOString().slice(0, 10), emptyUsageTotals())
  for (const record of filtered) addCall(trend.get(day(record.startedAt))!, record)
  const pageSize = query.pageSize ?? 8
  const page = Math.min(query.page ?? 1, Math.max(1, Math.ceil(tasks.length / pageSize)))
  return { totals: sumTokenUsage(filtered), trend: [...trend].map(([date, totals]) => ({ day: date, ...totals })), ranking: { project: ranking(filtered, 'project'), model: ranking(filtered, 'model'), source: ranking(filtered, 'source') }, tasks: tasks.slice((page - 1) * pageSize, page * pageSize), taskCount: tasks.length, page, pageSize, options: { projects: options(dates, 'project'), models: options(dates, 'model'), channels: options(dates, 'channel') }, coverage }
}
/** 详情中的范围外调用明确标识，不混入 matching 小计。 */
export function tokenUsageTaskDetail(records: readonly TokenUsageRecord[], taskId: string, query: TokenUsageQuery): TokenUsageTaskDetail | null {
  const calls = records.filter(record => record.taskId === taskId).sort((a, b) => b.startedAt - a.startedAt)
  const task = groupTokenUsageTasks(calls)[0]
  if (!task) return null
  const matching = filterTokenUsage(calls, query)
  const identities = new Set(matching.map(record => record.id))
  return { task, matching: sumTokenUsage(matching), calls: calls.map(record => ({ ...record, matchesFilter: identities.has(record.id) })) }
}
/** CSV 引号和公式前缀转义，未知数字保留空单元格。 */
function csvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value)
  const safe = /^[\s]*[=+@-]/.test(text) && typeof value === 'string' ? `'${text}` : text
  return `"${safe.replace(/"/g, '""')}"`
}
/** 生成逐调用 CSV，UTF-8 BOM 兼容常用表格应用，UTC 时间不会歧义。 */
export function tokenUsageCsv(records: readonly TokenUsageRecord[]): string {
  const headers = ['调用 ID', '任务 ID', '任务', '项目', '渠道', '模型', '来源', '开始时间 UTC', '状态', '输入（含缓存）', '输出', '缓存读取', '缓存写入', '数据来源']
  const rows = records.map(record => [record.id, record.taskId, record.taskTitle, record.projectName, record.channelName, record.modelId, TOKEN_USAGE_SOURCE_LABELS[record.source], new Date(record.startedAt).toISOString(), record.status, record.inputTokens, record.outputTokens, record.cacheReadTokens, record.cacheWriteTokens, record.origin].map(csvCell).join(','))
  return '\uFEFF' + [headers.map(csvCell).join(','), ...rows].join('\r\n') + '\r\n'
}
