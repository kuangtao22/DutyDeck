/**
 * 端到端冒烟：**定义 → 版本 → 导出 → 序列化 → 解析 → 执行**。
 *
 * 这是整个模块的脊椎。它跨越三层（service / shared 的导出函数 / capability-runner 的解析与执行），
 * 任何一处断链——比如导出的包不符合自己的 spec、或 runner 解析不了导出的文本——都会在这里暴露。
 *
 * 用的是离线假模型，不出网。
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilitySceneDefinition } from '@proma/shared'
import { parseCapabilityPackage, createCapabilityRunner, type ModelRequest } from '@proma/capability-runner'
import { CapabilityFactoryStore } from './capability-factory-store'
import { CapabilityFactoryService } from './capability-factory-service'

/** 离线假模型：按步骤返回预设文本，并记录收到的请求。 */
function fakeModel(byStep: Record<string, string>) {
  const requests: ModelRequest[] = []
  return {
    requests,
    callModel: async (request: ModelRequest) => {
      requests.push(request)
      const text = byStep[request.stepId]
      if (text === undefined) throw new Error(`假模型未定义步骤 ${request.stepId}`)
      return { text }
    },
  }
}

/** 一份带抽取步骤与评审判据的真实场景定义。 */
function sceneDefinition(name: string): CapabilitySceneDefinition {
  return {
    name,
    description: '从小说章节里抽取角色表',
    inputs: [{ name: 'text', type: 'string', description: '章节正文' }],
    outputs: [{ name: 'characters', from: { stepId: 'extract' }, shape: 'structured' }],
    steps: [{
      type: 'extract',
      id: 'extract',
      title: '抽取角色',
      modelSlot: 'main',
      prompt: '从下面的章节里抽取角色：\n{{text}}',
      inputs: { text: { from: 'workflow-input', field: 'text' } },
      judgeFields: [
        { name: 'characters', type: 'array', description: '角色表', items: {
          type: 'object',
          fields: [
            { name: 'name', type: 'string', description: '角色名' },
            { name: 'aliases', type: 'array', items: { type: 'string' }, required: false },
          ],
        } },
      ],
      strictness: 'strict',
      maxAttempts: 2,
    }],
    capabilities: [],
    modelSlots: [{ id: 'main', model: 'fake-model', temperature: 0.2 }],
    acceptance: {
      criteria: ['角色名必须出自原文', '不得编造不存在的角色'],
      judgePrompt: '按判据逐条核对这份角色表，只依据原文。',
      metrics: [{ name: '召回率', weight: 0.6, direction: 'positive' }],
    },
  }
}

/** 建场景 → 存草案 → 采纳 → 导出，返回包文本与场景信息。 */
function buildAndExport() {
  const service = new CapabilityFactoryService({
    store: new CapabilityFactoryStore(mkdtempSync(join(tmpdir(), 'cap-spine-'))),
    now: () => 3000,
    createId: (() => { let n = 0; return () => `id-${(n += 1)}` })(),
  })
  const scene = service.createScene('小说角色提取')
  service.saveDraft(scene.id, sceneDefinition('小说角色提取'), 'human', '补齐抽取步骤与评审判据')
  service.adoptDraft(scene.id)
  const { package: pkg, delivery } = service.exportPackage(scene.id, {
    packageVersion: '1.0.0', fileName: 'novel-characters.json',
  })
  return { service, scene, pkg, delivery }
}

describe('脊椎：定义 → 版本 → 导出 → 序列化 → 解析 → 执行', () => {
  test('导出的包能通过自己的 spec 校验，并能序列化后再解析回来', () => {
    const { pkg, delivery } = buildAndExport()
    // 走一遍真实的传输形态：JSON 文本
    const text = JSON.stringify(pkg, null, 2)
    const reparsed = parseCapabilityPackage(text)
    expect(reparsed.name).toBe('小说角色提取')
    expect(reparsed.steps).toHaveLength(1)
    // 交付边界：评审提示词与指标不随包走，只带判据文本
    expect(reparsed.acceptance.criteria).toHaveLength(2)
    expect(text).not.toContain('judgePrompt')
    expect(text).not.toContain('召回率')
    // 包版本 ↔ 场景版本可双向查
    expect(delivery.sceneVersion).toBe(2)
  })

  test('解析回来的包可以被参考 runner 直接执行并产出声明中的输出', async () => {
    const { pkg } = buildAndExport()
    const reparsed = parseCapabilityPackage(JSON.stringify(pkg))
    const model = fakeModel({
      extract: JSON.stringify({ characters: [{ name: '林知远', aliases: ['老林'] }, { name: '周砚' }] }),
    })
    const runner = createCapabilityRunner({ callModel: model.callModel })
    const result = await runner.run(reparsed, { text: '林知远把最后一只箱子推进底舱……周砚喊了他的名字。' })

    expect(result.status).toBe('succeeded')
    expect(result.valid).toBe(true)
    expect(result.outputs?.characters).toEqual({ characters: [{ name: '林知远', aliases: ['老林'] }, { name: '周砚' }] })
    // 格式说明由 schema 自动生成并注入，提示词里不必手写
    expect(model.requests[0]?.formatInstruction).toContain('characters')
  })

  test('模型返回不合法的结构时，整次运行被判无效（约束轴）', async () => {
    const { pkg } = buildAndExport()
    const reparsed = parseCapabilityPackage(JSON.stringify(pkg))
    const model = fakeModel({ extract: JSON.stringify({ characters: [{ aliases: ['缺名字'] }] }) })
    const runner = createCapabilityRunner({ callModel: model.callModel })
    const result = await runner.run(reparsed, { text: '随便一段' })

    expect(result.status).toBe('failed')
    expect(result.valid).toBe(false)
    expect(result.steps[0]?.status).toBe('invalid')
    expect(result.steps[0]?.constraintErrors?.join()).toContain('name')
  })

  test('定义不合法的场景会被拦在导出这一步，坏包不会流到消费方', () => {
    const service = new CapabilityFactoryService({
      store: new CapabilityFactoryStore(mkdtempSync(join(tmpdir(), 'cap-spine-bad-'))),
      now: () => 4000,
      createId: (() => { let n = 0; return () => `bad-${(n += 1)}` })(),
    })
    const scene = service.createScene('坏场景')
    const broken = sceneDefinition('坏场景')
    // 模拟 Agent 传来的宽松 JSON：extract 步骤缺了 judgeFields
    const brokenSteps = [{ ...broken.steps[0], judgeFields: undefined }]
    service.saveDraft(scene.id, { ...broken, steps: brokenSteps as never }, 'agent', 'Agent 漏了判定字段')
    service.adoptDraft(scene.id)

    expect(() => service.exportPackage(scene.id, {
      packageVersion: '1.0.0', fileName: 'broken.json',
    })).toThrow(/能力包未通过 spec 校验，已阻止导出/)
  })
})
