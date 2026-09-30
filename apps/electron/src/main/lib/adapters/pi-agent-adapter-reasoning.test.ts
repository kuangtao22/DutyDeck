import { describe, expect, mock, test } from 'bun:test'

mock.module('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getName: () => 'Proma Test' },
  BrowserWindow: { getAllWindows: () => [] },
  WebContentsView: class {},
  MessageChannelMain: class {},
  utilityProcess: {},
  ipcMain: { handle: () => undefined, removeHandler: () => undefined },
  shell: { openExternal: async () => undefined, openPath: async () => '' },
  dialog: {}, clipboard: {}, nativeImage: {}, screen: {}, globalShortcut: {},
  powerSaveBlocker: {}, powerMonitor: {}, systemPreferences: {}, Menu: {},
  Notification: class {},
  net: {},
  session: {},
  safeStorage: { isEncryptionAvailable: () => false },
  default: {},
}))

/** 动态导入确保 Electron 替身先于 adapter 依赖生效。 */
const { resolvePiOpenAIReasoningProfile } = await import('./pi-agent-adapter')

describe('Copilot 多协议 reasoning 请求扩展', () => {
  test('Given Copilot GPT 使用 OpenAI Responses When 解析扩展 profile Then 启用 OpenAI effort', () => {
    /** GPT 模型应命中 OpenAI Responses reasoning profile。 */
    const profile = resolvePiOpenAIReasoningProfile(
      'github-copilot',
      'gpt-5.3-codex',
      'openai-responses',
    )

    expect(profile?.id).toBe('openai-reasoning-standard')
    expect(profile?.encodings['openai-responses']?.kind).toBe('openai-reasoning-effort')
  })

  test('Given Copilot Claude 使用 Anthropic Messages When 解析扩展 profile Then 不注入 OpenAI effort', () => {
    /** Claude 模型不得创建会改写 OpenAI 请求体的扩展。 */
    const profile = resolvePiOpenAIReasoningProfile(
      'github-copilot',
      'claude-sonnet-5',
      'anthropic-messages',
    )

    expect(profile).toBeUndefined()
  })
})
