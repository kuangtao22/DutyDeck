import { describe, expect, test } from 'bun:test'
import { getChangedWorkspaceComponentForTool } from './agent-component-activation'

describe('MCP 配置工具的工作区展示', () => {
  test('Given 受控 MCP 配置成功 When 识别变更组件 Then 展示 MCP 面板', () => {
    expect(getChangedWorkspaceComponentForTool('proma_workspace_configure_mcp_server', {})).toBe('mcp')
  })

  test('Given 普通文件工具修改 mcp.json When 识别变更组件 Then 不自动展示 MCP 面板', () => {
    expect(getChangedWorkspaceComponentForTool('Write', {
      file_path: '/tmp/.proma/agent-workspaces/project-a/mcp.json',
    })).toBeNull()
  })
})
