import { describe, expect, test } from 'bun:test'
import { createEmptySceneDefinition } from '@proma/shared'
import { savedTaskDraft, parseSavedTaskInput, taskInputTemplate, inspectTaskContent } from './capability-factory-task-input'

/** 覆盖不同输入类型，确保复用不会改变测试材料。 */
const definition = {
  ...createEmptySceneDefinition('复用任务'),
  inputs: [
    { name: 'text', type: 'string' as const },
    { name: 'enabled', type: 'boolean' as const },
    { name: 'count', type: 'number' as const },
    { name: 'items', type: 'array' as const, required: false },
    { name: 'meta', type: 'object' as const, required: false },
  ],
}

describe('保存任务的输入回填', () => {
  test('Given 各类型输入 When 原样重跑 Then 保留空白、false、零、null和缺省字段', () => {
    const input = { text: '  正文\n', enabled: false, count: 0, items: null }
    expect(parseSavedTaskInput(definition, savedTaskDraft(definition, input)))
      .toEqual({ input, errors: [] })
    expect(JSON.parse(savedTaskDraft(definition, input).content)).not.toHaveProperty('meta')
  })

  test('Given 已保存任务 When 修改内容 Then 用新内容且不改原任务', () => {
    const input = { text: '原文', enabled: true, count: 1, items: ['甲'], meta: { tag: '原始' } }
    const draft = { ...savedTaskDraft(definition, input), content: JSON.stringify({ ...input, text: '修改后的正文', count: 2 }) }
    expect(parseSavedTaskInput(definition, draft).input).toEqual({ ...input, text: '修改后的正文', count: 2 })
    expect(input.text).toBe('原文')
  })

  test('Given 场景输入发生变化 When 回填 Then 不带已移除字段且无效新输入仍报错', () => {
    const input = { text: '正文', enabled: false, count: '不是数字', removed: '旧字段' }
    const parsed = parseSavedTaskInput(definition, savedTaskDraft(definition, input))
    expect(parsed.input).not.toHaveProperty('removed')
    expect(parsed.errors).toEqual(['count: 期望 数字，实际是 字符串'])
  })

  /** 正文场景中的其他上下文可选，不要求用户为了运行而构造 JSON。 */
  const textScene = { ...definition, inputs: [definition.inputs[0]!, definition.inputs[3]!] }

  test('Given 一个正文和可选上下文 When 新建或复用正文 Then 单框文本原样映射，JSON 外观也不误解析', () => {
    expect(savedTaskDraft(textScene)).toEqual({ format: 'auto', content: '' })
    const input = { text: '  [{"name":"林舟"}]\n' }
    const draft = savedTaskDraft(textScene, input)
    expect(draft.format).toBe('text')
    expect(parseSavedTaskInput(textScene, draft)).toEqual({ input, errors: [] })
  })

  test('Given 任务含可选字段 When 复用 Then 完整 JSON 保留 null、空数组与已有内容', () => {
    for (const items of [null, [], ['林舟']]) {
      const input = { text: '正文', items }
      const draft = savedTaskDraft(textScene, input)
      expect(draft.format).toBe('json')
      expect(parseSavedTaskInput(textScene, draft)).toEqual({ input, errors: [] })
    }
    expect(savedTaskDraft(textScene, {}).format).toBe('json')
  })

  test('Given 完整输入 When JSON 非法、根类型错误、缺字段或多余字段 Then 阻止提交并指出原因', () => {
    for (const content of ['{', '[]', 'null', '"正文"', '{}', '{"text":"正文","extra":1}']) {
      expect(parseSavedTaskInput(textScene, { format: 'json', content }).errors.length).toBeGreaterThan(0)
    }
  })

  test('Given 多必填或无明确主文本的场景 When 新建 Then 使用完整输入且不虚构数字', () => {
    expect(savedTaskDraft(definition).format).toBe('auto')
    expect(taskInputTemplate(definition).count).toBeNull()
    expect(parseSavedTaskInput(definition, { format: 'text', content: '正文' }).errors).toHaveLength(1)
  })

  test('Given 文本、JSON 和 Markdown When 自动识别 Then 区分格式但不修改原文', () => {
    for (const content of ['普通正文', '价格 * 数量', '{未完成', '[林舟走进书店]']) {
      expect(inspectTaskContent(content).format).toBe('text')
    }
    for (const content of ['{"name":"林舟"}', '[1,2]', 'false', '0', 'null']) {
      expect(inspectTaskContent(content).format).toBe('json')
    }
    for (const content of ['# 章节\n正文', '- 林舟\n- 陈伯', '**角色**', '[原文](https://example.com)', '|角色|证据|\n|---|---|']) {
      expect(inspectTaskContent(content).format).toBe('markdown')
    }
    expect(inspectTaskContent('  \n').format).toBe('empty')
  })

  test('Given 自动模式 When 粘贴正文、JSON 数组或无关对象 Then 原样传给文本变量', () => {
    for (const content of ['  # 第一章\n林舟\n', '[{"name":"林舟"}]', '{"name":"林舟"}', '```json\n[1,2]\n```']) {
      expect(parseSavedTaskInput(textScene, { format: 'auto', content }))
        .toEqual({ input: { text: content }, errors: [] })
    }
  })

  test('Given 自动模式 When 粘贴场景字段 JSON 或完整 JSON 代码块 Then 自动映射变量', () => {
    const input = { text: '正文', items: ['林舟'] }
    for (const content of [JSON.stringify(input), '```json\n' + JSON.stringify(input) + '\n```']) {
      expect(parseSavedTaskInput(textScene, { format: 'auto', content })).toEqual({ input, errors: [] })
    }
    expect(inspectTaskContent('说明\n```json\n{"text":"正文"}\n```').format).toBe('markdown')
  })

  test('Given 匹配场景的 JSON 有错误 When 自动提交 Then 不回退正文来绕过校验', () => {
    for (const content of ['{"text":42}', '{"text":"正文","extra":1}', '{"items":[]}']) {
      expect(parseSavedTaskInput(textScene, { format: 'auto', content }).errors.length).toBeGreaterThan(0)
    }
    expect(parseSavedTaskInput(definition, { format: 'auto', content: '# 正文' }).errors.length).toBeGreaterThan(0)
  })

  test('Given JSON 正文本身含同名字段 When 强制正文或复用旧任务 Then 不意外拆分正文', () => {
    const content = '{"text":"这是小说中的代码"}'
    expect(parseSavedTaskInput(textScene, { format: 'text', content }).input).toEqual({ text: content })
    expect(parseSavedTaskInput(textScene, savedTaskDraft(textScene, { text: content })).input).toEqual({ text: content })
  })
})
