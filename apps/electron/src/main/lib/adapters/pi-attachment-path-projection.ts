import type { Agent } from '@earendil-works/pi-agent-core'
import type { SDKMessage } from '@proma/shared'
import { createDataRootReferenceCodec } from '../data-root-reference'
import type { DataRootPathSnapshot } from '../data-root-reference'
import { projectSessionAttachmentPaths } from '../session-attachment-path-compat'

/**
 * 为模型请求恢复历史附档的当前路径；不修改 Pi transcript 或任意工具参数。
 * @param agent 已创建的 Pi Agent，保留其既有请求转换链。
 * @param snapshot 由宿主解析并固定的根；缺失时沿用旧调用方行为。
 */
export function installPiAttachmentPathProjection(agent: Pick<Agent, 'transformContext'>, snapshot?: DataRootPathSnapshot): void {
  if (!snapshot) return
  /** 每次查询只创建一次编解码器，模型多轮请求无额外磁盘 I/O。 */
  const codec = createDataRootReferenceCodec(snapshot.activeRoot, snapshot.historicalRoots)
  const previousTransform = agent.transformContext
  agent.transformContext = async (messages, signal) => {
    const prepared = await previousTransform?.(messages, signal) ?? messages
    return prepared.map((message) => {
      if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'toolResult') return message
      /** SDK 外壳仅适配已有已知字段投影器；实际 Pi 消息内容不做格式转换。 */
      const wrapper = { type: 'user', message } as unknown as SDKMessage
      const projected = projectSessionAttachmentPaths(wrapper, codec.resolve)
      return projected === wrapper ? message : (projected as unknown as { message: typeof message }).message
    })
  }
}
