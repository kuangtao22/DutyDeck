import { describe, expect, test } from 'bun:test'
import {
  analyzeServerOpsSqlQuery, getServerOpsSqlStatementHead, planServerOpsSqlWrite, splitServerOpsSqlStatements,
} from './server-ops-sql-parser'

describe('写脚本语句切分', () => {
  test('Given 多条语句与各种分号写法 When 切分 Then 逐条返回且忽略空片段', () => {
    const sql = 'UPDATE a SET x = 1; INSERT INTO b VALUES (2);; SELECT 3'
    expect(splitServerOpsSqlStatements(sql, 'mysql')).toEqual([
      'UPDATE a SET x = 1', 'INSERT INTO b VALUES (2)', 'SELECT 3',
    ])
  })

  test('Given 分号出现在字符串字面量里 When 切分 Then 不当作语句边界', () => {
    expect(splitServerOpsSqlStatements("UPDATE a SET x = 'a;b'; SELECT 2", 'mysql'))
      .toEqual(["UPDATE a SET x = 'a;b'", 'SELECT 2'])
  })

  test('Given 行注释与块注释 When 切分 Then 保留原文且注释里的分号不切分', () => {
    const sql = '-- 说明; 不是边界\nUPDATE a SET x = 1; /* 块注释; 同样不是 */ SELECT 2'
    const statements = splitServerOpsSqlStatements(sql, 'mysql')
    expect(statements).toHaveLength(2)
    /** 从原文切片，注释与格式原样保留，确认界面与实际执行一致。 */
    expect(statements[0]).toContain('-- 说明; 不是边界')
    expect(statements[1]).toContain('/* 块注释; 同样不是 */')
  })

  test('Given 行注释吃掉行尾分号 When 切分 Then 按服务端语义不切分', () => {
    /** `;` 落在注释内，语句并未结束，切分结果必须与服务端一致。 */
    expect(splitServerOpsSqlStatements('UPDATE a SET x = 1 -- 尾注释; 仍在注释内', 'mysql'))
      .toHaveLength(1)
  })

  test('Given MySQL 双减号后不是空白 When 切分 Then 不把它误当成注释', () => {
    expect(splitServerOpsSqlStatements('UPDATE t SET n = n--1; DELETE FROM t WHERE id = 2', 'mysql'))
      .toEqual(['UPDATE t SET n = n--1', 'DELETE FROM t WHERE id = 2'])
  })

  test('Given MySQL 可执行块注释 When 生成计划 Then 拒绝而不是跳过其中代码', () => {
    expect(() => planServerOpsSqlWrite('/*!50000 DROP TABLE t */; UPDATE t SET n = 1', 'mysql')).toThrow()
    expect(() => planServerOpsSqlWrite('/*M!100100 DROP TABLE t */; UPDATE t SET n = 1', 'mysql')).toThrow()
  })

  test('Given $$ 引用体、位置参数或 DELIMITER When 切分 Then 整脚本拒绝而不是猜边界', () => {
    for (const sql of [
      'CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;',
      'SELECT $1;',
      'DELIMITER //\nSELECT 1//',
    ]) {
      expect(() => splitServerOpsSqlStatements(sql, 'postgresql')).toThrow()
    }
  })

  test('Given 未闭合的块注释或字符串 When 切分 Then 拒绝', () => {
    expect(() => splitServerOpsSqlStatements('SELECT 1 /* 未闭合', 'mysql')).toThrow()
    expect(() => splitServerOpsSqlStatements("SELECT ' 未闭合", 'mysql')).toThrow()
  })

  test('Given 只有注释或空白 When 切分 Then 按不完整 SQL 拒绝', () => {
    expect(() => splitServerOpsSqlStatements('-- 只有注释', 'mysql')).toThrow()
    expect(() => splitServerOpsSqlStatements('   \n ', 'mysql')).toThrow()
  })

  test('Given 语句条数超过上限 When 切分 Then 拒绝', () => {
    const sql = Array.from({ length: 201 }, () => 'SELECT 1').join(';')
    expect(() => splitServerOpsSqlStatements(sql, 'mysql')).toThrow()
  })

  test('Given 同一段带注释 SQL When 走只读解析 Then 仍然拒绝注释', () => {
    /** 放宽只作用于写脚本切分，只读查询合同不能被这次改动带松。 */
    expect(() => analyzeServerOpsSqlQuery('-- 说明\nSELECT 1 FROM t', 'testdb', 'mysql')).toThrow()
  })
})

describe('写脚本计划', () => {
  test('Given 注释开头的写语句 When 取首关键字 Then 不受注释干扰', () => {
    expect(getServerOpsSqlStatementHead('-- 说明\nUPDATE t SET a = 1', 'mysql')).toBe('UPDATE')
    expect(getServerOpsSqlStatementHead('/* 块注释 */ DELETE FROM t', 'mysql')).toBe('DELETE')
  })

  test('Given 语句表 When 生成写计划 Then 标注写类别并保留原文', () => {
    const plan = planServerOpsSqlWrite('ALTER TABLE t ADD COLUMN n INT; -- 补数据\nUPDATE t SET n = 1', 'mysql')
    expect(plan.statements.map((statement) => statement.head)).toEqual(['ALTER', 'UPDATE'])
    expect(plan.statements.every((statement) => statement.mutating)).toBe(true)
  })

  test('Given 含会话控制语句 When 生成写计划 Then 整脚本拒绝', () => {
    for (const sql of ['SET autocommit = 0; UPDATE t SET a = 1', 'USE otherdb; DELETE FROM t', 'BEGIN; UPDATE t SET a = 1; COMMIT']) {
      expect(() => planServerOpsSqlWrite(sql, 'mysql')).toThrow()
    }
  })

  test('Given SQLite 事务或外部目标控制语句 When 生成写计划 Then 整脚本拒绝', () => {
    for (const sql of [
      'END TRANSACTION; UPDATE t SET a = 1',
      "ATTACH DATABASE '/tmp/other.db' AS other; UPDATE t SET a = 1",
      'DETACH DATABASE other; UPDATE t SET a = 1',
      'PRAGMA writable_schema = ON; UPDATE t SET a = 1',
      'VACUUM INTO \'/tmp/copy.db\'; UPDATE t SET a = 1',
    ]) {
      expect(() => planServerOpsSqlWrite(sql, 'sqlite')).toThrow()
    }
  })

  test('Given 只有只读语句 When 生成写计划 Then 拒绝并引导走只读通道', () => {
    expect(() => planServerOpsSqlWrite('SELECT 1', 'mysql')).toThrow()
  })

  test('Given CTE 形式的写入 When 生成写计划 Then 按写处理而不是误判只读', () => {
    const plan = planServerOpsSqlWrite('WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x', 'postgresql')
    expect(plan.statements[0]?.head).toBe('WITH')
    expect(plan.statements[0]?.mutating).toBe(true)
  })
})
