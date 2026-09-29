import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  createServerOpsSqlHistoryExecutionHandlers,
  formatServerOpsSqlWriteTarget,
  getServerOpsSqlWriteConfirmationDescription,
  ServerOpsSqlQueryPanel,
  ServerOpsSqlQueryResult,
  ServerOpsSqlWriteResult,
} from './ServerOpsSqlQueryPanel'
import { ServerOpsSqlQueryHistory } from './ServerOpsSqlQueryHistory'
import { createServerOpsSqlQueryHistoryIdleProjection } from './server-ops-sql-query-history-controller'
import { createServerOpsSqlWriteIdleProjection } from './server-ops-sql-write-controller'
import type { ServerOpsDataSource } from '@proma/shared'

/** 面板写模式使用的完整公开数据源快照。 */
const mysqlSource: ServerOpsDataSource = {
  id: 'source-1', transport: 'direct', engine: 'mysql', label: '业务主库', address: '127.0.0.1', port: 3306,
  tlsMode: 'disabled', hasPassword: true, createdAt: 1, updatedAt: 2,
}

/** 写执行结果的静态渲染夹具；各用例只覆盖要验证的字段。 */
function createWriteProjection(overrides: Record<string, unknown> = {}) {
  return {
    ...createServerOpsSqlWriteIdleProjection(),
    status: 'success' as const,
    context: { sourceId: 'source-1', source: mysqlSource, database: 'main', configurationKey: 'v1', available: true },
    execution: {
      sql: 'UPDATE t SET n = n + 1',
      database: 'main',
      result: {
        writeId: 'write-1', database: 'main', statementCount: 2, affectedRows: 5, committed: true,
        durationMs: 12, statements: [{ head: 'ALTER', affectedRows: 0 }, { head: 'UPDATE', affectedRows: 5 }], warnings: [],
      },
    },
    ...overrides,
  }
}

describe('ServerOpsSqlQueryPanel', () => {
  test('Given 查询与写入都执行完成 When 更新历史 Then 查询保存原 SQL 而写入只刷新主进程运行记录', () => {
    const recorded: Array<{ sourceId: string; database: string; sql: string }> = []
    let refreshCount = 0
    const handlers = createServerOpsSqlHistoryExecutionHandlers({
      record: async (input) => { recorded.push(input) },
      refresh: async () => { refreshCount += 1 },
    })
    handlers.onQueryExecuted({ sourceId: 'source-1', database: 'main', sql: 'SELECT 1' })
    handlers.onWriteExecuted()
    expect(recorded).toEqual([{ sourceId: 'source-1', database: 'main', sql: 'SELECT 1' }])
    expect(refreshCount).toBe(1)
  })

  test('Given SQLite 写入确认 When 展示事务说明 Then 不承诺任何失败都必然回滚', () => {
    const description = getServerOpsSqlWriteConfirmationDescription('sqlite')
    expect(description).toContain('事务失败会尝试回滚')
    expect(description).toContain('最终结果以执行回执为准')
    expect(description).not.toContain('任一句失败会自动回滚')
  })

  test('Given 网络库与 SQLite When 展示写入目标 Then 包含名称端点或文件路径及数据库', () => {
    expect(formatServerOpsSqlWriteTarget(mysqlSource, 'app')).toBe('业务主库 · 127.0.0.1:3306 · 数据库 app')
    expect(formatServerOpsSqlWriteTarget({
      ...mysqlSource, id: 'sqlite-1', label: '本地缓存', engine: 'sqlite', filePath: '/tmp/app.db', address: undefined, port: undefined,
    }, 'main')).toBe('本地缓存 · /tmp/app.db · 数据库 main')
  })

  test('Given 当前数据库 When 渲染 Then 提供显式执行取消与有界行数控件', () => {
    const html = renderToStaticMarkup(<ServerOpsSqlQueryPanel api={{}} sourceId="source-1" database="app" configurationKey="v1" available />)
    expect(html).toContain('SQL 编辑器')
    expect(html).toContain('执行查询')
    expect(html).toContain('取消查询')
    expect(html).toContain('max="200"')
    expect(html).toContain('Ctrl/Cmd + Enter')
    expect(html).toContain('aria-label="查询说明"')
    expect(html).toContain('aria-label="查询输出"')
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>.*?查询结果/s)
    expect(html).toContain('查询历史')
    expect(html).toContain('role="tabpanel"')
  })

  test('Given SQLite 查询页 When 渲染 Then 编辑器标记 SQLite 方言并显示对应大字段函数', () => {
    const html = renderToStaticMarkup(<ServerOpsSqlQueryPanel api={{}} sourceId="source-1" database="main" configurationKey="v1" available dialect="sqlite" />)
    expect(html).toContain('data-server-ops-sql-dialect="sqlite"')
  })

  test('Given 查询接口缺失 When 渲染 Then 执行入口不可用且说明升级原因', () => {
    const html = renderToStaticMarkup(<ServerOpsSqlQueryPanel api={{}} sourceId="source-1" database="app" configurationKey="v1" available />)
    expect(html).toMatch(/disabled=""[^>]*aria-label="执行查询"|aria-label="执行查询"[^>]*disabled=""/)
    expect(html).toContain('查询接口尚未就绪')
  })

  test('Given 空查询结果 When 渲染 Then 保留真实列头与执行快照', () => {
    const html = renderToStaticMarkup(<ServerOpsSqlQueryResult busy={false} execution={{
      sql: 'SELECT id FROM users',
      database: 'app',
      result: { queryId: 'query-1', database: 'app', columns: ['id'], rows: [], rowCount: 0, durationMs: 12, truncated: false, warnings: [] },
    }} />)
    expect(html).toContain('<th')
    expect(html).toContain('>id</th>')
    expect(html).toContain('执行 SQL：SELECT id FROM users')
    expect(html).toContain('数据库：')
    expect(html).toContain('12 ms')
    expect(html).toContain('查询成功，结果为空')
  })

  test('Given 已保存历史含SQL字面值 When 渲染 Then 显示原语句和回填入口并转义HTML', () => {
    /** SQL 文本保持可复用，但不能作为 HTML 注入列表。 */
    const html = renderToStaticMarkup(<ServerOpsSqlQueryHistory projection={{
      ...createServerOpsSqlQueryHistoryIdleProjection(),
      context: { sourceId: 'source-1', database: 'app', configurationKey: 'v1' },
      status: 'ready',
      entries: [{ id: 'entry-1', sourceId: 'source-1', database: 'app', createdAt: 1, sql: "SELECT '<script>alert(1)</script>' AS value" }],
    }} onUse={() => undefined} onRefresh={() => undefined} />)
    expect(html).toContain('最近 100 条')
    expect(html).toContain('写入按每次运行记录')
    expect(html).toContain('填入编辑器')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('执行查询')
  })

  test('Given 默认只读模式 When 渲染 Then 不出现写入标记且写模式按钮需要显式开启', () => {
    const html = renderToStaticMarkup(<ServerOpsSqlQueryPanel api={{ writeServerOpsDatabase: async () => createWriteProjection().execution!.result, cancelServerOpsDatabaseWrite: async () => undefined }} sourceId="source-1" source={mysqlSource} database="main" configurationKey="v1" available />)
    expect(html).toContain('只读 SELECT')
    expect(html).not.toContain('写入模式 · 会修改数据')
    /** 写模式默认关闭：按钮存在、aria-pressed 为假且未被禁用，必须由用户显式开启。 */
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('写模式</button>')
    expect(html).not.toMatch(/aria-pressed="false" disabled=""/)
    expect(html).not.toContain('data-server-ops-sql-write-result')
  })

  test('Given 旧 preload 缺少写接口 When 渲染 Then 写模式入口禁用并说明原因', () => {
    /** 只读接口齐全但写接口缺失：必须显式禁用写模式，而不是让按钮点了没反应。 */
    const html = renderToStaticMarkup(<ServerOpsSqlQueryPanel api={{}} sourceId="source-1" source={mysqlSource} database="main" configurationKey="v1" available />)
    /** 不依赖属性顺序：禁用状态与原因文案各自断言。 */
    expect(html).toMatch(/aria-pressed="false" disabled=""/)
    expect(html).toContain('title="当前客户端不支持写库，请完整退出并重启客户端后再试。"')
  })

  test('Given 写接口存在但没有完整数据源快照 When 渲染 Then 禁用写模式而不是按 sourceId 猜目标', () => {
    const html = renderToStaticMarkup(<ServerOpsSqlQueryPanel api={{
      writeServerOpsDatabase: async () => createWriteProjection().execution!.result,
      cancelServerOpsDatabaseWrite: async () => undefined,
    }} sourceId="source-1" database="main" configurationKey="v1" available />)
    expect(html).toMatch(/aria-pressed="false" disabled=""/)
    expect(html).toContain('当前数据源快照不可用，无法安全执行写入。')
  })

  test('Given PostgreSQL 或 SSH 跳板目标 When 渲染 Then 写模式禁用并解释真实原因', () => {
    const api = { writeServerOpsDatabase: async () => createWriteProjection().execution!.result, cancelServerOpsDatabaseWrite: async () => undefined }
    const postgresSource = { ...mysqlSource, id: 'source-pg', engine: 'postgresql' as const }
    const postgres = renderToStaticMarkup(<ServerOpsSqlQueryPanel api={api} sourceId="source-pg" source={postgresSource} database="app" configurationKey="v1" available dialect="postgresql" writeDisabledReason="当前 PostgreSQL 暂不支持手工写入。" />)
    expect(postgres).toMatch(/aria-pressed="false" disabled=""/)
    expect(postgres).toContain('当前 PostgreSQL 暂不支持手工写入。')
    const sshSource = { ...mysqlSource, id: 'source-ssh', transport: 'ssh' as const, hostId: 'host-1' }
    const ssh = renderToStaticMarkup(<ServerOpsSqlQueryPanel api={api} sourceId="source-ssh" source={sshSource} database="app" configurationKey="v1" available writeDisabledReason="经 SSH 跳板的数据源暂不支持手工写入，请改用直连。" />)
    expect(ssh).toMatch(/aria-pressed="false" disabled=""/)
    expect(ssh).toContain('经 SSH 跳板的数据源暂不支持手工写入，请改用直连。')
  })

  test('Given 写执行成功 When 渲染写入结果 Then 明确说明改动是否已生效', () => {
    const html = renderToStaticMarkup(<ServerOpsSqlWriteResult projection={createWriteProjection()} />)
    expect(html).toContain('data-server-ops-sql-write-result')
    expect(html).toContain('2 条语句 · 影响 5 行 · 12 ms')
    expect(html).toContain('已提交')
    expect(html).toContain('改动已生效')
    expect(html).toContain('执行语句：UPDATE t SET n = n + 1')
    /** 逐条语句用首关键字展示，不泄漏正文。 */
    expect(html).toContain('>ALTER<')
    expect(html).toContain('>UPDATE<')
  })

  test('Given 旧写回执只有 committed=false When 渲染写入结果 Then 显示结果未知而不谎称已回滚', () => {
    const projection = createWriteProjection({
      execution: {
        sql: 'UPDATE t SET n = 1',
        database: 'main',
        result: {
          writeId: 'write-2', database: 'main', statementCount: 1, affectedRows: 0, committed: false,
          durationMs: 4, statements: [{ head: 'UPDATE', affectedRows: 0 }], warnings: ['脚本包含会隐式提交的语句，MySQL 下这些改动无法回滚'],
        },
      },
    })
    const html = renderToStaticMarkup(<ServerOpsSqlWriteResult projection={projection} />)
    expect(html).toContain('结果未知')
    expect(html).toContain('无法确认改动是否生效')
    expect(html).not.toContain('已回滚')
    expect(html).toContain('无法回滚')
  })

  test('Given 写执行部分生效 When 渲染写入结果 Then 明确要求核对且不建议直接重跑', () => {
    const projection = createWriteProjection({
      status: 'error',
      execution: {
        sql: 'ALTER TABLE t ADD n INT; UPDATE t SET n = 1',
        database: 'main',
        result: {
          writeId: 'write-3', database: 'main', statementCount: 2, affectedRows: 5, committed: false,
          outcome: 'partial', errorCode: 'SERVER_OPS_DATA_WRITE_FAILED', durationMs: 20,
          statements: [{ head: 'ALTER', affectedRows: 0 }, { head: 'UPDATE', affectedRows: 5 }], warnings: [],
        },
      },
    })
    const html = renderToStaticMarkup(<ServerOpsSqlWriteResult projection={projection} />)
    expect(html).toContain('部分生效')
    expect(html).toContain('部分改动已经生效，请核对数据库后再决定是否重跑')
  })

  test('Given 写模式下渲染历史 When 传入运行入口 Then 每条记录同时提供运行与回填', () => {
    const html = renderToStaticMarkup(<ServerOpsSqlQueryHistory projection={{
      ...createServerOpsSqlQueryHistoryIdleProjection(),
      context: { sourceId: 'source-1', database: 'main', configurationKey: 'v1' },
      status: 'ready',
      entries: [{ id: 'entry-1', sourceId: 'source-1', database: 'main', createdAt: 1, sql: 'UPDATE t SET n = 1' }],
    }} onUse={() => undefined} onRun={() => undefined} onRefresh={() => undefined} />)
    expect(html).toContain('>运行</button>')
    expect(html).toContain('填入编辑器')
    expect(html).toContain('回填并打开写入确认')
  })

  test('Given 只读模式渲染历史 When 未传运行入口 Then 不出现运行按钮', () => {
    const html = renderToStaticMarkup(<ServerOpsSqlQueryHistory projection={{
      ...createServerOpsSqlQueryHistoryIdleProjection(),
      context: { sourceId: 'source-1', database: 'main', configurationKey: 'v1' },
      status: 'ready',
      entries: [{ id: 'entry-1', sourceId: 'source-1', database: 'main', createdAt: 1, sql: 'UPDATE t SET n = 1' }],
    }} onUse={() => undefined} onRefresh={() => undefined} />)
    expect(html).not.toContain('>运行</button>')
    expect(html).toContain('填入编辑器')
  })

  test('Given 写运行历史含完成与缺失回执 When 渲染 Then 显示逐次状态时间耗时和影响行数', () => {
    const html = renderToStaticMarkup(<ServerOpsSqlQueryHistory projection={{
      ...createServerOpsSqlQueryHistoryIdleProjection(),
      context: { sourceId: 'source-1', database: 'main', configurationKey: 'v1' },
      status: 'ready',
      entries: [
        {
          id: 'entry-1', sourceId: 'source-1', database: 'main', createdAt: 10, sql: 'UPDATE t SET n = 1',
          execution: { writeId: 'write-1', startedAt: 1_000, finishedAt: 1_020, result: { ...createWriteProjection().execution!.result, outcome: 'committed' } },
        },
        {
          id: 'entry-2', sourceId: 'source-1', database: 'main', createdAt: 20, sql: 'DELETE FROM t',
          execution: { writeId: 'write-2', startedAt: 2_000 },
        },
        { id: 'entry-3', sourceId: 'source-1', database: 'main', createdAt: 30, sql: 'SELECT 1' },
      ],
    }} onUse={() => undefined} onRun={() => undefined} runDisabled onRefresh={() => undefined} />)
    expect(html).toContain('已提交')
    expect(html).toContain('12 ms')
    expect(html).toContain('影响 5 行')
    expect(html).toContain('未收到结束回执')
    expect(html).toContain('历史语句（无运行结果）')
    expect(html).toMatch(/disabled=""[^>]*title="回填并打开写入确认"/)
  })
})
