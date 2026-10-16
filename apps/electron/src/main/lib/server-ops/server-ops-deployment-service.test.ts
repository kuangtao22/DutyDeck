import { describe, expect, test } from 'bun:test'
import type { ServerOpsDeploymentTarget } from '@proma/shared'
import { ServerOpsDeploymentService } from './server-ops-deployment-service'

/** 使用纯内存边界验证准入检查，测试不连接用户的服务器。 */
function fixture() {
  /** 固定目标用于验证配置 revision 与 SSH 代次。 */
  const target: ServerOpsDeploymentTarget = {
    id: '10000000-0000-4000-8000-000000000001', projectId: '10000000-0000-4000-8000-000000000002',
    hostId: '10000000-0000-4000-8000-000000000003', revision: 1, name: '官网', environment: '测试',
    composeProject: 'website', composeFile: '/srv/website/compose.yml', sourceUrl: '', registry: '', accessUrl: '',
    createdAt: 1, updatedAt: 1,
  }
  /** 模拟当前 SSH 身份，测试可以推进代次来模拟断开重连。 */
  const identity = { hostId: target.hostId, connectionId: '10000000-0000-4000-8000-000000000004', generation: 1 }
  /** 捕获实际派发命令，证明检查不会触发变更。 */
  const commands: string[] = []
  /** 模拟 Docker 固定字段投影，故意不包含环境变量或完整 inspect。 */
  let output = JSON.stringify({ service: 'web', image: 'example/web:1', project: 'website', files: target.composeFile })
  /** 可注入 await 间隙内的身份变化。 */
  let onExec: (() => void) | undefined
  /** 主机归属可在检查期间变化。 */
  let projectId = target.projectId
  const service = new ServerOpsDeploymentService({
    store: { getTarget: () => structuredClone(target), listTargets: () => [structuredClone(target)] },
    getHost: () => ({ projectId }),
    getActiveIdentity: () => ({ ...identity }),
    exec: async (_hostId, _connectionId, command) => {
      commands.push(command)
      onExec?.()
      return { stdout: command.includes(' ps --all ') ? output : '2.30.0\n', stderr: '', exitCode: 0, truncated: false }
    },
    now: () => 1000,
  })
  return { target, identity, commands, service, setOutput: (value: string) => { output = value }, setHook: (value: () => void) => { onExec = value }, moveHost: () => { projectId = '10000000-0000-4000-8000-000000000005' } }
}

describe('Given 已保存的 Compose 发布目标', () => {
  test('When 检查现场标签 Then 显示真实服务并保持未验证的发布条件关闭', async () => {
    const f = fixture()
    const result = await f.service.checkTarget({ targetId: f.target.id, expectedRevision: 1 })
    expect(result.services).toEqual([{ name: 'web', image: 'example/web:1' }])
    expect(result.canDeploy).toBe(false)
    expect(result.evidence.find((item) => item.code === 'compose-identity')?.status).toBe('passed')
    expect(result.evidence.find((item) => item.code === 'database-effects')?.status).toBe('unverified')
    expect(f.commands.every((command) => !/(?:^| )(?:up|pull|restart|run|down)(?: |$)/u.test(command))).toBe(true)
    expect(f.commands.every((command) => command.includes('--host unix:///var/run/docker.sock'))).toBe(true)
    expect(JSON.stringify(result)).not.toContain('stderr')
  })
  test('When 配置 revision 过期 Then 不派发命令', async () => {
    const f = fixture()
    await expect(f.service.checkTarget({ targetId: f.target.id, expectedRevision: 2 })).rejects.toThrow('REVISION_CONFLICT')
    expect(f.commands).toHaveLength(0)
  })
  test('When SSH 在 await 期间换代 Then 拒绝迟到证据', async () => {
    const f = fixture()
    f.setHook(() => { f.identity.generation++ })
    await expect(f.service.checkTarget({ targetId: f.target.id, expectedRevision: 1 })).rejects.toThrow('STALE')
  })
  test('When 主机移到其他项目 Then 拒绝旧目标和在途结果', async () => {
    const f = fixture()
    f.setHook(f.moveHost)
    await expect(f.service.checkTarget({ targetId: f.target.id, expectedRevision: 1 })).rejects.toThrow('SCOPE')
  })
  test('When 有同名项目但入口路径不同 Then 阻断目标匹配', async () => {
    const f = fixture()
    f.setOutput(JSON.stringify({ service: 'web', image: 'web:1', project: 'website', files: '/other/compose.yml' }))
    const result = await f.service.checkTarget({ targetId: f.target.id, expectedRevision: 1 })
    expect(result.evidence.find((item) => item.code === 'compose-identity')?.status).toBe('blocked')
  })
  test('When Compose 返回多服务 JSONL Then 聚合服务并保持入口身份校验', async () => {
    const f = fixture()
    f.setOutput([
      JSON.stringify({ Service: 'web', Image: 'example/web:1', Project: 'website', ConfigFiles: f.target.composeFile }),
      JSON.stringify({ Service: 'worker', Image: 'example/worker:1', Project: 'website', ConfigFiles: f.target.composeFile }),
    ].join('\n'))
    const result = await f.service.checkTarget({ targetId: f.target.id, expectedRevision: 1 })
    expect(result.services).toEqual([
      { name: 'web', image: 'example/web:1' },
      { name: 'worker', image: 'example/worker:1' },
    ])
    expect(result.evidence.find((item) => item.code === 'compose-identity')?.status).toBe('passed')
  })
  test('When Compose 文件路径包含 shell 字符 Then 参数转义后不会扩大命令语义', async () => {
    const f = fixture()
    f.target.composeFile = "/srv/it's/compose.yml"
    f.setOutput(JSON.stringify({ service: 'web', image: 'example/web:1', project: 'website', files: f.target.composeFile }))
    await f.service.checkTarget({ targetId: f.target.id, expectedRevision: 1 })
    const command = f.commands.find((value) => value.includes(' ps --all '))!
    expect(command).toContain("-f '/srv/it'\\''s/compose.yml'")
    expect(command).not.toContain("; touch")
  })
  test('When CLI 输出包含额外敏感字段或超过预算 Then 拒绝整份输出', async () => {
    const f = fixture()
    for (const output of [JSON.stringify({ service: 'web', image: 'web:1', project: 'website', files: f.target.composeFile, password: 'secret' }), 'x'.repeat(12_289)]) {
      f.setOutput(output)
      await expect(f.service.checkTarget({ targetId: f.target.id, expectedRevision: 1 })).rejects.toThrow('OUTPUT_INVALID')
    }
  })
  test('When 同目标并发检查或服务已释放 Then 不产生第二轮远端读取', async () => {
    const f = fixture()
    const first = f.service.checkTarget({ targetId: f.target.id, expectedRevision: 1 })
    await expect(f.service.checkTarget({ targetId: f.target.id, expectedRevision: 1 })).rejects.toThrow('BUSY')
    await first
    f.service.dispose()
    await expect(f.service.checkTarget({ targetId: f.target.id, expectedRevision: 1 })).rejects.toThrow('DISPOSED')
  })
})
