/**
 * 交付这一段的展示逻辑（纯函数）：默认文件名与导出前的体检文案。
 */
import type { CapabilityPackageReadiness } from '@proma/shared'

/**
 * 建议的导出文件名：`<场景名>-v<版本>.json`。
 *
 * 场景名可能带空格、斜杠、中文标点 —— 主进程只接受"一个普通文件名"，
 * 所以这里先规整成人能读又不越界的形态（中文保留，仅替换分隔符与危险字符）。
 *
 * @param sceneName 场景名
 * @param version 导出时的场景版本
 * @returns 安全的默认文件名
 */
export function suggestedPackageFileName(sceneName: string, version: number): string {
  const safe = sceneName.trim().replace(/[\s/\\:*?"<>|]+/g, '-').replace(/^-+|-+$/g, '')
  const base = safe.length === 0 ? 'capability-package' : safe
  return `${base}-v${version}.json`
}

/** 导出前体检的一句话：已验证就说清依据，未验证就说清缺什么。 */
export function describeDeliveryHint(readiness: CapabilityPackageReadiness): { tone: 'ok' | 'warn'; text: string } {
  return readiness.verified
    ? {
        tone: 'ok',
        text: '已验证：当前版本在真实数据上跑通过（没有用占位桩）。导出后可以把包交给关联项目接入。',
      }
    : {
        tone: 'warn',
        text: `${readiness.reason ?? '还没有验证过'}。包本身照样可以导出（定义与提示词是完整的），`
          + '但接进项目后提示词大概率还要返工 —— 建议先在「运行」页跑一次真实数据再导出。',
      }
}
