import { randomUUID } from 'node:crypto'
import { existsSync, opendirSync, readdirSync } from 'node:fs'
import { basename, join, posix } from 'node:path'
import type { InteractionDesignInputs, InteractionDesignMethod, InteractionDesignResults, PrototypeCandidate, PrototypeCandidateSummary, PrototypeCheck, PrototypeDocument, PrototypeDraft, PrototypeJob, PrototypeSnapshot, PrototypeVersion } from '@proma/shared'
import { assertPrototypeDraft, parsePrototypeDraft, parseInteractionDesignCommand, PROTOTYPE_LIMITS, validatePrototypeStructure } from '@proma/shared'
import { acquireMediaFileLock } from '../media/media-file-lock'
import { readAtomicFileState, writeJsonFileAtomicSecure } from '../safe-file'
import { assertInteractionId, interactionDirectory, readInteractionFile } from './paths'
import { InteractionAssetService, MAX_INTERACTION_IMAGE_BYTES } from './asset-service'
import { InteractionSourceService, interactionHash } from './source-service'
import type { InteractionSourceReader } from './source-service'
import { createInteractionDelivery } from './delivery-service'

/** 主进程为已授权项目构造的依赖，真实来源读取使用稳定目录能力。 */
export interface InteractionDesignServiceDependencies {
  /** 工作区身份，用于正式文件归属验证。 */
  workspaceId: string
  /** 重新核验当前会话、项目根与权限绑定。 */
  assertCurrent?: () => void
  /** getProjectFilesPath(workspace.slug) 返回的可信项目根。 */
  projectRoot: string
  /** 可重建缓存根，与正式文件独立。 */
  cacheRoot?: string
  /** 生产环境提供稳定目录读取，测试可注入隔离实现。 */
  readSourceFile?: InteractionSourceReader
  /** 主进程验证项目、媒体身份与权限后返回独立图片字节。 */
  readMediaAsset?: (ref: { assetId: string; revision: number; hash: string; mediaKind: 'image' }) => Promise<Uint8Array>
  /** 覆盖异步准备和短提交阶段的工作区写 lease。 */
  withWriteLease?: <T>(effect: () => Promise<T>) => Promise<T>
}
/** 原子提交点仅指向已经完整保存的不可变版本。 */
interface PrototypeHead {
  schemaVersion: 1
  workspaceId: string
  prototypeId: string
  revision: number
  /** 已经分配过的最高版本号；恢复旧版本时保持历史编号单调。 */
  latestRevision?: number
  /** 候选采纳记录与 head 同一次提交，崩溃恢复不重复采纳。 */
  adopted: Record<string, number>
}
/** 正文去重后的版本文件，保留全部非正文属性。 */
interface StoredVersion {
  /** 完整文档的 SHA-256，用于检测版本元数据篡改。 */
  hash: string
  document: Omit<PrototypeDocument, 'pages'> & { pages: Array<Omit<PrototypeDocument['pages'][number], 'html'> & { contentHash: string }> }
  version: PrototypeVersion
}
/** 正式数据只读和修改都通过本服务。 */
export class InteractionDesignService {
  /** 项目来源读取。 */
  private readonly sources: InteractionSourceService
  /** 独立图片库。 */
  private readonly assets: InteractionAssetService
  constructor(private readonly dependencies: InteractionDesignServiceDependencies) {
    assertInteractionId(dependencies.workspaceId)
    this.sources = new InteractionSourceService(dependencies.projectRoot, dependencies.readSourceFile)
    this.assets = new InteractionAssetService(dependencies.projectRoot)
  }
  /** 获取已校验的正式目录；不把全局缓存当权威数据。 */
  private root(create = false): string { return interactionDirectory(this.dependencies.projectRoot, ['.proma', 'interaction-design'], create) }
  /** 校验原型身份并定位独立目录。 */
  private directory(id: string, child?: string, create = false): string {
    assertInteractionId(id)
    return interactionDirectory(this.dependencies.projectRoot, ['.proma', 'interaction-design', 'prototypes', id, ...(child ? [child] : [])], create)
  }
  /** 有界读取正式 JSON；不存在或损坏均不静默还原旧 head。 */
  private json<T>(path: string, maxBytes = 32 * 1024 * 1024): T { return JSON.parse(readInteractionFile(path, maxBytes).toString('utf8')) as T }
  /** 读取并核验项目归属和当前版本。 */
  private head(id: string, budget?: { remaining: number }): PrototypeHead {
    /** head 不携带正文，仅允许有限采纳索引；列表调用同时消耗累计预算。 */
    const bytes = readInteractionFile(join(this.directory(id), 'head.json'), Math.min(budget?.remaining ?? 512 * 1024, 512 * 1024))
    if (budget) budget.remaining -= bytes.length
    /** 当前正式提交点。 */
    const head = JSON.parse(bytes.toString('utf8')) as PrototypeHead
    const latestRevision = head.latestRevision ?? head.revision
    if (head.schemaVersion !== 1 || head.workspaceId !== this.dependencies.workspaceId || head.prototypeId !== id
      || !Number.isSafeInteger(head.revision) || head.revision < 1
      || !Number.isSafeInteger(latestRevision) || latestRevision < head.revision) throw new Error('原型归属或版本记录损坏')
    /** 高水位必须对应已经完整写入的历史文件，不能把空洞当成可恢复版本。 */
    if (!existsSync(join(this.directory(id, 'revisions'), `${latestRevision}.json`))) throw new Error('原型历史版本记录损坏')
    /** 兼容旧 head 文件时在内存中补齐历史最高版本号。 */
    head.latestRevision = latestRevision
    return head
  }
  /** 读取固定历史版本并逐页验证内容 hash。 */
  private version(id: string, revision: number): PrototypeDocument {
    /** 当前指针与历史高水位只读取一次，避免恢复/导出时重复读取 head。 */
    const head = this.head(id)
    if (!Number.isSafeInteger(revision) || revision < 1 || revision > (head.latestRevision ?? head.revision)) throw new Error('原型版本不存在')
    /** 不可变版本记录。 */
    const stored = this.json<StoredVersion>(join(this.directory(id, 'revisions'), `${revision}.json`), 2 * 1024 * 1024)
    if (!stored.document || !Array.isArray(stored.document.pages) || stored.document.pages.length > PROTOTYPE_LIMITS.pages) throw new Error('版本页面记录非法')
    /** 在加载下一页前扣除正文读取预算。 */
    let remainingContentBytes = PROTOTYPE_LIMITS.totalChars * 4
    /** 恢复后的完整文档。 */
    const document: PrototypeDocument = { ...stored.document, pages: stored.document.pages.map(page => {
      if (!/^[a-f0-9]{64}$/.test(page.contentHash)) throw new Error('页面内容身份非法')
      /** 内容寻址的页面对象。 */
      const content = this.json<{ html: string }>(join(this.directory(id, 'contents'), `${page.contentHash}.json`), Math.min(remainingContentBytes, PROTOTYPE_LIMITS.pageChars * 4 + 1024))
      if (typeof content.html === 'string') remainingContentBytes -= Buffer.byteLength(content.html)
      if (typeof content.html !== 'string' || interactionHash(content.html) !== page.contentHash) throw new Error('页面正文已损坏')
      /** 不向 renderer 暴露存储 locator。 */
      const { contentHash: _hash, ...metadata } = page
      return { ...metadata, html: content.html }
    }) }
    if (document.id !== id || document.revision !== revision || document.schemaVersion !== 1) throw new Error('版本身份不匹配')
    assertPrototypeDraft(document)
    if (interactionHash(JSON.stringify([document.id, document.revision, document.createdAt, document.updatedAt, parsePrototypeDraft(document)])) !== stored.hash) throw new Error('版本内容身份已损坏')
    return document
  }
  /** 枚举固定目录内有限 JSON 文件。 */
  private records<T>(id: string, child: string, maximumRevision?: number): T[] {
    /** 子目录可能尚未创建。 */
    const path = join(this.directory(id), child)
    if (!existsSync(path)) return []
    this.directory(id, child)
    /** 记录名只允许稳定身份。 */
    const names = readdirSync(path).filter(name => /^[A-Za-z0-9_-]+\.json$/.test(name) && (maximumRevision === undefined || /^[1-9][0-9]*\.json$/.test(name) && Number(name.slice(0, -5)) <= maximumRevision))
    if (names.length > 2000) throw new Error('记录数量超过读取预算')
    /** 单次读取累计预算，避免大量历史挤占主进程内存。 */
    let remaining = 32 * 1024 * 1024
    return names.map(name => {
      /** 在解析前以剩余预算限制读取。 */
      const bytes = readInteractionFile(join(path, name), remaining)
      remaining -= bytes.length
      return JSON.parse(bytes.toString('utf8')) as T
    })
  }
  /** 候选可采纳性由当前 head 推导，不修改旧生成结果。 */
  private candidate(id: string, candidateId: string): PrototypeCandidate {
    assertInteractionId(candidateId)
    /** 独立保存的候选正文。 */
    const candidate = this.json<PrototypeCandidate & { draftHash: string }>(join(this.directory(id, 'candidates'), `${candidateId}.json`))
    /** 当前提交点。 */
    const head = this.head(id)
    if (candidate.id !== candidateId || candidate.prototypeId !== id) throw new Error('候选归属不匹配')
    assertPrototypeDraft(candidate.draft)
    if (candidate.draftHash !== interactionHash(JSON.stringify(parsePrototypeDraft(candidate.draft)))) throw new Error('候选正文身份已损坏')
    /** 存储校验字段不穿过 renderer/Agent 返回边界。 */
    const { draftHash: _draftHash, ...publicCandidate } = candidate
    if (head.adopted[candidateId]) return { ...publicCandidate, status: 'adopted', adoptedRevision: head.adopted[candidateId] }
    if (candidate.status === 'discarded') return publicCandidate
    return { ...publicCandidate, status: candidate.baseRevision === head.revision ? 'ready' : 'stale' }
  }
  /** 候选列表只读取摘要，避免加载全部生成正文。 */
  private candidateSummaries(id: string, head: PrototypeHead): PrototypeCandidateSummary[] {
    /** 首次尚无候选目录。 */
    const path = join(this.directory(id), 'candidates')
    if (!existsSync(path)) return []
    this.directory(id, 'candidates')
    /** 轻量摘要文件集合。 */
    const names = readdirSync(path).filter(name => /^[A-Za-z0-9_-]+\.summary\.json$/.test(name))
    if (names.length > 2000) throw new Error('候选数量超过预算')
    return names.map(name => {
      /** 独立候选摘要，不含 HTML。 */
      const storedSummary = this.json<PrototypeCandidateSummary & { draftHash?: string }>(join(path, name), 8192)
      /** 兼容先前摘要残留的存储字段，不向调用方泄漏。 */
      const { draftHash: _draftHash, ...summary } = storedSummary
      if (summary.prototypeId !== id) throw new Error('候选归属不匹配')
      if (head.adopted[summary.id]) return { ...summary, status: 'adopted' as const, adoptedRevision: head.adopted[summary.id] }
      return { ...summary, status: summary.status === 'discarded' ? 'discarded' as const : summary.baseRevision === head.revision ? 'ready' as const : 'stale' as const }
    })
  }
  /** 单独更新候选摘要，正文与摘要都不拥有推进 head 的权限。 */
  private candidateSummary(candidate: PrototypeCandidate): void {
    /** 去掉不可变候选正文。 */
    const { draft: _draft, draftHash: _draftHash, ...summary } = candidate as PrototypeCandidate & { draftHash?: string }
    /** 固定摘要路径。 */
    const path = join(this.directory(candidate.prototypeId, 'candidates'), `${candidate.id}.summary.json`)
    /** 当前摘要身份。 */
    const state = readAtomicFileState(path)
    writeJsonFileAtomicSecure(path, summary, { expectedDestination: state ? { kind: 'state', state } : { kind: 'missing' } })
  }
  /** 返回当前文档及有限的轻量记录。 */
  private snapshot(id: string): PrototypeSnapshot {
    /** 当前提交点。 */
    const head = this.head(id)
    return {
      document: this.version(id, head.revision),
      /** 恢复旧版本后仍展示更高版本，用户可以再次切换而不丢历史。 */
      versions: this.records<StoredVersion>(id, 'revisions', head.latestRevision).filter(value => value.version.revision <= (head.latestRevision ?? head.revision)).map(value => value.version).sort((a, b) => b.revision - a.revision),
      candidates: this.candidateSummaries(id, head),
      assets: this.assets.list(), jobs: this.records<PrototypeJob>(id, 'jobs'), checks: this.records<PrototypeCheck>(id, 'checks'),
    }
  }
  /** 使用工作区 lease 与跨进程模块锁覆盖整个受控变更。 */
  private async write<T>(effect: () => Promise<T> | T): Promise<T> {
    /** 已授权的写入闭包。 */
    const run = async (): Promise<T> => {
      /** 模块短锁；各异步来源准备在调用本方法前完成。 */
      this.dependencies.assertCurrent?.()
      const release = acquireMediaFileLock(join(this.root(true), '.interaction-design.lock'))
      try { return await effect() } finally { release() }
    }
    return run()
  }
  /** 保存完整不可变版本，然后原子 CAS 推进唯一 head。 */
  private commit(id: string, baseRevision: number, draft: PrototypeDraft, summary: string, adoptedId?: string): void {
    draft = parsePrototypeDraft(draft)
    this.dependencies.assertCurrent?.()
    this.assertAssets(draft)
    /** 现有提交点，初次创建允许缺失。 */
    const directory = this.directory(id, undefined, true)
    /** head 文件及读取期 CAS 状态。 */
    const headPath = join(directory, 'head.json')
    /** 读取期文件身份。 */
    const state = readAtomicFileState(headPath)
    /** 当前权威版本。 */
    const previous = state ? this.head(id) : null
    if ((previous?.revision ?? 0) !== baseRevision) throw new Error('原型版本已变化，请重新读取后修改')
    /** 创建时间始终沿用原始文档。 */
    const createdAt = previous ? this.version(id, previous.revision).createdAt : Date.now()
    /** 新版本号取历史最高值之后，避免恢复旧版本后覆盖已有历史文件。 */
    const revision = (previous?.latestRevision ?? previous?.revision ?? 0) + 1
    /** 完整新文档。 */
    const document: PrototypeDocument = { ...structuredClone(draft), schemaVersion: 1, id, revision, createdAt, updatedAt: Date.now() }
    /** 页面内容寻址目录。 */
    const contents = this.directory(id, 'contents', true)
    /** 页面正文和元数据分离存储。 */
    const pages = document.pages.map(page => {
      /** HTML 内容身份。 */
      const contentHash = interactionHash(page.html)
      /** 不可变内容位置。 */
      const path = join(contents, `${contentHash}.json`)
      if (!existsSync(path)) writeJsonFileAtomicSecure(path, { html: page.html }, { expectedDestination: { kind: 'missing' } })
      else {
        /** 已存在但未被引用的崩溃残留也必须经过内容身份验证。 */
        const existing = this.json<{ html: string }>(path, PROTOTYPE_LIMITS.pageChars * 4 + 1024)
        if (typeof existing.html !== 'string' || interactionHash(existing.html) !== contentHash) throw new Error('已有页面内容对象损坏，未提交新版本')
      }
      /** 从版本记录移除正文。 */
      const { html: _html, ...metadata } = page
      return { ...metadata, contentHash }
    })
    /** 新版本记录完整写入后才允许发布 head。 */
    const versionPath = join(this.directory(id, 'revisions', true), `${revision}.json`)
    /** 崩溃遗留的未发布版本允许在锁内覆盖，不属于可读取历史。 */
    const orphanState = readAtomicFileState(versionPath)
    writeJsonFileAtomicSecure(versionPath, { hash: interactionHash(JSON.stringify([document.id, document.revision, document.createdAt, document.updatedAt, parsePrototypeDraft(document)])), document: { ...document, pages }, version: { revision, summary: summary.slice(0, 1000), createdAt: document.updatedAt } }, { expectedDestination: orphanState ? { kind: 'state', state: orphanState } : { kind: 'missing' } })
    /** 候选采纳记录与当前版本共享一个提交点。 */
    const adopted = { ...(previous?.adopted ?? {}), ...(adoptedId ? { [adoptedId]: revision } : {}) }
    writeJsonFileAtomicSecure(headPath, { schemaVersion: 1, workspaceId: this.dependencies.workspaceId, prototypeId: id, revision, latestRevision: revision, adopted }, { expectedDestination: state ? { kind: 'state', state } : { kind: 'missing' } })
  }
  /** 保存独立记录，调用者持有模块锁。 */
  private record<T extends { id: string }>(id: string, child: string, record: T): void {
    this.dependencies.assertCurrent?.()
    assertInteractionId(record.id)
    /** 记录位置。 */
    const path = join(this.directory(id, child, true), `${record.id}.json`)
    /** 当前记录状态供 CAS 更新。 */
    const state = readAtomicFileState(path)
    writeJsonFileAtomicSecure(path, record, { expectedDestination: state ? { kind: 'state', state } : { kind: 'missing' } })
  }
  /** 生成结果仅保存候选，不能替换正式 head。 */
  private propose(input: InteractionDesignInputs['propose']): PrototypeCandidateSummary {
    input = { ...input, draft: parsePrototypeDraft(input.draft) }
    this.assertAssets(input.draft)
    /** 当前原型提交点。 */
    const head = this.head(input.prototypeId)
    if (input.baseRevision < 1 || input.baseRevision > head.revision) throw new Error('候选基线版本不存在')
    if (input.jobId) {
      /** 绑定当前任务，拒绝取消后回填或跨会话伪造。 */
      const job = this.job(input.prototypeId, input.jobId)
      if (job.sessionId !== input.sessionId || job.status !== 'running' || job.baseRevision !== input.baseRevision) throw new Error('生成任务已结束或归属不匹配')
      this.assertJobScope(job, input.draft)
    }
    /** 不可变候选内容。 */
    const candidate: PrototypeCandidate = { id: randomUUID(), prototypeId: input.prototypeId, baseRevision: input.baseRevision, draft: structuredClone(input.draft), summary: input.summary.slice(0, 1000), status: head.revision === input.baseRevision ? 'ready' : 'stale', createdAt: Date.now(), ...(input.jobId ? { jobId: input.jobId } : {}) }
    this.record(input.prototypeId, 'candidates', { ...candidate, draftHash: interactionHash(JSON.stringify(candidate.draft)) })
    this.candidateSummary(candidate)
    if (input.jobId) this.record(input.prototypeId, 'jobs', { ...this.job(input.prototypeId, input.jobId), status: 'candidate' })
    /** 摘要不返回正文。 */
    const { draft: _draft, ...result } = candidate
    return result
  }
  /** 提交候选和采纳候选都复核任务页面范围，不能靠生成期的一次检查。 */
  private assertJobScope(job: PrototypeJob, draft: PrototypeDraft): void {
    if (!job.pageId) return
    /** 固定任务基线。 */
    const baseline = parsePrototypeDraft(this.version(job.prototypeId, job.baseRevision))
    /** 仅目标页面正文可不同；目录归属和页面名称也属于用户页面管理。 */
    const withoutPageContent = (value: PrototypeDraft): string => JSON.stringify({ ...value, pages: value.pages.map(page => page.id === job.pageId ? { ...page, html: '' } : page) })
    if (withoutPageContent(baseline) !== withoutPageContent(draft)) throw new Error('候选修改超出任务页面范围')
  }
  /** 确认所有逻辑图片引用已在本项目独立库中存在。 */
  private assertAssets(draft: PrototypeDraft): void {
    /** 当前项目已知资产身份。 */
    const known = new Set(this.assets.list().map(asset => asset.id))
    for (const page of draft.pages) {
      for (const match of page.html.matchAll(/prototype-asset:([A-Za-z0-9_-]+)/g)) {
        if (!known.has(match[1]!)) throw new Error('原型引用了不存在的项目素材')
      }
    }
  }
  /** 读取独立任务并验证归属。 */
  private job(id: string, jobId: string): PrototypeJob {
    assertInteractionId(jobId)
    this.head(id)
    /** 当前任务记录。 */
    const job = this.json<PrototypeJob>(join(this.directory(id, 'jobs'), `${jobId}.json`))
    if (job.id !== jobId || job.prototypeId !== id) throw new Error('任务归属不匹配')
    return job
  }
  /** 类型安全入口；边界 parser 由生产 facade 调用。 */
  async invoke<M extends InteractionDesignMethod>(method: M, input: InteractionDesignInputs[M]): Promise<InteractionDesignResults[M]> {
    /** 服务直调同样执行严格白名单解析，不能绕过 IPC 验证。 */
    const command = parseInteractionDesignCommand({ method, input })
    this.dependencies.assertCurrent?.()
    /** 所有异步来源准备都持有项目 lease，迁移不能在准备和提交之间改根。 */
    const effect = async (): Promise<InteractionDesignResults[M]> => {
      /** 完成后复核授权，迟到读取不能返回给失效会话。 */
      const result = await this.execute(command.method, command.input)
      this.dependencies.assertCurrent?.()
      return result as InteractionDesignResults[M]
    }
    return this.dependencies.withWriteLease ? this.dependencies.withWriteLease(effect) : effect()
  }
  /** 根据受限命令调用对应服务，所有修改都在写 lease 和模块锁内。 */
  private async execute(method: InteractionDesignMethod, input: InteractionDesignInputs[InteractionDesignMethod]): Promise<InteractionDesignResults[InteractionDesignMethod]> {
    switch (method) {
      case 'list': {
        /** 原型根不存在时不创建任何正式数据。 */
        const path = join(this.dependencies.projectRoot, '.proma', 'interaction-design', 'prototypes')
        if (!existsSync(path)) return []
        this.root()
        interactionDirectory(this.dependencies.projectRoot, ['.proma', 'interaction-design', 'prototypes'])
        /** 原型与目录条目都有硬上限，避免无界枚举或静默截断。 */
        const ids: string[] = []
        /** 流式目录句柄，不预先加载所有文件名。 */
        const handle = opendirSync(path)
        /** 任何目录条目都会消耗枚举预算。 */
        let entries = 0
        try {
          for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
            if (++entries > 4000) throw new Error('原型目录条目超过列表预算')
            if (!/^[A-Za-z0-9_-]+$/.test(entry.name)) continue
            if (existsSync(join(path, entry.name, 'head.json'))) ids.push(entry.name)
            if (ids.length > 2000) throw new Error('原型数量超过列表预算')
          }
        } finally { handle.closeSync() }
        /** head 与版本元数据共享 8 MiB 读取预算，正文不参与列表查询。 */
        const budget = { remaining: 8 * 1024 * 1024 }
        return ids.map(id => {
          /** 当前版本提交点。 */
          const head = this.head(id, budget)
          /** 仅读取包含页面 locator 的版本元数据，不打开 contents。 */
          const bytes = readInteractionFile(join(this.directory(id, 'revisions'), `${head.revision}.json`), Math.min(budget.remaining, 2 * 1024 * 1024))
          budget.remaining -= bytes.length
          /** 摘要不是内容完整性证明；完整 hash 校验由 load/getVersion 执行。 */
          const stored = JSON.parse(bytes.toString('utf8')) as StoredVersion
          /** 用于轻量展示的当前版本元数据。 */
          const document = stored.document
          if (!document || document.id !== id || document.revision !== head.revision || document.schemaVersion !== 1
            || typeof document.name !== 'string' || document.name.length > 120 || !document.name.trim()
            || (document.platform !== 'mobile' && document.platform !== 'desktop')
            || !Array.isArray(document.pages) || document.pages.length < 1 || document.pages.length > PROTOTYPE_LIMITS.pages
            || !Number.isSafeInteger(document.updatedAt) || document.updatedAt < 0) throw new Error('原型摘要元数据损坏')
          return { id, name: document.name, platform: document.platform, revision: document.revision, pageCount: document.pages.length, updatedAt: document.updatedAt }
        })
      }
      case 'create': {
        /** 已解析的新建参数。 */
        const request = input as InteractionDesignInputs['create']
        return this.write(() => {
          /** 新原型稳定身份。 */
          const id = randomUUID()
          /** 页面入口传 pageName 时直接使用用户的页面名，避免先创建容器再生成重复首页。 */
          const pageName = request.pageName ?? '首页'
          this.commit(id, 0, { name: request.name, platform: request.platform, brief: '', groups: [{ id: 'main', name: '主要页面' }], pages: [{ id: 'home', groupId: 'main', name: pageName, html: '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body><main><h1 data-prototype-element="title">新页面</h1><p>在主会话描述这个页面的内容和交互。</p></main></body></html>' }], entryPageId: 'home', flows: [] }, request.pageName ? '创建页面' : '创建原型')
          return this.snapshot(id)
        })
      }
      case 'load': return this.snapshot((input as InteractionDesignInputs['load']).prototypeId)
      case 'save': {
        /** 已解析的保存参数。 */
        const request = input as InteractionDesignInputs['save']
        return this.write(() => { this.commit(request.prototypeId, request.baseRevision, request.draft, request.summary); return this.snapshot(request.prototypeId) })
      }
      case 'getVersion': {
        /** 历史读取参数。 */
        const request = input as InteractionDesignInputs['getVersion']
        return this.version(request.prototypeId, request.revision)
      }
      case 'restore': {
        /** 恢复只切换当前 head，不写入新的版本文件。 */
        const request = input as InteractionDesignInputs['restore']
        return this.write(() => {
          /** 读取期 CAS 状态与当前 head，避免旧界面覆盖新提交。 */
          const headPath = join(this.directory(request.prototypeId), 'head.json')
          const state = readAtomicFileState(headPath)
          const head = this.head(request.prototypeId)
          if (!state) throw new Error('原型当前指针记录损坏')
          if (head.revision !== request.baseRevision) throw new Error('原型版本已变化，请重新读取后恢复')
          /** 先完整校验目标版本，再原子切换当前指针。 */
          this.version(request.prototypeId, request.revision)
          writeJsonFileAtomicSecure(headPath, {
            schemaVersion: 1,
            workspaceId: this.dependencies.workspaceId,
            prototypeId: request.prototypeId,
            revision: request.revision,
            latestRevision: head.latestRevision ?? head.revision,
            adopted: head.adopted,
          }, { expectedDestination: { kind: 'state', state } })
          return this.snapshot(request.prototypeId)
        })
      }
      case 'propose': return this.write(() => this.propose(input as InteractionDesignInputs['propose']))
      case 'getCandidate': {
        /** 候选定位参数。 */
        const request = input as InteractionDesignInputs['getCandidate']
        return this.candidate(request.prototypeId, request.candidateId)
      }
      case 'adopt': {
        /** 显式用户采纳。 */
        const request = input as InteractionDesignInputs['adopt']
        return this.write(() => {
          /** 当前候选与可采纳性。 */
          const candidate = this.candidate(request.prototypeId, request.candidateId)
          if (candidate.status === 'adopted') return this.snapshot(request.prototypeId)
          if (candidate.status !== 'ready' || candidate.baseRevision !== request.baseRevision) throw new Error('候选已过期或不可采纳')
          if (candidate.jobId) {
            /** 候选正文提交与任务终态之间崩溃时，未完成的候选不能被采纳。 */
            const job = this.job(request.prototypeId, candidate.jobId)
            if (job.status !== 'candidate' || job.baseRevision !== candidate.baseRevision) throw new Error('候选对应的生成任务尚未完成或已失效')
            this.assertJobScope(job, candidate.draft)
          }
          this.commit(request.prototypeId, request.baseRevision, candidate.draft, candidate.summary, candidate.id)
          return this.snapshot(request.prototypeId)
        })
      }
      case 'discardCandidate': {
        /** 显式放弃候选。 */
        const request = input as InteractionDesignInputs['discardCandidate']
        return this.write(() => {
          /** 当前候选。 */
          const candidate = this.candidate(request.prototypeId, request.candidateId)
          if (candidate.status === 'adopted') throw new Error('已采纳候选不能放弃')
          this.record(request.prototypeId, 'candidates', { ...candidate, status: 'discarded', draftHash: interactionHash(JSON.stringify(parsePrototypeDraft(candidate.draft))) })
          this.candidateSummary({ ...candidate, status: 'discarded' })
          return this.snapshot(request.prototypeId)
        })
      }
      case 'beginJob': {
        /** 生成任务输入。 */
        const request = input as InteractionDesignInputs['beginJob']
        return this.write(() => {
          if (this.head(request.prototypeId).revision !== request.baseRevision) throw new Error('生成基线已变化')
          /** 验证范围来自实际基线，不接受不存在的页面。 */
          const baseline = this.version(request.prototypeId, request.baseRevision)
          if (request.pageId && !baseline.pages.some(page => page.id === request.pageId)) throw new Error('任务页面不存在')
          if (request.elementId) {
            /** 元素引用提供修改上下文，实际候选隔离边界仍为所属页面。 */
            const page = baseline.pages.find(value => value.id === request.pageId)
            if (!page || !new RegExp(`data-prototype-element\\s*=\\s*["']${request.elementId}["']`, 'i').test(page.html)) throw new Error('任务元素在指定页面不存在')
          }
          /** 已固定任务所属会话和范围。 */
          const job: PrototypeJob = { ...request, id: randomUUID(), status: 'running', createdAt: Date.now(), ...(request.elementId ? { message: '元素引用已固定，候选变更保护范围为所属页面' } : {}) }
          this.record(request.prototypeId, 'jobs', job)
          return job
        })
      }
      case 'cancelJob': case 'failJob': {
        /** 结束任务但不修改正式原型。 */
        const request = input as InteractionDesignInputs['failJob']
        return this.write(() => {
          /** 当前任务身份。 */
          const job = this.job(request.prototypeId, request.jobId)
          if (job.sessionId !== request.sessionId) throw new Error('任务会话不匹配')
          if (job.status === 'running') this.record(request.prototypeId, 'jobs', { ...job, status: method === 'cancelJob' ? 'cancelled' : 'failed', message: request.message?.slice(0, 1000) })
          return method === 'cancelJob' ? this.snapshot(request.prototypeId) : this.job(request.prototypeId, request.jobId)
        })
      }
      case 'importAsset': {
        /** 本项目图片来源。 */
        const request = input as InteractionDesignInputs['importAsset']
        this.head(request.prototypeId)
        /** 在安全来源读取之后复制到独立资产库。 */
        const bytes = await this.sources.bytes(request.relativePath, MAX_INTERACTION_IMAGE_BYTES)
        return this.write(() => { this.head(request.prototypeId); return this.assets.import(bytes, basename(request.relativePath)) })
      }
      case 'importMediaAsset': {
        /** 可信媒体引用，不能接受 renderer 绝对路径。 */
        const request = input as InteractionDesignInputs['importMediaAsset']
        this.head(request.prototypeId)
        if (!this.dependencies.readMediaAsset) throw new Error('媒体导入尚未授权')
        /** 后端验证引用后获得的图片字节。 */
        const bytes = Buffer.from(await this.dependencies.readMediaAsset({ assetId: request.assetId, revision: request.revision, hash: request.hash, mediaKind: 'image' }))
        return this.write(() => { this.head(request.prototypeId); return this.assets.import(bytes, request.assetId, request.hash) })
      }
      case 'assetContent': {
        /** 独立资产定位参数。 */
        const request = input as InteractionDesignInputs['assetContent']
        this.head(request.prototypeId)
        return this.assets.content(request.assetId)
      }
      case 'inspectProject': return this.sources.inspect()
      case 'readSource': return this.sources.read((input as InteractionDesignInputs['readSource']).paths)
      case 'importHtml': return this.importHtml(input as InteractionDesignInputs['importHtml'])
      case 'exportHtml': {
        /** 导出固定版本，不读取后来改变的 head 正文。 */
        const request = input as InteractionDesignInputs['exportHtml']
        /** 固定的版本完整文档。 */
        const document = this.version(request.prototypeId, request.revision)
        return this.write(() => createInteractionDelivery(document, this.assets, this.directory(request.prototypeId, 'deliveries', true)))
      }
      case 'validate': case 'recordExperience': {
        /** 验证证据严格绑定明确版本。 */
        const request = input as InteractionDesignInputs['recordExperience']
        return this.write(() => {
          /** 被验证的不可变文档。 */
          const document = this.version(request.prototypeId, request.revision)
          /** 结构检查只报告结构事实。 */
          const issues = method === 'validate' ? validatePrototypeStructure(document) : []
          /** 用户声明实际访问过的页面顺序，不推断未访问覆盖。 */
          const visitedPageIds = method === 'recordExperience' ? request.visitedPageIds : []
          if (visitedPageIds.some(id => !document.pages.some(page => page.id === id))) throw new Error('体验记录包含不存在的页面')
          /** 持久证据。 */
          const check: PrototypeCheck = { id: randomUUID(), revision: request.revision, kind: method === 'validate' ? 'structure' : 'experience', passed: issues.length === 0 && (method === 'validate' || visitedPageIds.length > 0), issues, visitedPageIds, createdAt: Date.now() }
          this.record(request.prototypeId, 'checks', check)
          return check
        })
      }
    }
  }
  /** 把静态 HTML 与本地相对依赖转为独立候选，读取失败不覆盖原稿。 */
  private async importHtml(request: InteractionDesignInputs['importHtml']): Promise<PrototypeCandidateSummary> {
    /** 固定来源版本。 */
    const document = this.version(request.prototypeId, request.baseRevision)
    /** 页面源 HTML。 */
    const original = await this.sources.text(request.relativePath)
    /** 递归闭包剩余总预算。 */
    let remaining = 4 * 1024 * 1024
    /** 已读取的依赖去重与循环检测。 */
    const active = new Set<string>()
    /** 解析并复制相对依赖，拒绝网络与项目越界。 */
    const dependency = async (url: string, source: string, depth: number): Promise<string> => {
      if (/^(?:data:|#|prototype-asset:)/i.test(url)) return url
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(url) || depth > 6) throw new Error('导入依赖必须是有界的本地相对资源')
      /** 去除查询与锚点后的实际相对依赖位置。 */
      const path = posix.normalize(posix.join(posix.dirname(source), decodeURIComponent(url.split(/[?#]/, 1)[0]!)))
      if (active.has(path)) throw new Error('导入依赖形成循环')
      active.add(path)
      try {
        if (/\.css$/i.test(path)) {
          /** 原始 CSS。 */
          let css = await this.sources.text(path, Math.min(remaining, 512 * 1024))
          remaining -= Buffer.byteLength(css)
          /** 将 CSS @import 递归内联，预览 CSP 不需要开放外部样式源。 */
          const imports = [...css.matchAll(/@import\s+(?:url\(\s*(['"]?)(.*?)\1\s*\)|(['"])(.*?)\3)\s*([^;]*);/gi)]
          for (const imported of imports) {
            /** 已打包的子样式数据。 */
            const resource = await dependency(imported[2] ?? imported[4]!, path, depth + 1)
            if (!resource.startsWith('data:text/css;base64,')) throw new Error('CSS import 只能引用本地样式')
            /** 子样式实际正文。 */
            const content = Buffer.from(resource.slice('data:text/css;base64,'.length), 'base64').toString('utf8')
            css = css.replace(imported[0], imported[5]?.trim() ? `@media ${imported[5]} {${content}}` : content)
          }
          /** CSS 相对图片和字体引用；字体暂不准入，避免错误导出。 */
          const matches = [...css.matchAll(/url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi)]
          for (const match of matches) {
            /** CSS data URL 内必须使用可独立解析的图片数据。 */
            const resource = await dependency(match[2]!, path, depth + 1)
            css = css.replace(match[0], `url("${resource.startsWith('prototype-asset:') ? this.assets.content(resource.slice(16)).dataUrl : resource}")`)
          }
          return `data:text/css;base64,${Buffer.from(css).toString('base64')}`
        }
        if (/\.[cm]?js$/i.test(path)) {
          /** 只支持独立脚本，ES module 依赖必须先打包。 */
          const script = await this.sources.text(path, Math.min(remaining, 512 * 1024))
          remaining -= Buffer.byteLength(script)
          if (/\b(?:import\s*(?:[('"*{]|\w)|export\s)/.test(script)) throw new Error('导入脚本包含模块依赖，请先构建静态 HTML')
          return `data:text/javascript;base64,${Buffer.from(script).toString('base64')}`
        }
        if (/\.woff2?$/i.test(path)) {
          /** 字体作为当前页面内嵌资源保存，保持离线字体一致。 */
          const font = await this.sources.bytes(path, Math.min(remaining, 2 * 1024 * 1024))
          remaining -= font.length
          /** 标准 WOFF/WOFF2 文件头。 */
          const signature = font.subarray(0, 4).toString('ascii')
          if (signature !== 'wOFF' && signature !== 'wOF2') throw new Error('字体文件格式无效')
          return `data:font/${signature === 'wOF2' ? 'woff2' : 'woff'};base64,${font.toString('base64')}`
        }
        /** 其余资源只允许经过魔数检查的图片。 */
        const bytes = await this.sources.bytes(path, Math.min(remaining, MAX_INTERACTION_IMAGE_BYTES))
        remaining -= bytes.length
        /** 保存独立图片，不因 Canvas 清理而失效。 */
        const asset = await this.write(() => this.assets.import(bytes, basename(path)))
        return `prototype-asset:${asset.id}`
      } finally { active.delete(path) }
    }
    /** 改写的候选 HTML。 */
    let html = original.replace(/<(img|script|link|source)\b[^>]*>/gi, tag => tag.replace(/\b(src|href)\s*=\s*([^\s"'=<>`]+)/gi, (_attribute, name: string, value: string) => `${name}="${value}"`))
    /** 只改写资源属性，普通链接稍后显式处理。 */
    const matches = [...html.matchAll(/<(img|script|link|source)\b[^>]*?\b(src|href)\s*=\s*(['"])(.*?)\3[^>]*>/gi)]
    for (const match of matches) {
      /** 经依赖闭包复制的资源引用。 */
      const replacement = await dependency(match[4]!, request.relativePath, 0)
      if (match[1]!.toLowerCase() === 'script' && replacement.startsWith('data:text/javascript;base64,')) {
        /** 脚本内联以匹配隔离预览 CSP。 */
        const content = Buffer.from(replacement.slice('data:text/javascript;base64,'.length), 'base64').toString('utf8')
        if (/<\/script/i.test(content)) throw new Error('脚本包含无法安全内联的结束标签')
        html = html.replace(match[0], `<script>${content}`)
      } else if (match[1]!.toLowerCase() === 'link' && replacement.startsWith('data:text/css;base64,')) {
        /** 样式内联，避免 data URL 样式被隔离策略拦截。 */
        const content = Buffer.from(replacement.slice('data:text/css;base64,'.length), 'base64').toString('utf8')
        if (/<\/style/i.test(content)) throw new Error('样式包含无法安全内联的结束标签')
        html = html.replace(match[0], `<style>${content}</style>`)
      } else html = html.replace(match[0], match[0].replace(`${match[3]}${match[4]}${match[3]}`, `${match[3]}${replacement}${match[3]}`))
    }
    if (/\bsrcset\s*=|<base\b|<iframe\b|<object\b|<embed\b/i.test(html)) throw new Error('HTML 包含尚未支持的嵌入或响应式资源，请先生成独立静态页面')
    /** 页面内 CSS 同样不能留下失效的相对资源。 */
    const inlineUrls = [...html.matchAll(/url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi)]
    for (const match of inlineUrls) html = html.replace(match[0], `url("${await dependency(match[2]!, request.relativePath, 0)}")`)
    /** 目标分组不存在时拒绝，不隐式修改目录。 */
    const groupId = request.groupId ?? document.groups[0]?.id
    if (!groupId || !document.groups.some(group => group.id === groupId)) throw new Error('导入目标分组不存在')
    /** 新页面稳定身份。 */
    const id = randomUUID()
    return this.write(() => this.propose({ ...request, draft: { ...document, pages: [...document.pages, { id, groupId, name: basename(request.relativePath), html, source: { path: request.relativePath, hash: interactionHash(original), kind: 'html' } }] }, summary: `导入 ${basename(request.relativePath)}` }))
  }
}
