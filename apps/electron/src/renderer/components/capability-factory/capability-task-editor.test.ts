import { describe, expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { formatTaskJson, taskJsonDiagnostic, taskJsonFolds } from './capability-task-editor'

describe('任务编辑器 JSON 操作', () => {
  test('Given 精确数字与转义字符 When 手动格式化 Then 只改变空白且不损失原始值', () => {
    const raw = '{"id":9007199254740993123,"value":1.2300,"text":"a\\n{b}","items":[]}'
    const formatted = formatTaskJson(raw)
    expect(formatted).toContain('9007199254740993123')
    expect(formatted).toContain('1.2300')
    expect(formatted).toContain('"a\\n{b}"')
    expect(formatted).toContain('\n  "items": []\n')
    expect(JSON.parse(formatted)).toEqual(JSON.parse(raw))
  })

  test('Given JSON 围栏 When 格式化 Then 保留围栏且可继续按正文传入', () => {
    expect(formatTaskJson('```json\n{"x":1}\n```')).toBe('```json\n{\n  "x": 1\n}\n```')
  })

  test('Given 无效 JSON When 格式化或检查 Then 不改原文并给出可定位错误', () => {
    expect(() => formatTaskJson('{"x":}')).toThrow()
    const diagnostic = taskJsonDiagnostic('{"x":}')
    expect(diagnostic?.message).toContain('JSON')
    expect(diagnostic?.from).toBeGreaterThanOrEqual(0)
    expect(diagnostic?.from).toBeLessThanOrEqual(6)
    expect(taskJsonDiagnostic('```json\n{"x":1}\n```')).toBeNull()
  })

  test('Given 含字符串括号的嵌套 JSON When 折叠 Then 仅折叠多行结构', () => {
    const doc = EditorState.create({ doc: '{\n "text": "}\\\"[",\n "items": [\n  1\n ]\n}' }).doc
    const folds = taskJsonFolds(doc)
    expect(folds.get(1)).toEqual({ from: 1, to: doc.length - 1 })
    expect(folds.has(3)).toBe(true)
    expect(folds.has(2)).toBe(false)
    expect(taskJsonFolds(EditorState.create({ doc: '{"items":[]}' }).doc).size).toBe(0)
  })
})
