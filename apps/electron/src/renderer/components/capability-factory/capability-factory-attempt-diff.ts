/**
 * 两次单步尝试的对比（纯函数）。
 *
 * 这是"根据返回内容优化"的最后一块：光看这一次的返回，无法判断"改了这句到底好没好"；
 * 必须把两次放在一起看 —— 提示词改了哪几行、输入是不是同一份、约束结论从什么变成了什么。
 *
 * 刻意只做**行级 diff**：提示词是写给人看的文本，行级增删已经足够定位"改的是哪一句"，
 * 再细的字符级 diff 只会让改一个词的噪音铺满整屏。
 */
import type { CapabilityRun } from '@proma/shared'

/** 一行差异。`same` 是两边都有的行，用来保留上下文。 */
export interface TextDiffLine {
  kind: 'same' | 'added' | 'removed'
  text: string
}

/**
 * 行级 diff（LCS）。
 *
 * @param before 基线文本
 * @param after 当前文本
 * @returns 逐行差异；顺序即原文顺序
 */
export function diffTextLines(before: string, after: string): TextDiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const n = a.length
  const m = b.length

  /** 后缀 LCS 长度表：`table[i][j]` = a[i..] 与 b[j..] 的最长公共子序列长度。 */
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const row = table[i]
      const nextRow = table[i + 1]
      if (!row || !nextRow) continue
      row[j] = a[i] === b[j] ? (nextRow[j + 1] ?? 0) + 1 : Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0)
    }
  }

  const lines: TextDiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'same', text: a[i] ?? '' })
      i += 1
      j += 1
      continue
    }
    /** 相等时优先"删除"：让"删了一行 + 加了一行"读起来像一次修改。 */
    const down = table[i + 1]?.[j] ?? 0
    const right = table[i]?.[j + 1] ?? 0
    if (down >= right) {
      lines.push({ kind: 'removed', text: a[i] ?? '' })
      i += 1
    } else {
      lines.push({ kind: 'added', text: b[j] ?? '' })
      j += 1
    }
  }
  while (i < n) { lines.push({ kind: 'removed', text: a[i] ?? '' }); i += 1 }
  while (j < m) { lines.push({ kind: 'added', text: b[j] ?? '' }); j += 1 }
  return lines
}

/** 约束轴的结论，用于对比"从什么变成了什么"。 */
function constraintOutcome(run: CapabilityRun): string {
  if (run.valid) return '约束通过'
  const reasons = run.steps.flatMap((step) => step.constraintErrors ?? [])
  if (reasons.length > 0) return `约束不通过：${reasons[0] ?? ''}`
  return '约束不通过'
}

/** 两次尝试的对比结果。 */
export interface AttemptComparison {
  /** 提示词模板是否变了：没变说明这次差异来自输入或模型随机性。 */
  promptChanged: boolean
  promptDiff: TextDiffLine[]
  promptSummary: { added: number; removed: number }
  /** 输入里值变化了的槽名；为空表示两次用的是同一份输入。 */
  inputChangedKeys: string[]
  /** 约束轴的变化：`通过 → 不通过` 这类。 */
  constraintFrom: string
  constraintTo: string
  /** 解析结果是否完全一致（一致时"这次改动没影响输出"本身就是一个结论）。 */
  parsedOutputUnchanged: boolean
}

/**
 * 对比两次尝试。
 *
 * @param baseline 基线（通常是上一次）
 * @param current 当前（通常是这一次）
 * @returns 提示词差异、输入差异与两轴结论
 */
export function describeAttemptComparison(baseline: CapabilityRun, current: CapabilityRun): AttemptComparison {
  const before = baseline.stepPrompt ?? ''
  const after = current.stepPrompt ?? ''
  const promptDiff = diffTextLines(before, after)

  const keys = new Set([...Object.keys(baseline.input ?? {}), ...Object.keys(current.input ?? {})])
  const inputChangedKeys = [...keys].filter((key) =>
    JSON.stringify(baseline.input?.[key] ?? null) !== JSON.stringify(current.input?.[key] ?? null))

  return {
    promptChanged: before !== after,
    promptDiff,
    promptSummary: {
      added: promptDiff.filter((line) => line.kind === 'added').length,
      removed: promptDiff.filter((line) => line.kind === 'removed').length,
    },
    inputChangedKeys,
    constraintFrom: constraintOutcome(baseline),
    constraintTo: constraintOutcome(current),
    parsedOutputUnchanged: JSON.stringify(baseline.steps[0]?.parsedOutput ?? null)
      === JSON.stringify(current.steps[0]?.parsedOutput ?? null),
  }
}
