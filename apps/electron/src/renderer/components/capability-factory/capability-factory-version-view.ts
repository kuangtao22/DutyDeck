/**
 * 版本历史的展示逻辑（纯函数）。
 *
 * 为什么每一版都要带"相对上一版改了什么"：只列 `v2 · agent · 08:28` 的话，
 * 人根本认不出哪一版是"我调好的那版" —— 版本号本身没有语义，
 * 有语义的是**这一版动了什么**。回滚的价值全在这上面。
 */
import { diffSceneDefinition } from '@proma/shared'
import type { CapabilitySceneVersion } from '@proma/shared'

/** 一行版本历史。 */
export interface SceneVersionRow {
  version: number
  /** 来源的中文说法：Agent 提出 / 人工。 */
  sourceLabel: string
  /** 相对上一版改了什么；v1 与"与上一版无差异"各有专门说法。 */
  changeSummary: string
  note: string
  createdAt: number
  /** 是否就是当前生效的版本。 */
  isCurrent: boolean
}

/** 来源标签：Agent 与人的改动要能一眼分开（回滚时会关心"这版是谁弄的"）。 */
function sourceLabel(source: CapabilitySceneVersion['source']): string {
  return source === 'agent' ? 'Agent 提出' : '人工'
}

/**
 * 把版本历史整理成可渲染的行（**最新的在前**）。
 *
 * @param versions 版本历史（升序，来自 listVersions）
 * @param currentVersion 当前生效版本号
 * @returns 逐行展示信息
 */
export function describeVersionHistory(
  versions: readonly CapabilitySceneVersion[],
  currentVersion: number,
): SceneVersionRow[] {
  const ascending = [...versions].sort((a, b) => a.version - b.version)
  return ascending
    .map((version, index) => {
      const previous = index === 0 ? null : ascending[index - 1] ?? null
      return {
        version: version.version,
        sourceLabel: sourceLabel(version.source),
        changeSummary: previous === null
          ? '首个版本'
          : summarizeChanges(previous, version),
        note: version.note,
        createdAt: version.createdAt,
        isCurrent: version.version === currentVersion,
      }
    })
    .reverse()
}

/** 相邻两版的差异摘要；无差异时如实说明（重命名之外的"空改动"也会走到这里）。 */
function summarizeChanges(previous: CapabilitySceneVersion, version: CapabilitySceneVersion): string {
  const changes = diffSceneDefinition(previous.definition, version.definition)
  if (changes.length === 0) return '与上一版无差异'
  /** 一行放不下全部改动，只显示前两条，其余给出条数。 */
  const head = changes.slice(0, 2).map((change) => change.detail).join('；')
  return changes.length > 2 ? `${head}；等 ${changes.length} 处` : head
}

/**
 * 回滚的后果说明。
 *
 * 回滚**不是删除历史**：它把旧快照提升为一个新版本（版本号只增不减），
 * 所以界面上必须写清"会生成 v(N+1)，内容与 vX 一致"，否则用户会以为版本号回退了。
 *
 * @param targetVersion 要回到的版本
 * @param currentVersion 当前生效版本
 * @returns 一句给人看的后果说明
 */
export function describeRollbackEffect(targetVersion: number, currentVersion: number): string {
  if (targetVersion === currentVersion) return `v${targetVersion} 就是当前生效版本，无需回滚。`
  return `回到 v${targetVersion} 会生成 v${currentVersion + 1}（内容与 v${targetVersion} 一致）：`
    + '版本号只增不减，中间那些版本都留在历史里，随时可以再回滚回来。'
}
