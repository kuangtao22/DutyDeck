/**
 * 虚拟接入：为场景声明的**外部能力**绑一份本地桩。
 *
 * 为什么必须有这一段：工厂里最值钱的动作是"改提示词 → 立刻跑一遍"，
 * 但真实能力（读数据库、调接口、读本地正文）在测试环境里没有或不该动。
 * 桩让整条链路能跑起来，同时**不进场景版本、不进能力包**。
 *
 * 纪律（写在界面上，避免被当成"随便填点假数据"）：
 * 桩的字段名/类型/嵌套必须与该能力的 outputSchema 一致。
 * 只求跑通的假数据会让工厂里全绿、真实接入时提示词全部返工。
 * 未绑桩的能力不会自动补占位值：依赖它的步骤会明确失败。
 */
import * as React from 'react'
import { Trash2 } from 'lucide-react'
import { capabilityStubPlaceholder } from '@proma/shared'
import type { CapabilitySceneDefinition, CapabilityStub, CapabilityStubSource } from '@proma/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { stubSkeleton } from './capability-factory-run-view'

/** 虚拟接入区属性。 */
export interface CapabilityFactoryStubSectionProps {
  definition: CapabilitySceneDefinition
  stubs: readonly CapabilityStub[]
  /** 保存 / 清空进行中：按钮锁住，避免重复提交。 */
  busy: boolean
  error: string | null
  onSave: (capabilityId: string, payload: unknown, source: CapabilityStubSource) => void
  onDelete: (capabilityId: string) => void
}

/** 来源标签：占位值必须一眼可见，因为它只能证明流程通了。 */
function sourceBadge(stub: CapabilityStub): { label: string; className: string } {
  if (stub.source === 'placeholder') {
    return { label: '占位桩', className: 'border-amber-500/45 text-amber-600 dark:text-amber-400' }
  }
  return stub.source === 'agent'
    ? { label: 'Agent 填的桩', className: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400' }
    : { label: '已绑桩', className: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400' }
}

/**
 * 渲染虚拟接入清单。
 *
 * @param props 场景定义、已有桩与回调
 * @returns 每个声明能力一行：id + 说明 + 绑定状态 + 编辑 / 清空
 */
export function CapabilityFactoryStubSection({
  definition, stubs, busy, error, onSave, onDelete,
}: CapabilityFactoryStubSectionProps): React.ReactElement {
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [text, setText] = React.useState('')
  const [parseError, setParseError] = React.useState<string | null>(null)

  /** 打开编辑器：已绑定时回填现有 payload，未绑定时给按 outputSchema 生成的骨架。 */
  const startEdit = (capabilityId: string, outputSchema: CapabilitySceneDefinition['capabilities'][number]['outputSchema']): void => {
    const existing = stubs.find((stub) => stub.capabilityId === capabilityId)
    setEditingId(capabilityId)
    setParseError(null)
    setText(existing ? JSON.stringify(existing.payload, null, 2) : stubSkeleton(outputSchema))
  }

  return (
    <div className="space-y-1.5" data-capability-factory-stubs>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        这些能力由接入方在运行时提供（读库、调接口、读本地正文），工厂里没有它们可调，
        所以要用桩替代才能跑。桩只影响本地运行，不进场景版本也不进能力包。
      </p>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        想先看流程：点「自动填占位」——形状对、内容是空的，跑出来的过程能看、质量结论不能看。
        要判断提示词行不行：填一份按真实返回形状的数据（可以让左侧 Agent 读项目后生成）。
      </p>
      {error ? <p role="alert" className="text-[11px] leading-relaxed text-destructive">{error}</p> : null}

      {definition.capabilities.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">这个场景没有声明外部能力，不需要虚拟接入。</p>
      ) : null}

      {definition.capabilities.map((capability) => {
        const stub = stubs.find((item) => item.capabilityId === capability.id)
        const editing = editingId === capability.id
        const badge = stub ? sourceBadge(stub) : null
        return (
          <div key={capability.id} className="rounded-sm border border-border/70 px-2 py-1.5">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{capability.id}</span>
              <Badge variant="outline" className={badge ? `text-[10px] ${badge.className}` : 'text-[10px] text-muted-foreground'}>
                {badge?.label ?? '未绑桩'}
              </Badge>
            </div>
            {capability.description ? (
              <p className="mt-0.5 line-clamp-2 text-[10px] leading-relaxed text-muted-foreground">{capability.description}</p>
            ) : null}

            {editing ? (
              <div className="mt-1.5 space-y-1.5">
                <Textarea
                  autoFocus
                  rows={6}
                  value={text}
                  disabled={busy}
                  aria-label={`虚拟接入：${capability.id}`}
                  className="font-mono text-[10px]"
                  onChange={(event) => { setText(event.target.value); setParseError(null) }}
                />
                {parseError ? <p role="alert" className="text-[11px] text-destructive">{parseError}</p> : null}
                <div className="flex items-center gap-1.5">
                  <Button
                    type="button" size="sm" disabled={busy}
                    onClick={() => {
                      try {
                        onSave(capability.id, JSON.parse(text), 'human')
                        setEditingId(null)
                      } catch {
                        setParseError('桩必须是合法 JSON')
                      }
                    }}
                  >
                    保存桩
                  </Button>
                  <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setEditingId(null)}>
                    取消
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-1 flex items-center gap-1.5">
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => startEdit(capability.id, capability.outputSchema)}>
                  {stub ? '编辑桩' : '绑定桩'}
                </Button>
                {/* 一键占位：把"卡在第一步"变成"先跑起来看流程"，但来源会被记成占位值 */}
                <Button
                  type="button" size="sm" variant="ghost" disabled={busy}
                  title="按输出契约填一份空占位值，先跑通流程"
                  onClick={() => onSave(capability.id, capabilityStubPlaceholder(capability.outputSchema), 'placeholder')}
                >
                  自动填占位
                </Button>
                {stub ? (
                  <Button
                    type="button" size="sm" variant="ghost" disabled={busy}
                    aria-label={`清空桩：${capability.id}`}
                    onClick={() => onDelete(capability.id)}
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
