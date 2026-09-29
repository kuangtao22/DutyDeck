import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_SERVER_OPS_VIEW_POSITION,
  updateServerOpsViewPosition,
} from './server-ops-atoms'

describe('运维面板视图位置记忆', () => {
  test('Given 尚未记录任何位置 When 读取默认值 Then 落在项目视图而不是上次的连接', () => {
    /** 这是既有约定：应用重启后默认回到项目分组，不能因为「记住位置」而变成直接进连接。 */
    expect(DEFAULT_SERVER_OPS_VIEW_POSITION).toEqual({
      projectId: null,
      connectionId: null,
      projectViewActive: true,
      activeSection: 'overview',
    })
    expect(updateServerOpsViewPosition(new Map(), 'session-a:single', {}).get('session-a:single'))
      .toEqual(DEFAULT_SERVER_OPS_VIEW_POSITION)
  })

  test('Given 已记录某会话的位置 When 切换另一个会话 Then 两者互不影响', () => {
    /** 切到别的会话再回来必须回到离开前的位置，但两个会话的位置不能串。 */
    const first = updateServerOpsViewPosition(new Map(), 'session-a:single', {
      projectId: 'project-a', connectionId: 'data:source-a', projectViewActive: false, activeSection: 'files',
    })
    const second = updateServerOpsViewPosition(first, 'session-b:single', {
      projectId: 'project-b', connectionId: 'ssh:host-b', projectViewActive: false, activeSection: 'logs',
    })
    expect(second.get('session-a:single')).toEqual({
      projectId: 'project-a', connectionId: 'data:source-a', projectViewActive: false, activeSection: 'files',
    })
    expect(second.get('session-b:single')).toEqual({
      projectId: 'project-b', connectionId: 'ssh:host-b', projectViewActive: false, activeSection: 'logs',
    })
  })

  test('Given 同一位置重复写入 When 内容未变化 Then 返回原引用避免无意义重渲染', () => {
    const first = updateServerOpsViewPosition(new Map(), 'session-a:single', { projectViewActive: false })
    expect(updateServerOpsViewPosition(first, 'session-a:single', { projectViewActive: false })).toBe(first)
    /** 真的变了就要产生新表，否则界面不会更新。 */
    expect(updateServerOpsViewPosition(first, 'session-a:single', { activeSection: 'docker' })).not.toBe(first)
  })

  test('Given 空选择会话已经挂载 When 其他会话更新全局默认 Then 空会话仍保留自己的空快照', () => {
    const frozenEmpty = updateServerOpsViewPosition(new Map(), 'session-empty:single', {})
    const anotherSession = updateServerOpsViewPosition(frozenEmpty, 'session-b:single', {
      projectId: 'project-b', connectionId: 'data:source-b', projectViewActive: false,
    })
    expect(anotherSession.get('session-empty:single')).toEqual(DEFAULT_SERVER_OPS_VIEW_POSITION)
  })
})
