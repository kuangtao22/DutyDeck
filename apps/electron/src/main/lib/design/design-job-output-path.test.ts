import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DataRootLocator } from '../data-root-locator'
import { resolveOwnedDesignJobOutputPath } from './design-job-manager'

/** 仅保留临时根以便每次测试后回收。 */
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

test('Given 新旧任务附件引用 When 确定清理归属 Then 仅接受本会话普通文件', () => {
  /** 独立 home 与数据根避免访问真实会话。 */
  const home = mkdtempSync(join(tmpdir(), 'dutydeck-output-reference-'))
  roots.push(home)
  const root = join(home, 'data')
  const own = join(root, 'attachments', 'session-one')
  mkdirSync(own, { recursive: true })
  writeFileSync(join(own, 'image.png'), 'image')
  mkdirSync(join(root, 'attachments', 'session-two'))
  writeFileSync(join(root, 'attachments', 'session-two', 'image.png'), 'other')
  symlinkSync(join(root, 'attachments', 'session-two'), join(own, 'linked'))
  const locator = new DataRootLocator({ homeDir: home })
  locator.write({ version: 1, activeRoot: root })
  expect(resolveOwnedDesignJobOutputPath('session-one', 'dutydeck-data:/attachments/session-one/image.png', locator)).toBeTruthy()
  expect(resolveOwnedDesignJobOutputPath('session-one', 'session-one/image.png', locator)).toBeTruthy()
  expect(resolveOwnedDesignJobOutputPath('session-one', join(own, 'image.png'), locator)).toBeTruthy()
  expect(resolveOwnedDesignJobOutputPath('session-one', join(home, '.proma', 'attachments', 'session-one', 'image.png'), locator)).toBeTruthy()
  for (const path of ['dutydeck-data:/attachments/session-two/image.png', 'dutydeck-data:/attachments/session-one/linked/image.png', 'dutydeck-data:/attachments/session-one/../session-two/image.png', join(root, 'attachments', 'session-two', 'image.png'), join(home, 'external', 'image.png')]) {
    expect(resolveOwnedDesignJobOutputPath('session-one', path, locator)).toBeUndefined()
  }
})
