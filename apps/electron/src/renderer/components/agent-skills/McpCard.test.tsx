import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { McpCard } from './McpCard'
import type { McpServerEntry } from '@proma/shared'

interface InteractiveElementProps {
  children?: React.ReactNode
  onKeyDown?: (event: { stopPropagation: () => void }) => void
}

/** 按按钮文本查找未挂载的 React 元素，用于验证卡片内部操作的事件边界。 */
function findElementByText(node: React.ReactNode, text: string): React.ReactElement<InteractiveElementProps> | null {
  if (!React.isValidElement<InteractiveElementProps>(node)) return null
  const children = React.Children.toArray(node.props.children)
  if (children.some((child) => child === text)) return node
  for (const child of children) {
    const found = findElementByText(child, text)
    if (found) return found
  }
  return null
}

describe('McpCard OAuth 键盘交互', () => {
  test('Given OAuth 授权按钮 When 按下 Enter Then 阻止事件冒泡到整卡打开操作', () => {
    const entry: McpServerEntry = {
      type: 'http',
      url: 'https://example.com/mcp',
      enabled: false,
      oauth: { clientId: 'public-client' },
    }
    const card = McpCard({
      name: '示例 MCP',
      entry,
      onOpen: () => undefined,
      onAuthorize: () => undefined,
    })
    const authorizeButton = findElementByText(card, 'OAuth 授权')
    let propagationStopped = false

    authorizeButton?.props.onKeyDown?.({ stopPropagation: () => { propagationStopped = true } })

    expect(authorizeButton).not.toBeNull()
    expect(propagationStopped).toBe(true)
  })
})
