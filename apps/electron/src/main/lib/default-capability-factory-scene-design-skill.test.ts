import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 随应用分发的场景设计 Skill；缺失时返回空文本以保留清晰断言。 */
function readSkill(): string {
  const path = join(import.meta.dir, '../../../default-skills/capability-factory-scene-design/SKILL.md')
  return existsSync(path) ? readFileSync(path, 'utf-8') : ''
}

test('Given capability-factory-scene-design 默认 Skill When 校验发布合同 Then 元数据与触发边界都在', () => {
  const skill = readSkill()

  expect(skill).toMatch(/^name: capability-factory-scene-design$/m)
  expect(skill).toMatch(/^group: proma$/m)
  expect(skill).toMatch(/^version: "1\.0\.4"$/m)
  /** 触发词必须写进 description，否则 Agent 不会在有需要时加载它。 */
  for (const trigger of ['编排工厂', '提示词工厂', '能力包', '场景']) {
    expect(skill).toContain(trigger)
  }
  /** 反向边界同样要写：普通代码修改不该被强行转入工厂。 */
  expect(skill).toContain('普通代码修改')
})

test('Given 场景设计 Skill When 读取核心口径 Then 只编排模型步骤且写明边界怎么归', () => {
  const skill = readSkill()

  expect(skill).toContain('只编排模型必须做的那部分')
  expect(skill).toContain('由模型决定「要不要做、以及用什么参数做」')
  expect(skill).toContain('输入契约')
  expect(skill).toContain('输出的消费方')
})

test('Given 场景设计 Skill When 读取反例 Then 保留"把 app 管线搬进场景"的真实教训', () => {
  const skill = readSkill()

  /** 这条反例来自 2026-09-28 的真实场景：4 步里 3 步是代码，跑出假绿。 */
  expect(skill).toContain('构建带段落引用的批次正文')
  expect(skill).toContain('跑出「完成 + 约束通过」却什么也没证明')
  expect(skill).toContain('正确形状：输入 `corpusText`')
})

test('Given 场景设计 Skill When 读取流程 Then 判据要可检查、且不许为跑通而绑桩', () => {
  const skill = readSkill()

  expect(skill).toContain('判据要可检查')
  expect(skill).toContain('更准确')
  expect(skill).toContain('不要为了"让整条链跑通"去绑虚拟接入')
  /** 权限边界：Skill 不能让人以为它能代替人做采纳与导出。 */
  expect(skill).toContain('采纳、导出、删除场景由人')
})

test('Given 场景设计 Skill When 读取迭代方式 Then 写明 Agent 自己就能跑（工具名与三个轴）', () => {
  const skill = readSkill()

  /** 能自己验证才会真正迭代；否则它只是打字机。 */
  expect(skill).toContain('factory_run_step')
  expect(skill).toContain('factory_list_runs')
  expect(skill).toContain('你自己就能跑，不必等人')
  /** 试跑的边界：不改场景、不推版本、不导出。 */
  expect(skill).toContain('试跑**不改场景、不推版本、不导出**')
  /** 三轴分开读：跑完了不等于结果可信。 */
  expect(skill).toContain('"跑完了"不等于"结果可信"')
})

test('系统提示只指向 Skill，不把 Skill 的详细内容再抄一遍（避免两处漂移）', () => {
  const skill = readSkill()
  const builder = readFileSync(join(import.meta.dir, 'agent-prompt-builder.ts'), 'utf-8')

  expect(builder).toContain('capability-factory-scene-design')
  /** 反例与流程细节只允许出现在 Skill 里。 */
  expect(builder).not.toContain('构建带段落引用的批次正文')
  expect(builder).not.toContain('createEmptySceneDefinition 里的模板模型名')
  expect(skill).toContain('createEmptySceneDefinition')
})

test('Given 用户要求优化 When 按 Skill 迭代 Then 在采纳前以相同任务验证草案并区分评审失败', () => {
  const skill = readSkill()
  for (const term of ['factory_list_tasks', 'factory_run_scene', 'expectedVersion', 'expectedDraftCreatedAt', 'comparisonId', 'comparisonRole', '候选草案', '评审自身失败', '同一份输入', '退化']) expect(skill).toContain(term)
  expect(skill).toContain('不能先采纳再验证')
  expect(skill).toContain('标准变更单独处理')
})
