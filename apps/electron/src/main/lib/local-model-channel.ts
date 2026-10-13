import type { Channel, LocalModelSnapshot } from '@proma/shared'

/** 将资产清单投影为渠道模型；磁盘渠道里的手工模型与凭据不能绕过本地能力验证。 */
export function projectLocalModelChannel(channel: Channel, snapshot: LocalModelSnapshot): Channel {
  if (channel.provider !== 'dutydeck-local') return channel
  return {
    ...channel, baseUrl: '', apiKey: '',
    models: snapshot.catalog.map((entry) => {
      /** 当前 revision 的权威资产，只接受精确 assetId。 */
      const asset = snapshot.assets.find((candidate) => candidate.assetId === entry.assetId)
      return {
        id: entry.assetId, name: entry.name, source: 'fetched' as const,
        enabled: Boolean(asset?.enabled && asset.capability.state === 'available' && snapshot.engine?.available),
      }
    }),
  }
}
