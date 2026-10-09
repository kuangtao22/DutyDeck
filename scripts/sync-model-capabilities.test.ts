import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

// 同步脚本的绝对路径，保证测试切换到临时工作目录后仍执行仓库内脚本。
const SCRIPT_PATH = resolve(import.meta.dir, 'sync-model-capabilities.ts')
// 每个测试创建的临时目录，测试结束后统一清理。
const temporaryDirectories: string[] = []

/** 创建隔离工作目录，并预建同步脚本约定的输出目录。 */
async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'proma-model-capabilities-'))
  temporaryDirectories.push(workspace)
  await mkdir(join(workspace, 'packages/shared/src/constants'), { recursive: true })
  return workspace
}

/** 在指定工作目录执行同步脚本，返回可断言的进程结果。 */
function runScript(workspace: string, args: string[]): Bun.SpawnSyncReturns<Uint8Array> {
  return Bun.spawnSync(['bun', SCRIPT_PATH, ...args], {
    cwd: workspace,
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

/** 将测试源数据写为 JSON，并返回原始文本与路径。 */
async function writeSource(workspace: string, source: object): Promise<{ path: string; text: string }> {
  const text = JSON.stringify(source)
  const path = join(workspace, 'models.json')
  await writeFile(path, text, 'utf8')
  return { path, text }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('sync-model-capabilities', () => {
  test('只保留映射供应商的文本输出模型，并稳定转换能力与价格阶梯', async () => {
    const workspace = await createWorkspace()
    const { path: sourcePath, text: sourceText } = await writeSource(workspace, {
      ignored: {
        models: {
          ignored: { id: 'ignored', reasoning: false, modalities: { input: ['text'], output: ['text'] }, limit: {} },
        },
      },
      openai: {
        models: {
          'z-shared': {
            id: 'z-shared',
            canonical_model_id: 'vendor/shared',
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
            temperature: false,
            interleaved: { field: 'reasoning_content' },
            status: 'beta',
            modalities: { input: ['image', 'text'], output: ['text'] },
            limit: { context: 1000, input: 800, output: 200 },
            cost: {
              input: 1,
              output: 2,
              cache_read: 0.1,
              tiers: [
                { input: 4, output: 8, tier: { type: 'volume', size: 10 } },
                { input: 3, output: 6, cache_write: 0.3, tier: { type: 'context', size: 300 } },
              ],
              context_over_200k: { input: 9, output: 18 },
            },
          },
          'a-image': {
            id: 'a-image',
            reasoning: false,
            modalities: { input: ['text'], output: ['image'] },
            limit: { context: 0, output: 0 },
          },
        },
      },
      deepseek: {
        models: {
          'a-shared': {
            id: 'a-shared',
            canonical_model_id: 'vendor/shared',
            reasoning: false,
            modalities: { input: ['text'], output: ['text'] },
            limit: { context: 500, output: 100 },
            cost: { context_over_200k: { input: 5, cache_read: 0.5 } },
          },
        },
      },
    })

    const result = runScript(workspace, ['--source', sourcePath])

    expect(result.exitCode).toBe(0)
    const outputPath = join(workspace, 'packages/shared/src/constants/model-capabilities.generated.json')
    const snapshot = JSON.parse(await readFile(outputPath, 'utf8'))
    expect(Object.keys(snapshot.providers)).toEqual(['deepseek', 'openai'])
    expect(Object.keys(snapshot.providers.openai)).toEqual(['z-shared'])
    expect(snapshot).toEqual({
      source: 'https://models.dev/api.json',
      sha256: createHash('sha256').update(sourceText).digest('hex'),
      providers: {
        deepseek: {
          'a-shared': {
            reasoning: false,
            reasoningOptions: [],
            contextWindow: 500,
            maxOutputTokens: 100,
            inputModalities: ['text'],
            outputModalities: ['text'],
            cost: { tiers: [{ inputTokensAbove: 200000, input: 5, cacheRead: 0.5 }] },
          },
        },
        openai: {
          'z-shared': {
            reasoning: true,
            reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }],
            temperature: false,
            contextWindow: 1000,
            maxInputTokens: 800,
            maxOutputTokens: 200,
            inputModalities: ['image', 'text'],
            outputModalities: ['text'],
            interleaved: { field: 'reasoning_content' },
            status: 'beta',
            cost: {
              input: 1,
              output: 2,
              cacheRead: 0.1,
              tiers: [{ inputTokensAbove: 300, input: 3, output: 6, cacheWrite: 0.3 }],
            },
          },
        },
      },
    })
    expect(await readFile(outputPath, 'utf8')).toEndWith('\n')
  })

  test('--check 在快照一致时成功，存在差异时退出 1 且不覆盖文件', async () => {
    const workspace = await createWorkspace()
    const { path: sourcePath } = await writeSource(workspace, {
      openai: {
        models: {
          model: { id: 'model', reasoning: false, modalities: { input: ['text'], output: ['text'] }, limit: {} },
        },
      },
    })
    expect(runScript(workspace, ['--source', sourcePath]).exitCode).toBe(0)
    expect(runScript(workspace, ['--source', sourcePath, '--check']).exitCode).toBe(0)
    const outputPath = join(workspace, 'packages/shared/src/constants/model-capabilities.generated.json')
    await writeFile(outputPath, '{"stale":true}\n', 'utf8')

    const staleResult = runScript(workspace, ['--source', sourcePath, '--check'])

    expect(staleResult.exitCode).toBe(1)
    expect(new TextDecoder().decode(staleResult.stderr)).toContain('模型能力快照已过期')
    expect(await readFile(outputPath, 'utf8')).toBe('{"stale":true}\n')
  })

  test('拒绝负数能力值，且不生成不可信快照', async () => {
    const workspace = await createWorkspace()
    const { path: sourcePath } = await writeSource(workspace, {
      openai: {
        models: {
          invalid: {
            id: 'invalid',
            reasoning: false,
            modalities: { input: ['text'], output: ['text'] },
            limit: { context: -1 },
          },
        },
      },
    })

    const result = runScript(workspace, ['--source', sourcePath])

    expect(result.exitCode).toBe(1)
    expect(new TextDecoder().decode(result.stderr)).toContain('非负有限数字')
    expect(await Bun.file(join(workspace, 'packages/shared/src/constants/model-capabilities.generated.json')).exists()).toBe(false)
  })
})
