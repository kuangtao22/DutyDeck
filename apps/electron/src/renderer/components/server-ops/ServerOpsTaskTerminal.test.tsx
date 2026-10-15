import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import type { ServerOpsTaskSummary } from '@proma/shared'
import { ServerOpsTaskTerminal, ServerOpsTaskTerminalSwitcher } from './ServerOpsTaskTerminal'

/** 隔离静态渲染夹具，不连接真实 Electron 或 SSH。 */
const task: ServerOpsTaskSummary = { taskId: 't', sessionId: 's', hostId: 'h', connectionId: 'c', command: 'sudo deploy', state: 'running', createdAt: 1 }
describe('Given 实际远程任务终端组件', () => {
  it('When 运行任务渲染 Then 显示终端密码提示和显式中断入口', () => {
    const html = renderToStaticMarkup(<ServerOpsTaskTerminal task={task} />)
    expect(html).toContain('运行中'); expect(html).toContain('中断任务'); expect(html).toContain('请直接在此终端输入'); expect(html).toContain('Agent 远程任务终端')
  })
  it('When 退出或失联 Then 明确显示退出码或结果未知而非统一成功', () => {
    const exited = renderToStaticMarkup(<ServerOpsTaskTerminal task={{ ...task, state: 'exited', exitCode: 17 }} />)
    const unknown = renderToStaticMarkup(<ServerOpsTaskTerminal task={{ ...task, state: 'unknown', message: 'SSH 连接已断开' }} />)
    expect(exited).toContain('退出码 17'); expect(unknown).toContain('结果未知'); expect(unknown).toContain('SSH 连接已断开'); expect(unknown).toContain('disabled=')
  })
  it('When 没有 Agent 任务 Then 仍保留手动 SSH 终端和选择入口', () => {
    const html = renderToStaticMarkup(<Provider store={createStore()}><ServerOpsTaskTerminalSwitcher sessionId="s" hostId="h" manualTerminal={<div>手动会话内容</div>} /></Provider>)
    expect(html).toContain('选择服务器终端'); expect(html).toContain('手动会话内容')
  })
})
