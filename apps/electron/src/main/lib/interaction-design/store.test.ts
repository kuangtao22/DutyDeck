import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InteractionDesignService } from './store'
import { InteractionSourceService, interactionHash } from './source-service'

/** 测试独立目录，禁止触碰真实项目数据。 */
const roots: string[] = []
/** 创建隔离工作区服务。 */
function setup(): { root: string; service: InteractionDesignService } {
  /** 临时项目根。 */
  const root = mkdtempSync(join(tmpdir(), 'interaction-store-'))
  roots.push(root)
  return { root, service: new InteractionDesignService({ workspaceId: 'workspace', projectRoot: root }) }
}
/** 每例删除自己创建的隔离项目。 */
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
/** 统一的测试会话。 */
const sessionId = 'session'

describe('交互设计版本与候选', () => {
  it('Given 空项目 When 从页面入口创建 Then 一次生成隐藏空间和用户命名页面', async () => {
    /** 隔离服务。 */
    const { service } = setup()
    const snapshot = await service.invoke('create', { sessionId, name: '欢迎页', pageName: '欢迎页', platform: 'mobile' })
    expect(snapshot.document.name).toBe('交互设计')
    expect(snapshot.document.pages).toHaveLength(1)
    expect(snapshot.document.pages[0]!.name).toBe('欢迎页')
    expect(snapshot.document.entryPageId).toBe(snapshot.document.pages[0]!.id)
  })
  it('Given 项目已有交互模块 When 再次创建 Then 拒绝创建第二个模块', async () => {
    const { service } = setup()
    await service.invoke('create', { sessionId, name: '唯一模块', platform: 'mobile' })
    await expect(service.invoke('create', { sessionId, name: '重复模块', platform: 'desktop' })).rejects.toThrow('已存在')
  })
  it('Given 新项目 When 创建、保存及恢复 Then 只切换当前版本且保留后续历史', async () => {
    /** 隔离服务。 */
    const { root, service } = setup()
    /** 初始快照。 */
    const first = await service.invoke('create', { sessionId, name: '测试原型', platform: 'mobile' })
    /** 完整编辑内容。 */
    const draft = { ...first.document, name: '修改名称' }
    /** 新版本。 */
    const saved = await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft, summary: '改名' })
    expect(saved.document.revision).toBe(2)
    expect((await service.invoke('getVersion', { sessionId, prototypeId: first.document.id, revision: 1 })).name).toBe('测试原型')
    /** 恢复前记录不可变版本文件，恢复只能改 head 指针。 */
    const revisionsDirectory = join(root, '.proma', 'interaction-design', 'prototypes', first.document.id, 'revisions')
    const beforeRestore = readdirSync(revisionsDirectory).sort().map(name => [name, readFileSync(join(revisionsDirectory, name))] as const)
    /** 历史恢复。 */
    const restored = await service.invoke('restore', { sessionId, prototypeId: first.document.id, baseRevision: 2, revision: 1 })
    expect(restored.document.revision).toBe(1)
    expect(restored.document.name).toBe('测试原型')
    expect(restored.versions).toHaveLength(2)
    expect(restored.versions.map(version => version.revision)).toEqual([2, 1])
    expect(readdirSync(revisionsDirectory).sort().map(name => [name, readFileSync(join(revisionsDirectory, name))] as const)).toEqual(beforeRestore)
    expect((await service.invoke('getVersion', { sessionId, prototypeId: first.document.id, revision: 2 })).name).toBe('修改名称')
    /** 从恢复后的旧版本继续保存，必须分配历史最高版本之后的新编号。 */
    const continued = await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: restored.document, summary: '从旧版本继续' })
    expect(continued.document.revision).toBe(3)
    expect(continued.versions.map(version => version.revision)).toEqual([3, 2, 1])
  })
  it('Given 当前版本与历史版本 When 删除历史 Then 只移除目标记录且保留版本高水位', async () => {
    /** 隔离项目目录与服务。 */
    const { root, service } = setup()
    /** 初始版本，用作历史基线。 */
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    /** 第二版，作为中间历史删除目标。 */
    const second = await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: { ...first.document, name: '第二版' }, summary: '第二版' })
    /** 当前第三版，必须保留。 */
    const third = await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 2, draft: { ...second.document, name: '第三版' }, summary: '第三版' })
    /** 临时项目版本目录，用于核对实际文件删除。 */
    const revisionsDirectory = join(root, '.proma', 'interaction-design', 'prototypes', first.document.id, 'revisions')
    await expect(service.invoke('deleteVersion', { sessionId, prototypeId: first.document.id, baseRevision: 2, revision: 1 })).rejects.toThrow('版本已变化')
    await expect(service.invoke('deleteVersion', { sessionId, prototypeId: first.document.id, baseRevision: 3, revision: 9 })).rejects.toThrow('版本不存在')
    /** 删除中间历史后的权威快照。 */
    const deleted = await service.invoke('deleteVersion', { sessionId, prototypeId: first.document.id, baseRevision: 3, revision: 2 })
    expect(deleted.document.revision).toBe(3)
    expect(deleted.versions.map(version => version.revision)).toEqual([3, 1])
    expect(readdirSync(revisionsDirectory).sort()).toEqual(['1.json', '3.json'])
    await expect(service.invoke('getVersion', { sessionId, prototypeId: first.document.id, revision: 2 })).rejects.toThrow('版本不存在')
    await expect(service.invoke('deleteVersion', { sessionId, prototypeId: first.document.id, baseRevision: 3, revision: 2 })).rejects.toThrow('版本不存在')
    await expect(service.invoke('deleteVersion', { sessionId, prototypeId: first.document.id, baseRevision: 3, revision: 3 })).rejects.toThrow('当前版本不能删除')
    /** 删除后继续保存的新版本。 */
    const continued = await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 3, draft: { ...third.document, name: '第四版' }, summary: '第四版' })
    expect(continued.document.revision).toBe(4)
    expect(continued.versions.map(version => version.revision)).toEqual([4, 3, 1])
    /** 恢复到旧版本后的快照。 */
    const restored = await service.invoke('restore', { sessionId, prototypeId: first.document.id, baseRevision: 4, revision: 1 })
    /** 恢复只切换指针，仍存在的较高历史版本可以提交过期候选。 */
    const historicalCandidate = await service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 4, draft: continued.document, summary: '历史基线候选' })
    expect(historicalCandidate.status).toBe('stale')
    /** 删除历史最高版本后的快照。 */
    const deletedHighest = await service.invoke('deleteVersion', { sessionId, prototypeId: first.document.id, baseRevision: 1, revision: 4 })
    expect(restored.document.revision).toBe(1)
    expect(deletedHighest.document.revision).toBe(1)
    expect(deletedHighest.versions.map(version => version.revision)).toEqual([3, 1])
    /** 验证历史最高编号删除后仍不复用的后续版本。 */
    const afterHighestDelete = await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: restored.document, summary: '第五版' })
    expect(afterHighestDelete.document.revision).toBe(5)
  })
  it('Given 开发交接引用历史版本 When 删除 Then 拒绝并保留交接基线', async () => {
    /** 隔离服务及固定交接基线。 */
    const { service } = setup()
    /** 初始版本，用作历史基线。 */
    const first = await service.invoke('create', { sessionId, name: '交接基线', platform: 'mobile' })
    await service.invoke('createHandoff', { sessionId, prototypeId: first.document.id, revision: 1 })
    await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: first.document, summary: '后续版本' })
    await expect(service.invoke('deleteVersion', { sessionId, prototypeId: first.document.id, baseRevision: 2, revision: 1 })).rejects.toThrow('已用于开发交接')
    expect((await service.invoke('getVersion', { sessionId, prototypeId: first.document.id, revision: 1 })).revision).toBe(1)
  })
  it('Given 运行任务引用历史版本 When 删除及取消后删除 Then 保护运行任务且拒绝已删基线的新候选', async () => {
    /** 隔离服务与运行中的整模块任务。 */
    const { service } = setup()
    /** 初始版本，用作历史基线。 */
    const first = await service.invoke('create', { sessionId, name: '任务基线', platform: 'mobile' })
    /** 引用旧基线的运行任务。 */
    const job = await service.invoke('beginJob', { sessionId, prototypeId: first.document.id, baseRevision: 1, instruction: '生成页面' })
    /** 删除前已保存的候选仍有完整独立正文。 */
    const candidate = await service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: first.document, summary: '已有候选' })
    await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: first.document, summary: '后续版本' })
    await expect(service.invoke('deleteVersion', { sessionId, prototypeId: first.document.id, baseRevision: 2, revision: 1 })).rejects.toThrow('运行中的生成任务')
    await service.invoke('cancelJob', { sessionId, prototypeId: first.document.id, jobId: job.id })
    await service.invoke('deleteVersion', { sessionId, prototypeId: first.document.id, baseRevision: 2, revision: 1 })
    await expect(service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: first.document, summary: '无效基线' })).rejects.toThrow('版本不存在')
    await expect(service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 1, jobId: job.id, draft: first.document, summary: '迟到回填' })).rejects.toThrow('版本不存在')
    /** 旧候选保留可读但不可直接采纳的事实。 */
    const preserved = await service.invoke('getCandidate', { sessionId, prototypeId: first.document.id, candidateId: candidate.id })
    expect(preserved.status).toBe('stale')
    expect(preserved.draft.pages).toEqual(first.document.pages)
  })
  it('Given 已采纳候选与离线导出 When 删除旧版本 Then 保留采纳幂等与导出正文', async () => {
    /** 隔离服务、采纳版本和独立导出。 */
    const { service } = setup()
    /** 初始版本，用作历史基线。 */
    const first = await service.invoke('create', { sessionId, name: '独立记录', platform: 'mobile' })
    /** 独立保存正文的候选记录。 */
    const candidate = await service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: first.document, summary: '采纳候选' })
    await service.invoke('adopt', { sessionId, prototypeId: first.document.id, baseRevision: 1, candidateId: candidate.id })
    /** 已导出的离线页面内容。 */
    const delivery = await service.invoke('exportHtml', { sessionId, prototypeId: first.document.id, revision: 2 })
    await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 2, draft: first.document, summary: '后续版本' })
    await service.invoke('deleteVersion', { sessionId, prototypeId: first.document.id, baseRevision: 3, revision: 2 })
    expect(delivery.html).toContain('在主会话描述这个页面的内容和交互。')
    expect((await service.invoke('getCandidate', { sessionId, prototypeId: first.document.id, candidateId: candidate.id })).adoptedRevision).toBe(2)
    expect((await service.invoke('adopt', { sessionId, prototypeId: first.document.id, baseRevision: 1, candidateId: candidate.id })).document.revision).toBe(3)
  })
  it('Given 交接记录被替换为符号链接 When 删除历史版本 Then 拒绝跳过无法验证的引用', async () => {
    /** 隔离项目与交接记录。 */
    const { root, service } = setup()
    /** 初始版本，用作历史基线。 */
    const first = await service.invoke('create', { sessionId, name: '受保护引用', platform: 'mobile' })
    /** 固定版本的开发交接记录。 */
    const handoff = await service.invoke('createHandoff', { sessionId, prototypeId: first.document.id, revision: 1 })
    await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: first.document, summary: '后续版本' })
    /** 仅在测试临时根内替换为链接，以验证 no-follow 边界。 */
    const path = join(root, '.proma', 'interaction-design', 'prototypes', first.document.id, 'deliveries', `${handoff.id}.handoff.json`)
    /** 测试根内的交接副本，作为符号链接目标。 */
    const target = join(root, 'handoff-copy.json')
    writeFileSync(target, readFileSync(path))
    rmSync(path)
    symlinkSync(target, path)
    await expect(service.invoke('deleteVersion', { sessionId, prototypeId: first.document.id, baseRevision: 2, revision: 1 })).rejects.toThrow()
    expect((await service.invoke('getVersion', { sessionId, prototypeId: first.document.id, revision: 1 })).revision).toBe(1)
  })
  it('Given 固定版本 When 生成开发交接包 Then 带上视口、元素身份、流程和视觉 tokens 且不带本机路径', async () => {
    const { root, service } = setup()
    const first = await service.invoke('create', { sessionId, name: '交接原型', platform: 'desktop' })
    const draft = { ...first.document, groups: [{ id: 'root', name: '产品' }, { id: 'account', name: '账号', parentId: 'root' }], pages: [{ ...first.document.pages[0]!, groupId: 'account', name: '登录', html: '<style>:root{--brand:#123456;--gap:16px}</style><button data-prototype-element="submit">进入</button>' }, { id: 'dashboard', groupId: 'root', name: '首页', html: '<h1 data-prototype-element="title">首页</h1>' }], entryPageId: first.document.pages[0]!.id, flows: [{ id: 'to-home', fromPageId: first.document.pages[0]!.id, elementId: 'submit', targetPageId: 'dashboard' }] }
    await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft, summary: '准备开发交接' })
    const handoff = await service.invoke('createHandoff', { sessionId, prototypeId: first.document.id, revision: 2 })
    expect(handoff.revision).toBe(2)
    expect(handoff.visualContract.viewport).toEqual({ width: 1280, height: 800 })
    expect(handoff.groups.find(group => group.id === 'account')?.path).toBe('产品 / 账号')
    expect(handoff.pages.find(page => page.name === '登录')?.elementIds).toEqual(['submit'])
    expect(handoff.pages.find(page => page.name === '登录')?.flowIds).toEqual(['to-home'])
    expect(handoff.designTokens).toEqual({ '--brand': '#123456', '--gap': '16px' })
    expect(handoff.manifestHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(handoff)).not.toContain(root)
    const deliveryRoot = join(root, '.proma', 'interaction-design', 'prototypes', first.document.id, 'deliveries')
    expect(readdirSync(deliveryRoot).some(name => name.endsWith('.handoff.json'))).toBe(true)
  })
  it('Given 相同基线 When 两次保存 Then 旧写入不能覆盖当前稿', async () => {
    /** 隔离服务及原型。 */
    const { service } = setup()
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'desktop' })
    const request = { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: first.document, summary: '保存' }
    await service.invoke('save', request)
    await expect(service.invoke('save', request)).rejects.toThrow('版本已变化')
  })
  it('Given 候选生成后手动保存 When 采纳旧候选 Then 提示过期并保留用户版本', async () => {
    /** 隔离服务与初始稿。 */
    const { service } = setup()
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    const request = { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: first.document, summary: '生成候选' }
    const candidate = await service.invoke('propose', request)
    expect((await service.invoke('load', { sessionId, prototypeId: first.document.id })).document.revision).toBe(1)
    await service.invoke('save', request)
    await expect(service.invoke('adopt', { ...request, candidateId: candidate.id })).rejects.toThrow('过期')
    expect((await service.invoke('getCandidate', { ...request, candidateId: candidate.id })).status).toBe('stale')
  })
  it('Given 候选基于旧版本 When 恢复该版本 Then 候选重新可采纳且恢复本身不新增版本', async () => {
    /** 隔离服务与初始稿。 */
    const { root, service } = setup()
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    const request = { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: first.document, summary: '候选' }
    const candidate = await service.invoke('propose', request)
    await service.invoke('save', request)
    const revisionsDirectory = join(root, '.proma', 'interaction-design', 'prototypes', first.document.id, 'revisions')
    expect(readdirSync(revisionsDirectory).sort()).toEqual(['1.json', '2.json'])
    const restored = await service.invoke('restore', { sessionId, prototypeId: first.document.id, baseRevision: 2, revision: 1 })
    expect(restored.document.revision).toBe(1)
    expect(restored.candidates.find(item => item.id === candidate.id)?.status).toBe('ready')
    expect(readdirSync(revisionsDirectory).sort()).toEqual(['1.json', '2.json'])
  })
  it('Given 可采纳候选 When 重复采纳 Then 只产生一个新版本', async () => {
    /** 隔离服务和候选。 */
    const { service } = setup()
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    const request = { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: first.document, summary: '候选' }
    const candidate = await service.invoke('propose', request)
    const adoption = { sessionId, prototypeId: first.document.id, baseRevision: 1, candidateId: candidate.id }
    await service.invoke('adopt', adoption)
    expect((await service.invoke('adopt', adoption)).document.revision).toBe(2)
  })
  it('Given 取消任务 When 迟到候选提交 Then 拒绝回填', async () => {
    /** 隔离任务。 */
    const { service } = setup()
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    const job = await service.invoke('beginJob', { sessionId, prototypeId: first.document.id, baseRevision: 1, instruction: '修改' })
    await service.invoke('cancelJob', { sessionId, prototypeId: first.document.id, jobId: job.id })
    await expect(service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: first.document, summary: '迟到', jobId: job.id })).rejects.toThrow('任务已结束')
  })
  it('Given 内容对象被修改 When 读取历史 Then 明确拒绝损坏正文', async () => {
    /** 隔离项目与正式文件。 */
    const { root, service } = setup()
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    const contents = join(root, '.proma', 'interaction-design', 'prototypes', first.document.id, 'contents')
    writeFileSync(join(contents, readdirSync(contents)[0]!), JSON.stringify({ html: 'tampered' }))
    await expect(service.invoke('load', { sessionId, prototypeId: first.document.id })).rejects.toThrow('损坏')
  })
})

describe('图片与授权来源', () => {
  it('Given 同一图片重复导入 When 源文件删除 Then 模块图片与历史仍可读取', async () => {
    /** 隔离图片。 */
    const { root, service } = setup()
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6n8AAAAASUVORK5CYII=', 'base64')
    writeFileSync(join(root, 'image.png'), png)
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    const request = { sessionId, prototypeId: first.document.id, relativePath: 'image.png' }
    const a = await service.invoke('importAsset', request)
    const b = await service.invoke('importAsset', request)
    expect(a.id).toBe(b.id)
    rmSync(join(root, 'image.png'))
    expect((await service.invoke('assetContent', { sessionId, prototypeId: first.document.id, assetId: a.id })).dataUrl).toContain(png.toString('base64'))
    expect(readFileSync(join(root, '.proma', 'interaction-design', 'assets', 'blobs', 'sha256', a.hash.slice(0, 2), `${a.hash}.png`))).toEqual(png)
  })
  it('Given 项目秘密和越界路径 When 读取来源 Then 拒绝且不返回正文', async () => {
    /** 隔离来源服务。 */
    const { root } = setup()
    const source = new InteractionSourceService(root)
    writeFileSync(join(root, '.env'), 'API_KEY=abcdefghijk')
    writeFileSync(join(root, 'settings.ts'), 'const api_key = "abcdefghijk"')
    await expect(source.read(['.env'])).rejects.toThrow('敏感')
    await expect(source.read(['../outside.ts'])).rejects.toThrow()
    await expect(source.read(['settings.ts'])).rejects.toThrow('敏感')
  })
  it('Given 正式根是符号链接 When 创建 Then 不在外部目录写入', async () => {
    /** 两个隔离项目。 */
    const { root, service } = setup()
    const outside = setup().root
    symlinkSync(outside, join(root, '.proma'))
    await expect(service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })).rejects.toThrow('不安全')
    expect(readdirSync(outside)).toEqual([])
  })
  it('Given 来源 symlink When 读取 Then 拒绝跟随', async () => {
    /** 独立来源与链接。 */
    const { root } = setup()
    writeFileSync(join(root, 'source.ts'), 'hello')
    symlinkSync(join(root, 'source.ts'), join(root, 'link.ts'))
    await expect(new InteractionSourceService(root).read(['link.ts'])).rejects.toThrow()
  })
  it('Given HTML 和相对 CSS/JS/图片 When 导入 Then 生成可采纳候选而不覆盖当前版本', async () => {
    /** 完整本地依赖闭包。 */
    const { root, service } = setup()
    writeFileSync(join(root, 'page.html'), '<html><head><link href="theme.css" rel="stylesheet"></head><body><img src="image.png"><script src="app.js"></script></body></html>')
    writeFileSync(join(root, 'theme.css'), 'body {color:red}')
    writeFileSync(join(root, 'app.js'), 'document.body.dataset.loaded="yes"')
    writeFileSync(join(root, 'image.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6n8AAAAASUVORK5CYII=', 'base64'))
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'desktop' })
    const imported = await service.invoke('importHtml', { sessionId, prototypeId: first.document.id, baseRevision: 1, relativePath: 'page.html' })
    const candidate = await service.invoke('getCandidate', { sessionId, prototypeId: first.document.id, candidateId: imported.id })
    expect(candidate.draft.pages[1]!.html).toContain('prototype-asset:')
    expect(candidate.draft.pages[1]!.html).toContain('<style>body {color:red}</style>')
    expect(candidate.draft.pages[1]!.source?.hash).toBe(interactionHash(readFileSync(join(root, 'page.html'))))
    expect((await service.invoke('load', { sessionId, prototypeId: first.document.id })).document.revision).toBe(1)
  })
})

describe('交付、预算与任务范围', () => {
  it('Given 无模块项目 When 执行只读列表和扫描 Then 不创建正式目录', async () => {
    /** 原始空项目。 */
    const { root, service } = setup()
    expect(await service.invoke('list', { sessionId })).toEqual([])
    expect((await service.invoke('inspectProject', { sessionId })).files).toEqual([])
    expect(readdirSync(root)).toEqual([])
  })
  it('Given 页面级任务 When 候选修改名称或目录 Then 拒绝越过任务范围', async () => {
    /** 页面级生成任务。 */
    const { service } = setup()
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    const job = await service.invoke('beginJob', { sessionId, prototypeId: first.document.id, baseRevision: 1, pageId: 'home', instruction: '改页面' })
    await expect(service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 1, jobId: job.id, draft: { ...first.document, name: '越界改名' }, summary: '改名' })).rejects.toThrow('超出任务页面范围')
    await expect(service.invoke('beginJob', { sessionId, prototypeId: first.document.id, baseRevision: 1, pageId: 'missing', instruction: '修改' })).rejects.toThrow('页面不存在')
    expect((await service.invoke('beginJob', { sessionId, prototypeId: first.document.id, baseRevision: 1, pageId: 'home', elementId: 'title', instruction: '修改' })).message).toContain('所属页面')
    await expect(service.invoke('beginJob', { sessionId, prototypeId: first.document.id, baseRevision: 1, pageId: 'home', elementId: 'missing', instruction: '修改' })).rejects.toThrow('元素')
  })
  it('Given 异步图片读取期间授权撤回 When 准备提交 Then 不写入图片或新版本', async () => {
    /** 可切换的测试授权。 */
    let authorized = true
    /** 验证整个异步准备期间持有 lease。 */
    let leased = false
    /** 初始项目根。 */
    const { root } = setup()
    writeFileSync(join(root, 'image.png'), 'placeholder')
    const service = new InteractionDesignService({ workspaceId: 'workspace', projectRoot: root,
      assertCurrent: () => { if (!authorized) throw new Error('授权已撤回') },
      withWriteLease: async effect => { leased = true; try { return await effect() } finally { leased = false } },
      readSourceFile: async () => { expect(leased).toBe(true); authorized = false; return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6n8AAAAASUVORK5CYII=', 'base64') },
    })
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    await expect(service.invoke('importAsset', { sessionId, prototypeId: first.document.id, relativePath: 'image.png' })).rejects.toThrow('授权已撤回')
    expect(readdirSync(join(root, '.proma', 'interaction-design'))).not.toContain('assets')
  })
  it('Given 超预算源码 When 有界读取 Then 明确失败而不返回残缺正文', async () => {
    /** 大型来源。 */
    const { root } = setup()
    writeFileSync(join(root, 'large.ts'), 'a'.repeat(512 * 1024 + 1))
    await expect(new InteractionSourceService(root).read(['large.ts'])).rejects.toThrow('预算')
  })
  it('Given 已导入页面和图片 When 采纳并导出固定历史版本 Then 图片内嵌且不混入后续修改', async () => {
    /** 含图片的静态页面。 */
    const { root, service } = setup()
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6n8AAAAASUVORK5CYII=', 'base64')
    writeFileSync(join(root, 'image.png'), png)
    writeFileSync(join(root, 'page.html'), '<html><body><img src="image.png"></body></html>')
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    const candidate = await service.invoke('importHtml', { sessionId, prototypeId: first.document.id, baseRevision: 1, relativePath: 'page.html' })
    const adopted = await service.invoke('adopt', { sessionId, prototypeId: first.document.id, baseRevision: 1, candidateId: candidate.id })
    expect(adopted.document.pages).toHaveLength(2)
    await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 2, draft: { ...adopted.document, name: '后续改名' }, summary: '后续版本' })
    const exported = await service.invoke('exportHtml', { sessionId, prototypeId: first.document.id, revision: 2 })
    expect(exported.revision).toBe(2)
    expect(exported.html).toContain(png.toString('base64'))
    expect(exported.html).not.toContain('后续改名')
    expect(exported.html).not.toContain('prototype-asset:')
    expect((await service.invoke('validate', { sessionId, prototypeId: first.document.id, revision: 2 })).kind).toBe('structure')
  })
})

describe('来源闭包和内容身份', () => {
  it('Given CSS 相对 import 和无引号资源 When 导入 Then 样式与脚本内联并可离线使用', async () => {
    /** 静态页面依赖。 */
    const { root, service } = setup()
    writeFileSync(join(root, 'page.html'), '<link rel=stylesheet href=theme.css><script src=app.js></script>')
    writeFileSync(join(root, 'theme.css'), '@import "base.css"; body{color:red}')
    writeFileSync(join(root, 'base.css'), 'html{background:white}')
    writeFileSync(join(root, 'app.js'), 'document.body.dataset.ready="yes"')
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'desktop' })
    const candidate = await service.invoke('importHtml', { sessionId, prototypeId: first.document.id, baseRevision: 1, relativePath: 'page.html' })
    const loaded = await service.invoke('getCandidate', { sessionId, prototypeId: first.document.id, candidateId: candidate.id })
    expect(loaded.draft.pages[1]!.html).toContain('html{background:white}')
    expect(loaded.draft.pages[1]!.html).toContain('<script>document.body.dataset.ready="yes"</script>')
    expect(loaded.draft.pages[1]!.html).not.toContain('base.css')
  })
  it('Given 可信媒体返回不匹配字节 When 校验引用hash Then 拒绝保存素材', async () => {
    /** 已注册但返回错误内容的测试 reader。 */
    const { root } = setup()
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6n8AAAAASUVORK5CYII=', 'base64')
    const service = new InteractionDesignService({ workspaceId: 'workspace', projectRoot: root, readMediaAsset: async () => png })
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    await expect(service.invoke('importMediaAsset', { sessionId, prototypeId: first.document.id, assetId: 'media', revision: 1, hash: 'a'.repeat(64) })).rejects.toThrow('hash 不匹配')
    expect((await service.invoke('load', { sessionId, prototypeId: first.document.id })).assets).toEqual([])
  })
  it('Given 原型元数据被改写 When 读取版本 Then hash校验拒绝伪造记录', async () => {
    /** 已提交版本元数据。 */
    const { root, service } = setup()
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    const path = join(root, '.proma', 'interaction-design', 'prototypes', first.document.id, 'revisions', '1.json')
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { document: { name: string } }
    stored.document.name = '被修改'
    writeFileSync(path, JSON.stringify(stored))
    await expect(service.invoke('getVersion', { sessionId, prototypeId: first.document.id, revision: 1 })).rejects.toThrow('版本内容身份')
  })
})

describe('崩溃残留与采纳二次校验', () => {
  it('Given 未发布的残缺版本 When 加载与下次保存 Then 当前head可读且残留不进入历史', async () => {
    /** 当前有效原型与未提交版本位置。 */
    const { root, service } = setup()
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    const revisions = join(root, '.proma', 'interaction-design', 'prototypes', first.document.id, 'revisions')
    writeFileSync(join(revisions, '2.json'), '{broken')
    expect((await service.invoke('load', { sessionId, prototypeId: first.document.id })).document.revision).toBe(1)
    const saved = await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: first.document, summary: '重试提交' })
    expect(saved.document.revision).toBe(2)
    expect(saved.versions).toHaveLength(2)
  })
  it('Given 内容hash路径存在损坏残留 When 新版本试图复用 Then 不推进head', async () => {
    /** 将新内容的目标对象预置为残缺 JSON。 */
    const { root, service } = setup()
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    const html = '<h1>新页面正文</h1>'
    const path = join(root, '.proma', 'interaction-design', 'prototypes', first.document.id, 'contents', `${interactionHash(html)}.json`)
    writeFileSync(path, JSON.stringify({ html: '损坏残留' }))
    const draft = { ...first.document, pages: [{ ...first.document.pages[0]!, html }] }
    await expect(service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft, summary: '新正文' })).rejects.toThrow('内容对象损坏')
    expect((await service.invoke('load', { sessionId, prototypeId: first.document.id })).document.revision).toBe(1)
  })
  it('Given 候选落盘后正文改变 When 采纳 Then 拒绝并保留当前版本', async () => {
    /** 原候选内容及其落盘位置。 */
    const { root, service } = setup()
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    const candidate = await service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: first.document, summary: '候选' })
    const path = join(root, '.proma', 'interaction-design', 'prototypes', first.document.id, 'candidates', `${candidate.id}.json`)
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { draft: { name: string } }
    stored.draft.name = '变更后的候选'
    writeFileSync(path, JSON.stringify(stored))
    await expect(service.invoke('adopt', { sessionId, prototypeId: first.document.id, candidateId: candidate.id, baseRevision: 1 })).rejects.toThrow('候选正文身份')
    expect((await service.invoke('load', { sessionId, prototypeId: first.document.id })).document.revision).toBe(1)
  })
  it('Given 候选写完但任务终态未提交 When 采纳 Then 不把未完成结果发布', async () => {
    /** 模拟候选和任务终态之间的崩溃。 */
    const { root, service } = setup()
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    const job = await service.invoke('beginJob', { sessionId, prototypeId: first.document.id, baseRevision: 1, instruction: '改稿' })
    const candidate = await service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: first.document, summary: '候选', jobId: job.id })
    const path = join(root, '.proma', 'interaction-design', 'prototypes', first.document.id, 'jobs', `${job.id}.json`)
    writeFileSync(path, JSON.stringify(job))
    await expect(service.invoke('adopt', { sessionId, prototypeId: first.document.id, candidateId: candidate.id, baseRevision: 1 })).rejects.toThrow('尚未完成')
    expect((await service.invoke('load', { sessionId, prototypeId: first.document.id })).document.revision).toBe(1)
  })
  it('Given 图片blob残留已损坏且无metadata When 重新导入 Then 不发布损坏素材', async () => {
    /** 模拟 blob 已存在但 metadata 丢失。 */
    const { root, service } = setup()
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6n8AAAAASUVORK5CYII=', 'base64')
    writeFileSync(join(root, 'image.png'), png)
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    const request = { sessionId, prototypeId: first.document.id, relativePath: 'image.png' }
    const asset = await service.invoke('importAsset', request)
    const directory = join(root, '.proma', 'interaction-design', 'assets')
    rmSync(join(directory, `${asset.id}.json`))
    writeFileSync(join(directory, 'blobs', 'sha256', asset.hash.slice(0, 2), `${asset.hash}.png`), 'corrupted')
    await expect(service.invoke('importAsset', request)).rejects.toThrow('图片内容对象损坏')
    expect((await service.invoke('load', { sessionId, prototypeId: first.document.id })).assets).toEqual([])
  })
  it('Given 他人会话任务 When 取消或回填 Then 拒绝跨会话改变任务', async () => {
    /** 已绑定会话的任务。 */
    const { service } = setup()
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    const job = await service.invoke('beginJob', { sessionId, prototypeId: first.document.id, baseRevision: 1, instruction: '改稿' })
    await expect(service.invoke('cancelJob', { sessionId: 'other-session', prototypeId: first.document.id, jobId: job.id })).rejects.toThrow('会话不匹配')
    await expect(service.invoke('failJob', { sessionId: 'other-session', prototypeId: first.document.id, jobId: job.id, message: '失败' })).rejects.toThrow('会话不匹配')
    await expect(service.invoke('propose', { sessionId: 'other-session', prototypeId: first.document.id, jobId: job.id, baseRevision: 1, draft: first.document, summary: '回填' })).rejects.toThrow('归属不匹配')
  })
})

it('Given 放弃候选 When 重读与列表展示 Then 校验hash保留但不暴露给调用方', async () => {
  /** 含存储校验字段的候选。 */
  const { root, service } = setup()
  const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
  const candidate = await service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: first.document, summary: '候选' })
  await service.invoke('discardCandidate', { sessionId, prototypeId: first.document.id, candidateId: candidate.id })
  const reloaded = await service.invoke('getCandidate', { sessionId, prototypeId: first.document.id, candidateId: candidate.id })
  const snapshot = await service.invoke('load', { sessionId, prototypeId: first.document.id })
  expect(reloaded.status).toBe('discarded')
  expect('draftHash' in reloaded).toBe(false)
  expect('draftHash' in snapshot.candidates[0]!).toBe(false)
  const directory = join(root, '.proma', 'interaction-design', 'prototypes', first.document.id, 'candidates')
  expect(JSON.parse(readFileSync(join(directory, `${candidate.id}.json`), 'utf8')).draftHash).toBeTruthy()
  expect(JSON.parse(readFileSync(join(directory, `${candidate.id}.summary.json`), 'utf8')).draftHash).toBeUndefined()
})

it('Given 唯一项目模块包含大页面且正文损坏 When list Then 仅读摘要而load仍拒绝损坏正文', async () => {
  /** 单模块、大正文的隔离项目。 */
  const { root, service } = setup()
  /** 保存两份接近单页上限的正文。 */
  const first = await service.invoke('create', { sessionId, name: '唯一模块', platform: 'mobile' })
  const draft = { ...first.document, pages: [
    { ...first.document.pages[0]!, html: `<main>${'a'.repeat(400_000)}</main>` },
    { id: 'second', groupId: 'main', name: '第二页', html: `<main>${'b'.repeat(400_000)}</main>` },
  ] }
  await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft, summary: '大页面' })
  /** 删除全部内容文件，任何正文读取都会失败。 */
  const contents = join(root, '.proma', 'interaction-design', 'prototypes', first.document.id, 'contents')
  for (const file of readdirSync(contents)) rmSync(join(contents, file))
  await expect(service.invoke('load', { sessionId, prototypeId: first.document.id })).rejects.toThrow()
  /** 摘要可以展示，但不宣称已经验证正文完整性。 */
  const summaries = await service.invoke('list', { sessionId })
  expect(summaries).toHaveLength(1)
  expect(summaries[0]).toMatchObject({ pageCount: 2, revision: 2, name: '唯一模块' })
})

it('Given 版本元数据累计超预算 When list Then 明确拒绝无界摘要读取', async () => {
  /** 累计元数据预算的隔离项目。 */
  const { root, service } = setup()
  /** 单模块元数据超过列表预算。 */
  const first = await service.invoke('create', { sessionId, name: '唯一模块', platform: 'mobile' })
  const path = join(root, '.proma', 'interaction-design', 'prototypes', first.document.id, 'revisions', '1.json')
  const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  stored.padding = 'x'.repeat(9 * 1024 * 1024)
  writeFileSync(path, JSON.stringify(stored))
  await expect(service.invoke('list', { sessionId })).rejects.toThrow('预算')
})
