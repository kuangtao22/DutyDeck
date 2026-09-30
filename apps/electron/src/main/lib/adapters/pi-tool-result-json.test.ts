import { describe, expect, test } from 'bun:test'
import { normalizePiToolResultDetails, serializePiToolResultPayload } from './pi-tool-result-json'

describe('Pi 工具结果 JSON 边界', () => {
  test('Given 正常业务结果 When 序列化 Then 正文与 details 保持同一份结构化证据', () => {
    const result = serializePiToolResultPayload({ ok: true, rows: [{ id: 1, tags: ['new'] }], nullable: null })

    expect(JSON.parse(result.text)).toEqual(result.details)
    expect(result.details).toEqual({ ok: true, rows: [{ id: 1, tags: ['new'] }], nullable: null })
  })

  test('Given 可安全转换的运行时值 When 归一化 Then 遵循 JSON 语义并保留诊断证据', () => {
    const failure = Object.assign(new Error('remote failed'), { code: 'E_REMOTE', optional: undefined })
    const result = serializePiToolResultPayload({
      id: 7n,
      missing: undefined,
      invalid: Number.NaN,
      createdAt: new Date(0),
      values: [undefined, Number.POSITIVE_INFINITY],
      failure,
    })

    expect(result.details).toEqual({
      id: '7',
      invalid: null,
      createdAt: '1970-01-01T00:00:00.000Z',
      values: [null, null],
      failure: { name: 'Error', message: 'remote failed', code: 'E_REMOTE' },
    })
    expect(() => JSON.parse(result.text)).not.toThrow()
  })

  test('Given 带访问器的外部结果 When 归一化 Then 不执行 getter 并明确拒绝丢证据', () => {
    let getterCalls = 0
    const value = Object.defineProperty({ stable: 'evidence' }, 'secret', {
      enumerable: true,
      get() {
        getterCalls += 1
        return 'should-not-run'
      },
    })

    expect(() => normalizePiToolResultDetails(value)).toThrow('PI_TOOL_RESULT_JSON_NORMALIZATION_FAILED: 不支持访问器属性: secret')
    expect(getterCalls).toBe(0)
  })

  test('Given 稀疏数组与索引访问器 When 归一化 Then 稀疏项转 null 且不执行 getter', () => {
    /** 同时包含稀疏项、普通数据项和危险访问器的输入数组。 */
    const values = new Array<unknown>(4)
    values[1] = 'stable'
    values[3] = undefined
    /** 用于证明归一化过程没有读取访问器。 */
    let getterCalls = 0
    Object.defineProperty(values, '2', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1
        return 'should-not-run'
      },
    })

    expect(() => normalizePiToolResultDetails(values))
      .toThrow('PI_TOOL_RESULT_JSON_NORMALIZATION_FAILED: 不支持访问器属性: 2')
    expect(getterCalls).toBe(0)

    /** 不含访问器的稀疏数组用于固定 JSON 的 null 语义。 */
    const sparse = new Array<unknown>(3)
    sparse[1] = 'stable'
    expect(normalizePiToolResultDetails(sparse)).toEqual([null, 'stable', null])
  })

  test('Given Error 的自有或原型 name/message 是访问器 When 归一化 Then 明确拒绝且 getter 零执行', () => {
    /** 自有 message getter 的执行计数。 */
    let ownGetterCalls = 0
    /** 覆盖 Error 构造器写入的自有 message 数据属性。 */
    const ownAccessorError = new Error('safe')
    Object.defineProperty(ownAccessorError, 'message', {
      configurable: true,
      get() {
        ownGetterCalls += 1
        return 'should-not-run'
      },
    })

    expect(() => normalizePiToolResultDetails(ownAccessorError))
      .toThrow('PI_TOOL_RESULT_JSON_NORMALIZATION_FAILED: 不支持访问器属性: message')
    expect(ownGetterCalls).toBe(0)

    /** 原型 name getter 的执行计数。 */
    let prototypeGetterCalls = 0
    /** 用原型访问器覆盖 Error.prototype.name 的查找路径。 */
    class AccessorNameError extends Error {}
    Object.defineProperty(AccessorNameError.prototype, 'name', {
      configurable: true,
      get() {
        prototypeGetterCalls += 1
        return 'should-not-run'
      },
    })

    expect(() => normalizePiToolResultDetails(new AccessorNameError('safe')))
      .toThrow('PI_TOOL_RESULT_JSON_NORMALIZATION_FAILED: 不支持访问器属性: name')
    expect(prototypeGetterCalls).toBe(0)
  })

  test('Given 循环引用或未知类实例 When 归一化 Then 以可诊断错误拒绝静默成功', () => {
    const circular: Record<string, unknown> = { id: 'cycle' }
    circular.self = circular

    expect(() => normalizePiToolResultDetails(circular)).toThrow('PI_TOOL_RESULT_JSON_NORMALIZATION_FAILED: 检测到循环引用')
    expect(() => normalizePiToolResultDetails(new Uint8Array([1, 2, 3])))
      .toThrow('PI_TOOL_RESULT_JSON_NORMALIZATION_FAILED: 不支持的对象类型: Uint8Array')
  })

  test('Given 兄弟字段共享同一对象 When 归一化 Then 不误判为循环引用', () => {
    const shared = { state: 'ready' }

    expect(normalizePiToolResultDetails({ first: shared, second: shared })).toEqual({
      first: { state: 'ready' },
      second: { state: 'ready' },
    })
  })

  test('Given Proxy 在读取结构时抛错 When 归一化 Then 返回可诊断边界错误', () => {
    const value = new Proxy({}, {
      getPrototypeOf() {
        throw new Error('proxy denied')
      },
    })

    expect(() => normalizePiToolResultDetails(value)).toThrow('PI_TOOL_RESULT_JSON_NORMALIZATION_FAILED: proxy denied')
  })

  test('Given __proto__ 业务键 When 归一化 Then 保留字段且不会修改结果原型', () => {
    const value: unknown = JSON.parse('{"__proto__":{"polluted":true},"safe":1}')
    const details = normalizePiToolResultDetails(value)

    expect(Object.getPrototypeOf(details)).toBeNull()
    const parsed: unknown = JSON.parse(JSON.stringify(details))
    expect(parsed !== null && typeof parsed === 'object' && Object.hasOwn(parsed, '__proto__')).toBeTrue()
    expect(JSON.stringify(parsed)).toBe('{"__proto__":{"polluted":true},"safe":1}')
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })
})
