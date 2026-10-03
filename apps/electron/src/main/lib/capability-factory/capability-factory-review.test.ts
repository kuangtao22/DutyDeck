import { describe, expect, test } from 'bun:test'
import type { CapabilityRun, CapabilityRunModelBinding, SceneAcceptance } from '@proma/shared'
import { reviewCapabilityRun } from './capability-factory-review'

/** 合成标准：必须有证据，指标缺少标注时允许无法判断。 */
const acceptance: SceneAcceptance = {
  criteria: ['名字来自正文'], judgePrompt: '按正文逐字核对，缺少标注时不估算准确率。',
  metrics: [{ name: '编造率', weight: 1, direction: 'negative' }],
}
/** 合成执行结果，保证评审拿到原输入与输出。 */
const run: CapabilityRun = {
  id: 'r', sceneId: 's', sceneVersion: 2, kind: 'full', status: 'succeeded', valid: true,
  input: { text: '小林走进书店。' }, outputs: { characters: ['小林', '阿明'] }, steps: [],
  startedAt: 1, finishedAt: 2,
}
/** 评审复用已解析渠道，无需用户再次绑定。 */
const binding: CapabilityRunModelBinding = {
  slotId: 'main', declaredModel: 'test', channelId: 'c', channelName: '合成渠道', modelId: 'test', substituted: false,
}
/** 模型返回完整质量报告，解析层必须独立复核而非盲信总体 passed。 */
const verdict = {
  passed: false, summary: '阿明在正文中没有证据',
  criteria: [{ criterion: '名字来自正文', passed: false, evidence: '正文只有小林，输出包含阿明。' }],
  metrics: [{ name: '编造率', value: 0.5, evidence: '两个候选中一个没有正文证据：1/2。' }],
  suggestions: ['明确要求仅提取原文出现的角色名。'],
}

describe('单次自动内容评审', () => {
  test('Given 有规则输入输出 When 评审 Then 模型收到完整材料并返回问题证据', async () => {
    const review = await reviewCapabilityRun({ run, acceptance, binding, callModel: async (request) => {
      expect(request.prompt).toContain('小林走进书店。')
      expect(request.prompt).toContain('阿明')
      expect(request.prompt).toContain(acceptance.judgePrompt)
      expect(request.prompt).toContain('同一组 evidence')
      expect(request.prompt).toContain('忠实概括')
      expect(request.channelId).toBe('c')
      return { text: JSON.stringify(verdict), model: 'test' }
    } })
    expect(review.status).toBe('succeeded')
    expect(review.passed).toBe(false)
    expect(review.criteria[0]?.evidence).toContain('阿明')
    expect(review.acceptance).toEqual(acceptance)
  })

  test('Given 总体报通过但有判据未通过 When 解析 Then 不能达标', async () => {
    const review = await reviewCapabilityRun({ run, acceptance, binding,
      callModel: async () => ({ text: JSON.stringify({ ...verdict, passed: true }), model: 'test' }),
    })
    expect(review.passed).toBe(false)
  })

  test('Given 模型给判据加编号或轻微改写 When 按声明顺序返回 Then 保留冻结标准并继续展示证据', async () => {
    const review = await reviewCapabilityRun({ run, acceptance,
      callModel: async () => ({ text: JSON.stringify({ ...verdict,
        criteria: [{ ...verdict.criteria[0], criterion: '1. 名字必须来自正文（逐字核对）' }],
        metrics: [{ ...verdict.metrics[0], name: '编造率（按输出项计算）' }],
      }), model: 'test' }),
      binding,
    })
    expect(review.status).toBe('succeeded')
    expect(review.criteria[0]?.criterion).toBe(acceptance.criteria[0])
    expect(review.metrics[0]?.name).toBe(acceptance.metrics[0]?.name)
    expect(review.criteria[0]?.evidence).toContain('阿明')
  })

  test('Given 模型在 JSON 前后附带说明 When 评审 Then 仍解析完整报告并保留证据', async () => {
    const review = await reviewCapabilityRun({ run, acceptance, binding,
      callModel: async () => ({
        text: `下面是本轮评审结果：\n${JSON.stringify(verdict)}\n以上为评审结论。`,
        model: 'test',
      }),
    })
    expect(review.status).toBe('succeeded')
    expect(review.criteria[0]?.evidence).toContain('阿明')
    expect(review.suggestions).toContain('明确要求仅提取原文出现的角色名。')
  })

  test('Given 指标缺乏依据 When 评审返回 null Then 不用零补齐也不能达标', async () => {
    const review = await reviewCapabilityRun({ run, acceptance, binding,
      callModel: async () => ({ text: JSON.stringify({ ...verdict, passed: true,
        criteria: [{ criterion: '名字来自正文', passed: true, evidence: '逐字核对通过' }],
        metrics: [{ name: '编造率', value: null, evidence: '没有足够标注' }],
      }), model: 'test' }),
    })
    expect(review.status).toBe('succeeded')
    expect(review.passed).toBeNull()
    expect(review.metrics[0]?.value).toBeNull()
  })

  test.each([
    { ...verdict, criteria: [] },
    { ...verdict, criteria: [{ criterion: '', passed: false, evidence: '无' }] },
    { ...verdict, passed: 'true' },
    { ...verdict, criteria: [{ criterion: '名字来自正文', passed: false, evidence: '' }] },
  ])('Given 评审结果缺项或结构错误 When 解析 Then 标为评测失败', async (payload) => {
    const review = await reviewCapabilityRun({ run, acceptance, binding,
      callModel: async () => ({ text: JSON.stringify(payload), model: 'test' }),
    })
    expect(review.status).toBe('failed')
    expect(review.passed).toBeNull()
  })

  test('Given 顶层返回 JSON 数组 When 解析 Then 不从嵌套对象猜测评审报告', async () => {
    const review = await reviewCapabilityRun({ run, acceptance, binding,
      callModel: async () => ({ text: JSON.stringify([verdict]), model: 'test' }),
    })
    expect(review.status).toBe('failed')
    expect(review.passed).toBeNull()
  })

  test('Given 模型调用异常 When 评审 Then 记录评测失败而不抛弃原运行', async () => {
    const review = await reviewCapabilityRun({ run, acceptance, binding,
      callModel: async () => { throw new Error('评审服务不可用') },
    })
    expect(review.error).toContain('评审服务不可用')
    expect(review.passed).toBeNull()
    expect(run.outputs).toEqual({ characters: ['小林', '阿明'] })
  })

  test('Given 评审端口不响应 When 到达时限 Then 取消请求且保留失败报告', async () => {
    /** 捕获真正传到模型端口的 signal，验证超时不只是界面提示。 */
    let signal: AbortSignal | undefined
    const review = await reviewCapabilityRun({ run, acceptance, binding, timeoutMs: 5,
      callModel: (request) => {
        signal = request.signal
        return new Promise(() => undefined)
      },
    })
    expect(review.status).toBe('failed')
    expect(review.error).toContain('超时')
    expect(signal?.aborted).toBe(true)
  })
})
