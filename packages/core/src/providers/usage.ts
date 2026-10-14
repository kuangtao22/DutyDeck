import type { TokenUsageAmounts } from '@proma/shared'

/** 只接受供应商报告的非负安全整数；缺失和非法值保持未知。 */
export function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** 未报告 usage 的标准空值，供流式累积使用。 */
export function emptyUsage(): TokenUsageAmounts {
  return { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }
}

/** 安全读取 JSON 对象，非对象不推断用量。 */
export function usageObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** 合并同一调用的累计快照；缺失字段不能覆盖已经报告的数值，零有效。 */
export function mergeUsage(previous: TokenUsageAmounts, next: TokenUsageAmounts): TokenUsageAmounts {
  return {
    inputTokens: next.inputTokens ?? previous.inputTokens,
    outputTokens: next.outputTokens ?? previous.outputTokens,
    cacheReadTokens: next.cacheReadTokens ?? previous.cacheReadTokens,
    cacheWriteTokens: next.cacheWriteTokens ?? previous.cacheWriteTokens,
  }
}

/** 将 Anthropic 的未缓存输入与缓存拆分相加；没有输入基数时保持未知。 */
export function inclusiveAnthropicInput(input: number | null, read: number | null, write: number | null): number | null {
  return input === null ? null : tokenCount(input + (read ?? 0) + (write ?? 0))
}

/** 按实际协议归一化响应；OpenAI 输出已含 reasoning，Google thoughts 另计。 */
export function normalizeProviderUsage(value: unknown, protocol: 'anthropic' | 'openai' | 'responses' | 'google'): TokenUsageAmounts {
  /** 原始 usage 对象，无对象时返回全未知。 */
  const raw = usageObject(value)
  if (!raw) return emptyUsage()
  if (protocol === 'anthropic') {
    /** Anthropic 输入基数不包含两类缓存。 */
    const read = tokenCount(raw.cache_read_input_tokens)
    const write = tokenCount(raw.cache_creation_input_tokens)
    return { inputTokens: inclusiveAnthropicInput(tokenCount(raw.input_tokens), read, write), outputTokens: tokenCount(raw.output_tokens), cacheReadTokens: read, cacheWriteTokens: write }
  }
  if (protocol === 'google') {
    /** Google 候选输出不含独立报告的思考 Token；缺失候选输出不能推为零。 */
    const output = tokenCount(raw.candidatesTokenCount)
    const thoughts = tokenCount(raw.thoughtsTokenCount)
    return { inputTokens: tokenCount(raw.promptTokenCount), outputTokens: output === null ? null : tokenCount(output + (thoughts ?? 0)), cacheReadTokens: tokenCount(raw.cachedContentTokenCount), cacheWriteTokens: null }
  }
  /** 两种 OpenAI 协议均已把缓存包含在输入、推理包含在输出中。 */
  const responses = protocol === 'responses'
  const details = usageObject(responses ? raw.input_tokens_details : raw.prompt_tokens_details)
  return { inputTokens: tokenCount(responses ? raw.input_tokens : raw.prompt_tokens), outputTokens: tokenCount(responses ? raw.output_tokens : raw.completion_tokens), cacheReadTokens: tokenCount(details?.cached_tokens), cacheWriteTokens: null }
}
