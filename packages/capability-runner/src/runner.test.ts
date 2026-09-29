import { describe, expect, test } from 'bun:test'
import { parseCapabilityPackageValue } from './parse'
import { createCapabilityRunner, type ModelRequest } from './runner'
import type { CapabilityPackage } from './spec'

/** 按步骤返回预设文本的假模型；同时记录收到的请求，便于断言注入内容。 */
function fakeModel(byStep: Record<string, string | ((request: ModelRequest) => string)>) {
  const requests: ModelRequest[] = []
  return {
    requests,
    callModel: async (request: ModelRequest) => {
      requests.push(request)
      const entry = byStep[request.stepId]
      if (entry === undefined) throw new Error(`假模型未定义步骤 ${request.stepId}`)
      return { text: typeof entry === 'function' ? entry(request) : entry }
    },
  }
}

/** 抽取类步骤的判定字段。 */
const judgeFields = [
  { name: 'accountId', type: 'string' as const, description: '账号标识' },
  { name: 'fields', type: 'array' as const, items: { type: 'string' as const } },
]

describe('参考 runner', () => {
  test('Given 模型调用失败 When 配置格式重试 Then 记录 failed 且不重复调用', async () => {
    const pkg = parseCapabilityPackageValue({
      kind: 'proma-ai-capability-package', specVersion: 1, packageVersion: '1.0.0',
      name: 'transport-error', exportedAt: 1, inputs: [],
      outputs: [{ name: 'answer', from: { stepId: 'scan' }, shape: 'structured' }],
      steps: [{ type: 'extract', id: 'scan', title: '提取', modelSlot: 'main', prompt: '测试', judgeFields, maxAttempts: 2 }],
      capabilities: [], modelSlots: [{ id: 'main', model: 'fake' }], acceptance: { criteria: ['字段完整'] },
    })
    /** 网络层已负责瞬时重试，格式重试不能再次发送同一失败请求。 */
    let calls = 0
    const runner = createCapabilityRunner({ callModel: async () => {
      calls += 1
      throw new Error('模型未返回正文')
    } })
    const result = await runner.run(pkg, {})
    expect(calls).toBe(1)
    expect(result.steps[0]?.status).toBe('failed')
    expect(result.steps[0]?.error).toBe('模型未返回正文')
    expect(result.steps[0]?.constraintErrors).toBeUndefined()
  })

  test('线性流程：llm → extract → 输出映射', async () => {
    const pkg = parseCapabilityPackageValue({
      kind: 'proma-ai-capability-package', specVersion: 1, packageVersion: '1.0.0',
      name: 'linear', exportedAt: 1,
      inputs: [{ name: 'text', type: 'string' }],
      outputs: [{ name: 'answer', from: { stepId: 'params', path: 'accountId' }, shape: 'text' }],
      steps: [
        { type: 'llm', id: 'intent', title: '解析意图', modelSlot: 'main', prompt: '判断：{{text}}' },
        { type: 'extract', id: 'params', title: '抽取参数', modelSlot: 'main', prompt: '抽取：{{prev}}',
          inputs: { prev: { from: 'step-output', stepId: 'intent' } }, judgeFields },
      ],
      capabilities: [], modelSlots: [{ id: 'main', model: 'fake' }],
      acceptance: { criteria: ['字段齐全'] },
    })
    const model = fakeModel({
      intent: '要查账号',
      params: '{"accountId":"a-1","fields":["status"]}',
    })
    const runner = createCapabilityRunner({ callModel: model.callModel })
    const result = await runner.run(pkg, { text: '查一下 a-1' })

    expect(result.status).toBe('succeeded')
    expect(result.valid).toBe(true)
    expect(result.outputs).toEqual({ answer: 'a-1' })
    // extract 步骤由 runner 自动注入格式说明，提示词里不必手写
    expect(model.requests[1]?.formatInstruction).toContain('accountId')
  })

  test('步骤进度按真实执行顺序回传开始与完成事件', async () => {
    const pkg = parseCapabilityPackageValue({
      kind: 'proma-ai-capability-package', specVersion: 1, packageVersion: '1.0.0',
      name: 'progress', exportedAt: 1, inputs: [], outputs: [],
      steps: [
        { type: 'llm', id: 'first', title: '第一步', modelSlot: 'main', prompt: '1' },
        { type: 'llm', id: 'second', title: '第二步', modelSlot: 'main', prompt: '2' },
      ],
      capabilities: [], modelSlots: [{ id: 'main', model: 'fake' }], acceptance: { criteria: ['c'] },
    })
    const events: string[] = []
    const runner = createCapabilityRunner({
      callModel: fakeModel({ first: 'a', second: 'b' }).callModel,
      onStepProgress: (event) => { events.push(`${event.phase}:${event.step.id}:${event.traces.length}`) },
    })

    await runner.run(pkg, {})

    expect(events).toEqual(['started:first:0', 'completed:first:1', 'started:second:1', 'completed:second:2'])
  })

  test('输入不满足契约时直接拒绝，不调用模型', async () => {
    const pkg = parseCapabilityPackageValue({
      kind: 'proma-ai-capability-package', specVersion: 1, packageVersion: '1.0.0',
      name: 'guard', exportedAt: 1,
      inputs: [{ name: 'text', type: 'string' }],
      outputs: [{ name: 'answer', from: { stepId: 'a' }, shape: 'text' }],
      steps: [{ type: 'llm', id: 'a', title: 'A', modelSlot: 'main', prompt: 'x' }],
      capabilities: [], modelSlots: [{ id: 'main', model: 'fake' }],
      acceptance: { criteria: ['c'] },
    })
    const model = fakeModel({ a: 'should not be called' })
    const runner = createCapabilityRunner({ callModel: model.callModel })
    const result = await runner.run(pkg, {})

    expect(result.status).toBe('failed')
    expect(result.inputErrors).toEqual(['text: 缺少必填输入'])
    expect(result.steps).toHaveLength(0)
    expect(model.requests).toHaveLength(0)
  })

  test('strict 抽取耗尽重试后判 invalid，整条链不继续', async () => {
    const pkg = parseCapabilityPackageValue({
      kind: 'proma-ai-capability-package', specVersion: 1, packageVersion: '1.0.0',
      name: 'strict', exportedAt: 1,
      inputs: [{ name: 'text', type: 'string' }],
      outputs: [{ name: 'answer', from: { stepId: 'after' }, shape: 'text' }],
      steps: [
        { type: 'extract', id: 'params', title: '抽取', modelSlot: 'main', prompt: 'x',
          judgeFields, maxAttempts: 2 },
        { type: 'llm', id: 'after', title: '后续', modelSlot: 'main', prompt: 'y' },
      ],
      capabilities: [], modelSlots: [{ id: 'main', model: 'fake' }],
      acceptance: { criteria: ['c'] },
    })
    const model = fakeModel({ params: '{"accountId":"a-1"}' }) // 缺 fields
    const runner = createCapabilityRunner({ callModel: model.callModel })
    const result = await runner.run(pkg, { text: 'x' })

    expect(result.status).toBe('failed')
    expect(result.valid).toBe(false)
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]?.status).toBe('invalid')
    expect(result.steps[0]?.attempts).toBe(2)
    expect(result.steps[0]?.constraintErrors?.join()).toContain('fields')
  })

  test('lenient 抽取不合法也继续，但整次运行标记 valid=false', async () => {
    const pkg = parseCapabilityPackageValue({
      kind: 'proma-ai-capability-package', specVersion: 1, packageVersion: '1.0.0',
      name: 'lenient', exportedAt: 1,
      inputs: [{ name: 'text', type: 'string' }],
      outputs: [{ name: 'answer', from: { stepId: 'after' }, shape: 'text' }],
      steps: [
        { type: 'extract', id: 'params', title: '抽取', modelSlot: 'main', prompt: 'x',
          judgeFields, strictness: 'lenient' },
        { type: 'llm', id: 'after', title: '后续', modelSlot: 'main', prompt: '收到 {{prev}}',
          inputs: { prev: { from: 'step-output', stepId: 'params' } } },
      ],
      capabilities: [], modelSlots: [{ id: 'main', model: 'fake' }],
      acceptance: { criteria: ['c'] },
    })
    const model = fakeModel({ params: '不是 JSON', after: '继续了' })
    const runner = createCapabilityRunner({ callModel: model.callModel })
    const result = await runner.run(pkg, { text: 'x' })

    expect(result.status).toBe('succeeded')
    expect(result.valid).toBe(false)
    expect(result.outputs).toEqual({ answer: '继续了' })
  })

  test('未绑定的能力导致该步骤失败，不静默跳过', async () => {
    const pkg = parseCapabilityPackageValue({
      kind: 'proma-ai-capability-package', specVersion: 1, packageVersion: '1.0.0',
      name: 'tool', exportedAt: 1,
      inputs: [{ name: 'text', type: 'string' }],
      outputs: [{ name: 'answer', from: { stepId: 'q' }, shape: 'text' }],
      steps: [{ type: 'tool', id: 'q', title: '查询', capabilityId: 'query', bindings: {} }],
      capabilities: [{ id: 'query', description: '查账号', inputSchema: [], outputSchema: [], sideEffect: 'read' }],
      modelSlots: [{ id: 'main', model: 'fake' }],
      acceptance: { criteria: ['c'] },
    })
    const runner = createCapabilityRunner({ callModel: fakeModel({}).callModel })
    const result = await runner.run(pkg, { text: 'x' })
    expect(result.status).toBe('failed')
    expect(result.steps[0]?.error).toContain('未绑定实现')
  })

  test('并行组 continue：部分失败记为 partial，且扇入带失败项、顺序与输入一致', async () => {
    const pkg = parseCapabilityPackageValue({
      kind: 'proma-ai-capability-package', specVersion: 1, packageVersion: '1.0.0',
      name: 'map-continue', exportedAt: 1,
      inputs: [{ name: 'accounts', type: 'array', items: { type: 'string' } }],
      outputs: [{ name: 'results', from: { stepId: 'each' }, shape: 'structured' }],
      steps: [{
        type: 'map', id: 'each', title: '逐个查询',
        over: { from: 'workflow-input', field: 'accounts' }, concurrency: 2,
        body: [{ type: 'tool', id: 'lookup', title: '查询', capabilityId: 'query',
          bindings: { id: { from: 'workflow-input', field: 'item' } } }],
      }],
      capabilities: [{ id: 'query', description: '查账号', inputSchema: [], outputSchema: [], sideEffect: 'read' }],
      modelSlots: [{ id: 'main', model: 'fake' }],
      acceptance: { criteria: ['c'] },
    })
    const runner = createCapabilityRunner({
      callModel: fakeModel({}).callModel,
      capabilities: {
        query: { call: (input) => {
          if (input.id === 'bad') throw new Error('超时')
          return { id: input.id, status: 'active' }
        } },
      },
    })
    const result = await runner.run(pkg, { accounts: ['a', 'bad', 'c'] })

    expect(result.status).toBe('partial')
    const results = result.outputs?.results as { index: number; ok: boolean }[]
    expect(results).toHaveLength(3)
    expect(results.map((item) => item.ok)).toEqual([true, false, true])
    expect(results.map((item) => item.index)).toEqual([0, 1, 2])
  })

  test('并行组 fail-fast：任一项失败即整组失败', async () => {
    const pkg = parseCapabilityPackageValue({
      kind: 'proma-ai-capability-package', specVersion: 1, packageVersion: '1.0.0',
      name: 'map-failfast', exportedAt: 1,
      inputs: [{ name: 'accounts', type: 'array', items: { type: 'string' } }],
      outputs: [{ name: 'results', from: { stepId: 'each' }, shape: 'structured' }],
      steps: [{
        type: 'map', id: 'each', title: '逐个查询', failurePolicy: 'fail-fast',
        over: { from: 'workflow-input', field: 'accounts' },
        body: [{ type: 'tool', id: 'lookup', title: '查询', capabilityId: 'query',
          bindings: { id: { from: 'workflow-input', field: 'item' } } }],
      }],
      capabilities: [{ id: 'query', description: '查账号', inputSchema: [], outputSchema: [], sideEffect: 'read' }],
      modelSlots: [{ id: 'main', model: 'fake' }],
      acceptance: { criteria: ['c'] },
    })
    const runner = createCapabilityRunner({
      callModel: fakeModel({}).callModel,
      capabilities: { query: { call: (input) => {
        if (input.id === 'bad') throw new Error('超时')
        return { id: input.id }
      } } },
    })
    const result = await runner.run(pkg, { accounts: ['a', 'bad', 'c'] })
    expect(result.status).toBe('failed')
    expect(result.outputs).toBeNull()
  })

  test('抽取第一次不合法、第二次合法时按 attempts 记录重试', async () => {
    let calls = 0
    const pkg = parseCapabilityPackageValue({
      kind: 'proma-ai-capability-package', specVersion: 1, packageVersion: '1.0.0',
      name: 'retry', exportedAt: 1,
      inputs: [{ name: 'text', type: 'string' }],
      outputs: [{ name: 'a', from: { stepId: 's' }, shape: 'text' }],
      steps: [{ type: 'extract', id: 's', title: '抽取', modelSlot: 'main', prompt: 'x',
        judgeFields: [{ name: 'id', type: 'string' }], maxAttempts: 3 }],
      capabilities: [], modelSlots: [{ id: 'main', model: 'fake' }],
      acceptance: { criteria: ['c'] },
    })
    const runner = createCapabilityRunner({ callModel: async () => {
      calls += 1
      return { text: calls === 1 ? '抱歉' : '{"id":"ok"}' }
    } })
    const result = await runner.run(pkg, { text: 'x' })
    expect(result.steps[0]?.status).toBe('succeeded')
    expect(result.steps[0]?.attempts).toBe(2)
  })
})

describe('单步试跑（提示词训练的主回路）', () => {
  /** 一个两步包：第一步读外部能力，第二步才是有提示词的抽取。 */
  const pkg: CapabilityPackage = {
    kind: 'proma-ai-capability-package',
    specVersion: 1,
    packageVersion: 'test',
    name: '单步人物抽取',
    exportedAt: 0,
    inputs: [{ name: 'bookId', type: 'number' }],
    outputs: [{ name: 'characters', from: { stepId: 'scan' }, shape: 'structured' }],
    steps: [
      {
        id: 'build', title: '构建批次正文', type: 'tool', capabilityId: 'corpus.build',
        bindings: { text: { from: 'workflow-input', field: 'bookId' } },
      },
      {
        id: 'scan', title: '扫描人物候选', type: 'extract', modelSlot: 'main',
        prompt: '从 {{corpus}} 里找出人物候选（正文长度 {{corpusText}}）',
        inputs: { corpus: { from: 'step-output', stepId: 'build' } },
        judgeFields: [{ name: 'characters', type: 'array' }],
      },
    ],
    capabilities: [{
      id: 'corpus.build', description: '构建语料正文', inputSchema: [], outputSchema: [], sideEffect: 'read',
    }],
    modelSlots: [{ id: 'main', model: 'm' }],
    acceptance: { criteria: ['必须有引用'] },
  }

  test('Given 上游没跑过 When 单跑第二步 Then 直接用调用方给的输入渲染提示词', async () => {
    /** 关键：没有绑定 corpus.build，也没有跑过第一步 —— 单步试跑完全不需要它们。 */
    const seen: string[] = []
    const runner = createCapabilityRunner({
      callModel: async (request) => { seen.push(request.prompt); return { text: '{"characters":[]}' } },
    })

    const outcome = await runner.runSingleStep(pkg, 'scan', { corpus: '第 1 段：阿明抬头。' })

    if ('error' in outcome) throw new Error(outcome.error)
    expect(outcome.valid).toBe(true)
    expect(seen[0]).toContain('第 1 段：阿明抬头。')
    /** 模板里另一个变量没给值，渲染成空 —— 如实反映"这次只喂了一个槽"。 */
    expect(seen[0]).toContain('正文长度 ')
    expect(outcome.step.status).toBe('succeeded')
    expect(outcome.step.parsedOutput).toEqual({ characters: [] })
  })

  test('Given 约束不通过 When 单跑 Then valid=false 且带上约束原因（训练要看的就是这个）', async () => {
    const runner = createCapabilityRunner({
      callModel: async () => ({ text: '{"characters":"不是数组"}' }),
    })

    const outcome = await runner.runSingleStep(pkg, 'scan', { corpus: '正文' })

    if ('error' in outcome) throw new Error(outcome.error)
    expect(outcome.valid).toBe(false)
    expect(outcome.step.status).toBe('invalid')
    expect(outcome.step.constraintErrors?.length ?? 0).toBeGreaterThan(0)
  })

  test('Given tool 步骤或并行组或不存在 When 单跑 Then 明确拒绝，不假装能跑', async () => {
    const runner = createCapabilityRunner({ callModel: async () => ({ text: '{}' }) })

    expect(await runner.runSingleStep(pkg, 'build', {})).toEqual({
      error: '这一步没有提示词（tool 步骤由接入方实现），单步试跑只针对提示词步骤',
    })
    expect(await runner.runSingleStep(pkg, 'nope', {})).toEqual({ error: '步骤不存在或不在顶层：nope' })
  })
})
