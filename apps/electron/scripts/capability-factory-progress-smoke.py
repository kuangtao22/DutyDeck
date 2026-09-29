"""运行进度交互回归；连接本地隔离预览，所有输入、模型输出仅在页面内存中。"""
import os
import re
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

# 默认使用既有 Vite 预览，也可显式指定另一个本地测试地址。
preview_file = Path(__file__).with_name('capability-factory-preview.html')
base_url = os.environ.get('FACTORY_PREVIEW_URL', f'http://127.0.0.1:5199/@fs{preview_file}')
screenshots = Path('/tmp/factory-progress-smoke')
screenshots.mkdir(exist_ok=True)


def check_progress(browser, mode, width=1040, theme='light', reduced=False):
    """提交一次模拟任务，核对业务步骤、评审步骤和终态，返回成功标记。"""
    page = browser.new_page(viewport={'width': width, 'height': 860}, reduced_motion='reduce' if reduced else 'no-preference')
    errors = []  # 收集本页面未处理的运行时异常。
    page.on('pageerror', lambda error: errors.append(str(error)))
    try:
        page.goto(f'{base_url}?longTask=1&width={width}&theme={theme}&stepDelay=1200&reviewDelay=1200&{mode}=1')
        page.wait_for_load_state('networkidle')
        page.get_by_role('tab', name='运行', exact=True).click()
        page.get_by_role('button', name='开始运行', exact=True).click()
        dialog = page.get_by_role('dialog')
        expect(dialog).to_be_visible()
        expect(dialog.get_by_role('button', name='开始运行', exact=True)).to_be_enabled()
        dialog.get_by_role('button', name='开始运行', exact=True).click()
        expect(dialog).not_to_be_visible()

        # 第一项开始时第二项只能等待；静态材料入口不显示运行动画。
        result = page.locator('[data-capability-factory-run^="preview-"]')
        nav = result.get_by_role('tablist', name='运行详情导航')
        expect(nav.locator('[aria-current="step"]')).to_contain_text('识别角色')
        expect(nav).to_contain_text('整理人物信息等待')
        expect(nav.get_by_role('tab', name='任务输入').locator('.animate-spin')).to_have_count(0)
        expect(nav.get_by_role('tab', name='模型信息').locator('.animate-spin')).to_have_count(0)
        animation = nav.locator('[aria-current="step"] .animate-spin').evaluate('(el) => getComputedStyle(el).animationName')
        assert (animation == 'none') == reduced, animation
        page.screenshot(path=str(screenshots / f'{mode}-running.png'))

        if mode == 'fail':
            expect(page.get_by_role('alert')).to_contain_text('未能取得本轮最终结果')
            expect(page.locator('.animate-spin')).to_have_count(0)
            expect(page.get_by_role('button', name='开始运行', exact=True)).to_be_enabled()
        else:
            if mode == 'manual':
                nav.get_by_role('tab', name='任务输入').click()
            expect(nav.locator('[aria-current="step"]')).to_contain_text('整理人物信息')
            expect(nav.get_by_role('tab', name=re.compile('识别角色')).locator('.lucide-check')).to_have_count(1)
            expect(nav.get_by_role('tab', name=re.compile('识别角色'))).to_contain_text('评审中')
            expect(nav.get_by_role('tab', name=re.compile('整理人物信息'))).to_contain_text('等待评审')
            if mode == 'manual':
                expect(nav.get_by_role('tab', name='任务输入')).to_have_attribute('aria-selected', 'true')
            else:
                expect(nav.get_by_role('tab', name=re.compile('自动评审'))).to_have_attribute('aria-selected', 'true')
            expect(nav.get_by_role('tab', name=re.compile('整理人物信息'))).to_contain_text('评审中')
            page.screenshot(path=str(screenshots / f'{mode}-review.png'))
            expect(result.get_by_role('button', name='开始运行', exact=True)).to_be_enabled()
            expect(nav.locator('.animate-spin')).to_have_count(0)
            if mode == 'manual':
                expect(nav.get_by_role('tab', name='任务输入')).to_have_attribute('aria-selected', 'true')
            if mode == 'reviewFail':
                expect(result.get_by_role('alert')).to_contain_text('模拟评测失败')
        assert not errors, errors
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        print(f'PASS {mode}: {width}px {theme}, reduced-motion={reduced}', flush=True)
    finally:
        page.close()


with sync_playwright() as playwright:
    # 独立临时浏览器配置，不接触用户已有浏览器会话。
    browser = playwright.chromium.launch(headless=True, channel='chrome')
    try:
        check_progress(browser, 'normal')
        check_progress(browser, 'manual', width=420, theme='dark', reduced=True)
        check_progress(browser, 'fail')
        check_progress(browser, 'reviewFail')
    finally:
        browser.close()
