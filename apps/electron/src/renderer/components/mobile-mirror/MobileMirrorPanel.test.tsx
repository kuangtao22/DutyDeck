import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MobileMirrorPanel } from './MobileMirrorPanel';

describe('手机面板初始渲染', () => {
  test('Given 尚未执行可见生命周期 When 渲染 Then 所有操作禁用且不访问设备', () => {
    // SSR 只提供空 bridge，若渲染本身访问设备则测试立即失败。
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: {} } });
    try {
      const html = renderToStaticMarkup(<MobileMirrorPanel sessionId="test-session" active onOpenMcp={() => undefined} />);
      expect(html).toContain('手机显示面板');
      expect(html).toContain('已暂停');
      expect(html).toContain('打开 MCP 设置');
      expect(html).toContain('输入到手机的文字');
      expect(html).toMatch(/aria-label="Home"[^>]*disabled/);
      expect(html).toMatch(/aria-label="向上滑动"[^>]*disabled/);
    } finally {
      if (previous) Object.defineProperty(globalThis, 'window', previous);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });
});
