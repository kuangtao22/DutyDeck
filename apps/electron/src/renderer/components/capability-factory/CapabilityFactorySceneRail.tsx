/**
 * 编排工厂左侧「场景」抽屉（结构与运维的项目抽屉一致）。
 *
 * 为什么是**容器内绝对定位的抽屉**，而不是常驻一列、也不用通用 Sheet：
 * ①工厂挂在右侧工作区的一栏里，窄的时候只有 300px 上下，常驻 212px 的列表会把右侧内容压没；
 * ②`SheetContent` 是 `fixed inset-y-0 left-0`，锚的是整个窗口，展开时目录会飞到窗口最左边
 *   （接口的 `ApiCatalogDrawer` 有同类注释）。运维的项目栏用了同一套写法，这里保持一致。
 *
 * 抽屉只负责呈现与回调：场景清单、重命名草稿、新建输入都仍由面板持有，
 * 这样抽屉开关一次不会把未提交的输入弄丢。
 */
import * as React from 'react'
import type { CapabilityScene } from '@proma/shared'
import { MoreHorizontal, PanelLeftClose, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/**
 * 一行摘要：步数 / 版本 / 是否有待采纳草案。
 *
 * @param scene 场景索引项
 * @returns 例如 `4 步 · v3 · 草案待采纳`
 */
export function formatCapabilitySceneSubtitle(scene: CapabilityScene): string {
  const parts = [`${scene.definition.steps.length} 步`, `v${scene.currentVersion}`]
  if (scene.draft) parts.push('草案待采纳')
  return parts.join(' · ')
}

/** 行内重命名状态；正在编辑的场景 id 为 null 时整行按普通按钮渲染。 */
export interface CapabilitySceneRenameState {
  sceneId: string | null
  value: string
  onChange: (value: string) => void
  onStart: (scene: CapabilityScene) => void
  onSubmit: () => void
  onCancel: () => void
}

/** 场景抽屉属性。 */
export interface CapabilityFactorySceneRailProps {
  open: boolean
  /** 场景清单；null 表示仍在读取。 */
  scenes: readonly CapabilityScene[] | null
  selectedSceneId: string | null
  /** 当前项目名，只作为列表副标题（与运维抽屉的「选择运维工作范围」同位）。 */
  workspaceLabel?: string
  /** 清单读取失败的原因；抽屉内如实说明，不静默显示成空列表。 */
  error?: string | null
  rename: CapabilitySceneRenameState
  /** 新建入口：只负责开弹窗，填名字与提交都在弹窗里，抽屉底部不再挂输入行。 */
  onRequestCreate: () => void
  /** 新建进行中时禁用 ＋，避免连点开出两个弹窗。 */
  createBusy: boolean
  onSelectScene: (sceneId: string) => void
  onRequestDelete: (scene: CapabilityScene) => void
  onOpenChange: (open: boolean) => void
}

/**
 * 渲染场景抽屉；关闭时不占用任何空间（与运维的项目抽屉同语义）。
 *
 * @param props 场景清单、行内编辑状态与回调
 * @returns 关闭时为 null，展开时为遮罩 + 左侧面板
 */
export function CapabilityFactorySceneRail({
  open, scenes, selectedSceneId, workspaceLabel, error, createBusy, rename, onRequestCreate, onSelectScene, onRequestDelete, onOpenChange,
}: CapabilityFactorySceneRailProps): React.ReactElement | null {
  const panelRef = React.useRef<HTMLElement>(null)
  React.useEffect(() => {
    if (!open) return
    /** Esc 关闭，并把焦点移入抽屉，避免键盘焦点留在背后的场景内容里。 */
    const handleKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') onOpenChange(false) }
    document.addEventListener('keydown', handleKeyDown)
    panelRef.current?.focus()
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onOpenChange])

  if (!open) return null
  const list = scenes ?? []

  return (
    <div className="absolute inset-0 z-30">
      <button
        type="button"
        tabIndex={-1}
        aria-label="关闭场景列表"
        className="absolute inset-0 cursor-default bg-background/35"
        onClick={() => onOpenChange(false)}
      />
      <aside
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="false"
        aria-label="场景列表"
        className="absolute inset-y-0 left-0 flex w-72 max-w-[88%] flex-col border-r border-border/40 bg-content-area text-foreground shadow-xl outline-none"
        data-capability-factory-scene-rail
      >
        <div className="flex items-start gap-1.5 border-b border-border/40 px-3 pb-2.5 pt-3">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold leading-tight">场景</div>
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{workspaceLabel ?? '选择编排范围'}</div>
          </div>
          <Button
            type="button" variant="ghost" size="icon-sm"
            title="新建场景" aria-label="新建场景" disabled={createBusy}
            onClick={onRequestCreate}
          >
            <Plus className="size-3.5" aria-hidden="true" />
          </Button>
          <Button
            type="button" variant="ghost" size="icon-sm"
            title="收起场景列表" aria-label="收起场景列表"
            onClick={() => onOpenChange(false)}
          >
            <PanelLeftClose className="size-3.5" aria-hidden="true" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
          {error ? (
            <p className="px-2 py-3 text-[11px] leading-relaxed text-destructive">{error}</p>
          ) : null}
          {!error && list.length === 0 ? (
            <p className="px-2 py-3 text-[11px] leading-relaxed text-muted-foreground">
              {scenes === null ? '正在读取场景…' : '还没有场景。点上方 ＋ 建一个，或在左侧 Agent 里让它设计。'}
            </p>
          ) : null}
          {list.map((scene) => (
            <div
              key={scene.id}
              className={`group flex items-start gap-2 rounded px-2 py-2 ${scene.id === selectedSceneId ? 'bg-muted' : 'hover:bg-muted/60'}`}
            >
              <span className="mt-0.5 flex-none text-[11px] leading-none text-muted-foreground" aria-hidden="true">◇</span>
              {rename.sceneId === scene.id ? (
                /* 行内重命名：与「修改名称」同一个入口，不再弹第二层对话框 */
                <input
                  autoFocus
                  value={rename.value}
                  onChange={(event) => rename.onChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') rename.onSubmit()
                    if (event.key === 'Escape') rename.onCancel()
                  }}
                  onBlur={rename.onSubmit}
                  aria-label={`重命名场景：${scene.definition.name}`}
                  className="h-6 min-w-0 flex-1 rounded-sm border border-input bg-background px-1.5 text-[12.5px] outline-none focus-visible:border-foreground/35"
                />
              ) : (
                <button type="button" onClick={() => onSelectScene(scene.id)} className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-[12.5px] font-medium">{scene.definition.name}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{formatCapabilitySceneSubtitle(scene)}</span>
                </button>
              )}
              {/* 管理菜单：与运维每条项目的 ⋯ 一致（hover 才出现，避免列表被按钮塞满） */}
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="grid size-5 flex-none place-items-center rounded text-muted-foreground opacity-0 hover:bg-border hover:text-foreground group-hover:opacity-100 data-[state=open]:opacity-100 focus-visible:opacity-100"
                    aria-label={`管理场景：${scene.definition.name}`}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <MoreHorizontal className="size-3.5" aria-hidden="true" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="z-[9999] w-36">
                  <DropdownMenuItem onSelect={() => rename.onStart(scene)}>
                    <Pencil className="size-3.5" aria-hidden="true" />
                    修改名称
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive" onSelect={() => onRequestDelete(scene)}>
                    <Trash2 className="size-3.5" aria-hidden="true" />
                    删除场景
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
        </div>
      </aside>
    </div>
  )
}
