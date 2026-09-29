import { describe, expect, test } from 'bun:test'
import type { CapabilityRun } from '@proma/shared'
import { describeAttemptComparison, diffTextLines } from './capability-factory-attempt-diff'

/** 造一次单步尝试；只关心对比用到的那几个字段。 */
function attempt(overrides: Partial<CapabilityRun> = {}): CapabilityRun {
  return {
    id: 'run', sceneId: 'scene-1', sceneVersion: 2, kind: 'step', stepId: 'scan',
    status: 'succeeded', valid: true, input: { corpus: '第 1 段' }, outputs: null,
    steps: [], startedAt: 0, finishedAt: 100,
    ...overrides,
  }
}

describe('行级 diff', () => {
  test('改了中间一行：给出删除 + 新增，其余行保留为上下文', () => {
    const diff = diffTextLines('第一行\n第二行\n第三行', '第一行\n第二行改过\n第三行')

    expect(diff).toEqual([
      { kind: 'same', text: '第一行' },
      { kind: 'removed', text: '第二行' },
      { kind: 'added', text: '第二行改过' },
      { kind: 'same', text: '第三行' },
    ])
  })

  test('新增与删除整行都能识别；完全相同时全是 same', () => {
    expect(diffTextLines('A', 'A\nB')).toEqual([
      { kind: 'same', text: 'A' }, { kind: 'added', text: 'B' },
    ])
    expect(diffTextLines('A\nB', 'B')).toEqual([
      { kind: 'removed', text: 'A' }, { kind: 'same', text: 'B' },
    ])
    expect(diffTextLines('same', 'same')).toEqual([{ kind: 'same', text: 'same' }])
  })
})

describe('两次尝试的对比', () => {
  test('改了提示词、输入没变 When 对比 Then 报出增删行数并说明输入是同一份', () => {
    const comparison = describeAttemptComparison(
      attempt({ stepPrompt: '找出人物\n输出 JSON' }),
      attempt({ stepPrompt: '找出人物，必须带段落引用\n输出 JSON' }),
    )

    expect(comparison.promptChanged).toBe(true)
    expect(comparison.promptSummary).toEqual({ added: 1, removed: 1 })
    expect(comparison.inputChangedKeys).toEqual([])
  })

  test('提示词没变但结果变了：能指出"差异不是来自提示词"', () => {
    const comparison = describeAttemptComparison(
      attempt({ stepPrompt: '同一段提示词', valid: false, steps: [{
        stepId: 'scan', title: '扫描', type: 'extract', status: 'invalid', attempts: 1,
        input: {}, constraintErrors: ['characters: 期望数组'], startedAt: 0, finishedAt: 1,
      }] }),
      attempt({ stepPrompt: '同一段提示词', valid: true }),
    )

    expect(comparison.promptChanged).toBe(false)
    expect(comparison.constraintFrom).toContain('characters: 期望数组')
    expect(comparison.constraintTo).toBe('约束通过')
  })

  test('输入变了要指名哪个槽：否则无法判断结果差异的归因', () => {
    const comparison = describeAttemptComparison(
      attempt({ input: { corpus: '第 1 段', known: [] } }),
      attempt({ input: { corpus: '第 2 段', known: [] } }),
    )

    expect(comparison.inputChangedKeys).toEqual(['corpus'])
  })

  test('解析结果一致时明确标记：这次改动没有影响输出，也是一个结论', () => {
    const withOutput = (text: string): CapabilityRun => attempt({ steps: [{
      stepId: 'scan', title: '扫描', type: 'extract', status: 'succeeded', attempts: 1,
      input: {}, parsedOutput: { characters: [{ name: text }] }, startedAt: 0, finishedAt: 1,
    }] })

    expect(describeAttemptComparison(withOutput('阿明'), withOutput('阿明')).parsedOutputUnchanged).toBe(true)
    expect(describeAttemptComparison(withOutput('阿明'), withOutput('阿明、祖母')).parsedOutputUnchanged).toBe(false)
  })
})
