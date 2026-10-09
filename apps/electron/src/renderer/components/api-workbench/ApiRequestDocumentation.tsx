import * as React from 'react'
import { BookOpen, FileQuestion, KeyRound } from 'lucide-react'
import type { ApiAssertion, ApiAuth, ApiField, ApiRequestBody, ApiRequestDefinition } from '@proma/shared'
import { Badge } from '@/components/ui/badge'

/** 已保存请求的只读文档属性。 */
export interface ApiRequestDocumentationProps {
  request: ApiRequestDefinition | null
  collectionName: string | null
}

/** 常见凭据字段名；保存定义未显式标记 secret 时仍必须保守隐藏。 */
const SENSITIVE_NAME_PATTERN = /(?:^|[-_])(authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret|client[-_]?secret|credential)(?:$|[-_])/i

/** 判断字段是否按显式标记、名称或常见鉴权值处理为秘密。 */
function isSensitiveField(field: ApiField): boolean {
  return Boolean(field.secret || field.secretRef || SENSITIVE_NAME_PATTERN.test(field.name) || /^(?:Bearer|Basic)\s+\S+/i.test(field.value.trim()))
}

/** 返回字段的安全展示值，秘密字段只报告已配置事实。 */
function fieldDisplayValue(field: ApiField): string {
  if (isSensitiveField(field)) return field.secretRef || field.value ? '已配置秘密值' : '待填写'
  return field.value || '未填写'
}

/** 递归隐藏 JSON 中由字段名标识的凭据，同时保留普通结构供阅读。 */
function redactStructuredBody(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactStructuredBody(item))
  if (!value || typeof value !== 'object') return value
  /** 只处理 JSON 解析得到的普通键值对象。 */
  const record = value as Record<string, unknown>
  /** 脱敏后的对象保持原字段顺序，便于与保存定义对照。 */
  const redacted: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(record)) {
    redacted[key] = SENSITIVE_NAME_PATTERN.test(key) ? '[REDACTED]' : redactStructuredBody(item)
  }
  return redacted
}

/** 安全展示 JSON 或文本正文，避免直接输出常见键值凭据。 */
function redactBodyText(text: string): string {
  try {
    return JSON.stringify(redactStructuredBody(JSON.parse(text) as unknown))
  } catch {
    return text
      .replace(/((?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret|credential)\s*[:=]\s*)([^\s,;&]+)/gi, '$1[REDACTED]')
      .replace(/\{\{\s*((?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret|credential)[^}]*)\}\}/gi, '{{[REDACTED]}}')
  }
}

/** 隐藏 URL 用户信息、敏感查询参数和敏感变量引用。 */
function redactUrl(rawUrl: string): string {
  /** 模板变量可能使 URL 无法解析，先执行不依赖 URL API 的替换。 */
  const templateSafeUrl = rawUrl.replace(/\{\{\s*((?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret|credential)[^}]*)\}\}/gi, '{{[REDACTED]}}')
  try {
    /** 使用标准 URL 解析避免手工拼接破坏查询参数。 */
    const parsed = new URL(templateSafeUrl)
    if (parsed.username) parsed.username = '[REDACTED]'
    if (parsed.password) parsed.password = '[REDACTED]'
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_NAME_PATTERN.test(key)) parsed.searchParams.set(key, '[REDACTED]')
    }
    return parsed.toString()
  } catch {
    return templateSafeUrl.replace(/([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret|credential)=)[^&#]*/gi, '$1[REDACTED]')
  }
}

/** 将鉴权定义转换为不包含凭据的说明。 */
function describeAuth(auth: ApiAuth): string {
  if (auth.type === 'none') return '无鉴权'
  if (auth.type === 'bearer') return 'Bearer Token（取值不展示）'
  if (auth.type === 'basic') return `Basic Auth${auth.username ? ` · 用户名 ${auth.username}` : ''}（密码不展示）`
  return `API Key · ${auth.in === 'query' ? 'Query' : 'Header'}${auth.name ? ` · ${auth.name}` : ''}（取值不展示）`
}

/** 将已保存断言转换为文档中的真实预期，不推导响应结构。 */
function describeAssertion(assertion: ApiAssertion): string {
  if (assertion.kind === 'status') return `状态码等于 ${assertion.expected}`
  if (assertion.kind === 'header') return `响应 Header ${assertion.path}：${assertion.expected}`
  if (assertion.kind === 'json-value') return `JSON ${assertion.path} 等于 ${assertion.expected}`
  if (assertion.kind === 'json-exists') return `JSON ${assertion.path} 必须存在`
  if (assertion.kind === 'json-type') return `JSON ${assertion.path} 类型为 ${assertion.expected}`
  if (assertion.kind === 'duration') return `耗时 ${assertion.expected}`
  if (assertion.kind === 'sse-count') return `SSE 事件数 ${assertion.expected}`
  if (assertion.kind === 'sse-first-event') return `首个 SSE 事件耗时 ${assertion.expected}`
  if (assertion.kind === 'sse-ended') return `SSE 结束状态为 ${assertion.expected}`
  return `最后一条 SSE 数据 ${assertion.expected}`
}

/** 展示参数或 Header 表格，保留启用状态和重复名称。 */
function FieldDocumentation({ title, fields }: { title: string; fields: ApiField[] }): React.ReactElement {
  return (
    <section className="space-y-2 border-b border-border/60 pb-4">
      <h3 className="text-xs font-semibold text-foreground">{title}</h3>
      {fields.length === 0 ? <p className="text-xs text-muted-foreground">未定义</p> : (
        <div className="overflow-x-auto rounded-md border border-border/60">
          <table className="w-full min-w-[28rem] text-left text-xs">
            <thead className="bg-muted/40 text-muted-foreground"><tr><th className="px-2 py-1.5 font-medium">名称</th><th className="px-2 py-1.5 font-medium">值</th><th className="px-2 py-1.5 font-medium">状态</th></tr></thead>
            <tbody>{fields.map((field) => (
              <tr key={field.id} className="border-t border-border/50">
                <td className="px-2 py-1.5 font-mono">{field.name || '未命名'}</td>
                <td className="max-w-80 break-all px-2 py-1.5 font-mono text-muted-foreground">{isSensitiveField(field) ? <span className="inline-flex items-center gap-1"><KeyRound className="size-3" aria-hidden="true" />{fieldDisplayValue(field)}</span> : fieldDisplayValue(field)}</td>
                <td className="px-2 py-1.5"><Badge variant={field.enabled ? 'secondary' : 'outline'}>{field.enabled ? '启用' : '停用'}</Badge></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/** 按真实正文类型展示保存内容，不把示例反推为 schema。 */
function BodyDocumentation({ body }: { body: ApiRequestBody }): React.ReactElement {
  const kindLabel = body.kind === 'none' ? '无正文' : body.kind === 'json' ? 'JSON' : body.kind === 'text' ? '文本' : body.kind === 'urlencoded' ? 'URL Encoded' : 'Multipart'
  return (
    <section className="space-y-2 border-b border-border/60 pb-4">
      <div className="flex items-center gap-2"><h3 className="text-xs font-semibold text-foreground">请求正文</h3><Badge variant="outline">{kindLabel}</Badge></div>
      {(body.kind === 'json' || body.kind === 'text') && (body.text
        ? <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/20 p-3 font-mono text-xs text-foreground">{redactBodyText(body.text)}</pre>
        : <p className="text-xs text-muted-foreground">正文为空</p>)}
      {body.kind === 'urlencoded' && <FieldDocumentation title="表单字段" fields={body.fields} />}
      {body.kind === 'multipart' && (
        <div className="space-y-2">
          <FieldDocumentation title="文本字段" fields={body.fields} />
          {(body.files ?? []).length === 0 ? <p className="text-xs text-muted-foreground">未保存文件引用</p> : (body.files ?? []).map((file) => (
            <p key={file.id} className="text-xs text-muted-foreground">文件字段 {file.name || '未命名'} · {file.fileName} · {file.sizeBytes} B{file.contentType ? ` · ${file.contentType}` : ''}</p>
          ))}
        </div>
      )}
      {body.kind === 'none' && <p className="text-xs text-muted-foreground">该请求没有正文。</p>}
    </section>
  )
}

/** 从 catalog 中的已保存请求定义即时生成只读接口文档。 */
export function ApiRequestDocumentation({ request, collectionName }: ApiRequestDocumentationProps): React.ReactElement {
  if (!request) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 px-6 text-center">
        <FileQuestion className="size-7 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-sm font-medium text-foreground">选择一条已保存请求</h2>
        <p className="max-w-md text-xs leading-5 text-muted-foreground">文档直接读取接口目录中的保存版本；未保存草稿不会生成文档。</p>
      </div>
    )
  }

  return (
    <article className="h-full min-h-0 overflow-y-auto" aria-label={`${request.name} 接口文档`}>
      <header className="space-y-2 border-b border-border px-4 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <BookOpen className="size-4 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-base font-semibold text-foreground">{request.name}</h2>
          <Badge variant="secondary">{request.method}</Badge>
          <Badge variant="outline">保存版本 {request.revision}</Badge>
        </div>
        <p className="break-all font-mono text-xs text-foreground">{request.url ? redactUrl(request.url) : '未填写 URL'}</p>
        <p className="text-xs text-muted-foreground">{collectionName ?? '未归属集合'}{request.folder ? ` / ${request.folder}` : ''}</p>
        <p className="text-sm leading-6 text-foreground/90">{request.description || '未填写接口说明。'}</p>
        <p className="text-[11px] text-muted-foreground">文档来自已保存定义；编辑器中的未保存修改不会反映在这里。</p>
      </header>

      <div className="space-y-4 px-4 py-4">
        <FieldDocumentation title="查询参数" fields={request.query} />
        <FieldDocumentation title="请求 Headers" fields={request.headers} />
        <section className="space-y-2 border-b border-border/60 pb-4">
          <h3 className="text-xs font-semibold text-foreground">鉴权</h3>
          <p className="text-xs text-muted-foreground">{describeAuth(request.auth)}</p>
        </section>
        <BodyDocumentation body={request.body} />

        <section className="space-y-2 border-b border-border/60 pb-4">
          <h3 className="text-xs font-semibold text-foreground">响应</h3>
          <div className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
            未定义响应结构。当前请求定义没有响应 schema，以下仅展示已保存的校验与提取规则。
          </div>
          {request.assertions.length === 0 ? <p className="text-xs text-muted-foreground">未定义默认断言</p> : (
            <ul className="space-y-1 text-xs text-foreground">{request.assertions.map((assertion) => <li key={assertion.id}>• {describeAssertion(assertion)}</li>)}</ul>
          )}
          {(request.extractions ?? []).length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-foreground">响应提取</p>
              {(request.extractions ?? []).map((extraction) => (
                <p key={extraction.id} className="text-xs text-muted-foreground">{extraction.from === 'json' ? `JSON ${extraction.path}` : extraction.from === 'header' ? `Header ${extraction.path}` : extraction.path ? `SSE 最后一条数据 ${extraction.path}` : 'SSE 最后一条数据'} → {extraction.name}{extraction.secret ? '（秘密变量）' : ''}</p>
              ))}
            </div>
          )}
        </section>

        <section className="space-y-2 pb-4">
          <h3 className="text-xs font-semibold text-foreground">测试用例</h3>
          {(request.cases ?? []).length === 0 ? <p className="text-xs text-muted-foreground">未定义具名用例</p> : (
            <div className="space-y-1">{(request.cases ?? []).map((testCase) => (
              <div key={testCase.id} className="flex flex-wrap items-center gap-2 text-xs"><span>{testCase.name}</span><Badge variant="outline">{testCase.source === 'agent' ? 'Agent' : '人工'}</Badge><span className="text-muted-foreground">{testCase.assertions.length} 条断言</span></div>
            ))}</div>
          )}
        </section>
      </div>
    </article>
  )
}
