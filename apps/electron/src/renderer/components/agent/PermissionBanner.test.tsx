import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PermissionRequest } from '@proma/shared'
import { allPendingPermissionRequestsAtom } from '@/atoms/agent-atoms'
import { PermissionBanner } from './PermissionBanner'

/** 造一条已入队的接口发送审批；Host 侧会把附件行一起塞进 toolInput。 */
function apiSendApproval(toolInput: Record<string, unknown>): PermissionRequest {
  return {
    requestId: 'permission-api-send',
    sessionId: 'session-1',
    toolName: 'api_send_request',
    toolInput,
    description: '发送接口请求',
    dangerLevel: 'dangerous',
    allowAlways: false,
  }
}

/** 造一条已入队的流程运行审批：Host 侧把步骤清单放在 scenario 里。 */
function apiScenarioApproval(toolInput: Record<string, unknown>): PermissionRequest {
  return {
    requestId: 'permission-api-scenario',
    sessionId: 'session-1',
    toolName: 'api_run_scenario',
    toolInput,
    description: '运行接口流程',
    dangerLevel: 'dangerous',
    allowAlways: false,
  }
}

describe('权限横幅', () => {
  test('Given 采纳草案缺少对比测试 When 渲染原有审批卡 Then 仍展示具体改动和预期收益且不弹全局对话框', () => {
    /** 同一条宿主快照将实际差异与 Agent 判断分开，避免把预期当实测结论。 */
    const store = createStore()
    store.set(allPendingPermissionRequestsAtom, new Map([['session-1', [{
      ...apiSendApproval({ approval: {
        kind: 'operation', operation: 'adoptDraft', title: '采纳「角色提取」草案',
        lines: ['v20 → v21'], destructive: false, appliesImmediately: true,
        adoption: {
          changes: ['扫描角色：从「总结人物」改为「逐字引用原文后列出人物」'],
          rationale: '补充原文引用要求',
          proposal: { problem: '当前提示词未约束引用必须逐字一致', expectedBenefit: '减少改写原文造成的引用失配', risk: '严格引用可能增加漏提，需要边界样本验证' },
          benefits: [], currentProblems: [], remainingRisks: [], validation: '尚未对比测试，预期收益待验证',
        },
      } }), toolName: 'factory_apply_operation', allowAlways: true,
    }]]]))
    const html = renderToStaticMarkup(<Provider store={store}><PermissionBanner sessionId="session-1" onStop={() => undefined} /></Provider>)
    expect(html).toContain('factory-adoption-review')
    expect(html).toContain('逐字引用原文后列出人物')
    expect(html).toContain('当前提示词未约束引用必须逐字一致')
    expect(html).toContain('预期收益（待验证）')
    expect(html).toContain('减少改写原文造成的引用失配')
    expect(html).toContain('确认采纳')
    expect(html).toContain('暂不采纳')
    expect(html).not.toContain('alertdialog')
    expect(html).not.toContain('本次会话总是允许')
    expect(html).not.toContain('Enter 允许')
    expect(html).not.toContain('暂无可由当前草案对比证据确认的收益')
  })

  test('Given 没有待处理请求 When 渲染 Then 不占用聊天空间', () => {
    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <PermissionBanner sessionId="session-1" onStop={() => undefined} />
      </Provider>,
    )

    expect(html).toBe('')
  })

  test('Given 接口变更审批 When 检查横幅源码 Then 走结构化视图并提示人工复核', async () => {
    const source = await Bun.file(new URL('./PermissionBanner.tsx', import.meta.url)).text()

    expect(source).toContain('describeApiWorkbenchApproval')
    expect(source).toContain('formatApiApprovalCaseDiff')
    expect(source).toContain('用例改动')
    expect(source).toContain('人工创建的用例不可被 Agent 修改或删除')
    /** 有结构化视图时不再重复渲染原始 JSON，避免用户要看两遍。 */
    expect(source).toContain('!apiApproval && !request.sdkTitle')
  })

  test('Given 接口发送审批带本机附件 When 渲染 Then 逐行显示字段、真实路径与大小', () => {
    const store = createStore()
    store.set(allPendingPermissionRequestsAtom, new Map([['session-1', [apiSendApproval({
      preparedId: 'prepared_1',
      preview: { requestName: '上传头像', environmentId: 'env_test', request: { method: 'POST', url: 'https://example.test/upload' } },
      send: { assertionCount: 0 },
      files: [{ field: 'avatar', path: '/Users/ada/secret/头像.png', sizeBytes: 20480 }],
    })]]]))

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <PermissionBanner sessionId="session-1" onStop={() => undefined} />
      </Provider>,
    )

    expect(html).toContain('POST https://example.test/upload')
    expect(html).toContain('本次将读取并上传的文件（批准后才读取字节）')
    expect(html).toContain('字段 avatar：/Users/ada/secret/头像.png（20480 字节）')
    /** realpath 展示的语义要写在卡片上，用户才知道链接名不会骗人。 */
    expect(html).toContain('realpath')
  })

  test('Given 不带附件的发送审批 When 渲染 Then 不出现附件区块', () => {
    const store = createStore()
    store.set(allPendingPermissionRequestsAtom, new Map([['session-1', [apiSendApproval({
      preparedId: 'prepared_2',
      preview: { request: { method: 'GET', url: 'https://example.test/users' } },
      send: { assertionCount: 1 },
    })]]]))

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <PermissionBanner sessionId="session-1" onStop={() => undefined} />
      </Provider>,
    )

    expect(html).toContain('GET https://example.test/users')
    expect(html).not.toContain('本次将读取并上传的文件')
  })

  test('Given 流程运行审批 When 渲染 Then 逐行显示步骤、策略与生产环境提醒', () => {
    const store = createStore()
    store.set(allPendingPermissionRequestsAtom, new Map([['session-1', [apiScenarioApproval({
      preparedId: 'prepared_scenario',
      scenario: {
        preparedId: 'prepared_scenario', scenarioId: 'scenario_login', scenarioName: '登录后看详情', catalogRevision: 5,
        onFailure: 'stop', createdAt: 1, expiresAt: 2,
        warnings: ['流程中有 1 个步骤指向 production 环境，运行前必须逐次复核'],
        steps: [
          { index: 0, stepId: 'step_login', name: '登录', requestId: 'request_login', method: 'POST', url: 'https://example.test/login' },
          { index: 1, stepId: 'step_profile', name: '用户详情', requestId: 'request_profile', method: 'GET', url: 'https://example.test/profile', environmentKind: 'production' },
        ],
      },
    })]]]))

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <PermissionBanner sessionId="session-1" onStop={() => undefined} />
      </Provider>,
    )

    expect(html).toContain('运行接口流程（一次批准整条流程）')
    expect(html).toContain('失败策略：stop（失败后跳过后续步骤）')
    expect(html).toContain('本次将按顺序执行的步骤')
    expect(html).toContain('1. 登录 · POST https://example.test/login')
    expect(html).toContain('2. 用户详情 · GET https://example.test/profile ⚠ 生产环境')
    expect(html).toContain('批准一次即授权这条流程的全部步骤')
    expect(html).toContain('流程中有 1 个步骤指向 production 环境，运行前必须逐次复核')
  })
})
