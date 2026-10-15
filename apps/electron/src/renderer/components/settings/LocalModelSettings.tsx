import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Cpu, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SettingsCard, SettingsSection } from './primitives'
import { acceptLocalModelSnapshotAtom, localModelErrorsAtom, localModelLoadErrorAtom, localModelPendingAtom, localModelProgressAtom, localModelPromptAtom, localModelSnapshotAtom, localModelTestAssetAtom, localModelTestResultsAtom, performLocalModelActionAtom, refreshLocalModelsAtom } from '@/atoms/local-model-atoms'
import type { LocalModelSnapshot } from '@proma/shared'
import { localModelControls, localModelSize, localModelStatus } from '@/lib/local-model-state'
import { settingsTabAtom } from '@/atoms/settings-tab'

/** 本地供应商同页管理：全部状态来自主进程，不写入渠道的手工模型列表。 */
export function LocalModelSettings(): React.ReactElement {
  /** Jotai 保留后台操作、提示词与测试回执，主进程快照负责生命周期恢复。 */
  const snapshot = useAtomValue(localModelSnapshotAtom)
  const errors = useAtomValue(localModelErrorsAtom)
  const loadError = useAtomValue(localModelLoadErrorAtom)
  const pending = useAtomValue(localModelPendingAtom)
  const [progress, setProgress] = useAtom(localModelProgressAtom)
  const [testAssetId, setTestAssetId] = useAtom(localModelTestAssetAtom)
  const [prompt, setPrompt] = useAtom(localModelPromptAtom)
  const results = useAtomValue(localModelTestResultsAtom)
  const accept = useSetAtom(acceptLocalModelSnapshotAtom)
  const refresh = useSetAtom(refreshLocalModelsAtom)
  const perform = useSetAtom(performLocalModelActionAtom)
  const setSettingsTab = useSetAtom(settingsTabAtom)
  /** 弹窗目标及回执始终按资产身份隔离。 */
  const testAsset = snapshot?.assets.find((asset) => asset.assetId === testAssetId)
  const result = testAssetId ? results[testAssetId] : undefined
  const engine = snapshot?.engine
  const engineReady = engine?.available === true && (engine.state === undefined || engine.state === 'installed')
  React.useEffect(() => {
    const offChanged = window.electronAPI.onLocalModelChanged(accept)
    const offProgress = window.electronAPI.onLocalModelProgress((event) => setProgress((previous) => ({ ...previous, [event.assetId]: event })))
    void refresh()
    return () => { offChanged(); offProgress() }
  }, [accept, refresh, setProgress])

  return <SettingsSection title="DutyDeck 本地模型" description="先在“关于/更新 → 可选环境能力”安装本地运行环境，再下载模型；模型完成加载和能力测试后才能启用。" action={<Button size="sm" variant="outline" onClick={() => void refresh()}><RefreshCw size={14} />刷新</Button>}>
    {loadError && <p role="alert" className="text-sm text-destructive">{loadError}</p>}
    {engine && <div className="flex flex-wrap items-center gap-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2.5">
      <Cpu className="h-4 w-4 text-muted-foreground" />
      <div className="min-w-0 flex-1"><p className="text-sm font-medium">llama.cpp 推理引擎</p><p className="text-xs text-muted-foreground">{engineReady ? `v${engine.version ?? '固定版本'} · 已就绪` : engine.state === 'error' ? '安装失败，可在关于/更新页重试' : '尚未就绪，模型操作已锁定'}</p></div>
      {!engineReady && <Button size="sm" variant="outline" onClick={() => setSettingsTab('about')}>前往关于/更新安装</Button>}
    </div>}
    {snapshot?.runtime.message && <p role="status" className="text-sm text-muted-foreground">{snapshot.runtime.message}</p>}
    <SettingsCard divided={false}>
      {!engineReady && snapshot && <p className="border-b border-border/50 px-4 py-3 text-sm text-muted-foreground">安装并校验 llama.cpp 后，模型下载按钮才会解锁。</p>}
      {!snapshot ? <p className="p-6 text-sm text-muted-foreground">{loadError ? '暂时无法读取模型。请刷新重试。' : '正在读取本地模型…'}</p> : snapshot.assets.length === 0 ? <p className="p-6 text-sm text-muted-foreground">当前安装包没有可用模型清单。</p> : <div className="divide-y divide-border/50">{snapshot.assets.map((asset) => {
        /** 模型行权限、元信息和本次进度均按同一资产计算。 */
        const controls = localModelControls(asset, snapshot)
        const catalog = snapshot.catalog.find((entry) => entry.assetId === asset.assetId)
        const currentProgress = controls.downloading ? progress[asset.assetId] : undefined
        const busy = Boolean(pending[asset.assetId])
        const cancelling = Boolean(pending[`${asset.assetId}:cancel`])
        const percent = currentProgress?.totalBytes ? Math.min(100, Math.round((currentProgress.completedBytes ?? 0) / currentProgress.totalBytes * 100)) : undefined
        return <div key={asset.assetId} className="px-4 py-4 space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1"><div className="text-sm font-medium">{asset.name}</div><div className="text-xs text-muted-foreground">{localModelStatus(asset.status)} · {localModelSize(asset.sizeBytes)}{catalog ? ` · ${catalog.quantization} · 预计内存 ${localModelSize(catalog.memoryBytes)}` : ''}</div></div>
            <div className="flex flex-wrap items-center gap-2">
              {controls.canDownload && <Button size="sm" variant="outline" disabled={busy} onClick={() => void perform({ assetId: asset.assetId, action: 'download' })}>{asset.status === 'error' ? '重试下载' : '下载'}</Button>}
              {controls.downloading && <Button size="sm" variant="outline" disabled={cancelling} onClick={() => void perform({ assetId: asset.assetId, action: 'cancel' })}>取消下载</Button>}
              {!controls.canDownload && !controls.downloading && !controls.canStop && <Button size="sm" variant="outline" disabled={busy || !controls.canStart || snapshot?.engine?.available === false} onClick={() => void perform({ assetId: asset.assetId, action: 'start' })}>加载</Button>}
              {controls.canStop && <Button size="sm" variant="outline" disabled={cancelling} onClick={() => void perform({ assetId: asset.assetId, action: 'stop' })}>{snapshot.runtime.state === 'starting' ? '取消加载' : '停止'}</Button>}
              {controls.canRedownload && <Button size="sm" variant="outline" disabled={busy} onClick={() => void perform({ assetId: asset.assetId, action: 'download' })}>重新下载</Button>}
              <Button size="sm" variant="outline" disabled={busy || !controls.loaded || snapshot.runtime.state !== 'running' || snapshot.runtime.busy} onClick={() => setTestAssetId(asset.assetId)}>测试</Button>
              <Switch aria-label={`启用 ${asset.name}`} checked={asset.enabled} disabled={busy || (!asset.enabled && !controls.canEnable)} onCheckedChange={() => void perform({ assetId: asset.assetId, action: 'toggle' })} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{!engineReady && !asset.installedAt ? '先在关于/更新页安装本地运行环境，再下载模型' : asset.capability.state === 'available' ? 'Agent 能力已验证' : asset.capability.state === 'unavailable' ? '能力检查未通过，请重新测试后启用' : '尚未验证能力，加载后可测试'}</p>
          {snapshot.runtime.assetId === asset.assetId && snapshot.runtime.busy && <p role="status" className="text-xs text-muted-foreground">模型正在被任务使用，任务结束后可停止或重新测试。</p>}
          {catalog && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">来源、版本与许可</summary><div className="mt-2 space-y-1 break-all"><p>来源：{new URL(catalog.downloadUrl).host} · {catalog.license}</p><p>版本：{catalog.revision}</p><p>磁盘预留：{localModelSize(catalog.diskBytes)} · 上下文：{catalog.contextWindow.toLocaleString()} tokens</p><p>内存为估算值，实际占用随系统和任务变化。</p></div></details>}
          {controls.downloading && <div role="status" className="space-y-1"><progress className="w-full h-1.5 accent-primary" max={100} value={percent} aria-label={`${asset.name} 下载进度`} /><p className="text-xs text-muted-foreground">{currentProgress?.message ?? localModelStatus(asset.status)}{percent !== undefined ? ` · ${percent}% · ${localModelSize(currentProgress?.completedBytes ?? 0)}` : ''}</p></div>}
          {(errors[asset.assetId] || asset.lastError) && <p role="alert" className="text-xs text-destructive break-words">{errors[asset.assetId] ?? asset.lastError}</p>}
        </div>
      })}</div>}
    </SettingsCard>
    <Dialog open={Boolean(testAsset)} onOpenChange={(open) => { if (!open) setTestAssetId(null) }}>
      <DialogContent className="sm:max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>测试 {testAsset?.name}</DialogTitle><DialogDescription>检查对话、工具调用和 JSON 能力，并显示实际回复。测试不会改变启用状态。</DialogDescription></DialogHeader>
        <label className="space-y-2 text-sm">测试提示词<Textarea value={prompt} maxLength={800} disabled={Boolean(testAssetId && pending[testAssetId])} onChange={(event) => setPrompt(event.target.value)} /></label>
        {result && <div aria-live="polite" className="space-y-3 text-sm"><p className={result.success ? 'text-emerald-600' : 'text-destructive'}>{result.message}</p><p className="text-muted-foreground">工具调用：{result.toolCallSupported ? '通过' : '未通过'} · JSON：{result.jsonSupported ? '通过' : '未通过'}</p>{result.reply && <div className="rounded-md border bg-muted/30 p-4 whitespace-pre-wrap break-words">{result.reply}</div>}</div>}
        {testAssetId && errors[testAssetId] && <p role="alert" className="text-sm text-destructive">{errors[testAssetId]}</p>}
        <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setTestAssetId(null)}>关闭</Button><Button disabled={!testAsset || !prompt.trim() || Boolean(testAssetId && pending[testAssetId]) || snapshot?.runtime.assetId !== testAssetId || !snapshot.runtime.endpointReady || snapshot.runtime.state !== 'running'} onClick={() => { if (testAssetId) void perform({ assetId: testAssetId, action: 'test' }) }}>{testAssetId && pending[testAssetId] === 'test' && <Loader2 size={14} className="animate-spin" />}发送测试</Button></div>
      </DialogContent>
    </Dialog>
  </SettingsSection>
}
