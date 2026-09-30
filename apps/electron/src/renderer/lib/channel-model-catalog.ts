import type { ChannelModel, ProviderType } from '@proma/shared'

/**
 * 合并供应商拉取的权威模型目录，返回供选择器和渠道保存使用的模型列表。
 * Copilot 的目录同时代表账号授权范围，不能保留目录外的手工模型；
 * 其他渠道延续手工模型保留与启用状态规则。
 */
export function mergeFetchedChannelModels(
  provider: ProviderType,
  previous: ChannelModel[],
  fetched: ChannelModel[],
): ChannelModel[] {
  if (provider === 'github-copilot') return fetched.map((model) => ({ ...model, enabled: true }))
  /** 当前拉取结果的 ID 集合，用于保留目录外手工配置。 */
  const fetchedIds = new Set(fetched.map((model) => model.id))
  /** 当前渠道的历史选择，用于保持普通 API 模型的启用状态。 */
  const previousById = new Map(previous.map((model) => [model.id, model]))
  return [
    ...previous.filter((model) => model.source === 'manual' && !fetchedIds.has(model.id)),
    ...fetched.map((model) => ({
      ...model,
      enabled: provider === 'openai-codex' || provider === 'xai'
        ? true : previousById.get(model.id)?.enabled ?? false,
    })),
  ]
}
