import { describe, expect, test } from 'bun:test'
import { parseCapabilityFactoryCommand } from './capability-factory-ipc'
import { createEmptySceneDefinition } from './capability-factory'

/** 校验一条命令能通过解析并保留字段。 */
function parse(value: unknown) {
  return parseCapabilityFactoryCommand(value)
}

describe('编排工厂 IPC 命令解析', () => {
  test('Given 局部采纳范围 When 解析 Then 保留精确块身份并拒绝无效范围及整份批次证据', () => {
    const input = { sessionId: 's1', sceneId: 'scene' }
    for (const scope of [{ kind: 'all' }, { kind: 'step', stepId: 'a' }, { kind: 'stepAcceptance', stepId: 'a' }]) {
      expect(parse({ method: 'adoptDraft', input: { ...input, scope } })).toMatchObject({ input: { scope } })
    }
    for (const scope of [null, {}, { kind: 'step' }, { kind: 'step', stepId: '' }, { kind: 'all', stepId: 'a' }, { kind: 'unknown' }]) {
      expect(() => parse({ method: 'adoptDraft', input: { ...input, scope } })).toThrow('CAPABILITY_FACTORY_INVALID')
    }
    expect(() => parse({ method: 'adoptDraft', input: { ...input, scope: { kind: 'step', stepId: 'a' }, testedBatchId: 'batch' } }))
      .toThrow('局部采纳不能使用整份草案的测试证据')
  })
  test('Given 大数据集 When 选择有限用例 Then 保留 caseIds 并拒绝空集、重复或不带数据集的选择', () => {
    const input = { sessionId: 's1', sceneId: 'scene', kind: 'evaluation', datasetId: 'dataset', caseIds: ['case-2'] }
    expect(parse({ method: 'runBatch', input })).toMatchObject({ input: { caseIds: ['case-2'] } })
    for (const caseIds of [[], ['same', 'same'], Array.from({ length: 11 }, (_, index) => `case-${index}`)]) {
      expect(() => parse({ method: 'runBatch', input: { ...input, caseIds } })).toThrow('CAPABILITY_FACTORY_INVALID')
    }
    expect(() => parse({ method: 'runBatch', input: { ...input, kind: 'comparison', datasetId: undefined, taskIds: ['task'] } })).toThrow('CAPABILITY_FACTORY_INVALID')
  })
  test('Given 持久批次 When 解析运行读取取消 Then 只接受受控输入与十条任务', () => {
    expect(parse({ method: 'runBatch', input: { sessionId: 's1', sceneId: 'scene', kind: 'comparison', taskIds: ['task-1'], expectedVersion: 2 } }))
      .toMatchObject({ method: 'runBatch', input: { kind: 'comparison', taskIds: ['task-1'] } })
    expect(parse({ method: 'getBatch', input: { sessionId: 's1', sceneId: 'scene', batchId: 'batch' } }).method).toBe('getBatch')
    expect(parse({ method: 'cancelBatch', input: { sessionId: 's1', sceneId: 'scene', batchId: 'batch' } }).method).toBe('cancelBatch')
    expect(parse({ method: 'listBatches', input: { sessionId: 's1', sceneId: 'scene' } }).method).toBe('listBatches')
    for (const extra of [{ scopeId: 'forged' }, { taskIds: Array.from({ length: 11 }, (_, index) => `task-${index}`) }, { kind: 'arbitrary' }]) {
      expect(() => parse({ method: 'runBatch', input: { sessionId: 's1', sceneId: 'scene', kind: 'comparison', taskIds: ['one'], ...extra } })).toThrow('CAPABILITY_FACTORY_INVALID')
    }
    expect(parse({ method: 'adoptDraft', input: { sessionId: 's1', sceneId: 'scene', testedBatchId: 'batch' } }))
      .toMatchObject({ input: { testedBatchId: 'batch' } })
  })
  test('Given 步骤标准 When 保存草案或提交临时定义 Then 保留合法结构并拒绝缺失字段', () => {
    const definition = { ...createEmptySceneDefinition('测试'), stepAcceptances: {
      scan: { criteria: ['有证据'], judgePrompt: '只评扫描', metrics: [] },
    } }
    expect(parse({ method: 'saveDraft', input: { sessionId: 's1', sceneId: 'a', note: '标准', definition } }))
      .toMatchObject({ input: { definition } })
    expect(parse({ method: 'runStep', input: { sessionId: 's1', sceneId: 'a', stepId: 'scan', input: {}, definition } }))
      .toMatchObject({ input: { definition } })
    for (const invalid of [{}, { criteria: '无效', judgePrompt: '', metrics: [] }, { criteria: [], judgePrompt: 1, metrics: [] }]) {
      expect(() => parse({ method: 'saveDraft', input: { sessionId: 's1', sceneId: 'a', note: '标准', definition: {
        ...definition, stepAcceptances: { scan: invalid },
      } } })).toThrow('definition.stepAcceptances.scan')
    }
  })
  test('只读命令只接受 sessionId', () => {
    expect(parse({ method: 'listScenes', input: { sessionId: 's1' } }))
      .toEqual({ method: 'listScenes', input: { sessionId: 's1' } })
  })

  test('未知方法即拒绝', () => {
    expect(() => parse({ method: 'dropDatabase', input: { sessionId: 's1' } }))
      .toThrow(/CAPABILITY_FACTORY_INVALID: method/)
  })

  test('未知字段即拒绝 —— 不让新语义悄悄进主进程', () => {
    expect(() => parse({ method: 'listScenes', input: { sessionId: 's1', workspaceId: 'w1' } }))
      .toThrow(/unknown:workspaceId/)
  })

  test('输入里不允许自行声明 workspace（避免越权到别的工作区）', () => {
    // 只有 sessionId 是合法字段，workspace 一律由主进程按会话反查
    expect(() => parse({ method: 'getScene', input: { sessionId: 's1', sceneId: 'a', workspaceId: 'w2' } }))
      .toThrow(/CAPABILITY_FACTORY_INVALID/)
  })

  test('保存草案接受宽松定义（允许编辑到一半），但名称与数组字段必须合法', () => {
    const definition = {
      name: '账号查询', description: '', inputs: [], outputs: [], steps: [],
      capabilities: [], modelSlots: [], acceptance: { criteria: [], judgePrompt: '', metrics: [] },
    }
    expect(parse({ method: 'saveDraft', input: { sessionId: 's1', sceneId: 'a', definition, note: '改' } }))
      .toMatchObject({ method: 'saveDraft' })

    expect(() => parse({ method: 'saveDraft', input: {
      sessionId: 's1', sceneId: 'a', note: '改', definition: { ...definition, steps: 'not-an-array' },
    } })).toThrow(/definition\.steps/)
  })

  test('保存草案可携带完整旧状态，并严格拒绝非法乐观锁结构', () => {
    const definition = createEmptySceneDefinition('账号查询')
    const expectedState = {
      currentVersion: 3,
      draft: { createdAt: 1234, definition: { ...definition, description: '打开弹窗时的草案' } },
    }
    expect(parse({
      method: 'saveDraft',
      input: { sessionId: 's1', sceneId: 'a', definition, note: '人工修改', expectedState },
    })).toMatchObject({ input: { expectedState } })
    expect(parse({
      method: 'saveDraft',
      input: { sessionId: 's1', sceneId: 'a', definition, note: '兼容旧调用' },
    })).not.toHaveProperty('input.expectedState')

    for (const invalidExpectedState of [
      { currentVersion: 0, draft: null },
      { currentVersion: 1.5, draft: null },
      { currentVersion: 1, draft: { createdAt: -1, definition } },
      { currentVersion: 1, draft: { createdAt: 1, definition, source: 'agent' } },
      { currentVersion: 1, draft: null, unknown: true },
    ]) {
      expect(() => parse({
        method: 'saveDraft',
        input: { sessionId: 's1', sceneId: 'a', definition, note: '非法锁', expectedState: invalidExpectedState },
      })).toThrow(/CAPABILITY_FACTORY_INVALID/)
    }
  })

  test('放弃草案复用同一旧状态契约，并兼容未带锁的旧调用', () => {
    const definition = createEmptySceneDefinition('账号查询')
    const expectedState = { currentVersion: 2, draft: { createdAt: 1234, definition } }
    expect(parse({ method: 'discardDraft', input: { sessionId: 's1', sceneId: 'a', expectedState } }))
      .toEqual({ method: 'discardDraft', input: { sessionId: 's1', sceneId: 'a', expectedState } })
    expect(parse({ method: 'discardDraft', input: { sessionId: 's1', sceneId: 'a' } }))
      .toEqual({ method: 'discardDraft', input: { sessionId: 's1', sceneId: 'a' } })
    expect(() => parse({
      method: 'discardDraft',
      input: { sessionId: 's1', sceneId: 'a', expectedState: { currentVersion: 2, draft: { createdAt: 1, definition, extra: true } } },
    })).toThrow(/CAPABILITY_FACTORY_INVALID/)
  })

  test('回滚的版本号必须是正整数', () => {
    expect(() => parse({ method: 'rollback', input: { sessionId: 's1', sceneId: 'a', targetVersion: 0 } }))
      .toThrow(/targetVersion/)
    expect(() => parse({ method: 'rollback', input: { sessionId: 's1', sceneId: 'a', targetVersion: 1.5 } }))
      .toThrow(/targetVersion/)
  })

  test('导出命令要求包版本与文件名非空', () => {
    expect(() => parse({ method: 'exportPackage', input: {
      sessionId: 's1', sceneId: 'a', packageVersion: '', fileName: 'x.json',
    } })).toThrow(/packageVersion/)
  })

  test('界面侧保留采纳 / 回滚 / 导出入口，与 Agent 共用业务服务', () => {
    const methods = ['adoptDraft', 'rollback', 'exportPackage'] as const
    for (const method of methods) {
      const input = method === 'rollback'
        ? { sessionId: 's1', sceneId: 'a', targetVersion: 1 }
        : method === 'exportPackage'
          ? { sessionId: 's1', sceneId: 'a', packageVersion: '1.0.0', fileName: 'x.json' }
          : { sessionId: 's1', sceneId: 'a' }
      expect(parse({ method, input }).method).toBe(method)
    }
  })

  test('优化对比后采纳可携带版本、草案时间与定义快照三重锁', () => {
    const expectedDraftDefinition = {
      name: '账号查询', description: '', inputs: [], outputs: [], steps: [], capabilities: [], modelSlots: [],
      acceptance: { criteria: [], judgePrompt: '', metrics: [] },
    }
    const parsed = parse({
      method: 'adoptDraft',
      input: {
        sessionId: 's1', sceneId: 'a', expectedVersion: 3, expectedDraftCreatedAt: 1234,
        expectedDraftDefinition,
      },
    })

    expect(parsed.input).toMatchObject({ expectedVersion: 3, expectedDraftCreatedAt: 1234, expectedDraftDefinition })
  })

  test('运行与虚拟接入的命令都要带会话，且桩必须有 payload', () => {
    expect(parse({ method: 'listStubs', input: { sessionId: 's1' } }).method).toBe('listStubs')
    expect(parse({ method: 'setStub', input: { sessionId: 's1', capabilityId: 'corpus.build', payload: { a: 1 }, source: 'human' } }).method).toBe('setStub')
    expect(parse({ method: 'deleteStub', input: { sessionId: 's1', capabilityId: 'corpus.build' } }).method).toBe('deleteStub')
    expect(parse({ method: 'runScene', input: { sessionId: 's1', sceneId: 'a', input: { text: '正文' } } }).method).toBe('runScene')
    expect(parse({ method: 'listRuns', input: { sessionId: 's1', sceneId: 'a', limit: 5 } }).method).toBe('listRuns')
    expect(parse({ method: 'listTasks', input: { sessionId: 's1', sceneId: 'a' } }))
      .toEqual({ method: 'listTasks', input: { sessionId: 's1', sceneId: 'a' } })

    /** payload 缺失会让"绑了桩但桩是 undefined"这种状态从 IPC 里溜进来。 */
    expect(() => parse({ method: 'setStub', input: { sessionId: 's1', capabilityId: 'corpus.build', source: 'human' } })).toThrow(/payload/)
  })

  test('任务列表命令严格拒绝多余字段', () => {
    expect(() => parse({ method: 'listTasks', input: { sessionId: 's1', sceneId: 'a', limit: 20 } }))
      .toThrow(/unknown:limit/)
  })

  test('Given 运行请求需要进度 When 携带 requestId Then 保留有界请求标识', () => {
    const full = parse({
      method: 'runScene',
      input: { sessionId: 's1', sceneId: 'a', input: { text: '正文' }, requestId: 'run-request-1' },
    })
    const step = parse({
      method: 'runStep',
      input: { sessionId: 's1', sceneId: 'a', stepId: 'scan', input: {}, requestId: 'step-request-1' },
    })

    expect(full.input).toMatchObject({ requestId: 'run-request-1' })
    expect(step.input).toMatchObject({ requestId: 'step-request-1' })
    expect(() => parse({
      method: 'runScene', input: { sessionId: 's1', sceneId: 'a', input: {}, requestId: '' },
    })).toThrow(/requestId/)
  })

  test('Given 优化对比运行 When 选择草案 Then 保留基线版本、草案快照标识与配对身份', () => {
    const parsed = parse({
      method: 'runScene',
      input: {
        sessionId: 's1', sceneId: 'a', input: { text: '正文' },
        target: 'draft', expectedVersion: 3, expectedDraftCreatedAt: 1234,
        expectedDraftDefinition: {
          name: '候选', description: '', inputs: [], outputs: [], steps: [], capabilities: [], modelSlots: [],
          acceptance: { criteria: [], judgePrompt: '', metrics: [] },
        },
        comparisonId: 'compare-1', comparisonRole: 'candidate',
      },
    })

    expect(parsed.input).toMatchObject({
      target: 'draft', expectedVersion: 3, expectedDraftCreatedAt: 1234,
      comparisonId: 'compare-1', comparisonRole: 'candidate',
    })
    expect(() => parse({
      method: 'runScene',
      input: { sessionId: 's1', sceneId: 'a', input: {}, target: 'draft', expectedVersion: 3 },
    })).toThrow(/expectedDraftCreatedAt/)
    expect(() => parse({
      method: 'runScene',
      input: {
        sessionId: 's1', sceneId: 'a', input: {}, target: 'current', expectedVersion: 3,
        comparisonId: 'compare-1', comparisonRole: 'candidate',
      },
    })).toThrow(/comparisonRole/)
  })

  test('桩的能力 id 与 JSON 值都要校验：非法 id 与非 JSON 值进不来', () => {
    expect(() => parse({ method: 'setStub', input: { sessionId: 's1', capabilityId: '坏 id', payload: {}, source: 'human' } }))
      .toThrow(/capabilityId/)
    expect(() => parse({ method: 'setStub', input: { sessionId: 's1', capabilityId: 'corpus.build', payload: { n: Number.NaN }, source: 'human' } }))
      .toThrow(/payload/)
    expect(() => parse({ method: 'setStub', input: { sessionId: 's1', capabilityId: 'corpus.build', payload: { fn: () => undefined }, source: 'human' } }))
      .toThrow(/payload/)
  })

  test('桩的来源由界面盖章：只认 placeholder / human，界面不能替 Agent 盖章', () => {
    expect(parse({ method: 'setStub', input: { sessionId: 's1', capabilityId: 'a.b', payload: {}, source: 'placeholder' } }).method).toBe('setStub')
    expect(() => parse({ method: 'setStub', input: { sessionId: 's1', capabilityId: 'a.b', payload: {}, source: 'agent' } }))
      .toThrow(/source/)
    expect(() => parse({ method: 'setStub', input: { sessionId: 's1', capabilityId: 'a.b', payload: {} } }))
      .toThrow(/source/)
  })

  test('运行输入必须是对象，且拒绝超大字符串（整本书该走文件而不是 IPC）', () => {
    expect(() => parse({ method: 'runScene', input: { sessionId: 's1', sceneId: 'a', input: [] } }))
      .toThrow(/input\.input/)
    expect(() => parse({ method: 'runScene', input: {
      sessionId: 's1', sceneId: 'a', input: { text: 'x'.repeat(1_000_001) },
    } })).toThrow(/input\.input\.text/)
  })

  test('提交历史条数上限在 1..100 之间', () => {
    expect(() => parse({ method: 'listRuns', input: { sessionId: 's1', sceneId: 'a', limit: 0 } })).toThrow(/limit/)
    expect(() => parse({ method: 'listRuns', input: { sessionId: 's1', sceneId: 'a', limit: 101 } })).toThrow(/limit/)
  })

  test('单步试跑命令：必须带步骤 id，可带一份未落盘的临时定义', () => {
    const parsed = parse({
      method: 'runStep',
      input: { sessionId: 's1', sceneId: 'a', stepId: 'scan', input: { corpus: '正文' } },
    })
    expect(parsed.method).toBe('runStep')
    expect(parsed.input).not.toHaveProperty('definition')

    /** 临时定义与 saveDraft 用同一套浅校验：能带进来，但坏结构仍会被拦。 */
    const temporaryDefinition = {
      name: '小说角色提取', description: '', inputs: [], outputs: [], steps: [],
      capabilities: [], modelSlots: [], acceptance: { criteria: [], judgePrompt: '', metrics: [] },
    }
    const withDefinition = parse({
      method: 'runStep',
      input: {
        sessionId: 's1', sceneId: 'a', stepId: 'scan', input: {},
        definition: { ...temporaryDefinition, steps: [] },
      },
    })
    expect(withDefinition.method).toBe('runStep')
    expect(() => parse({
      method: 'runStep',
      input: { sessionId: 's1', sceneId: 'a', stepId: '', input: {} },
    })).toThrow(/stepId/)
  })

  test('提交历史可以按运行范围过滤：full（整链）/ step（单步试跑）', () => {
    expect(parse({ method: 'listRuns', input: { sessionId: 's1', sceneId: 'a', kind: 'step' } }).method).toBe('listRuns')
    expect(parse({ method: 'listRuns', input: { sessionId: 's1', sceneId: 'a', kind: 'full' } }).method).toBe('listRuns')
    expect(() => parse({ method: 'listRuns', input: { sessionId: 's1', sceneId: 'a', kind: 'whatever' } }))
      .toThrow(/kind/)
  })
})
