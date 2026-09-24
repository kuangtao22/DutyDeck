import { describe, expect, test } from 'bun:test'
import { formatApiCaseReportMarkdown } from './api-workbench-cases'
import type { ApiCaseReportRow } from './api-workbench-cases'

/** 报告抬头固定值，便于逐字断言。 */
const meta = { requestName: '登录', method: 'POST', url: 'https://example.test/login', startedAt: 1_700_000_000_000 }

describe('接口用例报告', () => {
  test('Given 全部用例通过 When 生成报告 Then 汇总通过率且每行标注通过', () => {
    const rows: ApiCaseReportRow[] = [
      { caseId: 'case_ok', caseName: '正常登录', runId: 'run_1', state: 'completed', status: 200, assertionsPassed: 3, assertionsTotal: 3, durationMs: 240 },
      { caseId: 'case_param', caseName: '缺参数', runId: 'run_2', state: 'completed', status: 400, assertionsPassed: 2, assertionsTotal: 2, durationMs: 180 },
    ]

    const report = formatApiCaseReportMarkdown(rows, meta)

    expect(report).toContain('| 用例 | 结果 | 状态码 | 断言 | 耗时 | 备注 |')
    expect(report).toContain('| 正常登录 | 通过 | 200 | 3/3 | 240 ms |  |')
    expect(report).toContain('| 缺参数 | 通过 | 400 | 2/2 | 180 ms |  |')
    expect(report).toContain('- 结果：2/2 通过')
    expect(report).toContain('- 请求：POST https://example.test/login')
  })

  test('Given 有用例失败 When 生成报告 Then 汇总失败数量并保留失败原因', () => {
    const rows: ApiCaseReportRow[] = [
      { caseId: 'case_ok', caseName: '正常登录', runId: 'run_1', state: 'completed', status: 200, assertionsPassed: 3, assertionsTotal: 3, durationMs: 240 },
      { caseId: 'case_deny', caseName: '越权', runId: 'run_3', state: 'completed', status: 200, assertionsPassed: 1, assertionsTotal: 2, durationMs: 210, error: '期望 401 实际 200' },
    ]

    const report = formatApiCaseReportMarkdown(rows, meta)

    expect(report).toContain('- 结果：1/2 通过')
    expect(report).toContain('| 越权 | 失败 | 200 | 1/2 | 210 ms | 期望 401 实际 200 |')
  })

  test('Given 未执行或无断言的用例 When 生成报告 Then 不把它们算成通过', () => {
    const rows: ApiCaseReportRow[] = [
      { caseId: 'case_new', caseName: '未跑过的用例', status: null, assertionsPassed: 0, assertionsTotal: 2, durationMs: null },
      { caseId: 'case_empty', caseName: '只跑请求', runId: 'run_9', state: 'completed', status: 204, assertionsPassed: 0, assertionsTotal: 0, durationMs: 12 },
    ]

    const report = formatApiCaseReportMarkdown(rows, meta)

    expect(report).toContain('- 结果：尚未执行')
    expect(report).toContain('| 未跑过的用例 | 未执行 | — | 0/2 | — |  |')
    expect(report).toContain('| 只跑请求 | 未验证 | 204 | — | 12 ms |  |')
  })

  test('Given 用例名或原因含竖线与换行 When 生成报告 Then 表格结构不被破坏', () => {
    const rows: ApiCaseReportRow[] = [
      { caseId: 'case_pipe', caseName: '带|竖线\n和换行', runId: 'run_1', state: 'failed', status: null, assertionsPassed: 0, assertionsTotal: 1, durationMs: null, error: '第一行\n第二行|尾' },
    ]

    const report = formatApiCaseReportMarkdown(rows, meta)
    const dataLine = report.split('\n').find((line) => line.startsWith('| 带'))

    expect(dataLine).toBe('| 带\\|竖线 和换行 | 失败 | — | 0/1 | — | 第一行 第二行\\|尾 |')
    expect(report.split('\n').filter((line) => line.startsWith('|')).length).toBe(3)
  })
})
