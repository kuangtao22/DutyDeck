/** 编排工厂输出证据的确定性校验：保留模型原文，只报告引用完整性与来源问题。 */

/** 统一空白，避免 JSONL 或模型输出的换行差异遮蔽逐字比较。 */
function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * 读取 JSON / JSONL 文本中的结构，不修改原始输出；普通文本返回空数组。
 * @param value 待检查文本，允许完整的 JSON 代码围栏。
 * @returns 成功解析的对象或数组；文本语义仍由内容评审处理。
 */
function structuredValues(value: string): unknown[] {
  /** 只移除完整围栏，不从自然语言中猜测 JSON 边界。 */
  const text = value.trim().replace(/^```(?:jsonl?)?\s*([\s\S]*?)\s*```$/i, '$1').trim()
  if (!text.startsWith('{') && !text.startsWith('[')) return []
  try {
    return [JSON.parse(text)]
  } catch {
    return text.split(/\r?\n/).flatMap((line) => {
      try { return [JSON.parse(line)] } catch { return [] }
    })
  }
}

/**
 * 从可信输入收集 paragraphRef → 原文；同 ref 内容冲突时标成不可用，不以后写覆盖。
 * @param value 用户输入或成功工具步骤的输出；调用方不得混入模型输出。
 * @param index 原文索引，null 表示该引用有冲突。
 * @param issues 校验问题，直接追加以保留所有来源冲突。
 * @param depth 当前嵌套层数，限制异常数据的递归开销。
 */
function collectParagraphs(value: unknown, index: Map<string, string | null>, issues: string[], depth = 0): void {
  if (value === null || value === undefined) return
  if (depth > 32) {
    issues.push('原文嵌套过深，无法完整建立证据索引')
    return
  }
  if (typeof value === 'string') {
    for (const parsed of structuredValues(value)) collectParagraphs(parsed, index, issues, depth + 1)
    return
  }
  if (Array.isArray(value)) {
    for (const child of value) collectParagraphs(child, index, issues, depth + 1)
    return
  }
  if (typeof value !== 'object') return
  /** 只从带原文 text 的段落对象建索引，引用的 selectedText 不是来源。 */
  const record = value as Record<string, unknown>
  if (typeof record.paragraphRef === 'string' && record.paragraphRef.trim() && typeof record.text === 'string') {
    /** 比较统一空白后的原文，重复携带同一段落不算冲突。 */
    const source = normalizeText(record.text)
    if (index.has(record.paragraphRef) && index.get(record.paragraphRef) !== source) {
      index.set(record.paragraphRef, null)
      issues.push(`paragraphRef「${record.paragraphRef}」对应的原文来源冲突，无法验证引用`)
    } else index.set(record.paragraphRef, source)
  }
  for (const child of Object.values(record)) collectParagraphs(child, index, issues, depth + 1)
}

/**
 * 校验输出引用是否能回到可信原文；摘要是否被同组证据支持交给内容评审。
 * @param input 仅包含用户输入与成功工具输出的可信材料。
 * @param output 最终输出或模型步骤输出；支持对象、数组、JSON 和 JSONL 文本。
 * @returns 可定位的问题列表；空数组表示未发现确定性的引用问题。
 */
export function validateCapabilityEvidence(input: Record<string, unknown>, output: unknown): string[] {
  /** Map 避免 paragraphRef 命中原型属性，null 让冲突来源始终不可用。 */
  const paragraphs = new Map<string, string | null>()
  /** 汇集来源冲突与输出引用问题，去重后交给运行记录。 */
  const issues: string[] = []
  collectParagraphs(input, paragraphs, issues)

  /** 递归校验引用；inEvidence 用于识别 evidence 下缺失两个字段的空引用。 */
  const visit = (value: unknown, path: string, depth = 0, inEvidence = false): void => {
    if (depth > 32) {
      issues.push(`${path} 嵌套过深，无法完整校验证据`)
      return
    }
    if (typeof value === 'string') {
      /** 普通叙述保留给评审；结构化文本继续递归检查。 */
      const parsed = structuredValues(value)
      parsed.forEach((item, index) => visit(item, `${path}[JSON:${index}]`, depth + 1, inEvidence))
      if (inEvidence && !value.trim()) issues.push(`${path} 引用为空`)
      return
    }
    if (value === null || value === undefined) {
      if (inEvidence) issues.push(`${path} 引用为空`)
      return
    }
    if (Array.isArray(value)) {
      if (inEvidence && value.length === 0) issues.push(`${path} 引用为空`)
      value.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1, inEvidence))
      return
    }
    if (typeof value !== 'object') {
      if (inEvidence) issues.push(`${path} 不是有效引用`)
      return
    }
    /** 只检查显式段落引用；URL、文件定位等其它证据结构仍交给场景评审。 */
    const record = value as Record<string, unknown>
    const hasCitationField = 'selectedText' in record || ('paragraphRef' in record && (inEvidence || !('text' in record)))
    if (inEvidence && Object.keys(record).length === 0) issues.push(`${path} 引用为空`)
    if (hasCitationField) {
      const paragraphRef = typeof record.paragraphRef === 'string' ? record.paragraphRef : ''
      const selectedText = typeof record.selectedText === 'string' ? normalizeText(record.selectedText) : ''
      if (!paragraphRef.trim()) issues.push(`${path}.paragraphRef 缺失或为空`)
      if (!selectedText) issues.push(`${path}.selectedText 缺失或为空`)
      if (paragraphRef.trim() && selectedText) {
        const source = paragraphs.get(paragraphRef)
        if (source === undefined) issues.push(`${path}.paragraphRef「${paragraphRef}」不在可信原文段落中`)
        else if (source === null) issues.push(`${path}.paragraphRef「${paragraphRef}」的原文来源冲突`)
        else if (!source.includes(selectedText)) issues.push(`${path}.selectedText 不逐字属于 paragraphRef「${paragraphRef}」`)
      }
    }
    for (const [key, child] of Object.entries(record)) {
      /** 已核对的引用字面量不再当作 JSON 结构解释。 */
      if (key === 'paragraphRef' || key === 'selectedText') continue
      visit(child, `${path}.${key}`, depth + 1, key === 'evidence' || (inEvidence && typeof child === 'object'))
    }
  }

  visit(output, '$')
  return [...new Set(issues)]
}
