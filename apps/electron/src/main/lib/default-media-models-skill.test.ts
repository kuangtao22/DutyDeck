import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 随应用分发的统一媒体 Skill 入口路径。 */
const mediaModelsSkillPath = join(import.meta.dir, '../../../default-skills/media-models/SKILL.md')

/** 读取随应用分发的统一媒体 Skill，合同测试只验证入口与边界，不模拟真实供应商。 */
function readMediaModelsSkill(): string {
  return existsSync(mediaModelsSkillPath) ? readFileSync(mediaModelsSkillPath, 'utf8') : ''
}

test('Given 统一媒体 Skill When 校验模型发现 Then 覆盖全部目录、分页和可执行能力', () => {
  const skill = readMediaModelsSkill()

  expect(skill).toMatch(/^name: media-models$/m)
  expect(skill).toMatch(/^group: proma$/m)
  expect(skill).toMatch(/^version: "1\.0\.0"$/m)
  for (const rule of [
    'media_list_models',
    'media_list_api_models',
    'nextOffset',
    'available === true',
    'support.state === "supported"',
    'text-to-image',
    'image-to-image',
    'text-to-video',
    'image-to-video',
    'text-to-speech',
    'voice-cloning',
    'text-to-music',
  ]) expect(skill).toContain(rule)
})

test('Given 媒体生成请求 When 校验旧路由和执行边界 Then 禁止过期 Skill 并保留异步终态合同', () => {
  const skill = readMediaModelsSkill()

  for (const rule of [
    'media_prepare_generation',
    'media_execute_generation',
    'media_wait_generation',
    'media_get_generation',
    'media_cancel_generation',
    'media_list_assets',
    'cancelIntent: "explicit"',
    'configuration-only',
    'canvas-production',
    'proma-generate-image',
    'proma-gpt-image-2',
  ]) expect(skill).toContain(rule)
  expect(skill).toContain('不要把 TTS 模型、LLM 或旧图片模型冒充音乐模型')
  expect(skill).toContain('不重复提交同一付费任务')
})
