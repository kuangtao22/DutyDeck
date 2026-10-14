/** 与 V1 相同的四页产品示例，独立副本用于比较工作方式；不加载 V1 编辑器状态。 */
'use strict';

/** 图标字典：统一使用内联线性 SVG，原型离线运行时不请求外部资源。 */
const iconPaths = {
  plus:'M12 5v14M5 12h14', close:'m6 6 12 12M6 18 18 6', folder:'M3 7V5h6l2 2h10v13H3z', chat:'M4 4h16v12H9l-5 4z',
  layout:'M3 4h18v16H3zM8 4v16M8 9h13', layers:'m12 3 10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5',
  sparkles:'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5zM20 2v4M18 4h4',
  book:'M12 5v15M12 5C9 3 5 3 2 4v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1z',
  'arrow-up-right':'M6 18 18 6M6 6h12v12', 'arrow-up':'M12 19V5m-6 6 6-6 6 6', 'arrow-right':'M4 12h16m-6-6 6 6-6 6',
  'chevron-right':'m9 5 7 7-7 7', 'chevron-down':'m6 9 6 6 6-6', 'chevron-left':'m15 5-7 7 7 7',
  play:'m8 4 13 8-13 8z', download:'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  expand:'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5', phone:'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM10 18h4',
  // 专注模式的收拢图标，区别于进入专注的四角展开。
  collapse:'M3 8h5V3m8 0v5h5M3 16h5v5m8 0v-5h5',
  desktop:'M3 3h18v13H3zM12 16v5m-5 0h10', flow:'M3 3h6v6H3zM15 15h6v6h-6zM6 9v9h9M9 6h9v9',
  history:'M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2', refresh:'M20 7a9 9 0 0 0-15-1L2 9m0-6v6h6M4 17a9 9 0 0 0 15 1l3-3m0 6v-6h-6',
  undo:'M9 5 3 11l6 6M3 11h11a7 7 0 0 1 7 7', redo:'m15 5 6 6-6 6m6-6H10a7 7 0 0 0-7 7',
  palette:'M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-4c-1-1 0-3 2-3h2a4 4 0 0 0 3-4c-1-4-5-7-9-7zM7 8h.01M12 6h.01M17 8h.01M6 13h.01',
  sliders:'M5 3v7m0 4v7M12 3v12m0 4v2m7-18v3m0 4v11M2 10h6m1 5h6m1-9h6',
  moon:'M21 13A9 9 0 0 1 11 3 9 9 0 1 0 21 13z', sun:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1',
  check:'m5 12 4 4L19 6', leaf:'M20 3C8 2 2 9 6 16s16 3 14-13zM5 21l10-11',
  wifi:'M3 8a15 15 0 0 1 18 0M6 12a10 10 0 0 1 12 0m-9 4a5 5 0 0 1 6 0M12 20h.01',
  battery:'M3 7h15v10H3zM21 10v4M6 10h9v4H6z', chart:'M4 20V10m5 10V4m6 16v-7m5 7V7',
  calendar:'M4 5h16v16H4zM8 2v6m8-6v6M4 11h16', person:'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M4 21v-2a8 8 0 0 1 16 0v2',
  water:'M12 2S5 10 5 15a7 7 0 0 0 14 0c0-5-7-13-7-13z', bell:'M5 17h14l-2-3V9a5 5 0 0 0-10 0v5zM10 21h4',
  type:'M4 4h16M12 4v16M8 20h8', cursor:'m4 3 15 10-7 1-3 7z', panel:'M3 4h18v16H3zM9 4v16',
  lock:'M6 10h12v11H6zM8 10V6a4 4 0 0 1 8 0v4', unlock:'M6 10h12v11H6zM8 10V6a4 4 0 0 1 8 0', search:'m21 21-4.3-4.3M10.8 18a7.2 7.2 0 1 1 0-14.4 7.2 7.2 0 0 1 0 14.4', pencil:'m4 20 4-.8L19 8.2a2.2 2.2 0 0 0-3.2-3.2L4.8 16 4 20zM14.5 6.5l3 3', trash:'M5 7h14m-9 4v6m4-6v6M9 7V4h6v3m-9 0 1 14h10l1-14', grip:'M8 6h.01M8 12h.01M8 18h.01M16 6h.01M16 12h.01M16 18h.01',
  warning:'m12 3 10 18H2zM12 9v5m0 3h.01', code:'m8 6-6 6 6 6m8-12 6 6-6 6', copy:'M8 8h13v13H8zM16 8V3H3v13h5',
};

/** 生成装饰图标；输入字典键，返回固定安全 SVG 标记。 */
function icon(name) { return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${iconPaths[name] || iconPaths.layout}"/></svg>`; }
/** 转义用户文字；输入任意展示值，返回可安全嵌入文本或属性的字符串。 */
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character])); }
/** 复制纯 JSON 示例数据，隔离当前稿、候选稿和撤销记录。 */
function clone(value) { return JSON.parse(JSON.stringify(value)); }
/** 简化固定 DOM 查询；输入选择器，返回匹配节点。 */
function $(selector) { return document.querySelector(selector); }
/** 将声明式图标标记替换为 SVG，支持后续动态区域。 */
function hydrateIcons(root = document) { root.querySelectorAll('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon); }); }

/** 四页示例内容；页面身份与文字分离，文案变化不会断开流程。 */
const seedPages = [
  {id:'welcome',name:'欢迎页',role:'首次使用',title:'把小事，\n变成日常。',subtitle:'不用一下子改变生活。\n每天一小步，就是很好的开始。',cta:'开启我的第一天',state:'normal'},
  {id:'today',name:'今日习惯',role:'习惯概览',title:'早上好，阿光',subtitle:'今天也为自己做一点小事。',cta:'阅读 20 分钟',state:'normal'},
  {id:'detail',name:'习惯详情',role:'完成打卡',title:'阅读 20 分钟',subtitle:'给自己一段安静的时间',cta:'立即打卡',state:'normal'},
  {id:'done',name:'完成反馈',role:'正向反馈',title:'又向前一步。',subtitle:'今天的阅读已完成。\n微小的坚持，也值得被认真庆祝。',cta:'回到今日习惯',state:'normal'},
];
/** 为展示页生成设备状态栏；无业务参数。 */
function statusBar() { return `<div class="phone-status"><span>9:41</span><span class="status-icons">${icon('chart')}${icon('wifi')}${icon('battery')}</span></div>`; }
/** 给可编辑内容包一层稳定元素标识；父级借此区分编辑选择和演示点击。 */
function editable(pageId, element, className = '') { return `class="${className}${state.selectedPage === pageId && state.selectedElement === element ? ' element-selected' : ''}" data-element="${element}" data-page="${escapeHtml(pageId)}"`; }
/** 生成示例页面内容；输入页面、运行态和编辑标志，返回真实可交互 HTML。 */
function screenHtml(page, runtime = {completed:false}, editing = true) {
  /** 页面数据均经转义；画板不会把用户输入解释为脚本或标签。 */
  const text = {title:escapeHtml(page.title),subtitle:escapeHtml(page.subtitle),cta:escapeHtml(page.cta)};
  /** 同一来源动作既能在编辑模式选中，也能在演示模式执行跳转。 */
  const cta = `<button ${editable(page.id,'cta','app-button')} data-app-action="next" data-source="${escapeHtml(page.id)}">${text.cta}${icon('arrow-right')}</button>`;
  /** 基于当前设备使用真实布局变化，避免把手机页面简单拉宽。 */
  const className = `screen${editing?' editing':''}${state.device === 'desktop'?' desktop-screen':''}`;
  /** 页面正文按角色模板渲染，未知新增页保持可编辑和可演示。 */
  let body = '';
  if (page.state === 'loading') {
    body = `<div class="app-body"><h2 class="app-title">正在准备…</h2><div class="screen-skeleton"></div><div class="screen-skeleton"></div><p class="app-description">正在读取今日习惯</p><div class="app-bottom"><button class="app-button" data-app-action="resolve" data-source="${page.id}">显示加载结果</button></div></div>`;
  } else if (page.state === 'error') {
    body = `<div class="app-body"><div class="screen-empty">${icon('warning')}<h2>暂时没有加载成功</h2><p>你已有的记录仍然保留，稍后再试。</p></div><div class="app-bottom"><button class="app-button" data-app-action="resolve" data-source="${page.id}">重新加载</button></div></div>`;
  } else if (page.state === 'empty') {
    body = `<div class="app-body"><h2 class="app-title">从一件小事开始</h2><div class="screen-empty">${icon('leaf')}<p>你的习惯清单还是空的。<br>先给今天留 20 分钟阅读时间。</p></div><div class="app-bottom"><button class="app-button" data-app-action="resolve" data-source="${page.id}">添加阅读习惯</button></div></div>`;
  } else if (page.id === 'welcome') {
    body = `<div class="app-body"><div class="app-top-label"><div class="app-brand">${icon('leaf')}拾光</div><span>每天，一点点</span></div><h2 ${editable(page.id,'title','app-title')}>${text.title}</h2><p ${editable(page.id,'subtitle','app-description')}>${text.subtitle}</p><div class="welcome-art"><div class="orbit second"></div><div class="orbit"></div><div class="art-sun">${icon('leaf')}</div><div class="art-pill one">${icon('sun')}早一点，遇见阳光</div><div class="art-pill two">${icon('check')}今天，也做到了</div></div><div class="app-bottom">${cta}<p class="app-undertext">从一个习惯开始 · 随时调整自己的节奏</p><div class="page-number">01 / 04</div></div></div>`;
  } else if (page.id === 'today') {
    body = `<div class="app-body"><div class="date-line">10 月 14 日，星期三</div><div class="app-heading-row"><h2 ${editable(page.id,'title')}>${text.title}</h2><div class="app-avatar">光</div></div><p ${editable(page.id,'subtitle','app-description')}>${text.subtitle}</p><div class="app-progress"><div><strong>今天的小进步</strong><p>保持自己的节奏就好</p></div><div class="progress-circle" style="background:conic-gradient(#a6c192 0deg ${runtime.completed?240:120}deg,#e3eadb 0deg 360deg)"><strong>${runtime.completed?'2':'1'} / 3</strong></div></div><div class="app-section-heading">我的习惯<span>全部 3 项</span></div><div class="habit-row"><span class="habit-icon">${icon('sun')}</span><span class="habit-copy"><b>晨间散步</b><small>07:30 · 已连续 5 天</small></span><span class="habit-check done">${icon('check')}</span></div><button ${editable(page.id,'cta','habit-row')} data-app-action="next" data-source="today"><span class="habit-icon reading">${icon('book')}</span><span class="habit-copy"><b>${text.cta}</b><small>${runtime.completed?'今日已完成 · 连续 8 天':'20:30 · 已连续 7 天'}</small></span><span class="habit-check${runtime.completed?' done':''}">${runtime.completed?icon('check'):icon('chevron-right')}</span></button><div class="habit-row"><span class="habit-icon water">${icon('water')}</span><span class="habit-copy"><b>好好喝水</b><small>每天 · 1,500 毫升</small></span><span class="habit-check"></span></div><p class="app-note">“慢慢来，也是一种向前。”</p></div><nav class="app-nav" aria-label="示例 App 导航"><button class="active" data-app-action="today">${icon('calendar')}今天</button><button data-app-action="records">${icon('chart')}记录</button><button data-app-action="profile">${icon('person')}我的</button></nav>`;
  } else if (page.id === 'detail') {
    body = `<div class="app-body"><div class="app-top-nav"><button class="app-back" data-app-action="today" aria-label="返回今日习惯">${icon('chevron-left')}</button><span>我的习惯</span><span>•••</span></div><div class="detail-hero"><div class="detail-book">${icon('book')}</div><h2 ${editable(page.id,'title','detail-title')}>${text.title}</h2><p ${editable(page.id,'subtitle','detail-subtitle')}>${text.subtitle}</p></div><div class="detail-stats"><div><b>${runtime.completed?'8':'7'}</b><small>连续天数</small></div><div><b>24</b><small>累计完成</small></div><div><b>92<span style="font-size:13px">%</span></b><small>本月完成率</small></div></div><div class="app-section-heading">本周记录<span>10.12 — 10.18</span></div><div class="week-grid">${['一','二','三','四','五','六','日'].map((day,index)=>`<div class="week-day ${index<2?'done':index===2?'today':''}">${day}<span>${index<2?icon('check'):index+12}</span></div>`).join('')}</div><div class="reminder-row">${icon('bell')}每日提醒<span>20:30</span></div><div class="app-bottom">${cta}<p class="app-undertext">只要翻开书，就是一个好的开始</p></div></div>`;
  } else if (page.id === 'done') {
    body = `<div class="app-body"><div class="success-art">${icon('check')}</div><h2 ${editable(page.id,'title','success-title')}>${text.title}</h2><p ${editable(page.id,'subtitle','success-copy')}>${text.subtitle}</p><div class="streak-card"><strong>${runtime.completed?'8':'7'}</strong><small>天</small><p>正在延续的阅读习惯</p></div><div class="app-bottom">${cta}<p class="app-undertext">明天见，继续按自己的节奏走。</p></div></div>`;
  } else {
    body = `<div class="app-body"><div class="app-brand">${icon('leaf')}拾光</div><h2 ${editable(page.id,'title','app-title')}>${text.title}</h2><p ${editable(page.id,'subtitle','app-description')}>${text.subtitle}</p><div class="screen-empty">${icon('layout')}<p>为这张页面添加内容与流程</p></div><div class="app-bottom">${cta}</div></div>`;
  }
  return `<div class="${className}" style="--app-accent:${state.accent}" data-screen="${escapeHtml(page.id)}">${statusBar()}${body}<div class="phone-home"></div></div>`;
}
