"""真实组件交互验收；先用 bun run dev:vite --port 5199 启动隔离预览。"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

# 使用本机预览和临时截图目录，不连接模型或用户业务数据。
preview_file = Path(__file__).with_name('capability-factory-preview.html')
base_url = os.environ.get('FACTORY_PREVIEW_URL', f'http://127.0.0.1:5199/@fs{preview_file}')
screenshot_dir = Path('/tmp/factory-ui-smoke')
screenshot_dir.mkdir(exist_ok=True)

with sync_playwright() as playwright:
    # 使用本机 Chrome 的临时配置；结束时自动释放页面及浏览器。
    browser = playwright.chromium.launch(headless=True, channel='chrome')
    try:
        for width, height in [(605, 800), (300, 620)]:
            for theme in ['light', 'dark']:
                page = browser.new_page(viewport={'width': width, 'height': height})
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(f'{base_url}?width={width}&theme={theme}')
                page.wait_for_load_state('networkidle')
                expect(page.get_by_text('流程步骤', exact=True)).to_be_visible()
                page.screenshot(path=str(screenshot_dir / f'scene-{width}-{theme}.png'), animations='disabled')
                page.get_by_role('button', name='1 识别角色').click()
                dialog = page.get_by_role('dialog')
                expect(dialog).to_be_visible()

                # 键盘切换到输入，长输入与提示词分别编辑且跨页保留。
                dialog.get_by_role('tab', name='提示词', exact=True).focus()
                page.keyboard.press('ArrowRight')
                expect(dialog.get_by_role('tab', name='输入', exact=True)).to_have_attribute('aria-selected', 'true')
                expect(dialog.locator('textarea')).to_have_value('林舟推开书店的门。掌柜陈伯放下账本，向他点了点头。\n' * 80)
                dialog.locator('textarea').fill('本次测试：陈伯走进书店。')
                dialog.get_by_role('tab', name='提示词', exact=True).click()
                edited_prompt = '只提取有证据的角色。正文：{{text}}\n' + '结果必须包含 name 和 evidence。\n' * 60
                dialog.locator('textarea').fill(edited_prompt)
                page.screenshot(path=str(screenshot_dir / f'prompt-{width}-{theme}.png'), animations='disabled')

                # 弹窗和底部主操作必须始终位于视口内，长内容只在内部滚动。
                bounds = dialog.bounding_box()
                assert bounds and bounds['x'] >= 0 and bounds['y'] >= 0, bounds
                assert bounds['x'] + bounds['width'] <= width + 1, bounds
                assert bounds['y'] + bounds['height'] <= height + 1, bounds
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                run_bounds = dialog.get_by_role('button', name='试跑', exact=True).bounding_box()
                assert run_bounds and run_bounds['y'] + run_bounds['height'] <= height, run_bounds

                # 试跑使用编辑文本和输入；不先保存，也不会改场景版本。
                dialog.get_by_role('button', name='试跑', exact=True).click()
                expect(dialog.get_by_role('status')).to_contain_text('正在等待模型返回')
                expect(dialog.get_by_role('button', name='试跑中…')).to_be_disabled()
                expect(dialog.locator('[data-capability-factory-run="preview-2"]')).to_be_visible()
                snapshot = page.evaluate('window.factoryPreview.snapshot()')
                assert snapshot['runs'][0]['stepPrompt'] == edited_prompt
                assert snapshot['runs'][0]['input']['text'] == '本次测试：陈伯走进书店。'
                assert snapshot['scene']['currentVersion'] == 2 and snapshot['scene']['draft'] is None
                expect(dialog.get_by_text('渲染后的完整提示词', exact=True)).not_to_be_visible()
                page.screenshot(path=str(screenshot_dir / f'result-{width}-{theme}.png'), animations='disabled')

                # 历史先呈现列表，对比按需展开，并排除当前记录作为自身基线。
                dialog.get_by_role('tab', name='历史 3', exact=True).click()
                expect(dialog.get_by_label('选择对比基线')).not_to_be_visible()
                dialog.get_by_role('button', name='对比两次试跑').click()
                expect(dialog.get_by_label('选择对比基线')).to_be_visible()
                assert dialog.get_by_label('选择对比基线').locator('option').count() == 2
                dialog.locator('[role="tabpanel"][data-state="active"] button').last.click()
                expect(dialog.locator('[data-capability-factory-run="baseline"]')).to_be_visible()
                dialog.get_by_role('button', name='试跑', exact=True).click()
                expect(dialog.locator('[data-capability-factory-run="preview-3"]')).to_be_visible()

                # 保存草案与采纳语义仍分开；弹窗关闭后草案详情可以展开审阅。
                dialog.get_by_role('button', name='保存', exact=True).click()
                page.get_by_role('menuitem', name='保存为草案', exact=True).click()
                expect(dialog.get_by_role('button', name='保存', exact=True)).to_be_enabled()
                dialog.get_by_role('button', name='关闭', exact=True).click()
                expect(page.get_by_text('草案 v3', exact=True)).to_be_visible()
                page.get_by_role('button', name='查看改动', exact=True).click()
                expect(page.get_by_text('改了什么', exact=True)).to_be_visible()
                page.get_by_role('button', name='采纳 v3', exact=True).click()
                expect(page.get_by_text('草案 v3', exact=True)).not_to_be_visible()
                assert page.evaluate('window.factoryPreview.snapshot().scene.currentVersion') == 3

                # 没有外部能力的场景不展示接入设置；历史独立呈现空状态。
                page.get_by_role('tab', name='运行', exact=True).click()
                expect(page.get_by_role('tab', name='本轮', exact=True)).to_be_visible()
                expect(page.get_by_role('button', name='虚拟接入')).not_to_be_visible()
                page.get_by_role('tab', name='历史', exact=True).click()
                expect(page.get_by_text('暂无历史记录。', exact=True)).to_be_visible()
                assert not errors, errors
                print(f'PASS {width}x{height} {theme}: 键盘、编辑、试跑、历史对比、草案采纳、视口边界')
                page.close()

        # 读取旧历史的响应晚于新试跑时，新记录仍应是当前结果。
        page = browser.new_page(viewport={'width': 900, 'height': 800})
        page.goto(f'{base_url}?historyDelay=1')
        page.wait_for_load_state('networkidle')
        page.get_by_role('button', name='1 识别角色').click()
        dialog = page.get_by_role('dialog')
        dialog.get_by_role('button', name='试跑', exact=True).click()
        expect(dialog.locator('[data-capability-factory-run="preview-2"]')).to_be_visible()
        page.wait_for_timeout(1900)
        expect(dialog.locator('[data-capability-factory-run="preview-2"]')).to_be_visible()

        # 已有旧结果时，本次调用失败只显示错误，不把旧输出误作新结果。
        page.goto(f'{base_url}?fail=1')
        page.wait_for_load_state('networkidle')
        page.get_by_role('button', name='1 识别角色').click()
        dialog = page.get_by_role('dialog')
        expect(dialog.get_by_role('tab', name='历史 2')).to_be_visible()
        dialog.get_by_role('button', name='试跑', exact=True).click()
        expect(dialog.get_by_role('alert')).to_have_text('模拟模型暂时不可用')
        expect(dialog.locator('[data-capability-factory-run]')).to_have_count(0)
        print('PASS 失败旧记录隔离、迟到历史响应合并')
        page.close()
    finally:
        browser.close()
