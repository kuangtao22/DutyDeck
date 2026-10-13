import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stableCapabilityValueKey } from '../../../packages/shared/src/types/capability-factory'
import type { CapabilityCase, CapabilitySceneDefinition } from '../../../packages/shared/src/types/capability-factory'
import { validateCapabilityEvaluationProtocol, validateCapabilityExperimentSamples } from '../../../packages/shared/src/types/capability-factory-experiment'
import type { CapabilityExperimentSample } from '../../../packages/shared/src/types/capability-factory-experiment'
import { assertCapabilityScoringLabels } from '../../../apps/electron/src/main/lib/capability-factory/capability-factory-scoring'
import { writeJsonFileAtomicSecure } from '../../../apps/electron/src/main/lib/safe-file'

/** 证据只使用当前输入中的显式引用与原文，不运行其中指令。 */
interface Paragraph { paragraphRef: string; text: string }
/** 冻结姓名标签；其他业务字段继续由原场景评审。 */
interface CharacterLabel { name: string; nameEvidence: { paragraphRef: string; selectedText: string } }
/** 已整理的案例输入与完整姓名集合。 */
interface PilotCase extends CapabilityCase {
  input: { corpusText: string; knownCharacters: string; continuationContext: string }
  expected: { characters: CharacterLabel[]; scanComplete?: boolean }
  scoring: NonNullable<CapabilityCase['scoring']>
}
/** 同一来源的切片定位；本机用段落，公开全文用 UTF-16 半开区间。 */
interface Annotation { caseId: string; startUtf16?: number; endUtf16?: number; paragraphRefs?: string[] }
/** 来源级数据包；读取检查说明但绝不将其打印到优化上下文。 */
interface PilotPack {
  schemaVersion: number
  split: CapabilityExperimentSample['split']
  source: { sourceGroupId: string; sha256: string; cachedTextPath: string; format?: string; excludedParagraphRefs?: string[] }
  cases: PilotCase[]
  annotations: Annotation[]
}
/** 基线快照用于只读漂移检查，不能据此覆盖应用场景。 */
interface BaselineSnapshot { sceneId: string; sceneVersion: number; definition: CapabilitySceneDefinition; definitionFingerprint: string }
/** 控制台和审计文件只输出不含答案的数值摘要。 */
interface SplitSummary { split: string; cases: number; nonempty: number; empty: number; sourceGroups: number; textChars: number; minChars: number; maxChars: number; evidenceCount: number; packSha256: string; sourceSha256: string }
/** 独立语义核对记录必须绑定当前数据字节，不能沿用过期结论。 */
interface LabelReview { reviewed: number; passed: number; pending: number; files: { file: string; sha256: string }[] }

/** 数据包位置；命令可从任意工作目录运行。 */
const packageRoot = dirname(fileURLToPath(import.meta.url))
/** 三组固定顺序只用于输出摘要，不读取正文来生成候选。 */
const splits = ['optimization', 'validation', 'held-out'] as const
/** 不满足数据合同即停止；错误信息不含受保护文本或标签。 */
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }
/** 从包内读取 JSON；返回声明结构，具体合同在后续显式校验。 */
function readJson<T>(name: string): T { return JSON.parse(readFileSync(join(packageRoot, name), 'utf8')) as T }
/** 对实际文件字节或字符串计算 SHA-256。 */
function sha256(value: Buffer | string): string { return createHash('sha256').update(value).digest('hex') }
/** 与宿主实验使用相同稳定编码，不依赖 JSON 键插入顺序。 */
function fingerprint(value: unknown): string { return sha256(stableCapabilityValueKey(value)) }
/** JSONL 解码仅提取段落，空行忽略。 */
function decodeParagraphs(value: string): Paragraph[] { return value.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as Paragraph) }

/** 首先复用生产协议验证，不在脚本里另造评分标准。 */
const protocol = validateCapabilityEvaluationProtocol(readJson<unknown>('protocol.json'))
const baseline = readJson<BaselineSnapshot>('baseline-snapshot.json')
assert(fingerprint(baseline.definition) === baseline.definitionFingerprint, '基线快照指纹不符')
/** 只收集必要的验证中间态，不输出样本文本。 */
const samples: CapabilityExperimentSample[] = []
const allCases: PilotCase[] = []
const summaries: SplitSummary[] = []
const corpusHashes = new Set<string>()
for (const split of splits) {
  /** 每份包必须恰好提供该组十条，不能靠空样本补主指标分母。 */
  const packPath = `${split}.json`
  const pack = readJson<PilotPack>(packPath)
  assert(pack.schemaVersion === 1 && pack.split === split && pack.cases.length === 10, `${split}: 版本、划分或数量不符`)
  assert(pack.annotations.length === 10 && new Set(pack.annotations.map((item) => item.caseId)).size === 10, `${split}: 定位缺失或重复`)
  /** 来源限于持久数据包内，避免临时缓存过期或任意外部路径。 */
  const sourcePath = resolve(packageRoot, pack.source.cachedTextPath)
  const sourceRelative = relative(packageRoot, sourcePath)
  assert(!isAbsolute(pack.source.cachedTextPath) && !sourceRelative.startsWith('..'), `${split}: 来源必须在包内`)
  const sourceBytes = readFileSync(sourcePath)
  assert(sha256(sourceBytes) === pack.source.sha256, `${split}: 来源哈希不符`)
  const sourceText = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes)
  const sourceParagraphs = pack.source.format === 'jsonl' ? decodeParagraphs(sourceText) : []
  if (pack.source.format !== 'jsonl') {
    assert(/\*\*\* START OF (THE|THIS) PROJECT GUTENBERG/i.test(sourceText)
      && /\*\*\* END OF (THE|THIS) PROJECT GUTENBERG/i.test(sourceText), `${split}: 官方全文首尾标记缺失`)
  }
  /** 用集合及区间检查来源内交叠，不能仅靠序列化输入不同判唯一。 */
  const usedRefs = new Set<string>()
  const ranges: [number, number][] = []
  const lengths: number[] = []
  let empty = 0
  let evidenceCount = 0
  for (const item of pack.cases) {
    const label = `${split}/${item.id}`
    assert(item.source === 'agent' && item.scoring.split === split && item.scoring.sourceGroupId === pack.source.sourceGroupId, `${label}: 来源或分组不符`)
    assert(item.input.knownCharacters === '[]' && item.input.continuationContext === '', `${label}: 首轮输入条件不符`)
    assert(fingerprint(item.input) === item.scoring.inputFingerprint, `${label}: 输入指纹不符`)
    const paragraphs = decodeParagraphs(item.input.corpusText)
    assert(paragraphs.length > 0 && paragraphs.every((part) => typeof part.text === 'string' && part.text.trim() && typeof part.paragraphRef === 'string' && part.paragraphRef.length > 0 && part.paragraphRef.length <= 64), `${label}: 段落结构无效`)
    assert(new Set(paragraphs.map((part) => part.paragraphRef)).size === paragraphs.length, `${label}: 重复段落引用`)
    const text = paragraphs.map((part) => part.text).join('\n')
    const textHash = sha256(text)
    assert(!corpusHashes.has(textHash), `${label}: 正文精确重复`)
    corpusHashes.add(textHash)
    lengths.push(text.length)
    const annotation = pack.annotations.find((entry) => entry.caseId === item.id)
    assert(annotation, `${label}: 缺来源定位`)
    if (pack.source.format === 'jsonl') {
      assert(stableCapabilityValueKey(annotation.paragraphRefs) === stableCapabilityValueKey(paragraphs.map((part) => part.paragraphRef)), `${label}: 段落定位不符`)
      for (const part of paragraphs) {
        assert(!usedRefs.has(part.paragraphRef) && !pack.source.excludedParagraphRefs?.includes(part.paragraphRef), `${label}: 来源交叠或包含已排除段落`)
        usedRefs.add(part.paragraphRef)
        assert(sourceParagraphs.some((source) => source.paragraphRef === part.paragraphRef && source.text === part.text), `${label}: 原段落不匹配`)
      }
    } else {
      const start = annotation.startUtf16
      const end = annotation.endUtf16
      assert(typeof start === 'number' && typeof end === 'number' && Number.isInteger(start) && Number.isInteger(end)
        && start >= 0 && end > start && end <= sourceText.length, `${label}: 原文区间无效`)
      assert(sourceText.slice(start, end) === text, `${label}: 原文切片不匹配`)
      assert(!ranges.some(([left, right]) => start < right && end > left), `${label}: 切片重叠`)
      ranges.push([start, end])
      if (split === 'held-out') assert(start >= 38635, `${label}: 不能复用已暴露旧留出切片`)
    }
    assert(Array.isArray(item.expected.characters) && item.expected.characters.length <= 6, `${label}: 超出首页集合范围`)
    if (item.expected.characters.length === 0) empty += 1
    for (const character of item.expected.characters) {
      const evidence = character.nameEvidence
      assert(typeof character.name === 'string' && character.name.trim() && character.name.length <= 200
        && evidence.selectedText.length > 0 && evidence.selectedText.length <= 1200, `${label}: 姓名或证据长度无效`)
      const paragraph = paragraphs.find((part) => part.paragraphRef === evidence.paragraphRef)
      assert(paragraph?.text.includes(evidence.selectedText) && evidence.selectedText.includes(character.name), `${label}: 姓名证据不在对应原文`)
      evidenceCount += 1
    }
    samples.push({ caseId: item.id, ...item.scoring, expected: item.expected })
    allCases.push(item)
  }
  assert(empty < 10, `${split}: 缺少非空主指标样本`)
  summaries.push({ split, cases: pack.cases.length, nonempty: 10 - empty, empty, sourceGroups: 1,
    textChars: lengths.reduce((sum, value) => sum + value, 0), minChars: Math.min(...lengths), maxChars: Math.max(...lengths), evidenceCount,
    packSha256: sha256(readFileSync(join(packageRoot, packPath))), sourceSha256: pack.source.sha256 })
}
/** 生产预检证明结构可评分，不证明所有语义标签正确；语义核对单独审查。 */
validateCapabilityExperimentSamples(samples)
assertCapabilityScoringLabels(protocol, samples)
assert(new Set(samples.map((item) => item.sourceGroupId)).size === 3, '必须保留三个不同来源组')
/** 本校验只证明独立审查记录与数据仍一致，不替代语义阅读。 */
const labelReview = readJson<LabelReview>('label-review.json')
assert(labelReview.reviewed === 30 && labelReview.passed === 30 && labelReview.pending === 0, '独立标签审查尚未全部通过')
for (const summary of summaries) {
  assert(labelReview.files.filter((item) => item.file === `${summary.split}.json` && item.sha256 === summary.packSha256).length === 1,
    `${summary.split}: 独立审查后数据已变化，必须重新核对`)
}
/** 可选只读预检：开始真实调用前强制检查应用生效版本和整份基线。 */
let liveBaselineChecked = false
if (process.argv.includes('--check-live')) {
  const scenes = JSON.parse(readFileSync('/Users/xutaoyu/.proma/agent-workspaces/default/capability-factory/scenes.json', 'utf8')) as {
    scenes: { id: string; currentVersion: number; definition: CapabilitySceneDefinition }[]
  }
  const scene = scenes.scenes.find((item) => item.id === baseline.sceneId)
  assert(scene?.currentVersion === baseline.sceneVersion && fingerprint(scene.definition) === baseline.definitionFingerprint, '应用场景已漂移，需重新冻结基线')
  liveBaselineChecked = true
}
/** 输出摘要没有正文/答案；未知语义与价格不填零。 */
const audit = { schemaVersion: 1, checkedAt: new Date().toISOString(), passed: true, cases: allCases.length,
  sourceGroups: 3, protocolFingerprint: fingerprint(protocol), datasetFingerprint: fingerprint(allCases),
  baselineFingerprint: baseline.definitionFingerprint, liveBaselineChecked, independentReviewBound: true, splits: summaries,
  checks: ['完整来源SHA256', '官方全文首尾标记', '原文精确切片', '来源内不交叠', '来源不跨组', '输入和正文精确去重', '姓名证据逐字命中', '生产协议与完整标签预检', '独立标签复核与当前文件绑定'],
  limits: ['未检测所有近似或语义重复', '独立标签复核由Agent完成，未经用户逐条人工签署', '一部作品多片段不等于独立样本', '没有执行真实模型请求'],
}
if (process.argv.includes('--write')) {
  /** 合并数据集供后续宿主导入；此处不修改应用数据库或草案。 */
  writeJsonFileAtomicSecure(join(packageRoot, 'dataset.json'), { id: 'novel-character-real-pilot-20261011', name: '小说角色提取真实试点30条-20261011',
    version: 1, updatedAt: Date.now(), protocol, cases: allCases })
  writeJsonFileAtomicSecure(join(packageRoot, 'audit.json'), audit)
}
console.log(JSON.stringify(audit, null, 2))
