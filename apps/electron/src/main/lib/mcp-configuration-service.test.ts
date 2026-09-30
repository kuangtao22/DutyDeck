import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { McpServerEntry, WorkspaceMcpConfig } from '@proma/shared'

/** 测试内存中的工作区 MCP 配置，模拟原子读写边界。 */
const workspaceConfigs = new Map<string, WorkspaceMcpConfig>()
/** 每次保存的配置快照，用于验证 disabled-first 行为。 */
const savedConfigs: WorkspaceMcpConfig[] = []
/** 可由测试覆盖的握手实现。 */
let validationImplementation: (name: string, entry: McpServerEntry, workspaceSlug?: string) => Promise<{
  name: string
  valid: boolean
  message?: string
  reason?: string
}>

mock.module('./agent-workspace-manager', () => ({
  getWorkspaceMcpConfig: (workspaceSlug: string): WorkspaceMcpConfig => {
    const config = workspaceConfigs.get(workspaceSlug) ?? { servers: {} }
    return structuredClone(config)
  },
  saveWorkspaceMcpConfig: (workspaceSlug: string, config: WorkspaceMcpConfig): void => {
    const snapshot = structuredClone(config)
    workspaceConfigs.set(workspaceSlug, snapshot)
    savedConfigs.push(snapshot)
  },
}))

mock.module('./mcp-validator', () => ({
  validateMcpServer: (name: string, entry: McpServerEntry, workspaceSlug?: string) =>
    validationImplementation(name, entry, workspaceSlug),
}))

const { configureWorkspaceMcp, listWorkspaceMcpServers } = await import('./mcp-configuration-service')

beforeEach(() => {
  workspaceConfigs.clear()
  savedConfigs.length = 0
  validationImplementation = async (name) => ({ name, valid: true, message: '连接成功' })
})

describe('工作区 MCP 配置服务', () => {
  test('Given 新连接请求启用 When 验证成功 Then 先保存 disabled 再启用', async () => {
    const result = await configureWorkspaceMcp('project-a', {
      name: 'docs',
      type: 'http',
      url: 'https://mcp.example.com',
    })

    expect(savedConfigs).toHaveLength(2)
    expect(savedConfigs[0]?.servers.docs?.enabled).toBe(false)
    expect(savedConfigs[1]?.servers.docs).toMatchObject({
      enabled: true,
      lastTestResult: { success: true, message: '连接成功' },
    })
    expect(result).toMatchObject({ name: 'docs', enabled: true, verified: true, availableNextRun: true })
  })

  test('Given 请求启用 When 握手失败 Then 保存失败结果并保持 disabled', async () => {
    validationImplementation = async (name) => ({ name, valid: false, reason: '握手失败' })

    const result = await configureWorkspaceMcp('project-a', {
      name: 'docs',
      type: 'http',
      url: 'https://mcp.example.com',
    })

    expect(workspaceConfigs.get('project-a')?.servers.docs).toMatchObject({
      enabled: false,
      lastTestResult: { success: false, message: '握手失败' },
    })
    expect(result).toMatchObject({ enabled: false, verified: false, availableNextRun: false })
  })

  test('Given 同名连接参数变化 When 未确认替换 Then 拒绝且不写入', async () => {
    workspaceConfigs.set('project-a', {
      servers: { docs: { type: 'http', url: 'https://old.example.com', enabled: true } },
    })

    await expect(configureWorkspaceMcp('project-a', {
      name: 'docs',
      type: 'http',
      url: 'https://new.example.com',
    })).rejects.toThrow('replaceExisting=true')
    expect(savedConfigs).toHaveLength(0)
  })

  test('Given 同名连接目标变化且绑定请求头 When 已确认替换 Then 仍拒绝 Agent 搬运秘密', async () => {
    workspaceConfigs.set('project-a', {
      servers: {
        docs: {
          type: 'http',
          url: 'https://old.example.com',
          headers: { Authorization: 'Bearer secret' },
          enabled: true,
        },
      },
    })

    await expect(configureWorkspaceMcp('project-a', {
      name: 'docs',
      type: 'http',
      url: 'https://new.example.com',
      replaceExisting: true,
    })).rejects.toThrow('请在 MCP 管理界面移除或重新配置凭据')

    expect(workspaceConfigs.get('project-a')?.servers.docs).toMatchObject({
      url: 'https://old.example.com',
      headers: { Authorization: 'Bearer secret' },
    })
  })

  test('Given 同名连接目标不变且 OAuth 元数据变化 When 已确认替换 Then 保留请求头', async () => {
    workspaceConfigs.set('project-a', {
      servers: {
        docs: {
          type: 'http',
          url: 'https://same.example.com',
          headers: { Authorization: 'Bearer secret' },
          enabled: true,
        },
      },
    })

    await configureWorkspaceMcp('project-a', {
      name: 'docs',
      type: 'http',
      url: 'https://same.example.com',
      oauth: { clientId: 'public-client' },
      replaceExisting: true,
    })

    expect(workspaceConfigs.get('project-a')?.servers.docs).toMatchObject({
      url: 'https://same.example.com',
      headers: { Authorization: 'Bearer secret' },
      oauth: { clientId: 'public-client' },
    })
  })

  test('Given 同一工作区并发更新 When 第一项验证未完成 Then 第二项等待并保留两项结果', async () => {
    let releaseFirstValidation: (() => void) | undefined
    let validationCount = 0
    validationImplementation = async (name) => {
      validationCount += 1
      if (name === 'first') await new Promise<void>((resolve) => { releaseFirstValidation = resolve })
      return { name, valid: true, message: '连接成功' }
    }

    const first = configureWorkspaceMcp('project-a', { name: 'first', type: 'http', url: 'https://first.example.com' })
    await Bun.sleep(0)
    const second = configureWorkspaceMcp('project-a', { name: 'second', type: 'http', url: 'https://second.example.com' })
    await Bun.sleep(0)

    expect(validationCount).toBe(1)
    releaseFirstValidation?.()
    await Promise.all([first, second])
    expect(Object.keys(workspaceConfigs.get('project-a')?.servers ?? {}).sort()).toEqual(['first', 'second'])
  })

  test('Given 验证期间用户修改同名连接 When 旧验证返回 Then 不覆盖用户的新配置', async () => {
    let releaseValidation: (() => void) | undefined
    validationImplementation = async (name) => {
      await new Promise<void>((resolve) => { releaseValidation = resolve })
      return { name, valid: true, message: '旧连接成功' }
    }

    const configuring = configureWorkspaceMcp('project-a', {
      name: 'docs',
      type: 'http',
      url: 'https://old.example.com',
    })
    await Bun.sleep(0)
    workspaceConfigs.set('project-a', {
      servers: { docs: { type: 'http', url: 'https://user.example.com', enabled: false } },
    })
    releaseValidation?.()

    const result = await configuring
    expect(workspaceConfigs.get('project-a')?.servers.docs).toEqual({
      type: 'http',
      url: 'https://user.example.com',
      enabled: false,
    })
    expect(result).toMatchObject({ enabled: false, verified: false, availableNextRun: false })
  })

  test('Given 主进程工作区写守卫 When 配置并验证 Then 两次磁盘提交都经过守卫', async () => {
    const guardedWrites: string[] = []
    await configureWorkspaceMcp('project-a', {
      name: 'docs',
      type: 'http',
      url: 'https://mcp.example.com',
    }, {
      runWorkspaceSlugWrite: (workspaceSlug, effect) => {
        guardedWrites.push(workspaceSlug)
        return effect()
      },
    })

    expect(guardedWrites).toEqual(['project-a', 'project-a'])
  })

  test('Given 配置含诊断和秘密 When Agent 列出连接 Then 只返回脱敏摘要', () => {
    workspaceConfigs.set('project-a', {
      servers: {
        docs: {
          type: 'http',
          url: 'https://mcp.example.com',
          headers: { Authorization: 'Bearer secret' },
          enabled: true,
          lastTestResult: { success: true, message: '内部详情', timestamp: 1 },
        },
      },
    })

    expect(listWorkspaceMcpServers('project-a')).toEqual([
      { name: 'docs', type: 'http', enabled: true, verified: true },
    ])
  })
})
