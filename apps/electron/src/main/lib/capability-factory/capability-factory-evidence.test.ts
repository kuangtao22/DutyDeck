import { expect, test } from 'bun:test'
import { validateCapabilityEvidence } from './capability-factory-evidence'

test('Given selectedText 不属于 paragraphRef When 校验证据 Then 返回可定位问题', () => {
  const issues = validateCapabilityEvidence(
    { corpus: '{"paragraphRef":"c0-p1","text":"秦诚告诉他，家里托了关系。"}' },
    { relations: [{ summary: '秦诚有关系', evidence: [{ paragraphRef: 'c0-p1', selectedText: '秦诚没有被选中' }] }] },
  )
  expect(issues.some((issue) => issue.includes('c0-p1') && issue.includes('selectedText'))).toBe(true)
})

test('Given summary 是忠实概括或代词替换 When 校验证据 Then 不以逐字子串误判摘要', () => {
  const issues = validateCapabilityEvidence(
    { corpus: '{"paragraphRef":"c0-p1","text":"秦诚告诉他，家里托了关系。"}' },
    { relations: [{ summary: '秦诚家里托了关系。', evidence: [{ paragraphRef: 'c0-p1', selectedText: '秦诚告诉他，家里托了关系。' }] }] },
  )
  expect(issues).toEqual([])
})

test('Given 正确逐字证据 When 校验 Then 不产生问题', () => {
  expect(validateCapabilityEvidence(
    { corpus: [{ paragraphRef: 'c0-p1', text: '秦诚告诉他，家里托了关系。' }] },
    { relations: [{ summary: '秦诚告诉他，家里托了关系。', evidence: [{ paragraphRef: 'c0-p1', selectedText: '秦诚告诉他，家里托了关系。' }] }] },
  )).toEqual([])
})

test('Given 同一段落引用对应不同原文 When 校验 Then 报告来源冲突且不以后写覆盖', () => {
  /** 输入与工具返回出现冲突时，两份原文都不能擅自充当唯一依据。 */
  const issues = validateCapabilityEvidence(
    { input: [{ paragraphRef: 'p1', text: '真实原文' }], tools: [{ paragraphRef: 'p1', text: '另一份原文' }] },
    { evidence: [{ paragraphRef: 'p1', selectedText: '另一份原文' }] },
  )
  expect(issues.some((issue) => issue.includes('p1') && issue.includes('冲突'))).toBe(true)
})

test.each([
  { paragraphRef: 'p1', selectedText: '' },
  { paragraphRef: 'p1', selectedText: '   ' },
  { paragraphRef: '', selectedText: '真实原文' },
  { paragraphRef: 'p1' },
  { selectedText: '真实原文' },
  {},
])('Given 引用为空或缺少必要字段 When 校验 Then 不静默通过 %j', (evidence) => {
  expect(validateCapabilityEvidence(
    { corpus: [{ paragraphRef: 'p1', text: '真实原文' }] }, { evidence: [evidence] },
  ).length).toBeGreaterThan(0)
})

test.each([
  JSON.stringify({ evidence: [{ paragraphRef: 'missing', selectedText: '捏造原文' }] }),
  `${JSON.stringify({ evidence: [{ paragraphRef: 'p1', selectedText: '真实原文' }] })}\n${JSON.stringify({ evidence: [{ paragraphRef: 'missing', selectedText: '捏造原文' }] })}`,
  '```json\n{"evidence":[{"paragraphRef":"missing","selectedText":"捏造原文"}]}\n```',
])('Given 引用藏在 JSON 或 JSONL 文本中 When 校验 Then 仍然检查引用来源', (output) => {
  expect(validateCapabilityEvidence(
    { corpus: [{ paragraphRef: 'p1', text: '真实原文' }] }, output,
  ).some((issue) => issue.includes('missing'))).toBe(true)
})

test('Given 没有段落引用结构的普通文本 When 校验 Then 继续由内容评审判断', () => {
  expect(validateCapabilityEvidence({ text: '普通输入' }, '普通摘要，无结构化引用。')).toEqual([])
  expect(validateCapabilityEvidence({ text: '普通输入' }, { evidence: '普通理由说明，不声明段落引用。' })).toEqual([])
})

test.each([
  { url: 'https://example.invalid/source', quote: '来源文字' },
  { file: 'chapter.txt', line: 12 },
])('Given URL 或文件定位证据 When 校验 Then 不强制套用段落引用 schema', (evidence) => {
  expect(validateCapabilityEvidence({ text: '普通输入' }, { evidence })).toEqual([])
  /** 即使输入还包含段落数据，另一个合法定位体系也不应被改写成段落结构。 */
  expect(validateCapabilityEvidence(
    { corpus: [{ paragraphRef: 'p1', text: '真实原文' }] }, { evidence },
  )).toEqual([])
})

test.each([[], null, '', '   ', ['']].map((evidence) => ({ evidence })))('Given 显式 evidence 被清空 When 校验 Then 不能通过删除引用绕过检查', ({ evidence }) => {
  expect(validateCapabilityEvidence({}, { summary: '仍然声称有事实依据', evidence }).length).toBeGreaterThan(0)
})

test('Given 重复原文一致且引用名与对象原型重名 When 校验 Then 不误判冲突或读取原型值', () => {
  expect(validateCapabilityEvidence(
    { corpus: [{ paragraphRef: 'constructor', text: '真实原文' }, { paragraphRef: 'constructor', text: '真实原文' }] },
    { evidence: [{ paragraphRef: 'constructor', selectedText: '真实原文' }] },
  )).toEqual([])
})
