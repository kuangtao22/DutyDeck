import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectInstructionScopeController } from './pi-project-instruction-scope'

/** 测试生成的项目目录，逐例清理，避免读取用户真实 AGENTS.md。 */
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** 创建带子目录项目规则的隔离项目。 */
function createScopedProject(rule: string): { projectRoot: string; agentsPath: string } {
  /** 每个测试使用独立项目根，确保 resolver 只读取测试文件。 */
  const projectRoot = mkdtempSync(join(tmpdir(), 'proma-project-instruction-scope-'))
  temporaryDirectories.push(projectRoot)
  const childDirectory = join(projectRoot, 'child')
  mkdirSync(childDirectory, { recursive: true })
  const agentsPath = join(childDirectory, 'AGENTS.md')
  writeFileSync(agentsPath, rule, 'utf8')
  return { projectRoot, agentsPath }
}

/** 构造一次独立 query 使用的 controller，模拟恢复会话时 delivered 状态重新开始。 */
function createController(projectRoot: string): ProjectInstructionScopeController {
  return new ProjectInstructionScopeController({
    projectRoot,
    cwd: projectRoot,
    initialSources: [],
  })
}

describe('Pi 动态项目指令跨 query 恢复', () => {
  test('Given 恢复提示词含同一 source 历史 When 再次发现 Then 相同最新版去重且内容回退成为最新', () => {
    const { projectRoot, agentsPath } = createScopedProject('RULE_V1')

    const firstController = createController(projectRoot)
    expect(firstController.beforeToolCall({ toolName: 'read', input: { path: 'child/file.ts' } })?.block).toBe(true)
    const firstPrompt = firstController.appendPendingInstructions('BASE')
    expect(firstPrompt).toContain('RULE_V1')
    expect(firstPrompt.match(/<project_instruction /g)).toHaveLength(1)

    /** 新 query 会重建 controller，但恢复的 system prompt 已携带完全相同的 source。 */
    const resumedController = createController(projectRoot)
    expect(resumedController.beforeToolCall({ toolName: 'read', input: { path: 'child/file.ts' } })?.block).toBe(true)
    const deduplicatedPrompt = resumedController.appendPendingInstructions(firstPrompt)
    expect(deduplicatedPrompt).toBe(firstPrompt)
    /** 去重后 delivered 已同步，同一 query 再次访问不应重复阻断工具。 */
    expect(resumedController.beforeToolCall({ toolName: 'read', input: { path: 'child/file.ts' } })).toBeUndefined()

    /** 文件内容变化会产生新 hash，必须作为新版规则继续追加。 */
    writeFileSync(agentsPath, 'RULE_V2', 'utf8')
    const changedController = createController(projectRoot)
    expect(changedController.beforeToolCall({ toolName: 'read', input: { path: 'child/file.ts' } })?.block).toBe(true)
    const changedPrompt = changedController.appendPendingInstructions(deduplicatedPrompt)
    expect(changedPrompt).toContain('RULE_V1')
    expect(changedPrompt).toContain('RULE_V2')
    expect(changedPrompt.match(/<project_instruction /g)).toHaveLength(2)

    /** 规则从 V2 回退到历史 V1 时，历史中虽有 V1 也必须重新追加为最后激活版本。 */
    writeFileSync(agentsPath, 'RULE_V1', 'utf8')
    const revertedController = createController(projectRoot)
    expect(revertedController.beforeToolCall({ toolName: 'read', input: { path: 'child/file.ts' } })?.block).toBe(true)
    const revertedPrompt = revertedController.appendPendingInstructions(changedPrompt)
    expect(revertedPrompt.match(/<project_instruction /g)).toHaveLength(3)
    expect(revertedPrompt.lastIndexOf('RULE_V1')).toBeGreaterThan(revertedPrompt.lastIndexOf('RULE_V2'))

    /** 最新版本已是回退后的 V1，下一次恢复只同步 delivered，不继续膨胀。 */
    const stableController = createController(projectRoot)
    expect(stableController.beforeToolCall({ toolName: 'read', input: { path: 'child/file.ts' } })?.block).toBe(true)
    expect(stableController.appendPendingInstructions(revertedPrompt)).toBe(revertedPrompt)
  })
})
