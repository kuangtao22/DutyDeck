import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { createCanvasTextReadCoverage, parseCanvasTextReadPage, type CanvasTextReadPage } from './canvas-text-read-coverage'

/** 构造受控分页样本；省略 tool/schema 流程，仅验证覆盖算法边界。 */
function makePage(content: string, offset: number, length: number, nodeId = 'node-1'): CanvasTextReadPage {
  /** 本次返回的区段结束位置。 */
  const end = Math.min(offset + length, content.length)
  return { canvasId: 'canvas-1', nodeId, version: { kind: 'webview', revision: 1 },
    content: content.slice(offset, end), contentHash: createHash('sha256').update(content).digest('hex'),
    offset, nextOffset: end === content.length ? null : end, totalLength: content.length }
}

test('Given 尚未成功送达的页 When 后续页到达 Then 未提交覆盖不计入完整性', () => {
  /** 准备与实际送达分开，失败调用不能留下已读事实。 */
  const coverage = createCanvasTextReadCoverage()
  coverage.prepare(makePage('abcdef', 0, 3), 'task-1')
  const pending = coverage.prepare(makePage('abcdef', 3, 3), 'task-1')
  expect(pending.readCoverage).toEqual({ complete: false, nextOffset: 0 })
  expect(pending.matches('abcdef')).toBe(false)
})

test('Given 相同节点的不同任务或版本 When 拼接各自页面 Then 不混合证据', () => {
  /** 合同身份、版本、内容摘要各自变化都使前半段不可复用。 */
  const coverage = createCanvasTextReadCoverage()
  coverage.prepare(makePage('abcdef', 0, 3), 'task-1').commit()
  expect(coverage.prepare(makePage('abcdef', 3, 3), 'task-2').readCoverage.complete).toBe(false)
  expect(coverage.prepare({ ...makePage('abcdef', 3, 3), version: { kind: 'webview', revision: 2 } }, 'task-1')
    .readCoverage.complete).toBe(false)
  expect(coverage.prepare(makePage('abcXYZ', 3, 3), 'task-1').readCoverage.complete).toBe(false)
})

test('Given 已读页重叠 When 完整覆盖并核对权威正文 Then 只承认相同内容且忽略对象属性顺序', () => {
  /** 重叠页不要求重读，内容发生变化仍不得按字数签发。 */
  const coverage = createCanvasTextReadCoverage()
  coverage.prepare(makePage('abcdef', 0, 4), 'task-1').commit()
  const pending = coverage.prepare({ ...makePage('abcdef', 2, 4), version: { revision: 1, kind: 'webview' } }, 'task-1')
  expect(pending.readCoverage).toEqual({ complete: true, nextOffset: null })
  expect(pending.matches('abcdef')).toBe(true)
  expect(pending.matches('abcXYZ')).toBe(false)
})

test('Given 大量部分读取 When 超过活动文本上限 Then 淘汰旧覆盖而不持有无界正文', () => {
  /** 第33个节点触发旧记录淘汰；重新读尾页不能借用已淘汰的首段。 */
  const coverage = createCanvasTextReadCoverage()
  for (let index = 0; index < 33; index += 1) coverage.prepare(makePage('abcdef', 0, 3, `node-${index}`), 'task-1').commit()
  expect(coverage.prepare(makePage('abcdef', 3, 3, 'node-0'), 'task-1').readCoverage.complete).toBe(false)
  expect(coverage.prepare(makePage('abcdef', 3, 3, 'node-32'), 'task-1').matches('abcdef')).toBe(true)
})

test('Given 非法分页或伪造结束游标 When 解析 Then 不登记覆盖', () => {
  /** 只接受真实有界且页内连续的正文，空页不能制造完成证据。 */
  const valid = makePage('abcdef', 0, 3)
  expect(parseCanvasTextReadPage(valid)).toEqual(valid)
  for (const patch of [{ offset: -1 }, { offset: 0.5 }, { totalLength: 0 }, { totalLength: 300_000 },
    { content: '' }, { content: 'a'.repeat(8193) }, { contentHash: 'invented' }, { nextOffset: null }, { nextOffset: 5 },
    { version: { kind: 'image', revision: 1 } }, { version: { kind: 'webview', revision: -1 } }]) {
    expect(parseCanvasTextReadPage({ ...valid, ...patch })).toBeUndefined()
  }
})
