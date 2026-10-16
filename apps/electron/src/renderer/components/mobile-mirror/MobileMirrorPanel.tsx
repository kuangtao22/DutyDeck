import { useEffect, useMemo } from 'react';
import { atom, useAtom, useAtomValue } from 'jotai';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Home, Pause, Play, RefreshCw, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MobileMirrorController, normalizedImagePoint } from './mobile-mirror-controller';
import { mobileMirrorPausedAtomFamily } from '@/atoms/mobile-mirror-atoms';
import type { MobileMirrorDeviceRequest } from '@/atoms/mobile-mirror-atoms';

/** 右侧手机面板的可见会话；active 表示可见，不表示键盘焦点。 */
export interface MobileMirrorPanelProps {
  sessionId: string;
  active: boolean;
  /** 每轮首次执行生成的定位目标，后续工具调用不强制切换用户选择。 */
  deviceRequest?: MobileMirrorDeviceRequest;
  onOpenMcp?: () => void;
}

/** 手机屏幕与手动操作入口；只在当前面板和窗口均可见时持有连接。 */
export function MobileMirrorPanel({ sessionId, active, deviceRequest, onOpenMcp }: MobileMirrorPanelProps): JSX.Element {
  /** 每个会话单独的连接和内存 store，切换后旧结果不可流入新会话。 */
  const controller = useMemo(() => new MobileMirrorController(sessionId, window.electronAPI), [sessionId]);
  /** 输入草稿只属于当前面板，暂停意图则跨标签卸载保留到该会话恢复。 */
  const local = useMemo(() => ({ text: atom('') }), [controller]);
  const state = useAtomValue(controller.state, { store: controller.store });
  const [paused, setPaused] = useAtom(mobileMirrorPausedAtomFamily(sessionId));
  const [text, setText] = useAtom(local.text, { store: controller.store });

  useEffect(() => {
    // 在连接 effect 之前设置目标，首帧不会短暂显示列表中的另一台设备。
    if (deviceRequest) controller.followDevice(deviceRequest.deviceId);
  }, [controller, deviceRequest]);

  useEffect(() => {
    /** 窗口隐藏时立即释放资源，恢复可见后再创建新连接。 */
    const syncVisibility = (): void => {
      if (active && !paused && document.visibilityState !== 'hidden') controller.start();
      else controller.stop();
    };
    syncVisibility();
    document.addEventListener('visibilitychange', syncVisibility);
    return () => { document.removeEventListener('visibilitychange', syncVisibility); controller.stop(); };
  }, [active, paused, controller]);

  /** 当前设备决定系统按钮可用性；无有效帧时不允许操作。 */
  const device = state.devices.find((item) => item.id === state.deviceId);
  const frame = state.frame;
  const canControl = active && !paused && state.status === 'ready' && !!frame && !state.busy;
  const canManage = active && !paused && state.status === 'ready' && !state.busy;
  /** 状态文字区分首次加载、空设备、暂停和失败，不虚报实时视频。 */
  const statusText = state.status === 'error' ? '连接失败'
    : paused || !active || state.status === 'paused' ? '已暂停'
      : state.status === 'loading' ? '正在连接手机…'
        : !device ? state.requestedDeviceId ? 'Agent 操作的设备暂不可用' : '未发现设备'
          : state.busy ? '正在执行操作…' : !frame ? '正在获取屏幕…' : '屏幕约每秒更新';

  return (
    <section className="flex h-full min-h-0 flex-col bg-background text-foreground" aria-label="手机显示面板">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 p-3">
        <Smartphone className="size-4 shrink-0 text-muted-foreground" />
        <Select value={device ? state.deviceId : ''} onValueChange={(value) => controller.selectDevice(value)} disabled={!canManage || !state.devices.length}>
          <SelectTrigger aria-label="选择手机设备" className="min-w-0 flex-1"><SelectValue placeholder="选择设备" /></SelectTrigger>
          <SelectContent>{state.devices.map((item) => <SelectItem key={item.id} value={item.id}>{item.name} · {item.platform === 'ios' ? 'iOS' : 'Android'}</SelectItem>)}</SelectContent>
        </Select>
        <Button size="icon-sm" variant="ghost" title="刷新设备" aria-label="刷新设备" disabled={!canManage} onClick={() => { void controller.refreshDevices(); }}><RefreshCw /></Button>
        <Button size="icon-sm" variant="ghost" title={paused ? '恢复屏幕' : '暂停屏幕'} aria-label={paused ? '恢复屏幕' : '暂停屏幕'} onClick={() => setPaused(!paused)}>{paused ? <Play /> : <Pause />}</Button>
      </div>
      <div className="shrink-0 px-3 py-2 text-xs text-muted-foreground" role="status" aria-live="polite">{statusText}</div>
      <div className="relative flex min-h-24 flex-1 items-center justify-center overflow-hidden bg-muted/30 p-2">
        {frame ? (
          <button type="button" aria-label="手机屏幕，点击画面可操作设备" className="h-full w-full min-w-0 overflow-hidden rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default" disabled={!canControl}
            onClick={(event) => {
              // 屏幕采用 object-contain；留白点击不应误触手机边缘。
              if (!canControl || event.detail === 0) return;
              const point = normalizedImagePoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), frame.imageWidth, frame.imageHeight);
              if (point) void controller.perform({ type: 'tap', ...point, frameId: frame.frameId });
            }}>
            <img src={frame.imageDataUrl} alt={`${device?.name ?? '手机'}的当前屏幕`} draggable={false} className="h-full w-full object-contain" />
          </button>
        ) : (
          <div className="max-w-sm space-y-3 p-5 text-center text-sm text-muted-foreground">
            <Smartphone className="mx-auto size-9 opacity-50" />
            {state.status === 'error' ? <><p role="alert" className="break-words">{state.error}</p><p>请确认已在 MCP 中启用 Mobile MCP，并已连接、解锁和授权设备。</p></>
              : paused || state.status === 'paused' ? <p>屏幕已暂停，恢复后重新连接设备。</p>
                : state.status === 'ready' && !device ? <p>{state.requestedDeviceId
                  ? 'Agent 操作的设备暂不可用，请刷新设备列表或手动选择其他设备。'
                  : '请连接 Android 设备或启动 iOS 模拟器，然后刷新设备列表。'}</p>
                  : <p>{statusText}</p>}
            {state.status === 'error' && <Button size="sm" variant="outline" onClick={() => { if (active && !paused) controller.start(); }} disabled={!active || paused}>重试连接</Button>}
            {onOpenMcp && (state.status === 'error' || !device) && <Button size="sm" variant="ghost" onClick={onOpenMcp}>打开 MCP 设置</Button>}
          </div>
        )}
      </div>
      <div className="shrink-0 space-y-2 border-t border-border/60 p-3">
        <div className="flex flex-wrap items-center justify-center gap-1">
          <Button size="icon-sm" variant="outline" aria-label="返回" title={device?.platform === 'ios' ? 'iOS 不支持返回按钮' : '返回'} disabled={!canControl || device?.platform === 'ios'} onClick={() => { void controller.perform({ type: 'button', button: 'BACK' }); }}><ArrowLeft /></Button>
          <Button size="icon-sm" variant="outline" aria-label="Home" title="Home" disabled={!canControl} onClick={() => { void controller.perform({ type: 'button', button: 'HOME' }); }}><Home /></Button>
          <span className="mx-1 h-4 w-px bg-border" />
          {([{ direction: 'up', label: '向上滑动', Icon: ArrowUp }, { direction: 'down', label: '向下滑动', Icon: ArrowDown }, { direction: 'left', label: '向左滑动', Icon: ArrowLeft }, { direction: 'right', label: '向右滑动', Icon: ArrowRight }] as const).map(({ direction, label, Icon }) => (
            <Button key={direction} size="icon-sm" variant="outline" aria-label={label} title={label} disabled={!canControl} onClick={() => { if (frame) void controller.perform({ type: 'swipe', direction, frameId: frame.frameId }); }}><Icon /></Button>
          ))}
        </div>
        <form className="flex gap-2" onSubmit={(event) => {
          event.preventDefault();
          if (!canControl || !text.trim()) return;
          // 发送成功才清空；用户若已继续编辑则保留新内容。
          const submitted = text;
          void controller.perform({ type: 'type', text: submitted }).then((ok) => { if (ok) setText((current) => current === submitted ? '' : current); });
        }}>
          <Input aria-label="输入到手机的文字" placeholder="输入到手机当前输入框" maxLength={4096} value={text} onChange={(event) => setText(event.target.value)} disabled={!canControl} className="min-w-0" />
          <Button type="submit" size="sm" disabled={!canControl || !text.trim()}>发送</Button>
        </form>
        <p className="text-[11px] text-muted-foreground">点击画面操作 · 滑动按钮表示手指移动方向</p>
      </div>
    </section>
  );
}
