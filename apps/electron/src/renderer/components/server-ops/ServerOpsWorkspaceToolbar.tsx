import * as React from 'react'
import { ArrowLeftRight, ChevronDown, FolderOpen } from 'lucide-react'
import type { ServerOpsProject } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { WorkspaceEntitySelector } from '@/components/common/WorkspaceEntitySelector'

/** 当前项目可直接切换的服务器、数据库或 Redis 连接。 */
export interface ServerOpsWorkspaceConnectionOption {
  id: string
  label: string
  detail: string
  protocol?: string
}

/** 项目选择只使用工作区已加载的清单，切换交给既有离开检查处理。 */
interface ServerOpsProjectSelectorProps {
  projects: readonly ServerOpsProject[]
  projectId: string | null
  onSelectProject: (projectId: string) => void
  /** 项目列表页把管理动作收进同一个菜单；连接页保留既有抽屉入口。 */
  onManageProjects?: () => void
}

/** 根据当前项目显示下拉入口；返回可键盘操作且长名称可省略的选择器。 */
export function ServerOpsProjectSelector({ projects, projectId, onSelectProject, onManageProjects }: ServerOpsProjectSelectorProps): React.ReactElement {
  /** 失效身份不显示旧项目名，等待工作区完成回落。 */
  const project = projects.find((entry) => entry.id === projectId)
  return (
    /** 菜单与「编排场景」共用同一个组件，只有触发器外观按各自场景定制。 */
    <WorkspaceEntitySelector
      items={projects.map((entry) => ({ id: entry.id, name: entry.name }))}
      value={project?.id ?? null}
      onSelect={onSelectProject}
      emptyLabel="暂无项目"
      {...(onManageProjects ? { manage: { label: '管理项目', onSelect: onManageProjects } } : {})}
      trigger={(ref) => (
        <Button ref={ref} type="button" variant="outline" disabled={projects.length === 0 && !onManageProjects} className="h-8 w-full min-w-0 gap-2 rounded-md border-border/60 bg-background/40 px-2.5 py-0 text-xs font-normal [&>svg]:shrink-0" aria-label="切换运维项目" title={project?.name}>
          <FolderOpen className="size-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-left">{project?.name ?? '选择项目'}</span>
          <ChevronDown className="size-4 text-muted-foreground" aria-hidden="true" />
        </Button>
      )}
    />
  )
}

/** 连接身份与操作由详情提供，项目和授权仍由工作区统一管理。 */
export interface ServerOpsWorkspaceToolbarContent {
  connection?: React.ReactNode
  connectionActions?: React.ReactNode
  /** 当前项目的同级连接；存在时在头部提供直接切换入口。 */
  connectionOptions?: readonly ServerOpsWorkspaceConnectionOption[]
  /** 当前打开的连接 ID。 */
  connectionId?: string | null
  /** 用户从头部切换到另一条连接。 */
  onSelectConnection?: (connectionId: string) => void
  /** 展开视图打开项目管理时，先还原所属 Pane。 */
  onManageProjects?: () => void
}

/** 顶部集中呈现项目与连接身份，数据库范围由下一层工作台导航承载。 */
interface ServerOpsWorkspaceToolbarProps extends ServerOpsProjectSelectorProps, ServerOpsWorkspaceToolbarContent {
  actions?: React.ReactNode
}

/** 当前项目连接切换器；菜单复用项目选择器的键盘、焦点与滚动行为。 */
function ServerOpsConnectionSelector({
  connections,
  connectionId,
  onSelect,
}: {
  connections: readonly ServerOpsWorkspaceConnectionOption[]
  connectionId: string | null | undefined
  onSelect: (connectionId: string) => void
}): React.ReactElement {
  const current = connections.find((connection) => connection.id === connectionId)
  return (
    <WorkspaceEntitySelector
      items={connections.map((connection) => ({
        id: connection.id,
        name: connection.label,
        meta: [connection.protocol, connection.detail].filter(Boolean).join(' · '),
      }))}
      value={current?.id ?? null}
      onSelect={onSelect}
      emptyLabel="当前项目暂无连接"
      trigger={(ref) => (
        <Button ref={ref} type="button" variant="ghost" size="sm" className="h-8 shrink-0 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground" aria-label="切换当前项目连接" title="切换当前项目连接">
          <ArrowLeftRight className="size-3.5" aria-hidden="true" />
          <span>切换连接</span>
          <ChevronDown className="size-3.5" aria-hidden="true" />
        </Button>
      )}
    />
  )
}

/** 返回工作区顶部导航；宽 Pane 合为一行，窄 Pane 将连接身份排在项目下方。 */
export function ServerOpsWorkspaceToolbar({ projects, projectId, onSelectProject, onManageProjects, connection, connectionActions, connectionOptions, connectionId, onSelectConnection, actions }: ServerOpsWorkspaceToolbarProps): React.ReactElement {
  /** 将连接切换入口放到标题栏右侧，避免与连接身份和返回按钮挤在一起。 */
  const connectionSelector = connectionOptions && onSelectConnection ? (
    <div data-server-ops-connection-switcher>
      <ServerOpsConnectionSelector connections={connectionOptions} connectionId={connectionId} onSelect={onSelectConnection} />
    </div>
  ) : null
  return (
    <div className={cn('titlebar-no-drag shrink-0 gap-x-3 gap-y-2 border-b border-border/40 px-3 py-2', connection ? 'server-ops-connection-header' : 'flex items-center')} data-server-ops-workspace-toolbar data-server-ops-toolbar={connection ? '' : undefined}>
      <div className="min-w-0 max-w-48 flex-1" style={{ gridArea: 'project' }}><ServerOpsProjectSelector projects={projects} projectId={projectId} onSelectProject={onSelectProject} onManageProjects={onManageProjects} /></div>
      {connection ? <div className="flex min-w-0 items-center gap-1.5" style={{ gridArea: 'identity' }}>
        <div className="min-w-0 flex-1">{connection}</div>
      </div> : null}
      {connectionSelector || actions ? <div className="ml-auto flex h-8 shrink-0 items-center gap-1" style={{ gridArea: 'access' }}>{connectionSelector}{actions}</div> : null}
      {connectionActions ? <div className="flex shrink-0 items-center justify-end gap-1" style={{ gridArea: 'controls' }}>{connectionActions}</div> : null}
    </div>
  )
}
