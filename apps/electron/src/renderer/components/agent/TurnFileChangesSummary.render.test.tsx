import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TurnFileChangesSummary } from './TurnFileChangesSummary'

/** 渲染汇总块并返回静态 HTML，用于断言可见文案。 */
function renderSummary(props: Parameters<typeof TurnFileChangesSummary>[0]): string {
  // 文件 chip 复用应用内的 Tooltip，静态渲染同样需要 Provider 包裹。
  return renderToStaticMarkup(
    <TooltipProvider>
      <TurnFileChangesSummary {...props} />
    </TooltipProvider>,
  )
}

describe('本轮文件改动汇总渲染', () => {
  test('Given 已完整跟踪且无改动 When 渲染 Then 只断言受管范围内没有改动', () => {
    const html = renderSummary({ turnMessages: [], runObserved: true })

    // 证据源只覆盖受管根/附加目录/项目根与写类工具入参，不能断言「本轮没有任何改动」。
    expect(html).toContain('本轮未检测到受管范围内的文件改动')
  })

  test('Given 本轮用过命令行且无改动 When 渲染 Then 追加范围说明', () => {
    const html = renderSummary({
      turnMessages: [{
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{
            type: 'tool_use',
            id: 'call-shell',
            name: 'Bash',
            input: { command: "python3 - <<'PY'\nopen('/tmp/a','w').write('x')\nPY" },
          }],
        },
      } as unknown as Parameters<typeof TurnFileChangesSummary>[0]['turnMessages'][number]],
      runObserved: true,
    })

    expect(html).toContain('本轮未检测到受管范围内的文件改动')
    expect(html).toContain('本轮有命令行工具调用，工作区外的写入不计入这里')
  })

  test('Given 本轮只用写类工具且无改动 When 渲染 Then 不追加范围说明', () => {
    const html = renderSummary({
      turnMessages: [{
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'tool_use', id: 'call-edit', name: 'Edit', input: { file_path: '/p/a.ts' } }],
        },
      } as unknown as Parameters<typeof TurnFileChangesSummary>[0]['turnMessages'][number]],
      runObserved: true,
    })

    expect(html).toContain('本轮未检测到受管范围内的文件改动')
    expect(html).not.toContain('本轮有命令行工具调用')
  })

  test('Given 共享目录有改动但无法归属 When 渲染 Then 不再断言未检测到改动', () => {
    const html = renderSummary({
      turnMessages: [{
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [{ type: 'tool_use', id: 'call-bash', name: 'Bash', input: { command: 'ls /repo' } }] },
      } as unknown as Parameters<typeof TurnFileChangesSummary>[0]['turnMessages'][number]],
      runObserved: true,
      runUnattributed: true,
    })

    expect(html).toContain('本轮检测到共享目录有改动，但无法归属到本会话')
    expect(html).not.toContain('本轮未检测到受管范围内的文件改动')
    // 已有更准确的解释，不再叠加命令行范围说明。
    expect(html).not.toContain('本轮有命令行工具调用')
    expect(html).toContain('另有改动未计入统计')
  })

  test('Given 未完整跟踪但有无法归属的改动 When 渲染 Then 仍展示证据而非静默', () => {
    const html = renderSummary({ turnMessages: [], runObserved: false, runUnattributed: true })

    expect(html).toContain('本轮检测到共享目录有改动，但无法归属到本会话')
  })

  test('Given 未完整跟踪且无改动 When 渲染 Then 保持静默不写结论', () => {
    const html = renderSummary({ turnMessages: [], runObserved: false })

    expect(html).toBe('')
  })

  test('Given 仅有监听器归属路径 When 渲染 Then 进入汇总并显示数量', () => {
    const html = renderSummary({
      turnMessages: [],
      runPaths: ['/project/generated/report.md'],
      runObserved: true,
    })

    expect(html).toContain('本轮文件改动 1')
    expect(html).toContain('report.md')
  })

  test('Given 业务代码与构建产物混在一起 When 渲染 Then 按分类分行展示', () => {
    const html = renderSummary({
      turnMessages: [],
      runPaths: [
        '/project/src/BSJSEngine.swift',
        '/project/dist/app.min.js',
        '/project/README.md',
      ],
      runObserved: true,
    })

    expect(html).toContain('本轮文件改动 3')
    expect(html).toContain('代码 1')
    expect(html).toContain('配置与文档 1')
    expect(html).toContain('资源与生成物 1')
  })

  test('Given 工具路径与监听器路径指向同一文件 When 渲染 Then 只计一次', () => {
    const toolMessage = {
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_use',
          id: 'call-1',
          name: 'Write',
          input: { file_path: '/project/report.md' },
        }],
      },
    } as unknown as Parameters<typeof TurnFileChangesSummary>[0]['turnMessages'][number]
    const toolResult = {
      type: 'user',
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'call-1', is_error: false, content: 'ok' }],
      },
    } as unknown as Parameters<typeof TurnFileChangesSummary>[0]['turnMessages'][number]

    const html = renderSummary({
      turnMessages: [toolMessage, toolResult],
      runPaths: ['/project/report.md'],
      runObserved: true,
    })

    expect(html).toContain('本轮文件改动 1')
  })
})


describe('结构化文件行统计', () => {
  test('Given 精确和未知混合 When 渲染 Then 标明部分总计且未知不伪造零值', () => {
    const html = renderSummary({ turnMessages: [], runFiles: [
      { path: '/p/src/a.ts', status: 'modified', statsState: 'complete', additions: 4, deletions: 2 },
      { path: '/p/README.md', status: 'unknown', statsState: 'unavailable' },
    ] })
    expect(html).toContain('+4')
    expect(html).toContain('−2')
    expect(html).toContain('已统计部分文件')
    expect(html).toContain('暂无行数统计')
    expect(html).toContain('代码')
    expect(html).toContain('配置与文档')
    expect(html).not.toContain('+0')
  })
  test('Given 文件已还原 When 渲染 Then 从路径和总计剔除', () => {
    const html = renderSummary({ turnMessages: [], runObserved: true, runPaths: ['/p/a.ts'], runFiles: [
      { path: '/p/a.ts', status: 'unchanged', statsState: 'complete', additions: 0, deletions: 0 },
    ] })
    expect(html).not.toContain('a.ts')
    expect(html).toContain('未检测到')
  })
  test('Given 删除和二进制 When 渲染 Then 保留文件状态并说明统计边界', () => {
    const html = renderSummary({ turnMessages: [], runFiles: [
      { path: '/p/deleted.ts', status: 'deleted', statsState: 'complete', additions: 0, deletions: 3 },
      { path: '/p/photo.png', status: 'added', statsState: 'binary' },
    ] })
    expect(html).toContain('已删除')
    expect(html).toContain('二进制')
    expect(html).toContain('当前工作区')
  })

  test('Given 工具相对路径与主进程绝对路径相同 When 渲染 Then 按 basePath 合并为一行', () => {
    const html = renderSummary({
      turnMessages: [],
      basePath: '/p',
      runPaths: ['src/a.ts'],
      runFiles: [{ path: '/p/src/a.ts', status: 'modified', statsState: 'complete', additions: 1, deletions: 0 }],
    })

    expect(html).toContain('本轮文件改动 1')
  })

  test('Given 同名文件来自不同目录 When 渲染 Then 展示父目录帮助区分', () => {
    const html = renderSummary({ turnMessages: [], basePath: '/p', runFiles: [
      { path: '/p/src/index.ts', status: 'modified', statsState: 'complete', additions: 1, deletions: 0 },
      { path: '/p/tests/index.ts', status: 'modified', statsState: 'complete', additions: 2, deletions: 0 },
    ] })

    expect(html).toContain('>src</span>')
    expect(html).toContain('>tests</span>')
  })

  test('Given 超过八个文件 When 首次渲染 Then 默认只展示前八项并提供原生展开按钮', () => {
    const runFiles = Array.from({ length: 9 }, (_, index) => ({
      path: `/p/src/file-${index}.ts`,
      status: 'modified' as const,
      statsState: 'complete' as const,
      additions: 1,
      deletions: 0,
    }))
    const html = renderSummary({ turnMessages: [], runFiles })

    expect(html).toContain('展开其余 1 项')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('file-8.ts')
  })

  test('Given 产物先出现且第九项是代码 When 默认折叠 Then 仍按分类优先展示代码', () => {
    const artifacts = Array.from({ length: 8 }, (_, index) => ({
      path: `/p/dist/artifact-${index}.png`,
      status: 'modified' as const,
      statsState: 'complete' as const,
      additions: 1,
      deletions: 0,
    }))
    const html = renderSummary({ turnMessages: [], runFiles: [
      ...artifacts,
      { path: '/p/src/critical.ts', status: 'modified', statsState: 'complete', additions: 1, deletions: 0 },
    ] })

    expect(html).toContain('critical.ts')
    expect(html).not.toContain('artifact-7.png')
    expect(html).toContain('aria-controls=')
    expect(html).toContain('aria-labelledby=')
  })

  test('Given 已列文件精确但另有无法归属改动 When 渲染 Then 总计仍标记为部分统计', () => {
    const html = renderSummary({ turnMessages: [], runUnattributed: true, runFiles: [
      { path: '/p/a.ts', status: 'modified', statsState: 'complete', additions: 3, deletions: 1 },
    ] })

    expect(html).toContain('已统计部分文件')
    expect(html).toContain('另有改动未计入统计')
  })
})
