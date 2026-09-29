import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  isServerOpsId,
  isServerOpsLocalSqliteFilePath,
  isServerOpsSqliteFileId,
  planServerOpsSqlWrite,
  parseServerOpsDataRowFilters,
  parseServerOpsDataWriteResult,
  SERVER_OPS_DATA_WRITE_MAX_TIMEOUT_MS,
  SERVER_OPS_DATA_WRITE_STATEMENT_LIMIT,
} from '@proma/shared'
import type { ServerOpsDataWriteResult } from '@proma/shared'
import type { ServerOpsRuntimeDataReadRequest, ServerOpsRuntimeDataReadResult } from './server-ops-runtime-protocol'
import {
  createServerOpsSqliteExecutionPayload,
  createServerOpsSqlitePublicError,
  parseServerOpsSqliteExecutionResult,
  ServerOpsSqlitePublicError,
} from './server-ops-sqlite-runtime'

/** 子进程 stdout 的硬上限；略高于 schema 行结果合同以容纳 envelope。 */
const MAX_CHILD_STDOUT_BYTES = 2_200_000
/** 单字段 JSON 最坏转义会放大到约六倍，仅 schema-cell 放宽传输 envelope。 */
const MAX_CHILD_CELL_STDOUT_BYTES = 6_300_000
/** 子进程 stderr 不向上透传，只限制诊断输出占用。 */
const MAX_CHILD_STDERR_BYTES = 16_384
/** stdin JSON 上限，覆盖 16 KiB SQL 与受控请求元数据。 */
const MAX_CHILD_REQUEST_BYTES = 65_536

/** 本地 SQLite 子进程执行配置；测试可注入 Electron 可执行文件。 */
export interface ServerOpsLocalSqliteRuntimeOptions {
  executablePath?: string
}

/** 判断请求文本字段是否有界且不含控制字符。 */
function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
}

/** 在创建子进程前完成本地 SQLite 专属请求校验。 */
function validateLocalInput(input: ServerOpsRuntimeDataReadRequest): void {
  if (input.transport !== 'direct' || input.engine !== 'sqlite'
    || !isServerOpsLocalSqliteFilePath(input.filePath) || !isServerOpsSqliteFileId(input.localFileId)) {
    throw createServerOpsSqlitePublicError('SERVER_OPS_SQLITE_REQUEST_INVALID')
  }
  if (input.address !== undefined || input.port !== undefined || input.username !== undefined || input.password !== undefined
    || input.tlsMode !== 'disabled' || input.tlsServerName !== undefined) {
    throw createServerOpsSqlitePublicError('SERVER_OPS_SQLITE_REQUEST_INVALID')
  }
  if (input.database !== undefined && input.database !== 'main') throw createServerOpsSqlitePublicError('SERVER_OPS_SQLITE_REQUEST_INVALID')
  if (input.schemaDatabase !== undefined && input.schemaDatabase !== 'main') throw createServerOpsSqlitePublicError('SERVER_OPS_SQLITE_REQUEST_INVALID')
  if (input.schemaTableSearch !== undefined && (input.mode !== 'schema-tables' || input.schemaDatabase !== 'main'
    || !isBoundedText(input.schemaTableSearch, 128))) throw createServerOpsSqlitePublicError('SERVER_OPS_SQLITE_REQUEST_INVALID')
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 600_000) {
    throw createServerOpsSqlitePublicError('SERVER_OPS_SQLITE_REQUEST_INVALID')
  }
  if ((input.mode === 'schema-table' || input.mode === 'schema-rows' || input.mode === 'schema-cell') && !isBoundedText(input.schemaTable, 128)) {
    throw createServerOpsSqlitePublicError('SERVER_OPS_SQLITE_TABLE_REQUIRED')
  }
  if (input.mode === 'schema-rows' || input.mode === 'schema-cell') {
    if (!Number.isSafeInteger(input.rowOffset) || (input.rowOffset ?? -1) < 0 || (input.rowOffset ?? 0) > 1_000_000
      || (input.mode === 'schema-rows' && (!Number.isSafeInteger(input.rowLimit) || (input.rowLimit ?? 0) < 1 || (input.rowLimit ?? 0) > 200
        || (input.rowOffset ?? 0) % (input.rowLimit ?? 1) !== 0))) {
      throw createServerOpsSqlitePublicError('SERVER_OPS_SQLITE_REQUEST_INVALID')
    }
    if (input.rowFilters !== undefined) {
      try { parseServerOpsDataRowFilters(input.rowFilters) } catch {
        throw createServerOpsSqlitePublicError('SERVER_OPS_DATA_SCHEMA_FILTERS_INVALID')
      }
    }
  }
}

/**
 * 固定 Electron Node 子进程程序。
 *
 * 路径、文件身份、SQL 与筛选条件只经 stdin JSON 传入；脚本本身不拼入任何用户数据。
 * 子进程隔离同步 sqlite3_step，父进程可用 SIGKILL 在取消或墙钟超时时可靠回收。
 */
export const SERVER_OPS_LOCAL_SQLITE_SCRIPT = String.raw`
'use strict';
const { Buffer } = require('node:buffer');
const { createHash } = require('node:crypto');
const { closeSync, constants: fsConstants, openSync, readSync, statSync } = require('node:fs');
const { DatabaseSync, constants } = require('node:sqlite');
const { Worker } = require('node:worker_threads');

// 固定资源上限用于约束单次 IPC 输出、字段展示宽度与目录规模。
const MAX_OUTPUT_BYTES = 2100000;
const MAX_CELL_LENGTH = 256;
const MAX_COLUMNS = 64;
const MAX_TABLES = 500;
const SENSITIVE_PATTERN = /(pass(word)?|secret|token|api[_-]?key|credential|private[_-]?key|authorization|cookie|session)/i;

/** 输出唯一、有界的 JSON envelope；入参为公开结果或错误对象，无返回值。 */
function emit(value) {
  let raw = JSON.stringify(value);
  const maximum = payload && payload.mode === 'schema-cell' ? 6300000 : MAX_OUTPUT_BYTES;
  if (Buffer.byteLength(raw, 'utf8') > maximum) raw = JSON.stringify({ ok: false, code: 'SERVER_OPS_SQLITE_RESULT_TOO_LARGE' });
  process.stdout.write(raw);
}
/** 输出白名单错误码并中断当前读取；入参为稳定错误码，不正常返回。 */
function fail(code) { emit({ ok: false, code }); process.exitCode = 0; throw new Error('__PROMA_DONE__'); }
/** 按 UTF-16 单元安全裁剪，避免在高代理项后切断 emoji。 */
function sliceText(value, maximum) { let text = String(value).slice(0, maximum); if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1); return text; }
/** 清理展示文本中的控制字符并限长；返回可进入跨进程合同的字符串。 */
function cleanText(value, maximum) { return sliceText(String(value).replace(/[\u0000-\u001f\u007f]/g, ' '), maximum); }
/** 根据完整原始列名判断是否需要遮罩；返回敏感列判定结果。 */
function sensitive(name) {
  if (SENSITIVE_PATTERN.test(name)) return true;
  const normalized = String(name).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const parts = normalized.split('_').filter(Boolean);
  if (parts.some((part) => ['pass', 'password', 'passwd', 'pwd', 'passphrase', 'token', 'secret', 'credential'].includes(part))) return true;
  return parts.includes('key') && parts.some((part) => ['api', 'access', 'private', 'client', 'auth', 'session', 'encryption', 'signing'].includes(part));
}
/** 归一化单元格并执行遮罩和单值预算；返回共享合同允许的公开单元格。 */
function formatCell(value, masked, includeDigest) {
  if (masked) return '***';
  if (value === null) return null;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    if (value.byteLength > 1048576) fail('SERVER_OPS_SQLITE_RESULT_TOO_LARGE');
    return { kind: 'binary', bytes: value.byteLength };
  }
  const original = String(value);
  const text = cleanText(original, 1000000);
  const lossy = text !== original || text.length > MAX_CELL_LENGTH;
  if (!lossy) return text;
  return { kind: 'text', text: sliceText(text, MAX_CELL_LENGTH), truncated: true,
    ...(includeDigest ? { sha256: createHash('sha256').update(original, 'utf8').digest('hex') } : {}) };
}
/** 按 SQLite 规则引用已验证标识符；返回不可注入的 SQL 标识符片段。 */
function quoteIdentifier(value) { return '"' + String(value).replaceAll('"', '""') + '"'; }
/** 以数组和 bigint 模式执行受控语句；入参为 statement 与绑定值，返回全部元数据行。 */
function readRows(statement, values) {
  statement.setReturnArrays(true);
  statement.setReadBigInts(true);
  return statement.all(...values);
}
/** 精确读取 main 库对象；入参为连接与对象名，返回 schema 行或稳定失败。 */
function readObject(database, name) {
  const row = readRows(database.prepare("SELECT name, type, sql FROM main.sqlite_schema WHERE name = ? AND type IN ('table', 'view') LIMIT 1"), [name])[0];
  if (!row || String(row[0]) !== name) fail('SERVER_OPS_DATA_QUERY_TABLE_UNAVAILABLE');
  return row;
}
/** 读取表的非隐藏列元数据；入参为连接与表名，返回 table_xinfo 行。 */
function readColumns(database, name) {
  return readRows(database.prepare('PRAGMA main.table_xinfo(' + quoteIdentifier(name) + ')'), [])
    .filter((row) => row.length >= 7 && Number(row[6] || 0) === 0);
}
/** 按可选字面搜索读取用户表和视图目录；返回最多 MAX_TABLES + 1 行。 */
function tableSummary(database, search) {
  const sql = "SELECT name, type FROM main.sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' "
    + (search === undefined ? '' : 'AND instr(lower(name), lower(?)) > 0 ') + 'ORDER BY name LIMIT ?';
  return readRows(database.prepare(sql), search === undefined ? [MAX_TABLES + 1] : [search, MAX_TABLES + 1]);
}
/** 用实时列白名单构造分页筛选；返回参数化 WHERE 子句与绑定值。 */
function buildFilter(filters, columns) {
  const operators = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
  const patterns = new Set(['contains', 'not-contains', 'starts-with', 'ends-with']);
  const pieces = [];
  const values = [];
  for (const condition of filters.conditions) {
    if (!columns.has(condition.column) || sensitive(condition.column)) fail('SERVER_OPS_DATA_SCHEMA_FILTERS_INVALID');
    const column = quoteIdentifier(condition.column);
    if (condition.operator === 'is-null' || condition.operator === 'is-not-null') {
      pieces.push(column + (condition.operator === 'is-null' ? ' IS NULL' : ' IS NOT NULL'));
    } else if (patterns.has(condition.operator)) {
      const escaped = condition.value.replace(/[!%_]/g, (character) => '!' + character);
      const prefix = ['contains', 'not-contains', 'ends-with'].includes(condition.operator) ? '%' : '';
      const suffix = ['contains', 'not-contains', 'starts-with'].includes(condition.operator) ? '%' : '';
      pieces.push(column + (condition.operator === 'not-contains' ? ' NOT LIKE' : ' LIKE') + " ? ESCAPE '!'");
      values.push(prefix + escaped + suffix);
    } else if (operators[condition.operator]) {
      pieces.push(column + ' ' + operators[condition.operator] + ' ?');
      values.push(condition.value);
    } else fail('SERVER_OPS_DATA_SCHEMA_FILTERS_INVALID');
  }
  return { clause: ' WHERE (' + pieces.join(filters.match === 'all' ? ' AND ' : ' OR ') + ')', values };
}
/** 统一缩短文本以保留页内行列形状；返回压缩后的行集与预算截断标记。 */
function fitRowsToBudget(rows, maximumBytes) {
  const contentBytes = (value) => Buffer.byteLength(JSON.stringify(value, (key, cell) => key === 'sha256' ? undefined : cell), 'utf8');
  if (contentBytes(rows) <= maximumBytes && Buffer.byteLength(JSON.stringify(rows), 'utf8') <= 2097152) return [rows, false];
  const fit = (maximumText) => rows.map((row) => row.map((cell) => {
    if (typeof cell === 'string' && cell.length > maximumText) return { kind: 'text', text: sliceText(cell, maximumText), truncated: true,
      sha256: createHash('sha256').update(cell, 'utf8').digest('hex') };
    if (cell && cell.kind === 'text' && cell.text.length > maximumText) return { kind: 'text', text: sliceText(cell.text, maximumText), truncated: true, sha256: cell.sha256 };
    return cell;
  }));
  let lower = 0;
  let upper = MAX_CELL_LENGTH;
  let best = fit(0);
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const candidate = fit(middle);
    if (contentBytes(candidate) <= maximumBytes && Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= 2097152) { best = candidate; lower = middle + 1; }
    else upper = middle - 1;
  }
  if (contentBytes(best) > maximumBytes || Buffer.byteLength(JSON.stringify(best), 'utf8') > 2097152) fail('SERVER_OPS_SQLITE_RESULT_TOO_LARGE');
  return [best, true];
}
/** 流式读取并应用行数、单元格和总字节预算；返回行集及完整截断事实。 */
function readBoundedRows(statement, values, columnNames, maximumRows, maximumBytes, preserveRows) {
  statement.setReturnArrays(true);
  statement.setReadBigInts(true);
  const rows = [];
  let cellTruncated = false;
  let resultTruncated = false;
  let hasMore = false;
  for (const rawRow of statement.iterate(...values)) {
    if (rows.length >= maximumRows) { hasMore = true; resultTruncated = true; break; }
    const row = rawRow.map((value, index) => formatCell(value, sensitive(columnNames[index] || ''), preserveRows));
    const rowTruncated = row.some((cell) => cell && cell.kind === 'text');
    if (!preserveRows && Buffer.byteLength(JSON.stringify([...rows, row]), 'utf8') > maximumBytes) { resultTruncated = true; break; }
    rows.push(row);
    cellTruncated ||= rowTruncated;
  }
  let accepted = rows;
  if (preserveRows) {
    const fitted = fitRowsToBudget(rows, maximumBytes);
    accepted = fitted[0];
    resultTruncated ||= fitted[1];
  }
  return { rows: accepted, hasMore, cellTruncated, resultTruncated };
}
/** 安装 SQL 查询 authorizer；只允许指定基础表、安全函数和纯 SELECT。 */
function installQueryAuthorizer(database, allowedTables, hasWildcard) {
  const denied = new Set([
    constants.SQLITE_INSERT, constants.SQLITE_UPDATE, constants.SQLITE_DELETE, constants.SQLITE_CREATE_INDEX,
    constants.SQLITE_CREATE_TABLE, constants.SQLITE_CREATE_TEMP_INDEX, constants.SQLITE_CREATE_TEMP_TABLE,
    constants.SQLITE_CREATE_TEMP_TRIGGER, constants.SQLITE_CREATE_TEMP_VIEW, constants.SQLITE_CREATE_TRIGGER,
    constants.SQLITE_CREATE_VIEW, constants.SQLITE_DROP_INDEX, constants.SQLITE_DROP_TABLE,
    constants.SQLITE_DROP_TEMP_INDEX, constants.SQLITE_DROP_TEMP_TABLE, constants.SQLITE_DROP_TEMP_TRIGGER,
    constants.SQLITE_DROP_TEMP_VIEW, constants.SQLITE_DROP_TRIGGER, constants.SQLITE_DROP_VIEW,
    constants.SQLITE_ALTER_TABLE, constants.SQLITE_REINDEX, constants.SQLITE_ANALYZE, constants.SQLITE_ATTACH,
    constants.SQLITE_DETACH, constants.SQLITE_PRAGMA, constants.SQLITE_TRANSACTION, constants.SQLITE_SAVEPOINT,
    constants.SQLITE_CREATE_VTABLE, constants.SQLITE_DROP_VTABLE,
  ]);
  const safeFunctions = new Set(['count', 'sum', 'avg', 'min', 'max', 'round', 'abs', 'coalesce', 'ifnull', 'nullif',
    'lower', 'upper', 'length', 'substring', 'substr', 'date', 'datetime', 'strftime', 'trim', 'ltrim', 'rtrim', 'replace', 'like']);
  database.setAuthorizer((action, arg1, arg2, databaseName) => {
    if (denied.has(action)) return constants.SQLITE_DENY;
    if (action === constants.SQLITE_READ) {
      const table = String(arg1 || '');
      const column = String(arg2 || '');
      const aggregateProbe = databaseName === null && column === '';
      if ((!aggregateProbe && databaseName !== 'main') || !allowedTables.has(table) || table.startsWith('sqlite_')) return constants.SQLITE_DENY;
      if (sensitive(column) && !hasWildcard) return constants.SQLITE_DENY;
    } else if (action === constants.SQLITE_FUNCTION) {
      const functionName = String(arg2 || arg1 || '').toLowerCase();
      if (!safeFunctions.has(functionName)) return constants.SQLITE_DENY;
    } else if (action !== constants.SQLITE_SELECT) return constants.SQLITE_DENY;
    return constants.SQLITE_OK;
  });
}
/** 启动独立监督线程；入参为墙钟预算，返回不阻止正常退出的 Worker。 */
function startWatchdog(timeoutMs) {
  const source = [
    "'use strict';",
    "const { workerData } = require('node:worker_threads');",
    "const killChild = () => { try { process.kill(workerData.childPid, 'SIGKILL'); } catch {} };",
    "setTimeout(killChild, workerData.timeoutMs);",
    "setInterval(() => {",
    "  if (process.ppid !== workerData.parentPid) { killChild(); return; }",
    "  try { process.kill(workerData.parentPid, 0); }",
    "  catch (error) { if (error && error.code === 'ESRCH') killChild(); }",
    "}, 250);",
  ].join('\n');
  const worker = new Worker(source, { eval: true, workerData: {
    childPid: process.pid, parentPid: process.ppid, timeoutMs: Math.max(250, Number(timeoutMs) || 250),
  } });
  worker.unref();
  return worker;
}
/** 分派已验证读取请求；入参为只读连接、安全 payload 与文件大小，返回公开结果。 */
function execute(database, payload, fileSize) {
  const versionRow = readRows(database.prepare('SELECT sqlite_version()'), [])[0];
  const version = 'SQLite ' + String(versionRow[0]) + ' (Node ' + process.versions.node + ')';
  if (payload.mode === 'probe') {
    readRows(database.prepare('SELECT COUNT(*) FROM main.sqlite_schema'), []);
    return { capability: 'available', serverVersion: version, metrics: [], tables: [], warnings: [] };
  }
  if (payload.mode === 'diagnostics') {
    const pageSize = readRows(database.prepare('PRAGMA main.page_size'), [])[0][0];
    const pageCount = readRows(database.prepare('PRAGMA main.page_count'), [])[0][0];
    const objects = tableSummary(database);
    return { capability: 'available', serverVersion: version, metrics: [
      { id: 'file-size', label: '文件大小', value: String(fileSize) + ' B' },
      { id: 'page-size', label: '页大小', value: String(pageSize) + ' B' },
      { id: 'page-count', label: '页面数', value: String(pageCount) },
      { id: 'table-count', label: '表与视图', value: String(objects.length) },
    ], tables: [{ id: 'database-objects', title: '数据库对象', columns: [{ id: 'name', label: '名称' }, { id: 'type', label: '类型' }],
      rows: objects.slice(0, 200).map((row) => [cleanText(row[0], 128), row[1] === 'view' ? '视图' : '表']),
      truncated: objects.length > 200, emptyText: '没有用户表或视图' }], warnings: [] };
  }
  if (payload.mode === 'schema-tables') {
    const objects = tableSummary(database, payload.schemaTableSearch);
    return { mode: payload.mode, capability: 'available', database: 'main', databases: ['main'],
      tables: objects.slice(0, MAX_TABLES).map((row) => ({ name: cleanText(row[0], 128), type: row[1] === 'view' ? 'view' : 'table' })),
      ...(objects.length > MAX_TABLES ? { tablesTruncated: true } : {}), warnings: [] };
  }
  if (payload.mode === 'sql-query') {
    const allowedTables = new Set(payload.allowedTables);
    for (const table of allowedTables) {
      const object = readObject(database, table);
      if (object[1] !== 'table' || String(object[2] || '').toUpperCase().startsWith('CREATE VIRTUAL TABLE')) fail('SERVER_OPS_DATA_QUERY_TABLE_UNAVAILABLE');
    }
    installQueryAuthorizer(database, allowedTables, payload.hasWildcard);
    const startedAt = Date.now();
    const statement = database.prepare(payload.sql);
    statement.setReturnArrays(true);
    const columnNames = statement.columns().map((column) => String(column.name || ''));
    if (columnNames.length > MAX_COLUMNS) fail('SERVER_OPS_DATA_QUERY_TOO_MANY_COLUMNS');
    const bounded = readBoundedRows(statement, [], columnNames, payload.maxRows, 24576, false);
    return { queryId: payload.queryId, database: 'main', columns: columnNames.map((name) => cleanText(name, 128)), rows: bounded.rows,
      rowCount: bounded.rows.length, durationMs: Math.max(0, Date.now() - startedAt),
      truncated: bounded.hasMore || bounded.cellTruncated || bounded.resultTruncated,
      warnings: bounded.cellTruncated ? ['部分单元格内容过长，已截断'] : [] };
  }
  if (payload.mode === 'sql-write') {
    const startedAt = Date.now();
    const statements = Array.isArray(payload.statements) ? payload.statements : [];
    const results = [];
    let affectedTotal = 0;
    /** 只有 DML 的 changes 可作为本条语句影响行数，DDL/SELECT 不能沿用连接上的历史 changes。 */
    const affectedHeads = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE']);
    /** 构造不携带 SQL 或底层异常正文的公开失败结果。 */
    function writeFailure(outcome, errorCode, warnings) {
      return { writeId: payload.writeId, database: 'main', statementCount: results.length, affectedRows: affectedTotal,
        committed: false, outcome, errorCode, durationMs: Math.max(0, Date.now() - startedAt), statements: results,
        warnings: warnings || [] };
    }
    /** 事务由执行器统一控制；脚本里的会话控制语句已由父入口再次解析拒绝。 */
    try { database.exec('BEGIN IMMEDIATE'); }
    catch (error) { return writeFailure('not-started', 'SERVER_OPS_DATA_WRITE_FAILED'); }
    try {
      for (const entry of statements) {
        const statement = database.prepare(entry.text);
        const info = affectedHeads.has(String(entry.head)) ? statement.run() : (statement.get(), undefined);
        const changes = Number(info && info.changes);
        const affected = affectedHeads.has(String(entry.head)) && Number.isSafeInteger(changes) && changes > 0 ? changes : 0;
        results.push({ head: String(entry.head), affectedRows: affected });
        affectedTotal += affected;
      }
    } catch (error) {
      try { database.exec('ROLLBACK'); return writeFailure('rolled-back', 'SERVER_OPS_DATA_WRITE_FAILED'); }
      catch (ignored) { return writeFailure('unknown', 'SERVER_OPS_DATA_WRITE_FAILED', ['SQLite 回滚确认失败，改动状态未知']); }
    }
    try { database.exec('COMMIT'); }
    catch (error) {
      try { database.exec('ROLLBACK'); return writeFailure('rolled-back', 'SERVER_OPS_DATA_WRITE_COMMIT_FAILED'); }
      catch (ignored) { return writeFailure('unknown', 'SERVER_OPS_DATA_WRITE_COMMIT_FAILED', ['SQLite 提交与回滚均未确认，改动状态未知']); }
    }
    return { writeId: payload.writeId, database: 'main', statementCount: results.length, affectedRows: affectedTotal,
      committed: true, outcome: 'committed', durationMs: Math.max(0, Date.now() - startedAt), statements: results, warnings: [] };
  }
  const tableName = payload.schemaTable;
  if (typeof tableName !== 'string') fail('SERVER_OPS_SQLITE_TABLE_REQUIRED');
  const object = readObject(database, tableName);
  if (payload.baseTablesOnly && (object[1] !== 'table' || String(object[2] || '').toUpperCase().startsWith('CREATE VIRTUAL TABLE'))) {
    fail('SERVER_OPS_DATA_QUERY_TABLE_UNAVAILABLE');
  }
  const columnRows = readColumns(database, tableName);
  if (payload.mode === 'schema-table') {
    const columns = columnRows.slice(0, 256).map((row) => ({ name: cleanText(row[1], 128), type: cleanText(row[2] || 'BLOB', 128) || 'BLOB',
      nullable: !Boolean(row[3]), primaryKey: Number(row[5] || 0) > 0, ...(row[4] === null ? {} : { defaultText: cleanText(row[4], 256) }) }));
    const indexes = [];
    if (object[1] === 'table') {
      for (const indexRow of readRows(database.prepare('PRAGMA main.index_list(' + quoteIdentifier(tableName) + ')'), []).slice(0, 128)) {
        const indexName = String(indexRow[1]);
        const names = readRows(database.prepare('PRAGMA main.index_info(' + quoteIdentifier(indexName) + ')'), []).slice(0, 16)
          .filter((row) => row[2] !== null).map((row) => cleanText(row[2], 128));
        if (names.length > 0) indexes.push({ name: cleanText(indexName, 128), unique: Boolean(indexRow[2]), columns: names });
      }
    }
    return { mode: payload.mode, capability: 'available', columns, indexes, warnings: [] };
  }
  if (payload.mode === 'schema-rows') {
    if (object[1] !== 'table' || String(object[2] || '').toUpperCase().startsWith('CREATE VIRTUAL TABLE')) fail('SERVER_OPS_DATA_QUERY_TABLE_UNAVAILABLE');
    const shown = columnRows.slice(0, MAX_COLUMNS);
    const columnNames = shown.map((row) => String(row[1]));
    // 排序必须使用完整复合主键；第 65 列后的键仍参与分页，但不扩大公开列。
    const primary = columnRows.filter((row) => Number(row[5] || 0) > 0).sort((left, right) => Number(left[5]) - Number(right[5]));
    const filter = payload.rowFilters ? buildFilter(payload.rowFilters, new Set(columnRows.map((row) => String(row[1])))) : { clause: '', values: [] };
    const selectColumns = shown.map((row) => quoteIdentifier(row[1])).join(', ');
    const order = primary.length === 0 ? '' : ' ORDER BY ' + primary.map((row) => quoteIdentifier(row[1])).join(', ');
    const statement = database.prepare('SELECT ' + selectColumns + ' FROM main.' + quoteIdentifier(tableName) + filter.clause + order + ' LIMIT ? OFFSET ?');
    const bounded = readBoundedRows(statement, [...filter.values, payload.rowLimit + 1, payload.rowOffset], columnNames, payload.rowLimit, 1000000, true);
    return { mode: payload.mode, capability: 'available', columns: columnNames.map((name) => cleanText(name, 128)), rows: bounded.rows,
      offset: payload.rowOffset, limit: payload.rowLimit, truncated: columnRows.length > MAX_COLUMNS || bounded.cellTruncated || bounded.resultTruncated,
      hasMore: bounded.hasMore, orderedByPrimaryKey: primary.length > 0,
      warnings: columnRows.length > MAX_COLUMNS ? ['表列数超过 64，当前预览只显示前 64 列'] : [] };
  }
  if (payload.mode === 'schema-cell') {
    if (object[1] !== 'table' || String(object[2] || '').toUpperCase().startsWith('CREATE VIRTUAL TABLE')) fail('SERVER_OPS_DATA_QUERY_TABLE_UNAVAILABLE');
    const shown = columnRows.slice(0, MAX_COLUMNS);
    const target = shown[payload.cellColumnIndex];
    if (!target || cleanText(target[1], 128) !== payload.cellExpectedColumn) fail('SERVER_OPS_DATA_CELL_CHANGED');
    const columnName = String(target[1]);
    if (sensitive(columnName)) fail('SERVER_OPS_DATA_CELL_REDACTED');
    const primary = columnRows.filter((row) => Number(row[5] || 0) > 0).sort((left, right) => Number(left[5]) - Number(right[5]));
    const filter = payload.rowFilters ? buildFilter(payload.rowFilters, new Set(columnRows.map((row) => String(row[1])))) : { clause: '', values: [] };
    const order = primary.length === 0 ? '' : ' ORDER BY ' + primary.map((row) => quoteIdentifier(row[1])).join(', ');
    const identifier = quoteIdentifier(columnName);
    const statement = database.prepare('SELECT typeof(' + identifier + '), length(CAST(' + identifier + ' AS BLOB)), '
      + 'CASE WHEN length(CAST(' + identifier + ' AS BLOB)) <= 1048576 THEN ' + identifier + ' END FROM main.' + quoteIdentifier(tableName)
      + filter.clause + order + ' LIMIT 1 OFFSET ?');
    const row = readRows(statement, [...filter.values, payload.rowOffset])[0];
    if (!row || row.length !== 3 || !['text', 'integer', 'real'].includes(row[0])) fail('SERVER_OPS_DATA_CELL_CHANGED');
    const valueBytes = Number(row[1]);
    if (!Number.isSafeInteger(valueBytes) || valueBytes < 0) fail('SERVER_OPS_DATA_CELL_CHANGED');
    if (valueBytes > 1048576) fail('SERVER_OPS_DATA_CELL_TOO_LARGE');
    if (row[2] === null || Buffer.isBuffer(row[2]) || row[2] instanceof Uint8Array) fail('SERVER_OPS_DATA_CELL_CHANGED');
    const value = String(row[2]);
    const sha256 = createHash('sha256').update(value, 'utf8').digest('hex');
    if (sha256 !== payload.cellSha256) fail('SERVER_OPS_DATA_CELL_CHANGED');
    return { mode: payload.mode, capability: 'available', value, warnings: [] };
  }
  fail('SERVER_OPS_SQLITE_MODE_UNSUPPORTED');
}

// 子进程仅持有一次读取的连接、请求和监督线程，finally 统一释放。
let database;
let payload;
let watchdog;
try {
  const chunks = [];
  let bytes = 0;
  process.stdin.on('data', (chunk) => {
    bytes += chunk.byteLength;
    if (bytes > 65536) fail('SERVER_OPS_SQLITE_REQUEST_INVALID');
    chunks.push(chunk);
  });
  process.stdin.on('end', () => {
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      watchdog = startWatchdog(payload.timeoutMs);
      const before = statSync(payload.filePath, { bigint: true });
      if (!before.isFile()) fail('SERVER_OPS_SQLITE_FILE_NOT_REGULAR');
      if (before.dev + ':' + before.ino + ':' + before.birthtimeNs !== payload.localFileId) fail('SERVER_OPS_SQLITE_FILE_CHANGED');
      const descriptor = openSync(payload.filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      try {
        const header = Buffer.alloc(16);
        if (readSync(descriptor, header, 0, 16, 0) !== 16 || header.toString('binary') !== 'SQLite format 3\u0000') fail('SERVER_OPS_SQLITE_DATABASE_INVALID');
      } finally { closeSync(descriptor); }
      /**
       * 写模式必须真正以可写方式打开，并且**不能**设置 query_only：
       * 只读保证只属于只读链，写链的执行语义与它完全分离。
       */
      const readOnly = payload.mode !== 'sql-write';
      database = new DatabaseSync(payload.filePath, { readOnly, allowExtension: false, defensive: true });
      database.enableDefensive(true);
      database.enableLoadExtension(false);
      database.exec(readOnly
        ? 'PRAGMA hard_heap_limit = 67108864; PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 2000;'
        : 'PRAGMA hard_heap_limit = 67108864; PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 2000;');
      const after = statSync(payload.filePath, { bigint: true });
      if (after.dev + ':' + after.ino + ':' + after.birthtimeNs !== payload.localFileId) fail('SERVER_OPS_SQLITE_FILE_CHANGED');
      emit({ ok: true, result: execute(database, payload, before.size) });
    } catch (error) {
      if (error && error.message === '__PROMA_DONE__') return;
      const code = error && error.code;
      const text = String(error && error.message || '').toLowerCase();
      if (code === 'ENOENT') emit({ ok: false, code: 'SERVER_OPS_SQLITE_FILE_NOT_FOUND' });
      else if (code === 'EACCES' || code === 'EPERM') emit({ ok: false, code: 'SERVER_OPS_SQLITE_LOCAL_FILE_PERMISSION_DENIED' });
      else if (text.includes('locked') || text.includes('busy')) emit({ ok: false, code: 'SERVER_OPS_SQLITE_DATABASE_LOCKED' });
      /**
       * 写模式下必须先把「文件不可写」这类写侧原因归类完，
       * 否则会落进下面的读侧映射（例如把写失败报成「表不存在」）。
       */
      else if (payload && payload.mode === 'sql-write' && (text.includes('readonly') || text.includes('read-only')
        || text.includes('permission'))) emit({ ok: false, code: 'SERVER_OPS_DATA_WRITE_PERMISSION_DENIED' });
      else if (payload && payload.mode === 'sql-write') emit({ ok: false, code: 'SERVER_OPS_DATA_WRITE_FAILED' });
      else if (text.includes('not authorized') || text.includes('authorization denied')) emit({ ok: false, code: 'SERVER_OPS_DATA_QUERY_PERMISSION_DENIED' });
      else if (text.includes('no such table')) emit({ ok: false, code: 'SERVER_OPS_DATA_QUERY_TABLE_UNAVAILABLE' });
      else if (text.includes('no such column')) emit({ ok: false, code: 'SERVER_OPS_DATA_QUERY_COLUMN_UNAVAILABLE' });
      else if (text.includes('too big')) emit({ ok: false, code: 'SERVER_OPS_SQLITE_RESULT_TOO_LARGE' });
      else if (text.includes('database') || text.includes('malformed')) emit({ ok: false, code: 'SERVER_OPS_SQLITE_DATABASE_INVALID' });
      else emit({ ok: false, code: payload && payload.mode === 'sql-query' ? 'SERVER_OPS_DATA_QUERY_SQL_INVALID' : 'SERVER_OPS_SQLITE_READ_FAILED' });
    } finally {
      try { database && database.close(); } catch {}
      try { watchdog && watchdog.terminate(); } catch {}
    }
  });
} catch { emit({ ok: false, code: 'SERVER_OPS_SQLITE_READ_FAILED' }); }
`

/** 判断子进程返回是否为唯一 JSON envelope。 */
function parseChildEnvelope(raw: string): { ok: true; result: unknown } | { ok: false; code: string } {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw createServerOpsSqlitePublicError('SERVER_OPS_SQLITE_READ_FAILED')
  const record = parsed as Record<string, unknown>
  const keys = Object.keys(record).sort().join(',')
  if (record.ok === false && keys === 'code,ok' && typeof record.code === 'string') return { ok: false, code: record.code }
  if (record.ok === true && keys === 'ok,result') return { ok: true, result: record.result }
  throw createServerOpsSqlitePublicError('SERVER_OPS_SQLITE_READ_FAILED')
}

/** 杀死子进程，并依赖 close 事件确认 SQLite C++ 调用已经退出。 */
function terminateChild(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL') } catch { /* 已退出子进程会自然触发 close。 */ }
  }
}

/** 执行固定本地 SQLite 程序，并在子进程实际退出后才结算。 */
async function executeLocal(
  payload: Record<string, unknown>,
  signal: AbortSignal | undefined,
  executablePath: string,
): Promise<unknown> {
  const requestJson = JSON.stringify(payload)
  if (Buffer.byteLength(requestJson, 'utf8') > MAX_CHILD_REQUEST_BYTES) throw createServerOpsSqlitePublicError('SERVER_OPS_SQLITE_REQUEST_INVALID')
  if (signal?.aborted) throw new Error('SERVER_OPS_DATA_CANCELLED')

  const startedAt = Date.now()
  /** 写子进程被终止后只能报告状态未知，不能把取消等同于回滚。 */
  const unknownWriteResult = (errorCode: string): ServerOpsDataWriteResult => ({
    writeId: String(payload.writeId), database: 'main', statementCount: 0, affectedRows: 0,
    committed: false, outcome: 'unknown', errorCode, durationMs: Math.max(0, Date.now() - startedAt),
    statements: [], warnings: ['写入进程在返回事务结果前终止，数据库状态需要重新核对'],
  })
  return await new Promise<unknown>((resolve, reject) => {
    /** 子进程只继承环境并强制 Electron 使用 Node 模式，不传递任何用户数据。 */
    const child = spawn(executablePath, ['-e', SERVER_OPS_LOCAL_SQLITE_SCRIPT], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdoutChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let terminal: 'cancelled' | 'timeout' | 'too-large' | undefined
    const timeoutCode = payload.mode === 'sql-query' ? 'SERVER_OPS_DATA_QUERY_TIMEOUT'
      : payload.mode === 'sql-write' ? 'SERVER_OPS_DATA_WRITE_TIMEOUT'
        : payload.mode === 'schema-cell' ? 'SERVER_OPS_DATA_CELL_TIMEOUT' : 'SERVER_OPS_SQLITE_TIMEOUT'
    const timer = setTimeout(() => { terminal = 'timeout'; terminateChild(child) }, Number(payload.timeoutMs))
    const onAbort = (): void => { terminal = 'cancelled'; terminateChild(child) }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      if (terminal !== undefined) return
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > (payload.mode === 'schema-cell' ? MAX_CHILD_CELL_STDOUT_BYTES : MAX_CHILD_STDOUT_BYTES)) {
        terminal = 'too-large'; terminateChild(child); return
      }
      stdoutChunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (terminal !== undefined) return
      stderrBytes += chunk.byteLength
      if (stderrBytes > MAX_CHILD_STDERR_BYTES) terminateChild(child)
    })
    /** 启动失败或快速取消可能让 end 异步触发 EPIPE；只由 close 统一结算。 */
    child.stdin.on('error', () => { terminateChild(child) })
    child.once('error', () => { terminateChild(child) })
    child.once('close', (exitCode) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (terminal === 'cancelled') {
        if (payload.mode === 'sql-write') resolve(unknownWriteResult('SERVER_OPS_DATA_WRITE_CANCELLED'))
        else reject(new Error('SERVER_OPS_DATA_CANCELLED'))
        return
      }
      if (terminal === 'timeout') {
        if (payload.mode === 'sql-write') resolve(unknownWriteResult('SERVER_OPS_DATA_WRITE_TIMEOUT'))
        else reject(createServerOpsSqlitePublicError(timeoutCode))
        return
      }
      if (terminal === 'too-large') { reject(createServerOpsSqlitePublicError('SERVER_OPS_SQLITE_RESULT_TOO_LARGE')); return }
      if (exitCode !== 0 || stderrBytes > MAX_CHILD_STDERR_BYTES) {
        if (payload.mode === 'sql-write') resolve(unknownWriteResult('SERVER_OPS_DATA_WRITE_FAILED'))
        else reject(createServerOpsSqlitePublicError('SERVER_OPS_SQLITE_READ_FAILED'))
        return
      }
      try {
        const envelope = parseChildEnvelope(Buffer.concat(stdoutChunks).toString('utf8'))
        if (!envelope.ok) reject(createServerOpsSqlitePublicError(envelope.code))
        else resolve(envelope.result)
      } catch (error) {
        if (payload.mode === 'sql-write') resolve(unknownWriteResult('SERVER_OPS_DATA_WRITE_FAILED'))
        else reject(error instanceof ServerOpsSqlitePublicError ? error : createServerOpsSqlitePublicError('SERVER_OPS_SQLITE_READ_FAILED'))
      }
    })
    try { child.stdin.end(requestJson) } catch { terminateChild(child) }
  })
}

/**
 * 在独立、可终止的 Electron Node 子进程中只读解析本机 SQLite 文件。
 *
 * @param input 已由 runtime protocol 解析且由主进程绑定文件身份的请求
 * @param signal 用户取消信号；返回前会等待子进程 close
 * @param options 测试可注入 Electron 可执行文件，生产默认使用当前 Electron
 * @returns 与远端 SQLite 和 MySQL 工作台相同的结果合同
 */
export async function runServerOpsLocalSqliteRead(
  input: ServerOpsRuntimeDataReadRequest,
  signal?: AbortSignal,
  options: ServerOpsLocalSqliteRuntimeOptions = {},
): Promise<ServerOpsRuntimeDataReadResult> {
  validateLocalInput(input)
  const payload = { ...createServerOpsSqliteExecutionPayload(input), localFileId: input.localFileId }
  const value = await executeLocal(payload, signal, options.executablePath ?? process.execPath)
  return parseServerOpsSqliteExecutionResult(input, value)
}

/** 本地 SQLite 写执行请求；文件身份与语句计划由主进程在复核后绑定。 */
export interface ServerOpsLocalSqliteWriteRequest {
  /** 已由主进程 realpath 化的本地绝对路径。 */
  filePath: string
  /** 主进程验证过的本地文件身份，子进程会再核对一次。 */
  localFileId: string
  writeId: string
  /** SQLite 固定主库。 */
  database: string
  /** 共享层生成的语句计划；本入口会从正文重新生成并核对一次。 */
  statements: readonly { text: string; head: string }[]
  timeoutMs: number
}

/**
 * 校验本地写请求。
 *
 * 任何越界字段都在开子进程前拒绝：子进程只接受已经过这里判定的窄 payload。
 *
 * @param input 写执行请求
 */
function validateLocalWriteInput(input: ServerOpsLocalSqliteWriteRequest): void {
  if (!isServerOpsLocalSqliteFilePath(input.filePath)) throw new Error('SERVER_OPS_SQLITE_PATH_INVALID')
  if (!isServerOpsSqliteFileId(input.localFileId)) throw new Error('SERVER_OPS_SQLITE_FILE_CHANGED')
  if (!isServerOpsId(input.writeId)) throw new Error('SERVER_OPS_DATA_WRITE_INPUT_INVALID')
  /** SQLite 只开放主库，不允许借写通道切入附加库。 */
  if (input.database !== 'main') throw new Error('SERVER_OPS_DATA_WRITE_INPUT_INVALID')
  if (!Array.isArray(input.statements)
    || input.statements.length < 1 || input.statements.length > SERVER_OPS_DATA_WRITE_STATEMENT_LIMIT) {
    throw new Error('SERVER_OPS_DATA_WRITE_INPUT_INVALID')
  }
  for (const statement of input.statements) {
    if (!isBoundedText(statement.text, 65_536) || !/^[A-Z_]{1,32}$/u.test(statement.head)) {
      throw new Error('SERVER_OPS_DATA_WRITE_INPUT_INVALID')
    }
  }
  /** 跨进程协议不信任调用方携带的 head，父入口按完整脚本重新生成计划并逐项核对。 */
  try {
    const verified = planServerOpsSqlWrite(input.statements.map((statement) => statement.text).join(';\n'), 'sqlite').statements
    if (verified.length !== input.statements.length
      || verified.some((statement, index) => statement.text !== input.statements[index]?.text || statement.head !== input.statements[index]?.head)) {
      throw new Error('SERVER_OPS_DATA_WRITE_INPUT_INVALID')
    }
  } catch {
    throw new Error('SERVER_OPS_DATA_WRITE_INPUT_INVALID')
  }
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > SERVER_OPS_DATA_WRITE_MAX_TIMEOUT_MS) {
    throw new Error('SERVER_OPS_DATA_WRITE_INPUT_INVALID')
  }
}

/**
 * 在独立、可终止的 Electron Node 子进程中写本机 SQLite 文件。
 *
 * 与只读入口共用同一个子进程脚本，但以**可写方式**打开且不设置 `query_only`；
 * 入口先重新解析语句计划；事务、回滚与受影响行数统计都在子进程内完成。
 *
 * @param input 已由主进程绑定文件身份的写请求
 * @param signal 用户取消信号；返回前会等待子进程 close
 * @param options 测试可注入 Electron 可执行文件，生产默认使用当前 Electron
 * @returns 与网络引擎一致的写执行结果合同
 */
export async function runServerOpsLocalSqliteWrite(
  input: ServerOpsLocalSqliteWriteRequest,
  signal?: AbortSignal,
  options: ServerOpsLocalSqliteRuntimeOptions = {},
): Promise<ServerOpsDataWriteResult> {
  validateLocalWriteInput(input)
  const payload = {
    mode: 'sql-write',
    filePath: input.filePath,
    localFileId: input.localFileId,
    writeId: input.writeId,
    database: input.database,
    timeoutMs: Math.min(SERVER_OPS_DATA_WRITE_MAX_TIMEOUT_MS, Math.max(250, input.timeoutMs)),
    statements: input.statements.map((statement) => ({ text: statement.text, head: statement.head })),
  }
  /** 子进程 stdin 上限是 64 KiB；超限在这里就拒绝，不把截断的脚本发出去。 */
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_CHILD_REQUEST_BYTES) {
    throw new Error('SERVER_OPS_DATA_WRITE_INPUT_INVALID')
  }
  const value = await executeLocal(payload, signal, options.executablePath ?? process.execPath)
  return parseServerOpsDataWriteResult(value)
}
