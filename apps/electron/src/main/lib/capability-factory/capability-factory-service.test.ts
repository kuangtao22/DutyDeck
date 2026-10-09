import { describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityRun, CapabilitySceneDefinition } from '@proma/shared'
import { CapabilityFactoryStore } from './capability-factory-store'
import { CapabilityFactoryService, validateCapabilitySceneDraft } from './capability-factory-service'
import { writeJsonFileAtomic } from '../safe-file'

/** 每个用例独立的临时根目录 + 确定性时钟与 ID，避免互相污染。 */
function fixture() {
  let tick = 1000
  let seq = 0
  const rootDir = mkdtempSync(join(tmpdir(), 'cap-factory-'))
  const store = new CapabilityFactoryStore(rootDir)
  const service = new CapabilityFactoryService({
    store,
    now: () => (tick += 10),
    createId: () => `id-${(seq += 1)}`,
  })
  return { rootDir, store, service }
}

/** 在给定定义上加一条 llm 步骤，模拟一次 Agent 改动。 */
function withStep(definition: CapabilitySceneDefinition, prompt: string): CapabilitySceneDefinition {
  return {
    ...definition,
    steps: [{ type: 'llm', id: 'answer', title: '生成回答', modelSlot: 'main', prompt }],
    outputs: [{ name: 'answer', from: { stepId: 'answer' }, shape: 'text' }],
  }
}

/** 只修改描述，用于构造内容不同但结构合法的草案。 */
function withDescription(definition: CapabilitySceneDefinition, description: string): CapabilitySceneDefinition {
  return { ...definition, description }
}

describe('编排工厂服务', () => {
  test('批量读取运行只扫描一次存储，按请求顺序保留重复 ID，空请求不触盘', () => {
    const { store, service } = fixture()
    const scene = service.createScene('批读运行')
    const base: CapabilityRun = {
      id: 'run-1', sceneId: scene.id, sceneVersion: 1, status: 'succeeded', valid: true,
      input: {}, outputs: {}, steps: [], startedAt: 1, finishedAt: 2,
    }
    service.recordRun(base)
    service.recordRun({ ...base, id: 'run-2', startedAt: 3, finishedAt: 4 })
    const listRuns = spyOn(store, 'listRuns')

    expect(service.getRunsByIds(scene.id, [])).toEqual([])
    expect(listRuns).toHaveBeenCalledTimes(0)
    expect(service.getRunsByIds(scene.id, ['run-2', 'missing', 'run-1', 'run-2']).map((run) => run.id))
      .toEqual(['run-2', 'run-1', 'run-2'])
    expect(listRuns).toHaveBeenCalledTimes(1)
  })

  test('保存任务可跨服务实例读取，并按最近提交排序', () => {
    const { rootDir, service } = fixture()
    const scene = service.createScene('角色提取')
    const first = service.saveTask(scene.id, { text: '第一章' })
    const second = service.saveTask(scene.id, { text: '第二章' })

    const reopened = new CapabilityFactoryService({ store: new CapabilityFactoryStore(rootDir) })
    expect(reopened.listTasks(scene.id).map((task) => task.id)).toEqual([second.id, first.id])
    expect(reopened.listTasks(scene.id)[0]?.input).toEqual({ text: '第二章' })
  })

  test('内容相同的任务忽略对象键顺序去重，但保留文本空白和数组顺序语义', () => {
    const { service } = fixture()
    const scene = service.createScene('角色提取')
    const original = service.saveTask(scene.id, { options: { b: 2, a: 1 }, text: '正文', order: ['a', 'b'] })
    const duplicate = service.saveTask(scene.id, { order: ['a', 'b'], text: '正文', options: { a: 1, b: 2 } })
    service.saveTask(scene.id, { options: { a: 1, b: 2 }, text: ' 正文', order: ['a', 'b'] })
    service.saveTask(scene.id, { options: { a: 1, b: 2 }, text: '正文', order: ['b', 'a'] })

    expect(duplicate.id).toBe(original.id)
    expect(duplicate.createdAt).toBe(original.createdAt)
    expect(duplicate.updatedAt).toBeGreaterThan(original.updatedAt)
    expect(service.listTasks(scene.id)).toHaveLength(3)
  })

  test('任务严格按场景隔离', () => {
    const { service } = fixture()
    const first = service.createScene('场景一')
    const second = service.createScene('场景二')
    service.saveTask(first.id, { text: '第一份' })
    service.saveTask(second.id, { text: '第二份' })

    expect(service.listTasks(first.id).map((task) => task.input)).toEqual([{ text: '第一份' }])
    expect(service.listTasks(second.id).map((task) => task.input)).toEqual([{ text: '第二份' }])
  })

  test('旧版整链运行输入会只读合并成可复用任务，单步记录不会进入', () => {
    const { rootDir, service } = fixture()
    const scene = service.createScene('角色提取')
    const base: CapabilityRun = {
      id: 'full-1', sceneId: scene.id, sceneVersion: 1, kind: 'full', status: 'succeeded', valid: true,
      input: { text: '旧正文' }, outputs: {}, steps: [], startedAt: 100, finishedAt: 110,
    }
    service.recordRun(base)
    service.recordRun({ ...base, id: 'step-1', kind: 'step', input: { text: '步骤输入' }, startedAt: 200 })
    service.recordRun({ ...base, id: 'full-2', input: { text: '旧正文' }, startedAt: 300 })

    expect(service.listTasks(scene.id)).toEqual([{
      id: 'legacy-run-full-2', sceneId: scene.id, input: { text: '旧正文' }, createdAt: 100, updatedAt: 300,
    }])
    expect(existsSync(join(rootDir, 'tasks'))).toBe(false)
  })

  test('任务索引存在但 JSON 损坏时拒绝读取与覆盖', async () => {
    const { rootDir, service } = fixture()
    const scene = service.createScene('角色提取')
    const tasksDir = join(rootDir, 'tasks')
    const tasksPath = join(tasksDir, `${scene.id}.json`)
    mkdirSync(tasksDir, { recursive: true })
    await Bun.write(tasksPath, '{')

    expect(() => service.listTasks(scene.id)).toThrow(/任务索引.*损坏/)
    expect(() => service.saveTask(scene.id, { text: '不能覆盖' })).toThrow(/任务索引.*损坏/)
    expect(readFileSync(tasksPath, 'utf8')).toBe('{')
  })

  test('任务索引拒绝未知版本和跨场景条目', () => {
    const { rootDir, service } = fixture()
    const scene = service.createScene('角色提取')
    const tasksDir = join(rootDir, 'tasks')
    const tasksPath = join(tasksDir, `${scene.id}.json`)
    mkdirSync(tasksDir, { recursive: true })
    writeJsonFileAtomic(tasksPath, { schemaVersion: 99, tasks: [] })
    expect(() => service.listTasks(scene.id)).toThrow(/任务索引.*损坏/)

    writeJsonFileAtomic(tasksPath, {
      schemaVersion: 1,
      tasks: [{ id: 'task-1', sceneId: 'another-scene', input: {}, createdAt: 1, updatedAt: 1 }],
    })
    expect(() => service.listTasks(scene.id)).toThrow(/任务索引.*损坏/)
  })

  test('主任务索引损坏但备份有效时自动恢复', async () => {
    const { rootDir, service } = fixture()
    const scene = service.createScene('角色提取')
    service.saveTask(scene.id, { text: '可恢复正文' })
    service.saveTask(scene.id, { text: '可恢复正文' })
    const tasksPath = join(rootDir, 'tasks', `${scene.id}.json`)
    await Bun.write(tasksPath, '{')

    expect(service.listTasks(scene.id).map((task) => task.input)).toEqual([{ text: '可恢复正文' }])
    expect(JSON.parse(readFileSync(tasksPath, 'utf8'))).toMatchObject({ schemaVersion: 1 })
  })
  test('新建场景即建立 v1 并写入版本历史', () => {
    const { service } = fixture()
    const scene = service.createScene('账号查询')
    expect(scene.currentVersion).toBe(1)
    expect(scene.draft).toBeNull()
    expect(service.listVersions(scene.id).map((item) => item.version)).toEqual([1])
  })

  test('空名称即拒绝', () => {
    const { service } = fixture()
    expect(() => service.createScene('   ')).toThrow(/场景名称不能为空/)
  })

  test('保存草案不改当前定义，采纳后才推进版本', () => {
    const { service } = fixture()
    const scene = service.createScene('账号查询')
    const drafted = service.saveDraft(scene.id, withStep(scene.definition, '新提示词'), 'agent', 'Agent 改了提示词')

    // 关键约束：草案不影响生效定义
    expect(drafted.currentVersion).toBe(1)
    expect(drafted.definition.steps).toHaveLength(0)
    expect(drafted.draft?.source).toBe('agent')

    const { scene: adopted, version } = service.adoptDraft(scene.id)
    expect(adopted.currentVersion).toBe(2)
    expect(adopted.definition.steps).toHaveLength(1)
    expect(adopted.draft).toBeNull()
    expect(version.source).toBe('agent')
    expect(service.listVersions(scene.id).map((item) => item.version)).toEqual([1, 2])
  })

  test('Given Agent 把能力字段写进步骤 When 保存草案 Then 在写盘前指出未知字段', () => {
    const { service } = fixture()
    const scene = service.createScene('账号查询')
    const invalid = {
      ...withStep(scene.definition, '回答用户问题'),
      steps: [{
        type: 'llm', id: 'answer', title: '生成回答', modelSlot: 'main', prompt: '回答用户问题',
        name: '错误名称', outputSchema: [],
      }],
    } as unknown as CapabilitySceneDefinition

    expect(() => service.saveDraft(scene.id, invalid, 'agent', '错误字段'))
      .toThrow(/steps\[0\].*name, outputSchema/)
    expect(service.getScene(scene.id)?.draft).toBeNull()
  })

  test('Given 空白编辑中草案 When 保存或采纳 Then 只校验结构，不把完整可运行当作编辑门槛', () => {
    const { service } = fixture()
    const scene = service.createScene('账号查询')

    expect(() => validateCapabilitySceneDraft(scene.definition)).not.toThrow()
    service.saveDraft(scene.id, scene.definition, 'human', '继续编辑')

    expect(service.adoptDraft(scene.id).scene).toMatchObject({ currentVersion: 2, draft: null })
  })

  test('Agent 发起新建、重命名与回滚时，版本来源保持为 agent', () => {
    const { service } = fixture()
    const scene = service.createScene('账号查询', 'agent')
    service.renameScene(scene.id, '账号状态查询', 'agent')
    service.rollback(scene.id, 1, 'agent')

    expect(service.listVersions(scene.id).map((item) => item.source)).toEqual(['agent', 'agent', 'agent'])
  })

  test('保存时场景版本与草案快照未变化则允许更新', () => {
    const { service } = fixture()
    const scene = service.createScene('账号查询')
    const firstDefinition = withDescription(scene.definition, '打开弹窗时')
    const first = service.saveDraft(scene.id, firstDefinition, 'agent', 'Agent 初稿')
    const nextDefinition = withDescription(scene.definition, '人工调整后')

    const updated = service.saveDraft(scene.id, nextDefinition, 'human', '人工调整', {
      currentVersion: first.currentVersion,
      draft: {
        createdAt: first.draft?.createdAt as number,
        definition: firstDefinition,
      },
    })

    expect(updated.draft).toMatchObject({ definition: nextDefinition, source: 'human', note: '人工调整' })
    expect(updated.currentVersion).toBe(1)
  })

  test('Given 打开时没有草案 When Agent 先创建草案 Then 旧表单不覆盖新草案', () => {
    const { service } = fixture()
    const scene = service.createScene('账号查询')
    const agentDefinition = withDescription(scene.definition, 'Agent 新草案')
    service.saveDraft(scene.id, agentDefinition, 'agent', 'Agent 更新')

    expect(() => service.saveDraft(
      scene.id,
      withDescription(scene.definition, '旧弹窗内容'),
      'human',
      '旧弹窗保存',
      { currentVersion: scene.currentVersion, draft: null },
    )).toThrow(/不覆盖.*重新打开后比较/)
    expect(service.getScene(scene.id)?.draft?.definition).toEqual(agentDefinition)
  })

  test('Given 草案时间相同 When Agent 替换草案内容 Then 完整定义锁仍阻止覆盖', () => {
    const { store, service } = fixture()
    const scene = service.createScene('账号查询')
    const firstDefinition = withDescription(scene.definition, '弹窗打开时')
    const first = service.saveDraft(scene.id, firstDefinition, 'human', '第一份')
    const firstCreatedAt = first.draft?.createdAt as number
    const agentDefinition = withDescription(scene.definition, 'Agent 同毫秒替换')
    store.saveScenes([{
      ...first,
      draft: { definition: agentDefinition, source: 'agent', note: '同毫秒更新', createdAt: firstCreatedAt },
    }])

    expect(() => service.saveDraft(
      scene.id,
      withDescription(scene.definition, '旧弹窗保存值'),
      'human',
      '旧弹窗保存',
      { currentVersion: 1, draft: { createdAt: firstCreatedAt, definition: firstDefinition } },
    )).toThrow(/不覆盖.*重新打开后比较/)
    expect(service.getScene(scene.id)?.draft?.definition).toEqual(agentDefinition)
  })

  test('Given 弹窗打开后版本推进 When 保存旧表单 Then 不写入草案', () => {
    const { service } = fixture()
    const scene = service.createScene('账号查询')
    service.saveDraft(scene.id, withDescription(scene.definition, '待采纳'), 'agent', 'Agent 草案')
    service.adoptDraft(scene.id)

    expect(() => service.saveDraft(
      scene.id,
      withDescription(scene.definition, '基于 v1 的旧修改'),
      'human',
      '旧弹窗保存',
      { currentVersion: 1, draft: null },
    )).toThrow(/不覆盖.*重新打开后比较/)
    expect(service.getScene(scene.id)).toMatchObject({ currentVersion: 2, draft: null })
  })

  test('放弃草案只删除与用户所见一致的快照，旧调用仍保持兼容', () => {
    const { store, service } = fixture()
    const scene = service.createScene('账号查询')
    const firstDefinition = withDescription(scene.definition, '用户看到的草案')
    const first = service.saveDraft(scene.id, firstDefinition, 'agent', '第一份')
    const firstCreatedAt = first.draft?.createdAt as number
    const replacement = withDescription(scene.definition, 'Agent 同毫秒替换')
    store.saveScenes([{
      ...first,
      draft: { definition: replacement, source: 'agent', note: '新草案', createdAt: firstCreatedAt },
    }])

    expect(() => service.discardDraft(scene.id, {
      currentVersion: first.currentVersion,
      draft: { createdAt: firstCreatedAt, definition: firstDefinition },
    })).toThrow(/不覆盖.*重新打开后比较/)
    expect(service.getScene(scene.id)?.draft?.definition).toEqual(replacement)

    expect(service.discardDraft(scene.id).draft).toBeNull()
  })

  test('快照未变化时允许放弃草案', () => {
    const { service } = fixture()
    const scene = service.createScene('账号查询')
    const definition = withDescription(scene.definition, '待放弃')
    const drafted = service.saveDraft(scene.id, definition, 'human', '临时修改')

    const discarded = service.discardDraft(scene.id, {
      currentVersion: drafted.currentVersion,
      draft: { createdAt: drafted.draft?.createdAt as number, definition },
    })

    expect(discarded.draft).toBeNull()
  })

  test('没有草案时采纳即拒绝', () => {
    const { service } = fixture()
    const scene = service.createScene('账号查询')
    expect(() => service.adoptDraft(scene.id)).toThrow(/没有待采纳的草案/)
  })

  test('Given 用户看过候选对比 When 采纳前草案被覆盖 Then 原子拒绝旧快照且不推进版本', () => {
    const { service } = fixture()
    const scene = service.createScene('账号查询')
    const firstDefinition = withDescription(scene.definition, '第一份草案')
    const first = service.saveDraft(scene.id, firstDefinition, 'agent', '第一份')
    service.saveDraft(scene.id, withDescription(scene.definition, '第二份草案'), 'agent', '第二份')

    expect(() => service.adoptDraft(scene.id, {
      expectedVersion: 1,
      expectedDraftCreatedAt: first.draft?.createdAt,
      expectedDraftDefinition: firstDefinition,
    })).toThrow(/草案已变化/)
    expect(service.getScene(scene.id)?.currentVersion).toBe(1)
    expect(service.getScene(scene.id)?.definition.description).toBe('')
  })

  test('回滚把旧快照提升为新版本，且不删除历史', () => {
    const { service } = fixture()
    const scene = service.createScene('账号查询')
    service.saveDraft(scene.id, withStep(scene.definition, 'v2 的提示词'), 'human', '第一次改')
    service.adoptDraft(scene.id)

    const { scene: rolled, version } = service.rollback(scene.id, 1)
    // 版本号只增不减：回滚到 v1 的内容，但版本号是 v3
    expect(rolled.currentVersion).toBe(3)
    expect(rolled.definition.steps).toHaveLength(0)
    expect(version.note).toBe('回滚到 v1')
    expect(service.listVersions(scene.id).map((item) => item.version)).toEqual([1, 2, 3])
  })

  test('导出能力包只带判据文本，不带评审提示词与数据集', () => {
    const { service } = fixture()
    const scene = service.createScene('账号查询')
    const definition = withStep(scene.definition, '回答用户问题')
    service.saveDraft(scene.id, {
      ...definition,
      stepAcceptances: { answer: {
        criteria: ['必须给出状态', '不得编造到期时间'],
        judgePrompt: '按判据逐条核对这条输出……',
        metrics: [{ name: '任务完成率', weight: 0.4, direction: 'positive' }],
      } },
    }, 'human', '补评审判据')
    service.adoptDraft(scene.id)

    const { package: pkg, delivery } = service.exportPackage(scene.id, {
      packageVersion: '1.0.0', fileName: 'account.json',
    })

    expect(pkg.acceptance.criteria).toHaveLength(2)
    // 交付边界：评审提示词与指标权重不出现在包里
    expect(JSON.stringify(pkg)).not.toContain('judgePrompt')
    expect(JSON.stringify(pkg)).not.toContain('任务完成率')
    expect(JSON.stringify(pkg)).not.toContain('judgePrompt')
    // 包版本与场景版本能双向查到
    expect(delivery.sceneVersion).toBe(2)
    expect(delivery.packageVersion).toBe('1.0.0')
    expect(service.listDeliveries()).toHaveLength(1)
  })

  test('存储根目录可迁移：新实例读同一目录能拿到既有场景', () => {
    const { rootDir, service } = fixture()
    const scene = service.createScene('账号查询')
    const reopened = new CapabilityFactoryService({ store: new CapabilityFactoryStore(rootDir) })
    expect(reopened.getScene(scene.id)?.definition.name).toBe('账号查询')
  })

  test('重命名产生新版本（否则同一个版本号会对应两个名字）', () => {
    const { service } = fixture()
    const scene = service.createScene('账号查询')
    const renamed = service.renameScene(scene.id, '账号状态查询')
    expect(renamed.version?.version).toBe(2)
    expect(renamed.version?.note).toBe('重命名：账号查询 → 账号状态查询')
    expect(service.getScene(scene.id)?.definition.name).toBe('账号状态查询')
    expect(service.listVersions(scene.id).map((item) => item.version)).toEqual([1, 2])
  })

  test('重命名成同名或空名：同名不产生版本，空名拒绝', () => {
    const { service } = fixture()
    const scene = service.createScene('账号查询')
    expect(service.renameScene(scene.id, '账号查询').version).toBeNull()
    expect(service.listVersions(scene.id)).toHaveLength(1)
    expect(() => service.renameScene(scene.id, '   ')).toThrow(/场景名称不能为空/)
  })

  test('删除场景从索引移除，但保留版本历史（唯一恢复依据）', () => {
    const { service } = fixture()
    const scene = service.createScene('账号查询')
    service.renameScene(scene.id, '账号状态查询')
    expect(service.deleteScene(scene.id).deleted).toBe(true)
    expect(service.getScene(scene.id)).toBeNull()
    expect(service.listScenes()).toHaveLength(0)
    // 历史仍在：删除是可恢复的
    expect(service.listVersions(scene.id).map((item) => item.version)).toEqual([1, 2])
  })

  test('删除不存在的场景即拒绝', () => {
    const { service } = fixture()
    expect(() => service.deleteScene('missing')).toThrow(/场景不存在/)
  })

  test('导出：能力包真的落盘，并记下"有没有在真实数据上验证过"', () => {
    const { service } = fixture()
    const scene = service.createScene('账号查询')
    /** 空场景导不出（spec 要求步骤非空、判据非空），先给一份最小可导出的定义。 */
    service.saveDraft(scene.id, {
      ...scene.definition,
      steps: [{
        id: 'ask', title: '回答问题', type: 'llm', modelSlot: 'main',
        prompt: '回答 {{text}}',
      }],
      stepAcceptances: { ask: { criteria: ['回答必须只依据输入'], judgePrompt: '', metrics: [] } },
    }, 'human', '最小可导出定义')
    service.adoptDraft(scene.id)
    const versioned = service.getScene(scene.id)?.currentVersion ?? 1

    /** 没跑过：可以导出（包的内容是完整的），但记录必须是未验证。 */
    const first = service.exportPackage(scene.id, { packageVersion: '1.0.0', fileName: 'account-v1.json' })
    expect(first.delivery.verified).toBe(false)
    expect(first.delivery.unverifiedReason).toContain('还没有跑过一次整链运行')
    expect(first.delivery.filePath).toContain('deliveries/account-v1.json')
    /** 交付物必须能被拿走：文件真的写下来了。 */
    expect(existsSync(first.delivery.filePath as string)).toBe(true)
    expect(JSON.parse(readFileSync(first.delivery.filePath as string, 'utf-8')).kind)
      .toBe('proma-ai-capability-package')

    /** 在当前版本上真实运行且内容评审明确通过后，再导出才是已验证。 */
    service.recordRun({
      id: 'run-1', sceneId: scene.id, sceneVersion: versioned, kind: 'full',
      status: 'succeeded', valid: true, input: {}, outputs: null, steps: [],
      review: {
        status: 'succeeded', passed: true, summary: '回答只依据输入',
        acceptance: { criteria: ['回答必须只依据输入'], judgePrompt: '', metrics: [] },
        criteria: [{ criterion: '回答必须只依据输入', passed: true, evidence: '输出可追溯到输入' }],
        metrics: [], suggestions: [], startedAt: 5, finishedAt: 9,
      },
      startedAt: 0, finishedAt: 10,
    })
    const second = service.exportPackage(scene.id, { packageVersion: '1.0.0', fileName: 'account-v2.json' })
    expect(second.delivery.verified).toBe(true)
    expect(second.delivery.unverifiedReason).toBeUndefined()
  })

  test('导出文件名必须是一个普通文件名：目录成分与怪字符一律拒绝（它要变成磁盘路径）', () => {
    const { service } = fixture()
    const scene = service.createScene('账号查询')

    expect(() => service.exportPackage(scene.id, { packageVersion: '1.0.0', fileName: '../../evil.json' }))
      .toThrow(/导出文件名不合法/)
    expect(() => service.exportPackage(scene.id, { packageVersion: '1.0.0', fileName: 'a/b.json' }))
      .toThrow(/导出文件名不合法/)
    expect(() => service.exportPackage(scene.id, { packageVersion: '1.0.0', fileName: '.hidden' }))
      .toThrow(/导出文件名不合法/)
  })
})
