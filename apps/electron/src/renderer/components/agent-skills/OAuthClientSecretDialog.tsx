import * as React from 'react'
import { KeyRound, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

interface OAuthClientSecretDialogProps {
  serverName: string | null
  onOpenChange: (open: boolean) => void
  onSave: (clientSecret: string) => Promise<void>
}

/** 用户显式输入 OAuth client secret 的安全入口，值只通过 IPC 交给系统加密保护。 */
export function OAuthClientSecretDialog({ serverName, onOpenChange, onSave }: OAuthClientSecretDialogProps): React.ReactElement {
  /** 不进入 React state 的秘密输入引用，减少意外暴露面。 */
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (inputRef.current) inputRef.current.value = ''
    setSaving(false)
    setError(null)
  }, [serverName])

  /** 校验输入并通过安全 IPC 保存。 */
  const handleSave = async (): Promise<void> => {
    const clientSecret = inputRef.current?.value ?? ''
    if (!clientSecret.trim() || saving) return
    setSaving(true)
    setError(null)
    try {
      await onSave(clientSecret)
      if (inputRef.current) inputRef.current.value = ''
      onOpenChange(false)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Client Secret 保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={Boolean(serverName)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[560px] p-7" onOpenAutoFocus={(event) => event.preventDefault()}>
        {serverName && <>
          <DialogHeader className="space-y-2 text-left">
            <DialogTitle className="flex items-center gap-2 text-xl font-semibold"><KeyRound size={19} />保存 OAuth Client Secret</DialogTitle>
            <DialogDescription className="text-[15px] leading-6">
              {serverName} 的 OAuth 服务要求 Client Secret。它只会经系统加密保护保存，不会写入 mcp.json、显示给 Agent 或回传到页面。
            </DialogDescription>
          </DialogHeader>
          <div className="mt-7">
            <label htmlFor="oauth-client-secret" className="text-sm font-medium text-foreground">Client Secret <span className="text-destructive">*</span></label>
            <Input
              id="oauth-client-secret"
              autoComplete="off"
              type="password"
              className="mt-2 h-12 text-sm"
              placeholder="粘贴 OAuth 应用的 Client Secret"
              ref={inputRef}
              onKeyDown={(event) => { if (event.key === 'Enter') void handleSave() }}
            />
            {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter className="mt-7 gap-3 sm:justify-end">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button>
            <Button onClick={() => { void handleSave() }} disabled={saving}>
              {saving && <Loader2 size={15} className="animate-spin" />}
              安全保存并继续授权
            </Button>
          </DialogFooter>
        </>}
      </DialogContent>
    </Dialog>
  )
}
