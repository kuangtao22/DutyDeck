import { atom, createStore } from 'jotai';
import type { MobileMirrorAction, MobileMirrorActionInput, MobileMirrorCaptureInput, MobileMirrorDevice, MobileMirrorFrame, MobileMirrorOpenResult, MobileMirrorSessionInput } from '@proma/shared';

/** 面板只依赖五个受限 IPC，测试可注入不访问设备的实现。 */
export interface MirrorApi {
  openMobileMirror(input: MobileMirrorSessionInput): Promise<MobileMirrorOpenResult>;
  listMobileMirrorDevices(input: MobileMirrorSessionInput): Promise<MobileMirrorDevice[]>;
  captureMobileMirrorFrame(input: MobileMirrorCaptureInput): Promise<MobileMirrorFrame>;
  performMobileMirrorAction(input: MobileMirrorActionInput): Promise<void>;
  closeMobileMirror(input: MobileMirrorSessionInput): Promise<void>;
}
/** 仅当前面板的内存状态；截图不进入会话持久化。 */
export interface MirrorState {
  status: 'paused' | 'loading' | 'ready' | 'error';
  devices: MobileMirrorDevice[];
  deviceId: string;
  /** Agent 自动定位的设备；缺失时保留目标，禁止悄悄回退到另一台手机。 */
  requestedDeviceId: string | null;
  frame: MobileMirrorFrame | null;
  busy: boolean;
  error: string | null;
}
/** 计算 object-contain 中的归一化坐标；容器留白返回 null。 */
export function normalizedImagePoint(clientX: number, clientY: number, box: { left: number; top: number; width: number; height: number }, imageWidth: number, imageHeight: number): { x: number; y: number } | null {
  if (imageWidth <= 0 || imageHeight <= 0 || box.width <= 0 || box.height <= 0) return null;
  const scale = Math.min(box.width / imageWidth, box.height / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  const x = (clientX - box.left - (box.width - width) / 2) / width;
  const y = (clientY - box.top - (box.height - height) / 2) / height;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}
/** 串行帧循环：每次完成后再等待，关闭后所有迟到结果失效。 */
export class MobileMirrorController {
  /** 独立 store 使两个可见面板互不覆盖状态。 */
  readonly store = createStore();
  /** 当前设备、帧与操作状态。 */
  readonly state = atom<MirrorState>({ status: 'paused', devices: [], deviceId: '', requestedDeviceId: null, frame: null, busy: false, error: null });
  /** 当前有效连接；停止时先清空以屏蔽迟到响应。 */
  private connection: MobileMirrorSessionInput | null = null;
  /** 下一次截图计时器，不使用 setInterval 堆积请求。 */
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** 当前 IPC，设备切换与手动操作都等待它完成。 */
  private pending: Promise<void> | null = null;
  /** 手动操作或刷新设备排队时禁止安排截图。 */
  private manualPending = false;

  constructor(private readonly sessionId: string, private readonly api: MirrorApi) {}
  /** 读取当前内存快照，供控制器及测试使用。 */
  get snapshot(): MirrorState { return this.store.get(this.state); }
  /** 合并局部状态，不保留历史图像。 */
  private update(patch: Partial<MirrorState>): void { this.store.set(this.state, { ...this.snapshot, ...patch }); }
  /** 清理下一帧等待。 */
  private clearTimer(): void { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined; }
  /** 关闭连接为幂等回收；关闭失败不恢复后台轮询。 */
  private close(connection: MobileMirrorSessionInput): void { void this.api.closeMobileMirror(connection).catch(() => undefined); }
  /** 显式启动/重试；初始化晚到也不能复活旧连接。 */
  start(): void {
    this.stop();
    const connection = { sessionId: this.sessionId, mirrorId: crypto.randomUUID() };
    this.connection = connection;
    this.update({ status: 'loading', error: null, frame: null });
    void this.api.openMobileMirror(connection).then(({ devices }) => {
      if (this.connection !== connection) { this.close(connection); return; }
      const deviceId = this.snapshot.requestedDeviceId
        ?? (devices.some((device) => device.id === this.snapshot.deviceId) ? this.snapshot.deviceId : devices[0]?.id ?? '');
      this.update({ devices, deviceId, status: 'ready' });
      this.capture();
    }).catch((error: unknown) => this.fail(connection, error));
  }
  /** 暂停、隐藏、切会话及卸载都用同一回收路径。 */
  stop(): void {
    const connection = this.connection;
    this.connection = null;
    this.clearTimer();
    this.pending = null;
    this.manualPending = false;
    this.update({ status: 'paused', frame: null, busy: false });
    if (connection) this.close(connection);
  }
  /** 请求失败后停止，不自动无限重试。 */
  private fail(connection: MobileMirrorSessionInput, error: unknown): void {
    if (this.connection !== connection) return;
    this.stop();
    this.update({ status: 'error', error: error instanceof Error ? error.message : '手机连接失败，请重试' });
  }
  /** 本轮首次执行时定位 Agent 设备；只更新目标，不恢复暂停或重建连接。 */
  followDevice(deviceId: string): void {
    this.clearTimer();
    this.update({ requestedDeviceId: deviceId, deviceId, frame: null });
    if (!this.pending) this.capture();
  }
  /** 切换设备立即清旧图，等旧请求完成后才采集新设备。 */
  selectDevice(deviceId: string): void {
    if (!this.snapshot.devices.some((device) => device.id === deviceId) || this.snapshot.busy) return;
    this.clearTimer();
    this.update({ deviceId, requestedDeviceId: null, frame: null });
    if (!this.pending) this.capture();
  }
  /** 采集单帧，并仅在该连接仍可见时安排下一帧。 */
  private capture(): void {
    const connection = this.connection;
    const deviceId = this.snapshot.deviceId;
    if (!connection || !deviceId || !this.snapshot.devices.some((device) => device.id === deviceId)
      || this.pending || this.manualPending || this.snapshot.status !== 'ready') return;
    this.clearTimer();
    const pending = this.api.captureMobileMirrorFrame({ ...connection, deviceId }).then((frame) => {
      if (this.connection === connection && this.snapshot.deviceId === deviceId && frame.deviceId === deviceId) this.update({ frame });
    }).catch((error: unknown) => this.fail(connection, error)).finally(() => {
      if (this.connection !== connection || this.pending !== pending) return;
      this.pending = null;
      if (this.manualPending) return;
      if (this.snapshot.deviceId !== deviceId) this.capture();
      else this.timer = setTimeout(() => this.capture(), 1000);
    });
    this.pending = pending;
  }
  /** 用户操作和设备刷新共用串行门；后台帧不得穿插到动作之间。 */
  private async manual(operation: (connection: MobileMirrorSessionInput) => Promise<void>): Promise<boolean> {
    const connection = this.connection;
    if (!connection || this.manualPending || this.snapshot.status !== 'ready') return false;
    this.manualPending = true;
    this.clearTimer();
    this.update({ busy: true });
    try {
      await this.pending;
      if (this.connection !== connection) return false;
      await operation(connection);
      return this.connection === connection;
    } catch (error: unknown) { this.fail(connection, error); return false; }
    finally {
      if (this.connection === connection) {
        this.manualPending = false;
        this.update({ busy: false });
        this.capture();
      }
    }
  }
  /** 用户显式刷新设备，不自动分配或连接新设备。 */
  refreshDevices(): Promise<boolean> {
    return this.manual(async (connection) => {
      const devices = await this.api.listMobileMirrorDevices(connection);
      if (this.connection !== connection) return;
      const deviceId = this.snapshot.requestedDeviceId
        ?? (devices.some((device) => device.id === this.snapshot.deviceId) ? this.snapshot.deviceId : devices[0]?.id ?? '');
      this.update({ devices, deviceId, frame: null });
    });
  }
  /** 执行用户显式动作，动作结束后再更新屏幕。 */
  perform(action: MobileMirrorAction): Promise<boolean> {
    const deviceId = this.snapshot.deviceId;
    if (!deviceId) return Promise.resolve(false);
    return this.manual(async (connection) => {
      await this.api.performMobileMirrorAction({ ...connection, deviceId, action });
      // 操作会使服务端旧帧失效；新帧到达前禁用基于旧图的点击。
      if (this.connection === connection) this.update({ frame: null });
    });
  }
}
