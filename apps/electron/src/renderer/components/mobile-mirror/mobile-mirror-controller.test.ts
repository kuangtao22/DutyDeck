import { describe, expect, test } from 'bun:test';
import { MobileMirrorController, normalizedImagePoint, type MirrorApi } from './mobile-mirror-controller';

/** 可手动完成的请求，模拟关闭后迟到的 IPC 响应。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
/** 让当前异步链完成，不依赖真实轮询时间。 */
async function flush() { for (let index = 0; index < 12; index++) await Promise.resolve(); }
/** 独立假服务只记录调用，不连接设备。 */
function fixture() {
  const calls: string[] = [];
  const devices = [{ id: 'a', name: 'Android', platform: 'android' as const }, { id: 'b', name: 'iPhone', platform: 'ios' as const }];
  const pending = deferred<Awaited<ReturnType<MirrorApi['captureMobileMirrorFrame']>>>();
  const api: MirrorApi = {
    openMobileMirror: async () => ({ devices }),
    listMobileMirrorDevices: async () => devices,
    captureMobileMirrorFrame: async ({ deviceId }) => { calls.push(`capture:${deviceId}`); return pending.promise; },
    performMobileMirrorAction: async () => { calls.push('action'); },
    closeMobileMirror: async () => { calls.push('close'); },
  };
  const controller = new MobileMirrorController('session', api);
  const frame = { frameId: 'f', deviceId: 'a', imageDataUrl: 'data:image/png;base64,AA', imageWidth: 100, imageHeight: 200, coordinateWidth: 100, coordinateHeight: 200, capturedAt: Date.now() };
  return { controller, api, calls, pending, frame, devices };
}

describe('手机镜像生命周期', () => {
  test('Given Agent 指定设备 When 打开面板 Then 首帧来自同一设备，不默认选择列表首项', async () => {
    const f = fixture(); f.controller.followDevice('b'); f.controller.start(); await flush();
    expect(f.controller.snapshot.deviceId).toBe('b');
    expect(f.calls).toEqual(['capture:b']);
    f.controller.stop();
  });
  test('Given Agent 设备不在列表 When 打开或刷新 Then 不显示另一台手机，用户仍可手选', async () => {
    const f = fixture(); f.controller.followDevice('missing'); f.controller.start(); await flush();
    expect(f.controller.snapshot.deviceId).toBe('missing');
    expect(f.calls).toEqual([]);
    expect(await f.controller.refreshDevices()).toBe(true);
    expect(f.calls).toEqual([]);
    f.controller.selectDevice('b');
    expect(f.controller.snapshot.requestedDeviceId).toBeNull();
    expect(f.calls).toEqual(['capture:b']);
    f.controller.stop();
  });
  test('Given 面板已打开且截图在途 When 新轮指定另一设备 Then 等旧请求结束再切换，旧帧不显示', async () => {
    const f = fixture(); f.controller.start(); await flush();
    f.controller.followDevice('b');
    expect(f.calls).toEqual(['capture:a']);
    f.pending.resolve(f.frame); await flush();
    expect(f.controller.snapshot.frame).toBeNull();
    expect(f.calls).toEqual(['capture:a', 'capture:b']);
    f.controller.stop();
  });
  test('Given 已暂停 When Agent 定位另一设备 Then 保持暂停且不连接，恢复后选中目标', async () => {
    const f = fixture(); f.controller.followDevice('b');
    expect(f.controller.snapshot.status).toBe('paused');
    expect(f.calls).toEqual([]);
    f.controller.start(); await flush();
    expect(f.calls).toEqual(['capture:b']);
    f.controller.stop();
  });
  test('Given 初始化未完成 When 隐藏 Then 立即关闭且忽略迟到设备', async () => {
    const f = fixture();
    const opened = deferred<{ devices: typeof f.devices }>();
    f.api.openMobileMirror = () => opened.promise;
    f.controller.start(); f.controller.stop();
    opened.resolve({ devices: f.devices }); await flush();
    expect(f.calls.filter((call) => call === 'close').length).toBeGreaterThanOrEqual(1);
    expect(f.calls.some((call) => call.startsWith('capture'))).toBe(false);
    expect(f.controller.snapshot.frame).toBeNull();
  });
  test('Given 帧请求未完成 When 切设备 Then 旧帧不显示且请求串行', async () => {
    const f = fixture(); f.controller.start(); await flush();
    f.controller.selectDevice('b');
    expect(f.calls).toEqual(['capture:a']);
    f.pending.resolve(f.frame); await flush();
    expect(f.controller.snapshot.frame).toBeNull();
    expect(f.calls).toEqual(['capture:a', 'capture:b']);
    f.controller.stop();
  });
  test('Given 截图在途 When 用户操作 Then 操作等待截图并在结束后刷新', async () => {
    const f = fixture(); f.controller.start(); await flush();
    const action = f.controller.perform({ type: 'button', button: 'HOME' });
    expect(f.calls).toEqual(['capture:a']);
    f.pending.resolve(f.frame); await action; await flush();
    expect(f.calls.slice(0, 3)).toEqual(['capture:a', 'action', 'capture:a']);
    f.controller.stop();
  });
  test('Given 截图在途 When 暂停 Then 迟到帧不恢复轮询', async () => {
    const f = fixture(); f.controller.start(); await flush(); f.controller.stop();
    f.pending.resolve(f.frame); await flush();
    expect(f.controller.snapshot.frame).toBeNull();
    expect(f.calls).toEqual(['capture:a', 'close']);
  });
  test('Given 截图期间用户排队操作 When 面板隐藏 Then 不再发出操作', async () => {
    const f = fixture(); f.controller.start(); await flush();
    const operation = f.controller.perform({ type: 'button', button: 'HOME' });
    f.controller.stop(); f.pending.resolve(f.frame);
    expect(await operation).toBe(false);
    expect(f.calls).toEqual(['capture:a', 'close']);
  });
  test('Given 旧会话请求未完成 When 恢复连接 Then 旧帧不能覆盖新连接', async () => {
    const f = fixture(); f.controller.start(); await flush(); f.controller.stop();
    const newer = deferred<typeof f.frame>();
    f.api.captureMobileMirrorFrame = async () => newer.promise;
    f.controller.start(); await flush();
    f.pending.resolve(f.frame); await flush();
    expect(f.controller.snapshot.frame).toBeNull();
    newer.resolve({ ...f.frame, frameId: 'new' }); await flush();
    expect(f.controller.snapshot.frame?.frameId).toBe('new');
    f.controller.stop();
  });
  test('Given 设备刷新在途 Then 第二个操作不排队且刷新后清除失效设备', async () => {
    const f = fixture(); f.controller.start(); await flush();
    const listed = deferred<typeof f.devices>();
    f.api.listMobileMirrorDevices = async () => listed.promise;
    f.pending.resolve(f.frame); await flush();
    const refreshing = f.controller.refreshDevices(); await flush();
    expect(await f.controller.perform({ type: 'button', button: 'HOME' })).toBe(false);
    listed.resolve([]); expect(await refreshing).toBe(true);
    expect(f.controller.snapshot.deviceId).toBe('');
    expect(f.controller.snapshot.frame).toBeNull();
    f.controller.stop();
  });
  test('Given 当前截图已显示 When 操作成功且新帧未到 Then 旧帧立即失效', async () => {
    const f = fixture(); f.controller.start(); await flush();
    f.pending.resolve(f.frame); await flush();
    const next = deferred<typeof f.frame>();
    f.api.captureMobileMirrorFrame = async () => next.promise;
    expect(f.controller.snapshot.frame?.frameId).toBe('f');
    expect(await f.controller.perform({ type: 'button', button: 'HOME' })).toBe(true);
    expect(f.controller.snapshot.frame).toBeNull();
    f.controller.stop(); next.resolve(f.frame);
  });
  test('Given 服务连接失败 Then 显示错误并等待显式重试', async () => {
    const f = fixture(); f.api.openMobileMirror = async () => { throw new Error('请先启用 Mobile MCP'); };
    f.controller.start(); await flush();
    expect(f.controller.snapshot.status).toBe('error');
    expect(f.controller.snapshot.error).toContain('请先启用');
    expect(f.calls).toEqual(['close']);
  });
});

describe('手机屏幕缩放坐标', () => {
  test('Given 宽容器内竖屏 Then 留白不可点击，画面中心归一化为0.5', () => {
    const box = { left: 10, top: 20, width: 400, height: 400 };
    expect(normalizedImagePoint(20, 220, box, 100, 200)).toBeNull();
    expect(normalizedImagePoint(210, 220, box, 100, 200)).toEqual({ x: 0.5, y: 0.5 });
    expect(normalizedImagePoint(110, 20, box, 100, 200)).toEqual({ x: 0, y: 0 });
  });
});
