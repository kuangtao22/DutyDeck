import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@proma/shared'
import { projectSessionAttachmentPaths } from './session-attachment-path-compat'

/** 将测试中的旧受管根映射到新根；外部路径保持原样。 */
function resolvePath(path: string): string {
  return path.startsWith('/old/attachments/') ? path.replace('/old/', '/new/') : path
}

describe('历史会话附件路径只读投影', () => {
  test('给定空值或非对象历史记录，投影保留输入且不调用路径解析器', () => {
    /** JSONL 能解析这些值，但附件投影不应扩大坏记录的影响范围。 */
    const records: unknown[] = [null, undefined, false, 0, 'text', []]
    for (const record of records) {
      expect(projectSessionAttachmentPaths(record as SDKMessage, () => { throw new Error('不应解析') }) as unknown).toBe(record)
    }
  })

  test('给定用户附档文本，仅读取附档区块中的绝对路径', () => {
    /** 同时包含附档协议、普通正文和相对路径的历史消息。 */
    const message: SDKMessage = { type: 'user', message: { content: [{ type: 'text', text: '正文 /old/attachments/a.png\n<attached_files>\n- a.png: /old/attachments/a.png\n- external.png: /external/a.png\n- relative.png: relative/a.png\n</attached_files>\n结尾 /old/attachments/a.png' }] } }
    /** 投影结果仅更新严格的附档行。 */
    const projected = projectSessionAttachmentPaths(message, resolvePath)
    expect(JSON.stringify(projected)).toContain('- a.png: /new/attachments/a.png')
    expect(JSON.stringify(projected)).toContain('正文 /old/attachments/a.png')
    expect(JSON.stringify(projected)).toContain('结尾 /old/attachments/a.png')
    expect(JSON.stringify(projected)).toContain('relative/a.png')
    expect(JSON.stringify(message)).not.toContain('/new/')
  })

  test('给定结构化媒体和工具图片，只映射已知附件字段并保留其他对象', () => {
    /** 不应遍历的普通工具参数。 */
    const input = { localPath: '/old/attachments/input.png' }
    /** 三个允许的附件层级及不应改写的任意嵌套数据。 */
    const message: SDKMessage = {
      type: 'user',
      attachments: [{ localPath: '/old/attachments/top.png', label: '/old/attachments/label.png' }],
      mediaAttachments: [{ localPath: '/old/attachments/media.mp4', targetPath: '/old/attachments/target.mp4' }],
      message: {
        imageAttachments: [{ localPath: '/old/attachments/nested.png' }],
        content: [
          { type: 'tool_use', input },
          { type: 'tool_result', imageAttachments: [{ localPath: '/old/attachments/tool.png' }], content: [{ type: 'text', text: '<attached_files>\n- result.png: /old/attachments/result.png\n</attached_files>' }] },
        ],
      },
    }
    /** 保存输入快照验证函数不修改原始对象。 */
    const original = JSON.stringify(message)
    /** 映射后消息仍保留原有工具输入内容。 */
    const projected = projectSessionAttachmentPaths(message, resolvePath)
    expect(JSON.stringify(projected)).toContain('/new/attachments/top.png')
    expect(JSON.stringify(projected)).toContain('/new/attachments/media.mp4')
    expect(JSON.stringify(projected)).toContain('/new/attachments/target.mp4')
    expect(JSON.stringify(projected)).toContain('/new/attachments/nested.png')
    expect(JSON.stringify(projected)).toContain('/new/attachments/tool.png')
    expect(JSON.stringify(projected)).toContain('/new/attachments/result.png')
    expect(JSON.stringify(projected)).toContain('/old/attachments/input.png')
    expect(JSON.stringify(projected)).toContain('/old/attachments/label.png')
    expect(JSON.stringify(message)).toBe(original)
  })

  test('给定普通正文、工具命令或外部附件，无变化时复用原对象', () => {
    /** 即使正文含旧路径也不具有附件授权语义。 */
    const message: SDKMessage = { type: 'assistant', message: { content: [{ type: 'text', text: '/old/attachments/a.png' }, { type: 'tool_use', input: { command: 'cat /old/attachments/a.png' } }] }, attachments: [{ localPath: '/external/a.png' }] }
    expect(projectSessionAttachmentPaths(message, resolvePath)).toBe(message)
  })

  test('给定畸形附档行和嵌套未知对象，不调用路径解析器', () => {
    /** 不应作为附件路径读取的文本及未知层级。 */
    const message: SDKMessage = { type: 'user', message: { content: [{ type: 'text', text: '<attached_files>\n a.png: /old/attachments/a.png\n- relative.png: ./file.png\n</attached_files>' }] }, metadata: { attachments: [{ localPath: '/old/attachments/a.png' }] } }
    expect(projectSessionAttachmentPaths(message, () => { throw new Error('不应解析') })).toBe(message)
  })
})

describe('可移植会话附件引用', () => {
  test('给定字符串 content 和受管引用，读取时解析且不改变普通正文', () => {
    /** 新保存的字符串格式消息。 */
    const message: SDKMessage = { type: 'user', message: { content: '正文 dutydeck-data:/attachments/a.png\n<attached_files>\n- a.png: dutydeck-data:/attachments/a.png\n</attached_files>' } }
    /** 受管引用解析后的展示消息。 */
    const result = projectSessionAttachmentPaths(message, (path) => path.replace('dutydeck-data:/', '/new/'))
    expect(JSON.stringify(result)).toContain('- a.png: /new/attachments/a.png')
    expect(JSON.stringify(result)).toContain('正文 dutydeck-data:/attachments/a.png')
    expect(JSON.stringify(message)).not.toContain('/new/')
  })
})

  test('给定自定义数据根中的附件 When 连续两次搬迁 Then 相同引用按当前根解析且不依赖最初目录', async () => {
    /** 注入根定位器，不触碰真实用户数据或 locator。 */
    const { createDataRootPathResolver, createDataRootPathSerializer } = await import('./config-paths')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const firstRoot = join(tmpdir(), 'portable-first')
    const secondRoot = join(tmpdir(), 'portable-second')
    const thirdRoot = join(tmpdir(), 'portable-third')
    const suffix = join('agent-workspaces', 'project', 'session', 'attachments', '图片 #1.png')
    const initial = { type: 'user', mediaAttachments: [{ targetPath: join(firstRoot, suffix) }], message: { content: `<attached_files>\n- 图片: ${join(firstRoot, suffix)}\n</attached_files>` } } as unknown as SDKMessage
    const stored = projectSessionAttachmentPaths(initial, createDataRootPathSerializer({ requireActiveRoot: () => firstRoot }))
    expect(JSON.stringify(stored)).not.toContain(firstRoot)
    const second = projectSessionAttachmentPaths(stored, createDataRootPathResolver({ requireActiveRoot: () => secondRoot }))
    expect(JSON.stringify(second)).toContain(join(secondRoot, suffix))
    const storedAgain = projectSessionAttachmentPaths(second, createDataRootPathSerializer({ requireActiveRoot: () => secondRoot }))
    expect(storedAgain).toEqual(stored)
    const third = projectSessionAttachmentPaths(storedAgain, createDataRootPathResolver({ requireActiveRoot: () => thirdRoot }))
    expect(JSON.stringify(third)).toContain(join(thirdRoot, suffix))
  })


test('Given 单条损坏受管引用 When 投影附件与附档行 Then 保留损坏字段并继续转换有效引用', async () => {
  /** 使用真实引用编解码器触发非法分段错误。 */
  const { createDataRootReferenceCodec } = await import('./data-root-reference')
  const codec = createDataRootReferenceCodec('/current')
  const badPath = 'dutydeck-data:/attachments/../private.txt'
  const message = { type: 'user', attachments: [{ localPath: badPath }, { localPath: 'dutydeck-data:/attachments/good.txt' }], message: { content: `<attached_files>\n- bad: ${badPath}\n- good: dutydeck-data:/attachments/good.txt\n</attached_files>\n正文保留` } } as SDKMessage
  const original = JSON.stringify(message)
  const result = projectSessionAttachmentPaths(message, codec.resolve)
  expect(JSON.stringify(result)).toContain(badPath)
  expect(JSON.stringify(result)).toContain('/current/attachments/good.txt')
  expect(JSON.stringify(result)).toContain('正文保留')
  expect(JSON.stringify(message)).toBe(original)
  expect(() => projectSessionAttachmentPaths(message, () => { throw new Error('数据根不可用') })).toThrow('数据根不可用')
})
