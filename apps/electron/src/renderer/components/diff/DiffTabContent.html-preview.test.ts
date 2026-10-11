import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

/** 提取真实源码加载 effect，避免引入整套 DOM、编辑器和 Electron 环境。 */
function getContentLoadEffect(): string {
  const sourcePath = new URL('./DiffTabContent.tsx', import.meta.url)
  const source = ts.createSourceFile(sourcePath.pathname, readFileSync(sourcePath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let effect = ''
  /** 只选负责读取源码的 effect；HTML 授权 effect 必须与之独立。 */
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'React.useEffect') {
      const callback = node.arguments[0]
      if (callback?.getText(source).includes('async function load()')) effect = callback.getText(source)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!effect) throw new Error('未找到文件源码加载 effect')
  return ts.transpileModule(`(${effect})`, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS } }).outputText
}

describe('HTML 源码与渲染授权分离', () => {
  test('Given HTML 渲染授权不可用 When 文件内容读取成功 Then 仍保存源码且源码加载不申请授权', async () => {
    /** 收集真实 effect 提交的源码、缓存与加载状态。 */
    const contentUpdates: string[] = []
    const cacheUpdates: unknown[] = []
    const loadingUpdates: boolean[] = []
    let htmlRequests = 0
    const noOp = (): void => {}
    /** 仅替换边界依赖，执行组件当前的真实 load 实现。 */
    const bindings: Record<string, unknown> = {
      previewOnly: true, previewContentVersion: 0, refreshVersion: 0,
      filePath: '/workspace/index.html', fileAccess: {}, previewContentRefreshKey: 'page',
      isEditableText: false, activeMarkdownEditing: false, isLegacyOffice: false,
      isOfficePreview: false, isPdf: false, isImage: false, isHtml: true, ext: '.html',
      getContentCacheKey: () => 'preview', getPreviewContentCache: () => undefined,
      setPreviewContentCache: (_key: string, value: unknown) => { cacheUpdates.push(value) },
      setNewContent: (value: string) => { contentUpdates.push(value) },
      setLoading: (value: boolean) => { loadingUpdates.push(value) },
      setOldContent: noOp, setOfficeHtml: noOp, setOfficeHtmlUrl: noOp, setOfficeText: noOp,
      setHtmlPreviewUrl: noOp, setUnsupportedPreviewReason: noOp, setPreviewMetadata: noOp,
      setPdfSrc: noOp, setPdfZoom: noOp, setImagePath: noOp, setImageDataUrl: noOp,
      setImageZoom: noOp, setImageNaturalSize: noOp, setPreviewResolvedPaths: noOp,
      restoreScrollRef: { current: false }, lastNewContentRef: { current: '' }, lastOldContentRef: { current: '' },
      scrollPositionCache: new Map(), scrollKey: 'page', MD_EXTS: new Set(['.md']),
      window: { electronAPI: {
        resolveAndReadFile: async () => ({ content: '<h1>可复制的源码</h1>', resolvedPath: '/workspace/index.html' }),
        resolveHtmlPreviewPath: async () => { htmlRequests += 1; throw new Error('资源授权失败') },
      } },
    }
    /** 执行转译后的真实 effect；异步读取在下面的微任务等待中完成。 */
    const run = new Function(...Object.keys(bindings), `return ${getContentLoadEffect()}`)(...Object.values(bindings)) as () => (() => void)
    const dispose = run()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(contentUpdates.at(-1)).toBe('<h1>可复制的源码</h1>')
    expect(cacheUpdates).toEqual([{ oldContent: '', newContent: '<h1>可复制的源码</h1>' }])
    expect(htmlRequests).toBe(0)
    expect(loadingUpdates.at(-1)).toBe(false)
    dispose()
  })
})
