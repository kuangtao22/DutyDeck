import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createEmptySceneDefinition } from '@proma/shared'
import type { CapabilitySceneDefinition, CapabilityStub } from '@proma/shared'
import { CapabilityFactoryStubSection } from './CapabilityFactoryStubSection'

/** 一个声明了两个外部能力的场景：一个已绑桩、一个没绑。 */
const definition: CapabilitySceneDefinition = {
  ...createEmptySceneDefinition('小说角色提取'),
  capabilities: [
    {
      id: 'corpus.build', description: '把章节正文解析成带段落引用的批次正文',
      inputSchema: [{ name: 'text', type: 'string' }],
      outputSchema: [{ name: 'corpusText', type: 'string' }, { name: 'paragraphCount', type: 'number' }],
      sideEffect: 'read',
    },
    {
      id: 'anchor.ground', description: '把每条引文回到本地正文核对并落锚',
      inputSchema: [{ name: 'corpus', type: 'object' }],
      outputSchema: [{ name: 'characters', type: 'array' }],
      sideEffect: 'read',
    },
  ],
}

/** 渲染虚拟接入区。 */
function render(stubs: CapabilityStub[] = []): string {
  return renderToStaticMarkup(
    <CapabilityFactoryStubSection
      definition={definition}
      stubs={stubs}
      busy={false}
      error={null}
      onSave={() => undefined}
      onDelete={() => undefined}
    />,
  )
}

describe('虚拟接入区', () => {
  test('Given 没有桩 When 渲染 Then 每条能力都给出绑定入口与一键占位', () => {
    const html = render()

    expect(html).toContain('corpus.build')
    expect(html).toContain('anchor.ground')
    expect(html).toContain('未绑桩')
    /** 只数按钮本体：说明文字里也出现过「自动填占位」。 */
    expect(html.match(/>绑定桩</g)?.length).toBe(2)
    expect(html.match(/>自动填占位</g)?.length).toBe(2)
  })

  test('Given 已绑占位桩 When 渲染 Then 明确标成占位桩 —— 它只能证明流程通了', () => {
    const html = render([{
      capabilityId: 'corpus.build', payload: { corpusText: '', paragraphCount: 0 },
      source: 'placeholder', updatedAt: 1,
    }])

    expect(html).toContain('占位桩')
    expect(html).toContain('编辑桩')
    /** 占位桩的徽标替代了「已绑桩」：来源比"有没有绑"更该被看见。 */
    expect(html).not.toContain('>已绑桩<')
    expect(html).toContain('清空桩：corpus.build')
  })

  test('Given Agent 填的桩 When 渲染 Then 来源写在徽标上，人能分辨谁写的', () => {
    const html = render([{
      capabilityId: 'corpus.build', payload: { corpusText: '第 1 段', paragraphCount: 1 },
      source: 'agent', note: '取自真实响应', updatedAt: 1,
    }])

    expect(html).toContain('Agent 填的桩')
  })

  test('说明常驻：桩不进版本也不进包，形状不对会让真实接入返工', () => {
    const html = render()

    expect(html).toContain('不进场景版本也不进能力包')
    expect(html).toContain('质量结论不能看')
  })
})
