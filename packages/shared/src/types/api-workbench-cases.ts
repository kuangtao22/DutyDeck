import type { ApiRun } from './api-workbench'

/** 用例汇总的一行：界面表格、复制导出与将来的历史都共用同一形状。 */
export interface ApiCaseReportRow {
  /** 用例身份；请求自身的默认断言没有用例身份。 */
  caseId?: string
  caseName: string
  /** 已执行时才有运行身份；未执行表示只列出用例。 */
  runId?: string
  state?: ApiRun['state']
  status: number | null
  assertionsPassed: number
  assertionsTotal: number
  durationMs: number | null
  /** 失败原因或错误摘要；导出时放在备注列。 */
  error?: string
}

/** 报告抬头信息；全部来自已脱敏的公开事实。 */
export interface ApiCaseReportMeta {
  requestName: string
  method: string
  url: string
  startedAt: number
}

/** 单元格转义：竖线会破坏表格，换行会让一行变两行。 */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim()
}

/** 单行结论：未执行、通过、失败三态，不用状态码倒推业务结论。 */
function verdict(row: ApiCaseReportRow): string {
  if (!row.runId) return '未执行'
  if (row.assertionsTotal === 0) return '未验证'
  return row.assertionsPassed === row.assertionsTotal ? '通过' : '失败'
}

/** 耗时展示；不可观测时用短横线而不是 0。 */
function duration(row: ApiCaseReportRow): string {
  return row.durationMs === null ? '—' : `${row.durationMs} ms`
}

/**
 * 生成可粘贴的 Markdown 用例报告。
 * @param rows 用例结果行，顺序即报告顺序。
 * @param meta 请求身份与开始时间。
 * @returns Markdown 文本；不包含任何响应正文或秘密。
 */
export function formatApiCaseReportMarkdown(rows: readonly ApiCaseReportRow[], meta: ApiCaseReportMeta): string {
  /** 只统计已执行且带断言的用例，未执行不参与通过率。 */
  const executed = rows.filter((row) => row.runId !== undefined && row.assertionsTotal > 0)
  const passed = executed.filter((row) => row.assertionsPassed === row.assertionsTotal).length
  const summary = executed.length === 0 ? '尚未执行' : `${passed}/${executed.length} 通过`
  const lines = [
    '# 接口测试用例报告',
    '',
    `- 请求：${meta.method} ${meta.url}`,
    `- 用例集：${meta.requestName}`,
    `- 开始时间：${new Date(meta.startedAt).toLocaleString()}`,
    `- 结果：${summary}`,
    '',
    '| 用例 | 结果 | 状态码 | 断言 | 耗时 | 备注 |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const row of rows) {
    lines.push([
      cell(row.caseName),
      verdict(row),
      row.status === null ? '—' : String(row.status),
      row.assertionsTotal === 0 ? '—' : `${row.assertionsPassed}/${row.assertionsTotal}`,
      duration(row),
      cell(row.error ?? ''),
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'))
  }
  return lines.join('\n')
}
