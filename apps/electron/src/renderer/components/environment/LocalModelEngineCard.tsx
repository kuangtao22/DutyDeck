import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { AlertCircle, CheckCircle2, Cpu, ExternalLink, Loader2, XCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { settingsTabAtom } from '@/atoms/settings-tab'
import {
  acceptLocalModelSnapshotAtom,
  localModelErrorsAtom,
  localModelLoadErrorAtom,
  localModelPendingAtom,
  localModelSnapshotAtom,
  performLocalModelActionAtom,
  refreshLocalModelsAtom,
} from '@/atoms/local-model-atoms'
import { localModelSize } from '@/lib/local-model-state'

/** llama.cpp 环境是否已经完成校验并可供模型使用。 */
function isEngineReady(engine: NonNullable<ReturnType<typeof useEngineSnapshot>>): boolean {
  return engine.available && (engine.state === undefined || engine.state === 'installed')
}

/** 从共享快照读取引擎摘要，避免在多个设置页面复制字段兼容逻辑。 */
function useEngineSnapshot() {
  return useAtomValue(localModelSnapshotAtom)?.engine
}

/** 将引擎生命周期映射为用户能理解的状态文案。 */
function engineStateLabel(engine: NonNullable<ReturnType<typeof useEngineSnapshot>> | undefined): string {
  if (!engine) return '正在读取状态…'
  if (isEngineReady(engine)) return `v${engine.version ?? '固定版本'} · 已安装`
  return ({
    'not-installed': '尚未安装',
    downloading: '下载安装包…',
    verifying: '正在校验…',
    installing: '正在安装…',
    installed: '已安装，正在检测可用性',
    error: '安装失败，可重试',
  }[engine.state ?? 'not-installed'] ?? '状态未知')
}

/**
 * 关于/更新页的 llama.cpp 环境卡片。
 *
 * 引擎是多个 DutyDeck 本地模型共享的环境能力，安装入口集中在这里；
 * 模型配置页只展示依赖状态并跳转到这里，避免重复安装入口造成职责混淆。
 */
export function LocalModelEngineCard(): React.ReactElement {
  const snapshot = useAtomValue(localModelSnapshotAtom)
  const engine = useEngineSnapshot()
  const pending = useAtomValue(localModelPendingAtom)
  const errors = useAtomValue(localModelErrorsAtom)
  const loadError = useAtomValue(localModelLoadErrorAtom)
  const accept = useSetAtom(acceptLocalModelSnapshotAtom)
  const refresh = useSetAtom(refreshLocalModelsAtom)
  const perform = useSetAtom(performLocalModelActionAtom)
  const setSettingsTab = useSetAtom(settingsTabAtom)

  React.useEffect(() => {
    const offChanged = window.electronAPI.onLocalModelChanged(accept)
    void refresh()
    return offChanged
  }, [accept, refresh])

  const ready = engine ? isEngineReady(engine) : false
  const busy = engine?.state === 'downloading' || engine?.state === 'verifying' || engine?.state === 'installing'
  const pendingEngine = Boolean(pending.engine)
  // 安装失败以主进程快照诊断为准，避免迟到的 IPC 拒绝覆盖具体原因。
  const errorMessage = (engine?.state === 'error' ? engine.message : undefined) ?? errors.engine ?? engine?.message ?? loadError
  const StatusIcon = !engine ? Loader2 : ready ? CheckCircle2 : engine.state === 'error' ? XCircle : AlertCircle
  const statusColor = !engine ? 'text-muted-foreground' : ready ? 'text-green-600 dark:text-green-500' : engine.state === 'error' ? 'text-red-600 dark:text-red-500' : 'text-yellow-600 dark:text-yellow-500'

  return (
    <div className="flex items-start gap-3 rounded-lg bg-card p-3 shadow-sm transition-shadow hover:shadow-md">
      <div className="flex-shrink-0 pt-0.5">
        <StatusIcon className={`h-4 w-4 ${statusColor} ${!engine ? 'animate-spin' : ''}`} />
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Cpu className="h-4 w-4 text-muted-foreground" />
              <h4 className="text-sm font-medium">llama.cpp 推理引擎</h4>
              <Badge variant="secondary">DutyDeck 托管</Badge>
            </div>
            <p className="text-xs text-muted-foreground">{engineStateLabel(engine)}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {busy ? (
              <Button size="sm" variant="outline" disabled={Boolean(pending['engine:cancel'])} onClick={() => void perform({ action: 'engine-cancel' })}>
                取消安装
              </Button>
            ) : !ready ? (
              <Button size="sm" variant="outline" disabled={pendingEngine || engine?.state === 'error' && engine.message?.includes('不支持')} onClick={() => void perform({ action: 'engine-download' })}>
                {engine?.state === 'error' ? '重试安装' : '安装运行环境'}
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setSettingsTab('channels')}>
                管理本地模型
                <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {engine?.platform ?? '当前平台'} / {engine?.arch ?? '当前架构'}
          {engine?.sizeBytes ? ` · 安装包约 ${localModelSize(engine.sizeBytes)}` : ''}
          {' · '}安装一次，供多个 GGUF 模型共享
        </p>
        {busy && (
          <div role="status" className="space-y-1">
            <progress className="h-1.5 w-full accent-primary" max={engine?.sizeBytes ?? 1} value={Math.min(engine?.sizeBytes ?? 1, engine?.downloadedBytes ?? 0)} aria-label="llama.cpp 环境安装进度" />
            <p className="text-xs text-muted-foreground">{engine?.message ?? '正在下载安装包'}{engine?.sizeBytes ? ` · ${localModelSize(engine.downloadedBytes ?? 0)} / ${localModelSize(engine.sizeBytes)}` : ''}</p>
          </div>
        )}
        {!busy && !ready && (
          <p role={engine?.state === 'error' || loadError ? 'alert' : 'status'} className={`text-xs ${engine?.state === 'error' || loadError ? 'text-destructive' : 'text-muted-foreground'}`}>
            {errorMessage ?? '安装并校验后，模型配置页才会解锁下载、加载和测试。'}
          </p>
        )}
      </div>
    </div>
  )
}
