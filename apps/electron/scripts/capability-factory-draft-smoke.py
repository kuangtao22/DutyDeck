"""版本卡片与新旧对比交互回归；仅操作本地预览的虚拟场景。"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

# 使用独立预览，不读取 DutyDeck 中的真实场景或运行记录。
preview_file = Path(__file__).with_name('capability-factory-preview.html')
base_url = os.environ.get('FACTORY_PREVIEW_URL', f'http://127.0.0.1:5199/@fs{preview_file}')
screenshots = Path('/tmp/factory-draft-smoke')
screenshots.mkdir(exist_ok=True)


def prepare(page, width=1280, theme='dark'):
    """构造同时修改提示词、另一步骤及评审标准的候选，检查局部编辑保留范围。"""
    page.set_viewport_size({'width': width, 'height': 900})
    page.goto(f'{base_url}?optimize=1&width={width}&theme={theme}')
    page.wait_for_load_state('networkidle')
    page.evaluate('''async () => {
      const scene = window.factoryPreview.snapshot().scene;
      const definition = structuredClone(scene.draft.definition);
      definition.stepAcceptances.characters.criteria.push('新增评审规则');
      definition.steps[1].prompt += '\\n另一处草案修改';
      await window.electronAPI.capabilityFactory.invoke('saveDraft', {definition, note: '隔离测试'});
    }''')
    page.get_by_role('button', name='刷新场景').click()
    expect(page.get_by_text('新版本 v3 · 待采纳', exact=True)).to_have_count(3)


def save_draft(page, dialog):
    """只保存待采纳草案，保持当前运行版本不变。"""
    dialog.get_by_role('button', name='保存', exact=True).click()
    page.get_by_role('menuitem', name='保存为草案', exact=True).click()
    expect(dialog).not_to_be_visible()


def assert_diff_theme(page, theme):
    """检查实际差异行配色，避免外层浅色而 Shadow DOM 仍使用深色主题。"""
    addition = page.locator('[data-line-type=change-addition]').last
    deletion = page.locator('[data-line-type=change-deletion]').last
    expect(addition).to_have_css('background-color', 'rgb(228, 244, 233)' if theme == 'light' else 'rgb(19, 34, 23)')
    expect(deletion).to_have_css('background-color', 'rgb(248, 231, 230)' if theme == 'light' else 'rgb(39, 22, 20)')
    expect(addition).to_have_css('color-scheme', theme)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, channel='chrome')
    page = browser.new_page()
    errors = []
    console_errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
    try:
        prepare(page)
        page.get_by_role('button', name='1 识别角色', exact=True).click()
        dialog = page.get_by_role('dialog')
        expect(dialog.get_by_role('tab', name='版本对比', exact=True)).to_have_attribute('aria-selected', 'true')
        expect(page.locator('[data-line-type=change-addition]').first).to_be_visible()
        assert_diff_theme(page, 'dark')
        page.screenshot(path=str(screenshots / 'prompt-diff.png'))
        dialog.get_by_role('tab', name='编辑草案', exact=True).click()
        editor = dialog.get_by_role('textbox', name='提示词', exact=True)
        assert '只收录具名角色' in editor.input_value()
        edited_prompt = editor.input_value() + '\n保留用户手动修改'
        editor.fill(edited_prompt)
        dialog.get_by_role('tab', name='版本对比', exact=True).click()
        expect(dialog.get_by_text('含未保存修改', exact=False)).to_be_visible()
        dialog.get_by_role('tab', name='编辑草案', exact=True).click()
        expect(editor).to_have_value(edited_prompt)
        save_draft(page, dialog)
        saved = page.evaluate('window.factoryPreview.snapshot().scene')
        assert saved['currentVersion'] == 2
        assert saved['draft']['definition']['steps'][0]['prompt'] == edited_prompt
        assert '另一处草案修改' in saved['draft']['definition']['steps'][1]['prompt']
        assert '新增评审规则' in saved['draft']['definition']['stepAcceptances']['characters']['criteria']
        page.get_by_role('button', name='1 识别角色', exact=True).click()
        dialog.get_by_role('button', name='采纳整份草案 v3', exact=True).click()
        expect(dialog).not_to_be_visible()
        expect(page.get_by_text('新版本 v3 · 待采纳', exact=True)).to_have_count(0)
        assert page.evaluate('window.factoryPreview.snapshot().scene.currentVersion') == 3
        print('PASS prompt comparison, draft edit preservation, whole-scene adoption', flush=True)

        prepare(page, width=600, theme='light')
        page.get_by_role('button', name='编辑识别角色评审标准', exact=True).click()
        dialog.get_by_role('button', name='合并', exact=True).click()
        expect(page.locator('[data-line-type=change-addition]').first).to_be_visible()
        assert_diff_theme(page, 'light')
        page.screenshot(path=str(screenshots / 'acceptance-diff-light.png'))
        dialog.get_by_role('tab', name='编辑草案', exact=True).click()
        criterion = dialog.get_by_role('textbox', name='判据 1', exact=True)
        criterion.fill('手动补充的评审依据')
        dialog.get_by_role('tab', name='版本对比', exact=True).click()
        expect(dialog.get_by_role('button', name='采纳整份草案 v3')).to_be_disabled()
        dialog.get_by_role('button', name='返回编辑并保存').click()
        expect(criterion).to_have_value('手动补充的评审依据')
        save_draft(page, dialog)
        saved = page.evaluate('window.factoryPreview.snapshot().scene')
        assert '只收录具名角色' in saved['draft']['definition']['steps'][0]['prompt']
        assert saved['draft']['definition']['stepAcceptances']['characters']['criteria'][0] == '手动补充的评审依据'
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        print('PASS acceptance comparison and edits preserve prompt draft at 600px', flush=True)

        prepare(page)
        page.get_by_role('button', name='1 识别角色', exact=True).click()
        dialog.get_by_role('tab', name='编辑草案', exact=True).click()
        dialog.get_by_role('textbox', name='提示词', exact=True).fill('尚未保存的个人修改')
        # 模拟另一个 Agent 替换并采纳了不含此步骤的版本，轮询不得卸载正在编辑的弹窗。
        page.evaluate('''async () => {
          const definition = structuredClone(window.factoryPreview.snapshot().scene.draft.definition);
          definition.steps = definition.steps.filter(step => step.id !== 'characters');
          await window.electronAPI.capabilityFactory.invoke('saveDraft', {definition, note:'并发更新'});
          await window.electronAPI.capabilityFactory.invoke('adoptDraft', {});
        }''')
        expect(dialog.get_by_role('alert')).to_contain_text('草案已更新', timeout=7000)
        expect(dialog.get_by_role('textbox', name='提示词', exact=True)).to_have_value('尚未保存的个人修改')
        expect(dialog.get_by_role('button', name='保存', exact=True)).to_be_disabled()
        assert not errors, errors
        assert not any('same key' in message for message in console_errors), console_errors
        print('PASS concurrent removal retains local input and blocks stale save', flush=True)
    finally:
        browser.close()
