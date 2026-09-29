/**
 * Agent 本轮文件统计的磁盘持久化。
 *
 * 每轮只保存主进程已计算的元数据；不保存任何文件正文，也不会在读取时重新扫描工作区。
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgentRunFileChange, AgentRunFileChangesSnapshot } from '@proma/shared'
import { getAgentSessionMessagesPath } from './config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'

/** 每轮最多记录的文件数，防止异常工具调用放大元数据和 IPC 负担。 */
const MAX_FILES_PER_RUN = 256
/** 单条绝对路径允许的最大字符数，覆盖主流平台上限并避免损坏文件占用内存。 */
const MAX_FILE_PATH_LENGTH = 4_096
/** 单个统计快照的读取上限；数据只含元数据，超过即视为异常。 */
const MAX_SNAPSHOT_BYTES = 1_048_576
/** 固定的统计目录名，位于 Agent 会话 JSONL 目录旁。 */
const RUN_FILE_CHANGES_DIRECTORY = '.run-file-changes'
/** 仅接受由 startedAt 生成的十进制安全整数 runId。 */
const RUN_ID_PATTERN = /^(0|[1-9]\d{0,15})$/

/** 测试可注入会话消息路径，生产固定使用 config-paths 的安全入口。 */
export type AgentSessionMessagesPathResolver = (sessionId: string) => string

/** 供调用方使用的本轮统计磁盘服务。 */
export interface AgentRunFileChangesStore {
  /** 读取某会话的全部有效轮次统计。 */
  readAgentRunFileChanges(sessionId: string): AgentRunFileChangesSnapshot[]
  /** 按 runId 原子替换某轮的权威统计快照。 */
  writeAgentRunFileChanges(sessionId: string, snapshot: AgentRunFileChangesSnapshot): void
  /** 删除会话对应的全部本轮统计。 */
  removeAgentRunFileChanges(sessionId: string): void
}

/**
 * 创建无内存缓存的统计存储实例。
 *
 * @param resolveSessionMessagesPath 已验证 sessionId 后返回消息 JSONL 路径的函数。
 * @returns 同步磁盘读写的统计服务。
 */
export function createAgentRunFileChangesStore(
  resolveSessionMessagesPath: AgentSessionMessagesPathResolver = getAgentSessionMessagesPath,
): AgentRunFileChangesStore {
  /** 先经现有 JSONL 路径入口校验，再推导受控的统计目录。 */
  function getSessionDirectory(sessionId: string): string {
    const messagesPath = resolveSessionMessagesPath(sessionId)
    return join(dirname(messagesPath), RUN_FILE_CHANGES_DIRECTORY, sessionId)
  }

  /** 构造轮次文件路径前验证 runId 不会改变目录层级。 */
  function getSnapshotPath(sessionId: string, runId: string): string {
    assertValidRunId(runId)
    return join(getSessionDirectory(sessionId), `${runId}.json`)
  }

  return {
    readAgentRunFileChanges(sessionId): AgentRunFileChangesSnapshot[] {
      const sessionDirectory = getSessionDirectory(sessionId)
      if (!existsSync(sessionDirectory)) return []

      let entries: string[]
      try {
        entries = readdirSync(sessionDirectory)
      } catch {
        return []
      }

      const snapshots: AgentRunFileChangesSnapshot[] = []
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue
        const runId = entry.slice(0, -'.json'.length)
        if (!isValidRunId(runId)) continue

        const filePath = getSnapshotPath(sessionId, runId)
        try {
          /** 拒绝链接和目录，避免损坏目录项触发跨边界读取。 */
          if (!lstatSync(filePath).isFile()) continue
          const snapshot = readJsonFileSafe<AgentRunFileChangesSnapshot>(filePath, {
            validate: isAgentRunFileChangesSnapshot,
            maxBytes: MAX_SNAPSHOT_BYTES,
          })
          if (snapshot) snapshots.push(snapshot)
        } catch {
          /** 单轮损坏不影响其它统计文件。 */
        }
      }

      return snapshots.sort((left, right) => left.startedAt - right.startedAt)
    },

    writeAgentRunFileChanges(sessionId, snapshot): void {
      assertValidRunId(snapshot.runId)
      assertAgentRunFileChangesSnapshot(snapshot)
      const filePath = getSnapshotPath(sessionId, snapshot.runId)
      mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
      /** 每轮文件可由下一次权威快照完整替换，无需额外 .bak 占用。 */
      writeJsonFileAtomic(filePath, snapshot, true)
    },

    removeAgentRunFileChanges(sessionId): void {
      const sessionDirectory = getSessionDirectory(sessionId)
      if (!existsSync(sessionDirectory)) return
      /** sessionId 已由消息路径入口校验，删除范围限定为该会话的固定统计目录。 */
      rmSync(sessionDirectory, { recursive: true, force: true, maxRetries: 2 })
    },
  }
}

/** 生产单例不持有任何快照，所有数字都从磁盘读取或由调用方重新写入。 */
const defaultStore = createAgentRunFileChangesStore()

/**
 * 读取会话的全部有效本轮统计。
 *
 * @param sessionId 经调用方会话权限检查后的会话 ID。
 * @returns 按 startedAt 升序排列的有效快照。
 */
export function readAgentRunFileChanges(sessionId: string): AgentRunFileChangesSnapshot[] {
  return defaultStore.readAgentRunFileChanges(sessionId)
}

/**
 * 原子写入一轮主进程权威统计。
 *
 * @param sessionId 经调用方会话权限检查后的会话 ID。
 * @param snapshot 不含文件正文的本轮统计快照。
 */
export function writeAgentRunFileChanges(sessionId: string, snapshot: AgentRunFileChangesSnapshot): void {
  defaultStore.writeAgentRunFileChanges(sessionId, snapshot)
}

/**
 * 删除一个会话对应的全部本轮统计。
 *
 * @param sessionId 经调用方会话删除流程确认的会话 ID。
 */
export function removeAgentRunFileChanges(sessionId: string): void {
  defaultStore.removeAgentRunFileChanges(sessionId)
}

/** 验证 runId 是可精确表示的 startedAt 十进制字符串。 */
function isValidRunId(runId: unknown): runId is string {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) return false
  const numericRunId = Number(runId)
  return Number.isSafeInteger(numericRunId) && numericRunId >= 0 && String(numericRunId) === runId
}

/** 在写入路径生成前拒绝非法 runId。 */
function assertValidRunId(runId: unknown): asserts runId is string {
  if (!isValidRunId(runId)) throw new Error('无效的本轮 ID')
}

/** 检查数字字段是非负安全整数。 */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** 检查 revision 是从 1 开始递增的安全整数。 */
function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

/** 检查单条文件变化元数据，禁止把不完整统计伪装为精确数字。 */
function isAgentRunFileChange(value: unknown): value is AgentRunFileChange {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const statuses = ['added', 'modified', 'deleted', 'unchanged', 'unknown']
  const statsStates = ['complete', 'binary', 'too_large', 'unavailable', 'external_change', 'budget_exceeded']
  if (typeof record.path !== 'string' || record.path.length === 0 || record.path.length > MAX_FILE_PATH_LENGTH) return false
  if (!statuses.includes(record.status as string) || !statsStates.includes(record.statsState as string)) return false

  const hasAdditions = record.additions !== undefined
  const hasDeletions = record.deletions !== undefined
  if (record.statsState === 'complete') {
    return isNonNegativeSafeInteger(record.additions) && isNonNegativeSafeInteger(record.deletions)
  }
  return !hasAdditions && !hasDeletions
}

/** 检查可落盘快照的边界和字段一致性。 */
function isAgentRunFileChangesSnapshot(value: unknown): value is AgentRunFileChangesSnapshot {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (!isValidRunId(record.runId) || !isNonNegativeSafeInteger(record.startedAt)) return false
  if (record.runId !== String(record.startedAt)) return false
  const endedAt = record.endedAt
  if (endedAt !== undefined && (!isNonNegativeSafeInteger(endedAt) || endedAt < record.startedAt)) return false
  const revision = record.revision
  if (revision !== undefined && !isPositiveSafeInteger(revision)) return false
  if (!Array.isArray(record.files) || record.files.length > MAX_FILES_PER_RUN || !record.files.every(isAgentRunFileChange)) return false
  return record.hasUnattributedChanges === undefined || typeof record.hasUnattributedChanges === 'boolean'
}

/** 写入前抛出稳定错误，避免调用方误把无效快照当作落盘成功。 */
function assertAgentRunFileChangesSnapshot(value: unknown): asserts value is AgentRunFileChangesSnapshot {
  if (!isAgentRunFileChangesSnapshot(value)) throw new Error('无效的本轮文件统计快照')
}
