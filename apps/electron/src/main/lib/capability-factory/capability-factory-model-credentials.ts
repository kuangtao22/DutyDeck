/** 工厂 UI 与 Agent 共用订阅凭据入口；凭据仅留在主进程，不进入场景或运行记录。 */
import {
  getChannelById, persistCodexOAuthCredentials, persistGithubCopilotOAuthCredentials, persistXaiOAuthCredentials,
  resolveCodexOAuthCredentials, resolveGithubCopilotOAuthCredentials, resolveXaiOAuthCredentials,
} from '../channel-manager'
import type { CapabilityFactorySubscriptionCredentials } from './capability-factory-model-call'

/** 输入已配置渠道 ID，返回 Pi 所需凭据与刷新回调；不存在或停用时立即拒绝。 */
export async function resolveCapabilityFactorySubscriptionCredentials(channelId: string): Promise<CapabilityFactorySubscriptionCredentials> {
  /** 每次调用复核渠道，避免沿用打开选择器时的启用状态。 */
  const channel = getChannelById(channelId)
  if (!channel?.enabled) throw new Error('所选订阅渠道已不可用，请重新选择。')
  if (channel.provider === 'openai-codex') {
    return {
      codexOAuthCredentials: await resolveCodexOAuthCredentials(channelId),
      onCodexOAuthCredentialsRefreshed: (credentials) => persistCodexOAuthCredentials(channelId, credentials),
    }
  }
  if (channel.provider === 'xai') {
    return {
      xaiOAuthCredentials: await resolveXaiOAuthCredentials(channelId),
      onXaiOAuthCredentialsRefreshed: (credentials) => persistXaiOAuthCredentials(channelId, credentials),
    }
  }
  if (channel.provider === 'github-copilot') {
    /** 条件写回尊重等待期间重新登录的账号；只推进本次成功写入的凭据快照。 */
    let expectedCredentials = await resolveGithubCopilotOAuthCredentials(channelId)
    return {
      githubCopilotOAuthCredentials: expectedCredentials,
      onGithubCopilotOAuthCredentialsRefreshed: (credentials) => {
        if (persistGithubCopilotOAuthCredentials(channelId, credentials, expectedCredentials)) expectedCredentials = credentials
      },
    }
  }
  throw new Error('所选渠道不是已支持的订阅渠道。')
}
