import * as React from 'react'
import type { ServerOpsDeploymentCheck, ServerOpsDeploymentRun, ServerOpsDeploymentTarget } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

/** 部署页的发布版本 / 部署历史双 Tab。执行按钮在完整 bundle、迁移和恢复证据接入前保持关闭。 */
export interface ServerOpsDeploymentPanelProps {
  projectId: string
  hostId: string
  connected: boolean
  active: boolean
}

/** 展示发布目标检查与持久历史的运维面板。 */
export function ServerOpsDeploymentPanel({ projectId, hostId, connected, active }: ServerOpsDeploymentPanelProps): React.ReactElement {
  const [tab, setTab] = React.useState<'release' | 'history'>('release')
  const [targets, setTargets] = React.useState<ServerOpsDeploymentTarget[]>([])
  const [runs, setRuns] = React.useState<ServerOpsDeploymentRun[]>([])
  const [selectedTargetId, setSelectedTargetId] = React.useState<string | null>(null)
  const [check, setCheck] = React.useState<ServerOpsDeploymentCheck | null>(null)
  const [status, setStatus] = React.useState<'idle' | 'loading' | 'saving' | 'checking' | 'ready' | 'error'>('idle')
  const [error, setError] = React.useState<string | null>(null)
  const [form, setForm] = React.useState({ name: '', environment: 'production', composeProject: '', composeFile: '', sourceUrl: '', registry: '', accessUrl: '' })
  const requestVersion = React.useRef(0)
  const selectedTarget = targets.find((target) => target.id === selectedTargetId) ?? null

  /** 读取当前项目与主机的权威目标和运行历史；只在页签激活时读取。 */
  const load = React.useCallback(async (): Promise<void> => {
    if (!active) return
    const version = ++requestVersion.current
    setStatus('loading')
    setError(null)
    try {
      const [nextTargets, nextRuns] = await Promise.all([
        window.electronAPI.listServerOpsDeploymentTargets({ projectId, hostId }),
        window.electronAPI.listServerOpsDeploymentRuns({ projectId, hostId }),
      ])
      if (version !== requestVersion.current) return
      setTargets(nextTargets)
      setRuns(nextRuns)
      setSelectedTargetId((current) => current && nextTargets.some((target) => target.id === current) ? current : nextTargets[0]?.id ?? null)
      setStatus('ready')
    } catch (loadError) {
      if (version !== requestVersion.current) return
      setStatus('error')
      setError(loadError instanceof Error ? loadError.message : '部署记录读取失败')
    }
  }, [active, hostId, projectId])

  React.useEffect(() => { void load(); return () => { requestVersion.current += 1 } }, [load])

  /** 目标保存只写入配置，不执行远端发布。 */
  const saveTarget = async (): Promise<void> => {
    if (!connected || form.name.trim() === '' || form.composeProject.trim() === '' || form.composeFile.trim() === '') return
    setStatus('saving')
    setError(null)
    try {
      const target = await window.electronAPI.saveServerOpsDeploymentTarget({
        expectedRevision: selectedTarget?.revision ?? 0,
        target: {
          id: selectedTarget?.id ?? crypto.randomUUID(), projectId, hostId,
          name: form.name.trim(), environment: form.environment.trim(), composeProject: form.composeProject.trim(),
          composeFile: form.composeFile.trim(), sourceUrl: form.sourceUrl.trim(), registry: form.registry.trim(), accessUrl: form.accessUrl.trim(),
        },
      })
      setTargets((current) => [...current.filter((entry) => entry.id !== target.id), target])
      setSelectedTargetId(target.id)
      setStatus('ready')
    } catch (saveError) {
      setStatus('error')
      setError(saveError instanceof Error ? saveError.message : '部署目标保存失败')
    }
  }

  /** 只读检查 Compose 项目身份和数据库影响证据。 */
  const checkTarget = async (): Promise<void> => {
    if (!selectedTarget || !connected) return
    setStatus('checking')
    setError(null)
    try {
      setCheck(await window.electronAPI.checkServerOpsDeploymentTarget({ targetId: selectedTarget.id, expectedRevision: selectedTarget.revision }))
      setStatus('ready')
    } catch (checkError) {
      setStatus('error')
      setError(checkError instanceof Error ? checkError.message : '部署检查失败')
    }
  }

  React.useEffect(() => {
    if (!selectedTarget) return
    setForm({ name: selectedTarget.name, environment: selectedTarget.environment, composeProject: selectedTarget.composeProject, composeFile: selectedTarget.composeFile, sourceUrl: selectedTarget.sourceUrl, registry: selectedTarget.registry, accessUrl: selectedTarget.accessUrl })
    setCheck(null)
  }, [selectedTarget])

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-server-ops-deployment>
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-3 py-2" role="tablist" aria-label="发布与部署历史">
        {([['release', '发布版本'], ['history', '部署历史']] as const).map(([value, label]) => (
          <button key={value} type="button" role="tab" aria-selected={tab === value} className={cn('rounded-md px-3 py-1.5 text-xs', tab === value ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/50')} onClick={() => setTab(value)}>{label}</button>
        ))}
        <Button type="button" variant="ghost" size="sm" className="ml-auto h-7 text-xs" onClick={() => { void load() }} disabled={status === 'loading'}>刷新</Button>
      </div>
      {status === 'loading' ? <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">正在读取发布记录…</div> : tab === 'history' ? (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {runs.length === 0 ? <p className="text-xs text-muted-foreground">还没有部署运行记录。首次发布检查完成后，运行记录会保留在这里。</p> : <div className="space-y-2">{runs.map((run) => <div key={run.id} className="rounded-lg border border-border/60 p-3 text-xs"><div className="flex items-center gap-2"><Badge variant="outline">{run.kind === 'rollback' ? '回退' : '发布'}</Badge><span className="font-medium">{run.status}</span><span className="ml-auto text-muted-foreground">{new Date(run.startedAt).toLocaleString()}</span></div><p className="mt-2 text-muted-foreground">{run.summary || '无摘要'}</p></div>)}</div>}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {!connected && <div className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">连接飞牛 NAS 后才能读取和检查 Compose 现场。</div>}
          {targets.length > 0 && <label className="mb-3 block text-xs text-muted-foreground">已纳管目标<select className="mt-1 block h-8 w-full rounded-md border border-input bg-background px-2 text-xs" value={selectedTargetId ?? ''} onChange={(event) => setSelectedTargetId(event.target.value || null)}>{targets.map((target) => <option key={target.id} value={target.id}>{target.name} · {target.environment}</option>)}</select></label>}
          <div className="grid gap-2 md:grid-cols-2">
            {(['name', 'environment', 'composeProject', 'composeFile', 'sourceUrl', 'registry', 'accessUrl'] as const).map((field) => <label key={field} className="text-xs text-muted-foreground">{({ name: '目标名称', environment: '环境', composeProject: 'Compose 项目名', composeFile: '远端 Compose 文件', sourceUrl: '源码地址', registry: '镜像仓库', accessUrl: '访问地址' } as Record<string, string>)[field]}<Input className="mt-1 h-8 text-xs" value={form[field]} onChange={(event) => setForm((current) => ({ ...current, [field]: event.target.value }))} placeholder={field === 'composeFile' ? '/vol1/docker/taokoplay/current/deploy/fnos/compose.yml' : undefined} /></label>)}
          </div>
          <div className="mt-3 flex flex-wrap gap-2"><Button type="button" size="sm" onClick={() => { void saveTarget() }} disabled={!connected || status === 'saving'}>{status === 'saving' ? '保存中…' : selectedTarget ? '保存目标' : '保存并纳管'}</Button><Button type="button" size="sm" variant="outline" onClick={() => { void checkTarget() }} disabled={!connected || !selectedTarget || status === 'checking'}>{status === 'checking' ? '检查中…' : '检查现场'}</Button><Button type="button" size="sm" variant="outline" disabled title="待完成镜像 digest、数据库迁移与恢复证据后开放">发布暂未开放</Button></div>
          {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
          {check && <div className="mt-4 rounded-lg border border-border/60 p-3"><div className="flex items-center gap-2 text-xs font-medium"><span>检查结果</span><Badge variant="outline">{check.canDeploy ? '可发布' : '需要补齐证据'}</Badge><span className="ml-auto text-muted-foreground">有效至 {new Date(check.expiresAt).toLocaleTimeString()}</span></div><div className="mt-3 space-y-2">{check.evidence.map((evidence) => <div key={evidence.code} className="flex gap-2 text-xs"><Badge variant="outline" className={evidence.status === 'passed' ? 'text-emerald-600' : evidence.status === 'blocked' ? 'text-destructive' : 'text-amber-600'}>{evidence.status}</Badge><span>{evidence.message}</span></div>)}</div>{check.services.length > 0 && <p className="mt-3 text-xs text-muted-foreground">现场服务：{check.services.map((service) => `${service.name} (${service.image})`).join('、')}</p>}</div>}
        </div>
      )}
    </div>
  )
}
