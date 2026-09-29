import { describe, expect, test } from 'bun:test'
import {
  extractServerOpsScriptParameterNames,
  inferServerOpsScriptRisk,
  inferServerOpsScriptUsageSignals,
  parseServerOpsScript,
  parseServerOpsScriptParameter,
  parseServerOpsScriptSaveInput,
  renderServerOpsScriptBody,
} from './server-ops-script'
import type { ServerOpsScript } from './server-ops-script'

/** 构造一条最小合法 SSH 脚本，供各用例按需覆盖字段。 */
function createSshScript(overrides: Partial<ServerOpsScript> = {}): ServerOpsScript {
  return {
    id: 'script-1', projectId: 'project-1', name: '磁盘检查', kind: 'ssh-command',
    usage: 'one-off', risk: 'read-only', hostId: 'host-1', body: 'df -h', parameters: [],
    origin: 'user', enabled: true, createdAt: 1, updatedAt: 1, ...overrides,
  }
}

describe('运维脚本落盘投影', () => {
  test('Given 合法 SSH 与 SQL 脚本 When 解析 Then 原样通过', () => {
    expect(parseServerOpsScript(createSshScript()).body).toBe('df -h')
    const sql = createSshScript({
      kind: 'sql', usage: 'reusable', risk: 'mutating', hostId: undefined,
      sourceId: 'source-1', database: 'chebenben', preconditions: '仅限低峰期执行',
    })
    expect(parseServerOpsScript(sql).sourceId).toBe('source-1')
  })

  test('Given 单次脚本却带参数、或 SSH 脚本夹带数据源字段 When 解析 Then 拒绝', () => {
    expect(() => parseServerOpsScript(createSshScript({
      parameters: [{ name: 'days', label: '天数', type: 'number', required: true, sensitive: false }],
    }))).toThrow()
    expect(() => parseServerOpsScript(createSshScript({ sourceId: 'source-1', database: 'db' }))).toThrow()
  })

  test('Given 出现未知字段 When 解析 Then 拒绝', () => {
    expect(() => parseServerOpsScript({ ...createSshScript(), credentialRef: 'x' } as unknown)).toThrow()
  })
})

describe('运维脚本保存合同', () => {
  /** 通用脚本的基础输入；各用例只覆盖要验证的字段。 */
  const base = {
    projectId: 'project-1', name: '清理过期订单', kind: 'sql' as const, usage: 'reusable' as const,
    risk: 'mutating' as const, sourceId: 'source-1', database: 'chebenben',
    body: 'DELETE FROM orders WHERE created_at < {{before}}', enabled: true,
    parameters: [{ name: 'before', label: '截止日期', type: 'date' as const, required: true, sensitive: false }],
    preconditions: '已确认备份可用', expectedImpact: '预计影响 0-1000 行', rollbackPlan: '从备份恢复',
  }

  test('Given 通用变更脚本信息齐全 When 解析 Then 通过', () => {
    expect(parseServerOpsScriptSaveInput(base).parameters).toHaveLength(1)
  })

  test('Given 通用脚本缺前置条件 When 解析 Then 拒绝', () => {
    expect(() => parseServerOpsScriptSaveInput({ ...base, preconditions: '  ' })).toThrow('SERVER_OPS_SCRIPT_PRECONDITION_REQUIRED')
  })

  test('Given 通用变更脚本缺影响或回滚说明 When 解析 Then 拒绝', () => {
    expect(() => parseServerOpsScriptSaveInput({ ...base, expectedImpact: '' })).toThrow('SERVER_OPS_SCRIPT_IMPACT_REQUIRED')
    expect(() => parseServerOpsScriptSaveInput({ ...base, rollbackPlan: undefined })).toThrow('SERVER_OPS_SCRIPT_IMPACT_REQUIRED')
  })

  test('Given 单次脚本带参数 When 解析 Then 拒绝', () => {
    expect(() => parseServerOpsScriptSaveInput({ ...base, usage: 'one-off' })).toThrow()
  })

  test('Given 保存输入夹带来源或运行身份 When 解析 Then 拒绝', () => {
    expect(() => parseServerOpsScriptSaveInput({ ...base, origin: 'agent' })).toThrow()
    expect(() => parseServerOpsScriptSaveInput({ ...base, sessionId: 'session-1' })).toThrow()
  })
})

describe('参数占位符抽取', () => {
  test('Given 重复占位符与空白 When 抽取 Then 去重并保持出现顺序', () => {
    expect(extractServerOpsScriptParameterNames('a {{ one }} b {{two}} c {{one}}')).toEqual(['one', 'two'])
  })

  test('Given 空占位符、嵌套花括号或非法名称 When 抽取 Then 拒绝', () => {
    for (const body of ['{{}}', '{{{a}}}', '{{a b}}', '{{1abc}}', '{{a']) {
      expect(() => extractServerOpsScriptParameterNames(body)).toThrow()
    }
  })
})

describe('参数渲染', () => {
  test('Given shell 文本参数含单引号 When 渲染 Then 用 POSIX 转义而不是裸拼接', () => {
    const script = { kind: 'ssh-command' as const, body: 'echo {{msg}}', parameters: [
      { name: 'msg', label: '消息', type: 'text' as const, required: true, sensitive: false },
    ] }
    expect(renderServerOpsScriptBody(script, [{ name: 'msg', value: "a'; rm -rf /; echo '" }]).text)
      .toBe("echo 'a'\\''; rm -rf /; echo '\\'''")
  })

  test('Given SQL 文本参数含单引号 When 渲染 Then 用双写转义而不是裸拼接', () => {
    const script = { kind: 'sql' as const, body: "SELECT * FROM t WHERE n = {{n}}", parameters: [
      { name: 'n', label: '名称', type: 'text' as const, required: true, sensitive: false },
    ] }
    expect(renderServerOpsScriptBody(script, [{ name: 'n', value: "x' OR '1'='1" }]).text)
      .toBe("SELECT * FROM t WHERE n = 'x'' OR ''1''=''1'")
  })

  test('Given 标识符与数字参数 When 渲染 Then 只接受白名单形态', () => {
    const script = { kind: 'sql' as const, body: 'ALTER TABLE {{table}} ADD COLUMN n INT; DELETE FROM t LIMIT {{n}}', parameters: [
      { name: 'table', label: '表名', type: 'identifier' as const, required: true, sensitive: false },
      { name: 'n', label: '条数', type: 'number' as const, required: true, sensitive: false },
    ] }
    expect(renderServerOpsScriptBody(script, [{ name: 'table', value: 'orders' }, { name: 'n', value: '10' }]).text)
      .toContain('ALTER TABLE orders')
    expect(() => renderServerOpsScriptBody(script, [{ name: 'table', value: 'orders; DROP TABLE x' }, { name: 'n', value: '10' }])).toThrow()
    expect(() => renderServerOpsScriptBody(script, [{ name: 'table', value: 'orders' }, { name: 'n', value: '10 OR 1=1' }])).toThrow()
  })

  test('Given 未声明占位符、声明未使用或缺失必填 When 渲染 Then 整脚本拒绝', () => {
    expect(() => renderServerOpsScriptBody(
      { kind: 'ssh-command', body: 'echo {{ghost}}', parameters: [] }, [],
    )).toThrow('SERVER_OPS_SCRIPT_PLACEHOLDER_UNKNOWN')
    expect(() => renderServerOpsScriptBody(
      { kind: 'ssh-command', body: 'echo ok', parameters: [{ name: 'unused', label: '未用', type: 'text', required: false, sensitive: false }] }, [],
    )).toThrow('SERVER_OPS_SCRIPT_PARAMETER_UNUSED')
    expect(() => renderServerOpsScriptBody(
      { kind: 'ssh-command', body: 'echo {{a}}', parameters: [{ name: 'a', label: 'A', type: 'text', required: true, sensitive: false }] }, [],
    )).toThrow('SERVER_OPS_SCRIPT_PARAMETER_REQUIRED')
  })

  test('Given 可选参数未填 When 渲染 Then 用默认值并回传原始取值', () => {
    const script = { kind: 'sql' as const, body: "SELECT {{a}} {{b}}", parameters: [
      { name: 'a', label: 'A', type: 'text' as const, required: false, sensitive: false, default: 'x' },
      { name: 'b', label: 'B', type: 'text' as const, required: false, sensitive: false, default: '' },
    ] }
    const rendered = renderServerOpsScriptBody(script, [])
    /** 显式声明了空默认值才渲染成空字符串字面量，未声明的可选参数在解析阶段就被拒。 */
    expect(rendered.text).toBe("SELECT 'x' ''")
    expect(rendered.values).toEqual([{ name: 'a', value: 'x' }, { name: 'b', value: '' }])
  })

  test('Given 手工构造的可选参数没有默认值 When 渲染 Then 拒绝而不是静默渲染空串', () => {
    expect(() => renderServerOpsScriptBody(
      { kind: 'sql', body: 'SELECT {{a}}', parameters: [{ name: 'a', label: 'A', type: 'text', required: false, sensitive: false }] }, [],
    )).toThrow('SERVER_OPS_SCRIPT_PARAMETER_REQUIRED')
  })

  test('Given 可选参数没有默认值或默认值不符类型 When 解析定义 Then 拒绝', () => {
    const base = { name: 'a', label: 'A', type: 'number' as const, sensitive: false }
    expect(() => parseServerOpsScriptParameter({ ...base, required: false })).toThrow('SERVER_OPS_SCRIPT_PARAMETER_DEFAULT_REQUIRED')
    expect(() => parseServerOpsScriptParameter({ ...base, required: false, default: 'abc' })).toThrow('SERVER_OPS_SCRIPT_PARAMETER_DEFAULT_INVALID')
    expect(parseServerOpsScriptParameter({ ...base, required: false, default: '10' }).default).toBe('10')
  })
})

describe('单次与通用信号', () => {
  test('Given 写死记录标识 When 推断 Then 建议单次并列出强信号', () => {
    const result = inferServerOpsScriptUsageSignals('sql', 'UPDATE orders SET s=1 WHERE id = 1002003')
    expect(result.suggestedUsage).toBe('one-off')
    expect(result.strongSignals.length).toBeGreaterThan(0)
  })

  test('Given 已参数化且无单次痕迹 When 推断 Then 建议通用且无强信号', () => {
    const result = inferServerOpsScriptUsageSignals('sql', 'UPDATE orders SET s=1 WHERE created_at < {{before}}')
    expect(result.suggestedUsage).toBe('reusable')
    expect(result.strongSignals).toEqual([])
  })

  test('Given 天生不需要参数的复用脚本 When 推断 Then 不得因为「没有占位符」就建议单次', () => {
    const result = inferServerOpsScriptUsageSignals('ssh-command', 'systemctl restart nginx')
    expect(result.suggestedUsage).toBe('reusable')
    /** 仍然提示「复用时要手改」，但它只是弱信号。 */
    expect(result.weakSignals.length).toBeGreaterThan(0)
    expect(result.strongSignals).toEqual([])
  })

  test('Given 范围条件里的大数字 When 推断 Then 不再误报为写死记录标识', () => {
    const result = inferServerOpsScriptUsageSignals('sql', 'SELECT * FROM orders WHERE amount > 10000')
    expect(result.strongSignals).toEqual([])
  })

  test('Given SQL 无 WHERE 的 UPDATE When 推断 Then 提示影响范围不可预估', () => {
    expect(inferServerOpsScriptUsageSignals('sql', 'UPDATE orders SET s=1').strongSignals)
      .toContain('UPDATE/DELETE 没有 WHERE 条件，影响范围无法预估')
  })
})

describe('变更风险推断', () => {
  test('Given 不同类别正文 When 推断 Then 只作为默认值给出保守结论', () => {
    expect(inferServerOpsScriptRisk('sql', 'SELECT 1')).toBe('read-only')
    expect(inferServerOpsScriptRisk('sql', 'DROP TABLE x')).toBe('mutating')
    expect(inferServerOpsScriptRisk('ssh-command', 'uname -a')).toBe('read-only')
    expect(inferServerOpsScriptRisk('ssh-command', 'rm -rf /tmp/x')).toBe('mutating')
  })
})
