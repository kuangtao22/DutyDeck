import { describe, expect, test } from 'bun:test'
import type { LanBridgeAutomationDto } from '@proma/shared'

/** 提供 atoms 初始化所需的最小浏览器存储。 */
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  },
})

/** 提供移动端模块初始化所需的最小窗口地址。 */
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    location: { hostname: '127.0.0.1', href: 'http://127.0.0.1:29888/', protocol: 'http:' },
  },
})

/** 创建自动计划摘要，避免测试依赖主进程调度器。 */
function createAutomation(overrides: Partial<LanBridgeAutomationDto> = {}): LanBridgeAutomationDto {
  return {
    id: 'automation-1',
    name: '每日汇总',
    active: true,
    scheduleType: 'interval',
    intervalMinutes: 30,
    nextRunAt: 100,
    runHistory: [],
    ...overrides,
  }
}

describe('移动端自动计划摘要', () => {
  test('Given interval 计划包含运行日和时间窗口 When 格式化 Then 保留服务端调度边界', async () => {
    const { formatAutomationSchedule } = await import('./AutomationPanel')
    expect(formatAutomationSchedule(createAutomation({
      activeWeekdays: [1, 3, 5],
      activeWindowStart: '09:00',
      activeWindowEnd: '18:00',
    }))).toBe('每 30 分钟 · 周一、三、五 · 09:00-18:00')
  })

  test('Given once 计划 When 格式化 Then 展示一次性语义而不伪造下一次运行', async () => {
    const { formatAutomationSchedule } = await import('./AutomationPanel')
    expect(formatAutomationSchedule(createAutomation({
      scheduleType: 'once',
      scheduledAt: 0,
    }))).toBe('一次性')
  })
})
