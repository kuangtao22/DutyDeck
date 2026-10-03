import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import {
  browserModalCountAtom,
  browserNativeViewHiddenAtom,
  browserOverlayCountAtom,
} from './browser-modal-atoms'

describe('原生浏览器视图浮层避让', () => {
  test('Given 加号菜单浮层打开 When 查询原生视图状态 Then 隐藏页面但不依赖改变页面尺寸', () => {
    const store = createStore()

    expect(store.get(browserNativeViewHiddenAtom)).toBe(false)
    store.set(browserOverlayCountAtom, 1)
    expect(store.get(browserNativeViewHiddenAtom)).toBe(true)
    store.set(browserOverlayCountAtom, 0)
    expect(store.get(browserNativeViewHiddenAtom)).toBe(false)
  })

  test('Given 模态弹窗和浮层同时存在 When 浮层关闭 Then 模态避让仍保持有效', () => {
    const store = createStore()

    store.set(browserModalCountAtom, 1)
    store.set(browserOverlayCountAtom, 1)
    store.set(browserOverlayCountAtom, 0)
    expect(store.get(browserNativeViewHiddenAtom)).toBe(true)
    store.set(browserModalCountAtom, 0)
    expect(store.get(browserNativeViewHiddenAtom)).toBe(false)
  })
})
