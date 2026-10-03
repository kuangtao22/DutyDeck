"""优化整批采纳门槛的真实组件交互验收；仅使用本机假 IPC 预览。"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

# 预览入口与截图均为隔离测试资源，不访问用户业务目录或渠道。
preview_file = Path(__file__).with_name('capability-factory-preview.html')
base_url = os.environ.get('FACTORY_PREVIEW_URL', f'http://127.0.0.1:5199/@fs{preview_file}')
screenshot_dir = Path('/tmp/factory-optimization-smoke')
screenshot_dir.mkdir(exist_ok=True)


def prepare_and_compare(page, scenario):
    """打开指定合成情景并对两条任务运行；返回页面中的采纳按钮定位器。"""
    page.goto(f'{base_url}?optimize=1&width=960&stepDelay=0&reviewDelay=0&{scenario}=1')
    page.wait_for_load_state('networkidle')
    page.get_by_role('tab', name='运行', exact=True).click()
    page.get_by_role('tab', name='优化对比', exact=True).click()
    expect(page.get_by_role('checkbox')).to_have_count(2)
    page.get_by_role('checkbox').nth(1).check()
    page.get_by_role('button', name='开始对比', exact=True).click()
    expect(page.get_by_role('button', name='开始对比', exact=True)).to_be_enabled(timeout=15000)
    expect(page.get_by_label('任务对比结果', exact=True)).to_have_count(2)
    # 两条任务各跑当前版与候选，不因 UI 更新而重复调用，也不推进版本。
    snapshot = page.evaluate('window.factoryPreview.snapshot()')
    assert snapshot['calls'].count('runScene') == 4, snapshot['calls']
    assert snapshot['scene']['currentVersion'] == 2
    assert snapshot['scene']['draft'] is not None
    for record in snapshot['runs'][:4]:
        for review in record['stepReviews'].values():
            assert {metric['name'] for metric in review['metrics']} == {
                metric['name'] for metric in review['acceptance']['metrics']
            }, review
    return page.get_by_role('button', name='采纳已测试草案', exact=True)


def capture_result(page, name):
    """保留本情景结果截图，便于复核实际渲染和不可比原因。"""
    page.get_by_label('对比结果', exact=True).screenshot(path=str(screenshot_dir / f'{name}.png'), animations='disabled')


with sync_playwright() as playwright:
    # 使用 Chrome 的临时配置启动 headless 页面，关闭后不保留用户设置。
    browser = playwright.chromium.launch(headless=True, channel='chrome')
    page = browser.new_page(viewport={'width': 1000, 'height': 1100})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    try:
        adopt = prepare_and_compare(page, 'optimizeSecondFail')
        expect(adopt).to_have_count(0)
        snapshot = page.evaluate('window.factoryPreview.snapshot()')
        assert sorted(record['review']['passed'] for record in snapshot['runs'][:4]
                      if record['comparisonRole'] == 'candidate') == [False, True]
        capture_result(page, 'mixed-pass-fail')
        print('PASS 同批一好一坏不提供采纳，执行仅 4 次假 IPC', flush=True)

        adopt = prepare_and_compare(page, 'optimizeSecondUnchanged')
        expect(adopt).to_be_visible()
        expect(page.get_by_text('修复 1 · 退化 0', exact=True)).to_have_count(1)
        expect(page.get_by_text('修复 0 · 退化 0', exact=True)).to_have_count(1)
        capture_result(page, 'two-pass-one-improvement')
        page.get_by_role('checkbox').nth(1).uncheck()
        expect(adopt).to_have_count(0)
        page.get_by_role('checkbox').nth(1).check()
        expect(adopt).to_have_count(0)
        print('PASS 两条通过且一条改善可采纳；修改选择后旧背书不会恢复', flush=True)

        adopt = prepare_and_compare(page, 'optimizeNoImprovement')
        expect(adopt).to_have_count(0)
        expect(page.get_by_text('修复 0 · 退化 0', exact=True)).to_have_count(2)
        capture_result(page, 'no-improvement')
        print('PASS 两条均通过但无改善不提供采纳', flush=True)

        adopt = prepare_and_compare(page, 'optimizeUnknown')
        expect(adopt).to_have_count(0)
        page.get_by_role('button', name='查看详细对比', exact=True).first.click()
        expect(page.get_by_text('无法判断：指标：characters：evidenceCoverage', exact=True)).to_be_visible()
        capture_result(page, 'unknown')
        print('PASS 判据或指标未知不提供采纳，未知原因可展开', flush=True)

        adopt = prepare_and_compare(page, 'optimizeIncomparable')
        expect(adopt).to_have_count(0)
        expect(page.get_by_text('暂不能判断', exact=True)).to_have_count(2)
        page.get_by_role('button', name='查看详细对比', exact=True).first.click()
        expect(page.get_by_text('实际模型、模型参数不同或未记录', exact=True)).to_be_visible()
        capture_result(page, 'incomparable')
        assert not errors, errors
        print('PASS 不可比结果保留详情入口并显示具体原因；无页面异常', flush=True)
    finally:
        browser.close()
