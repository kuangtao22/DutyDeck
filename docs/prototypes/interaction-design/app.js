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
  lock:'M6 10h12v11H6zM8 10V6a4 4 0 0 1 8 0v4', unlock:'M6 10h12v11H6zM8 10V6a4 4 0 0 1 8 0',
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
/** 原型专用缓存键；与真实 DutyDeck 配置、会话、业务文件完全隔离。 */
const storageKey = 'dutydeck.interaction-design.prototype.v1';
/** 当前原型内存状态，交互数据和产品定义都只存在本页面。 */
let state = {
  title:'习惯养成 App',brief:'做一个温和、简洁的习惯养成 App，支持首次使用到阅读打卡。',pages:clone(seedPages),
  links:{welcome:'today',today:'detail',detail:'done',done:'today'},accent:'#bbd6a6',selectedPage:'welcome',selectedElement:'page',
  view:'design',canvasMode:'overview',device:'mobile',zoom:.58,inspectorTab:'design',revision:3,history:[],candidate:null,
  undo:[],redo:[],theme:'light',empty:false,styleChoice:'#bbd6a6',styleLocks:{layout:true,copy:true},
};
/** 启动时读取独立缓存；异常或过期结构保持种子示例可用。 */
function loadState() {
  try {
    /** 仅接受本原型写入的版本，防止无效缓存破坏工作台。 */
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (saved && saved.format === 1 && Array.isArray(saved.pages) && saved.pages.length <= 30 && saved.pages.every(page => typeof page.id === 'string' && typeof page.name === 'string' && typeof page.title === 'string' && typeof page.cta === 'string')) {
      state = {...state,...saved,undo:[],redo:[],view:'design',selectedElement:'page',inspectorTab:'design'};
      if (!/^#[0-9a-f]{6}$/i.test(state.accent)) state.accent = '#bbd6a6';
      if (!state.pages.some(page => page.id === state.selectedPage)) state.selectedPage = state.pages[0]?.id || 'welcome';
      if (!Array.isArray(state.history)) state.history = [];
    }
  } catch { /* 私密浏览或失效缓存不阻止原型体验。 */ }
}
/** 提取一个可恢复的内容快照，不把选择态、面板状态和撤销栈作为业务版本。 */
function snapshot() { return clone({title:state.title,brief:state.brief,pages:state.pages,links:state.links,accent:state.accent,device:state.device,empty:state.empty}); }
/** 保存示例状态并展示真实存储结果；写入失败仅保留内存。 */
function persist() {
  try {
    localStorage.setItem(storageKey, JSON.stringify({...state,format:1,undo:[],redo:[]}));
    $('#save-status').innerHTML = '<i class="status-dot"></i>已保存到本机浏览器';
  } catch { $('#save-status').textContent = '仅在本次页面中保存'; }
}
/** 记录撤销基线；每次内容修改只占一个步骤，最多保留 30 步。 */
function checkpoint() { state.undo.push(snapshot()); state.undo = state.undo.slice(-30); state.redo = []; }
/** 内容变更后创建历史快照、递增版本并刷新；输入面向人的修改说明。 */
function commitChange(description, author = '手动编辑') {
  if (!state.pages.some(page => page.id === state.selectedPage)) { state.selectedPage = state.pages[0]?.id || 'welcome'; state.selectedElement = 'page'; }
  state.revision += 1;
  state.history.unshift({id:state.revision,title:description,author,time:'刚刚',snapshot:snapshot()});
  state.history = state.history.slice(0,30);
  persist(); render();
}
/** 保留最近提示的计时器，连续操作时不会被旧计时器提前关闭。 */
let toastTimer;
/** 显示一次非阻塞提示；输入提示文字，无返回值。 */
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3500); }
/** 取当前页；空原型返回种子页仅供无副作用的文案展示。 */
function currentPage() { return state.pages.find(page => page.id === state.selectedPage) || state.pages[0] || clone(seedPages[0]); }
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

/** 更新整个工作台；所有视图共用同一份内容数据和选择身份。 */
function render() {
  document.documentElement.dataset.theme = state.theme;
  $('#prototype-title').innerHTML = `${escapeHtml(state.title)} <span class="tag">v${state.revision}</span>`;
  $('#prototype-subtitle').textContent = state.empty ? '从一个清晰的用户目标开始' : '拾光 · 从第一次打开，到养成一个小习惯';
  $('#version-count').textContent = state.history.length;
  $('#page-count').textContent = state.pages.length;
  $('.prototype-link span:nth-child(2)').innerHTML = `${escapeHtml(state.title)}<small>${state.pages.length} 个页面 · 当前方案</small>`;
  document.querySelectorAll('[data-view]').forEach(button => { button.classList.toggle('active', button.dataset.view===state.view); button.setAttribute('aria-selected',String(button.dataset.view===state.view)); });
  ['design','flow','versions'].forEach(view => { $(`#view-${view}`).hidden = view!==state.view; });
  renderPages(); renderCanvas(); renderInspector(); renderFlow(); renderVersions(); renderCandidate();
  $('#undo-button').disabled = state.undo.length===0; $('#redo-button').disabled = state.redo.length===0;
  $('#device-button').innerHTML = `${icon(state.device==='mobile'?'phone':'desktop')}<span class="device-label">${state.device==='mobile'?'手机':'桌面'}</span>${icon('chevron-down')}`;
  document.querySelectorAll('[data-canvas-mode]').forEach(button => { button.classList.toggle('active',button.dataset.canvasMode===state.canvasMode); button.setAttribute('aria-pressed',String(button.dataset.canvasMode===state.canvasMode)); });
  $('#selection-reference').innerHTML = `${icon('cursor')} ${escapeHtml(currentPage().name)} / ${elementName(state.selectedElement)} · v${state.revision}`;
  hydrateIcons();
}
/** 把受控元素键映射为用户可读名称。 */
function elementName(element) { return ({page:'整页',title:'主标题',subtitle:'说明文字',cta:'主要操作'})[element] || '整页'; }
/** 渲染轻量页面导航；当前页和入口页均由稳定 ID 判定。 */
function renderPages() {
  $('#page-list').innerHTML = state.pages.map((page,index)=>`<button class="page-item${page.id===state.selectedPage?' active':''}" data-select-page="${escapeHtml(page.id)}" aria-pressed="${page.id===state.selectedPage}"><span class="thumb thumb-${escapeHtml(page.id)}" aria-hidden="true"><i class="thumb-line"></i><i class="thumb-line"></i><i class="thumb-block"></i><i class="thumb-line"></i></span><span><span class="page-name">${String(index+1).padStart(2,'0')} ${escapeHtml(page.name)}</span><span class="page-detail">${page.id==='welcome'?'流程入口':escapeHtml(page.role)}</span></span></button>`).join('');
}
/** 生成总览或单页；空原型提供可执行的生成入口。 */
function renderCanvas() {
  if (state.empty || !state.pages.length) {
    $('#artboard-strip').innerHTML = `<div class="empty-view" style="width:100%"><span>${icon('layout')}</span><h2>先把想法，变成第一条流程</h2><p>告诉 Agent 谁会使用、要完成什么任务。<br>从页面结构开始，再细化每一个操作。</p><div class="row"><button class="primary" data-action="generate">${icon('sparkles')}生成示例原型</button><button class="button" data-action="restore-sample">打开示例</button></div><span class="empty-state-label">原型演示将生成「拾光」四页示例</span></div>`;
    return;
  }
  /** 总览只决定可见页面集合，不改变页面内容或实际设备布局。 */
  const visible = state.canvasMode==='single' ? [currentPage()] : state.pages;
  $('#artboard-strip').innerHTML = visible.map((page,index)=>`<article class="artboard${page.id===state.selectedPage?' active':''}${state.device==='desktop'?' desktop':''}" data-board="${escapeHtml(page.id)}" style="--board-scale:${state.zoom}"><div class="artboard-label"><span>${String(state.pages.indexOf(page)+1).padStart(2,'0')}</span><b>${escapeHtml(page.name)}</b>${page.id==='welcome'?'<span class="entry-tag">入口</span>':''}</div><div class="artboard-shell" tabindex="0" role="group" aria-label="${escapeHtml(page.name)}画板" data-select-page="${escapeHtml(page.id)}">${screenHtml(page)}</div><div class="artboard-foot"><span>${state.device==='mobile'?'390 × 844':'900 × 620'}</span><span>${icon('flow')} ${state.links[page.id]?'1 个页面动作':'尚未连接'}</span></div></article>`).join('');
  $('#zoom-label').textContent = `${Math.round(state.zoom*100)}%`;
}
/** 按当前页或元素展示允许修改的属性；任意源码不伪装为可编辑组件树。 */
function renderInspector() {
  /** 当前选中的明确业务对象，用来决定属性字段与引用范围。 */
  const page = currentPage();
  /** 属性区只支持预先登记的字段，与原型内容共用同一事实源。 */
  const propertyKey = state.selectedElement==='page'?'name':state.selectedElement;
  $('#inspector').innerHTML = `<div class="inspector-tabs"><button class="${state.inspectorTab==='design'?'active':''}" data-inspector-tab="design">设计</button><button class="${state.inspectorTab==='interaction'?'active':''}" data-inspector-tab="interaction">交互</button><span class="flex-spacer"></span><button class="icon-button drawer-close" data-action="close-drawers" aria-label="关闭属性面板">${icon('close')}</button></div>${state.empty?`<div class="empty-selection">${icon('cursor')}<p>创建页面后，即可编辑内容与行为。</p></div>`:`<section class="inspector-section"><div class="eyebrow">当前选择</div><h3>${escapeHtml(page.name)}<span class="property-type">${elementName(state.selectedElement)}</span></h3><div class="element-list">${['page','title','subtitle','cta'].map(element=>`<button class="element-item${state.selectedElement===element?' active':''}" data-select-element="${element}">${icon(element==='page'?'layout':element==='cta'?'cursor':'type')}${elementName(element)}</button>`).join('')}</div></section>${state.inspectorTab==='design'?`<section class="inspector-section"><h3>内容</h3><label class="property-label" for="property-input">${state.selectedElement==='page'?'页面名称':elementName(state.selectedElement)}</label><input class="property-input" id="property-input" maxlength="90" data-property="${propertyKey}" value="${escapeHtml(page[propertyKey])}" aria-label="${state.selectedElement==='page'?'页面名称':'元素内容'}"><div class="property-row"><span class="muted">设备</span><span class="property-value">${state.device==='mobile'?'手机 · 390 × 844':'桌面 · 900 × 620'}</span></div><div class="property-row"><span class="muted">布局</span><span class="property-value">自适应内容</span></div></section><section class="inspector-section"><h3>设计风格<button class="text-button" data-action="style">探索 ${icon('arrow-up-right')}</button></h3><div class="property-row"><span class="muted">主题色</span><span class="property-value"><i class="mini-swatch" style="background:${state.accent}"></i>${state.accent.toUpperCase()}</span></div><div class="color-options">${['#bbd6a6','#a8c4dc','#d7b8a4','#c3b6db'].map(color=>`<button class="color-option${state.accent===color?' active':''}" style="--swatch:${color}" data-color="${color}" aria-label="设置主题色 ${color}"></button>`).join('')}</div><div class="property-row"><span class="muted">字体</span><span class="property-value">系统字体 · 中文优先</span></div><p class="inspector-hint">风格影响全部页面；文字和页面结构保持独立。</p></section>`:`<section class="inspector-section"><h3>点击行为<span class="tag">1</span></h3><div class="action-card">${icon('cursor')}<span>主要操作 → 跳转页面</span></div><div class="property-row"><span class="muted">目标</span><button class="text-button" data-action="edit-link">${escapeHtml(state.pages.find(item=>item.id===state.links[page.id])?.name||'未设置')}${icon('chevron-down')}</button></div><p class="inspector-hint">演示模式点击执行；编辑模式点击选中元素。</p></section>`}<section class="inspector-section"><h3>页面状态</h3><div class="state-options">${[['normal','正常'],['empty','空'],['loading','加载'],['error','错误']].map(([key,label])=>`<button class="${page.state===key?'active':''}" data-page-state="${key}" aria-pressed="${page.state===key}">${label}</button>`).join('')}</div></section><section class="inspector-section"><button class="button full-width" data-action="ask-agent">${icon('sparkles')}让 Agent 修改选中内容</button><p class="inspector-hint">携带页面、元素和版本回到主会话，修改结果先生成候选。</p></section>`}`;
}
/** 流程视图基于实际链接生成，修改目标后地图、表格和演示同步更新。 */
function renderFlow() {
  /** 从实际入口沿主要操作遍历，循环返回边作为末端文字显示。 */
  const flowPages = [];
  /** 已访问页面用于有界检测返回边。 */
  const visited = new Set();
  /** 当前流程节点始终从稳定页面 ID 解析。 */
  let flowPage = state.pages.find(page => page.id === 'welcome') || state.pages[0];
  while (flowPage && !visited.has(flowPage.id)) { flowPages.push(flowPage); visited.add(flowPage.id); flowPage = state.pages.find(page => page.id === state.links[flowPage.id]); }
  $('#view-flow').innerHTML = state.empty ? `<div class="empty-view"><span>${icon('flow')}</span><h2>还没有页面流程</h2><p>生成页面后，在这里连接主要操作。</p><button class="primary" data-action="home">开始设计</button></div>` : `<div class="section-intro"><div><div class="eyebrow">用户旅程</div><h2>首次使用与打卡</h2><p>从欢迎页开始，找到习惯、完成打卡，再回到今日概览。</p></div><button class="primary compact" data-action="play">${icon('play')}演示流程</button></div><div class="flow-map">${flowPages.map((page,index)=>`<button class="flow-node" data-open-page="${escapeHtml(page.id)}"><span class="flow-index">${String(index+1).padStart(2,'0')} ${page.id==='welcome'?'· 入口':''}</span><strong>${escapeHtml(page.name)}</strong><p>${escapeHtml(page.role)}</p></button>${index<flowPages.length-1?`<span class="flow-connector">${icon('arrow-right')}</span>`:state.links[page.id]?`<span class="flow-connector">${icon('arrow-right')}<br>${escapeHtml(state.pages.find(item=>item.id===state.links[page.id])?.name||'未连接')}</span>`:''}`).join('')}</div><div class="flow-table"><div class="flow-table-row header"><span>所在页面</span><span>触发操作</span><span>跳转到</span><span></span></div>${state.pages.map(page=>`<div class="flow-table-row"><span>${escapeHtml(page.name)}</span><span class="muted">${escapeHtml(page.cta)}</span><span>${escapeHtml(state.pages.find(item=>item.id===state.links[page.id])?.name||'未连接')}</span><button class="text-button" data-edit-link="${escapeHtml(page.id)}">修改 ${icon('chevron-right')}</button></div>`).join('')}</div><div class="review-panel"><span>${icon('sparkles')}</span><div><h3>检查关键路径</h3><p>先检查页面连接是否完整，再由 Agent 评审文案和状态。<br>此原型真实检查本地连接；设计评审结果为示例。</p><div id="review-results" class="review-results" hidden></div></div><button class="button compact" data-action="review" id="review-button">运行检查</button></div>`;
}
/** 展示可恢复版本；每条恢复都创建新版本，不删除旧历史。 */
function renderVersions() {
  $('#view-versions').innerHTML = `<div class="section-intro"><div><div class="eyebrow">设计历程</div><h2>每一次调整，都可以回看</h2><p>手动修改和采纳的 Agent 候选，记录在同一条版本历史中。</p></div><span class="tag">当前 v${state.revision}</span></div>${state.history.length?state.history.map((version,index)=>`<article class="version-row"><span class="version-symbol">${icon(version.author.includes('Agent')?'sparkles':'history')}</span><div class="version-copy"><strong>v${version.id} · ${escapeHtml(version.title)}</strong>${index===0?' <span class="tag">当前</span>':''}<p>${version.snapshot.pages.length} 个页面 · ${escapeHtml(version.author)}</p><small>${escapeHtml(version.time)}${version.id<=3?' · 示例历史':''}</small></div><div class="version-actions"><button class="button compact" data-compare-version="${version.id}">查看差异</button>${index>0?`<button class="text-button" data-restore-version="${version.id}">恢复</button>`:''}</div></article>`).join(''):'<div class="empty-view"><p>第一次编辑后会在这里留下版本。</p></div>'}`;
}
/** 候选基线与当前版本不一致时只允许查看或丢弃，不提供覆盖入口。 */
function renderCandidate() {
  $('#candidate-banner').hidden = !state.candidate;
  if (!state.candidate) return;
  /** 迟到或基线变更由精确版本号判定，模拟与正式设计采用同一业务规则。 */
  const stale = state.candidate.baseRevision !== state.revision;
  $('#candidate-banner').innerHTML = `${icon(stale?'warning':'sparkles')}<span class="candidate-copy">${stale?'候选基于旧版本，当前页面已有新修改':'Agent 有一份修改候选'}<small>仅调整「习惯详情」的按钮文案 · 演示</small></span><button class="button compact" data-action="compare-candidate">查看差异</button><button class="text-button" data-action="discard-candidate">丢弃</button>`;
}

/** 对话框上次焦点，关闭后返回发起操作的元素。 */
let lastModalFocus;
/** 打开通用对话框；输入标题、HTML 正文、宽屏标志。 */
function openModal(title, body, wide = false, eyebrow = '交互设计') {
  lastModalFocus = document.activeElement;
  $('#modal-title').textContent = title; $('#modal-eyebrow').textContent = eyebrow;
  $('#modal-body').innerHTML = body; $('#modal').classList.toggle('dialog-wide',wide);
  if (!$('#modal').open) $('#modal').showModal();
  hydrateIcons($('#modal'));
}
/** 关闭普通对话框并恢复焦点。 */
function closeModal() { $('#modal').close(); if (lastModalFocus?.isConnected) lastModalFocus.focus(); }
/** 独立的业务定义视图，解释输入、产物、Agent 效果和阶段边界。 */
function showDefinition() {
  openModal('交互设计模块的业务定义', `<div class="definition-lead">把一个产品想法，变成<br>可以亲手验证的使用体验。</div><p>服务独立开发者、产品和设计人员。围绕当前项目管理多个原型，把需求、页面、交互流程、版本与交接依据放在一起。</p><div class="definition-steps"><span>描述需求</span>→<span>生成页面</span>→<span>局部迭代</span>→<span>演示验证</span>→<span>版本交接</span></div><div class="definition-grid"><div class="definition-block"><h3>输入什么</h3><p>用户目标、业务流程、品牌约束、参考页面，以及明确授权的项目资料。</p></div><div class="definition-block"><h3>交付什么</h3><p>可运行的原型、页面与状态说明、采纳的版本，以及已验证和待验证的路径。</p></div></div><h3>Agent 辅助能达到什么效果</h3><div class="capability-list"><div class="capability-row"><strong>拆解需求</strong><p>把“做一个习惯 App”拆成页面、入口、主要路径和边界状态，先暴露缺失信息。</p></div><div class="capability-row"><strong>生成可用草稿</strong><p>生成真实 HTML 页面与模拟数据，让按钮、表单、Tab 和弹窗能实际操作。</p></div><div class="capability-row"><strong>理解选中内容</strong><p>用户选中按钮后说“更明确一点”，Agent 获得精确元素引用，返回有范围的修改候选。</p></div><div class="capability-row"><strong>探索设计方向</strong><p>锁定结构和文案，比较色彩、字体等方向；选定后批量应用到相关页面。</p></div><div class="capability-row"><strong>检查关键路径</strong><p>检查断链、遗漏状态和可读性；真实执行的结果绑定具体版本，未测路径明确保留。</p></div><div class="capability-row"><strong>形成开发交接</strong><p>整理页面、资源、行为和设计约束，为后续实现提供依据；生产接口、原生 App 与发布仍需独立工程验证。</p></div></div><div class="warning-note">第一版采用“AI 生成页面 + 明确字段可视化调整”。任意 HTML 的全量双向组件编辑、真实多人协作和生产级后端接入属于后续独立能力。</div><p class="dialog-note">本演示：页面操作、属性修改、历史恢复和 HTML 导出真实生效；Agent 生成、候选内容与设计评审为预设模拟。</p><a class="definition-link" href="../../superpowers/specs/2026-10-14-interaction-design-module.md" target="_blank" rel="noopener">阅读完整业务定义与验收标准 ↗</a>`,true,'产品定义 · 设计提案');
}
/** 展示四个明确的风格候选，保留布局和文案锁定约束。 */
function showStyles() {
  state.styleChoice = state.accent;
  openModal('保留结构，探索另一种感觉', `<p>比较主题色方向，页面内容和交互流程保持一致。此原型展示四套固定配色候选。</p><div class="lock-row"><span>已锁定</span><span class="tag">${icon('lock')}页面结构</span><span class="tag">${icon('lock')}文案与交互</span></div><div class="style-grid">${[['#bbd6a6','#f4f7ee','#344931','自然留白','温和 · 日常'],['#a8c4dc','#f0f4f8','#304b62','清晨蓝调','清爽 · 专注'],['#d7b8a4','#f8f2ec','#685343','暖纸手记','亲近 · 安静'],['#c3b6db','#f4f0f8','#514765','暮色时分','柔和 · 从容']].map(([accent,bg,ink,name,detail])=>`<button class="style-card${state.accent===accent?' selected':''}" data-style-choice="${accent}" aria-pressed="${state.accent===accent}"><span class="style-preview" style="--style-bg:${bg};--style-ink:${ink};--style-accent:${accent}"><strong>把小事，<br>变成日常。</strong><span></span><i></i></span><span class="style-name">${name}<small>${detail}</small></span></button>`).join('')}</div><div class="dialog-actions"><button class="button" data-action="close-modal">取消</button><button class="primary" data-action="apply-style">应用到全部页面</button></div>`,true,'风格探索');
}
/** 比较旧稿与新稿的按钮、色彩和页面差异，动作由调用方决定。 */
function comparisonBody(before, after, footer = '') {
  /** 从两个内容快照选择同一页面，避免把不同页面误认为同版本差异。 */
  const oldPage = before.pages.find(page=>page.id==='detail') || before.pages[0] || seedPages[2];
  /** 新增页面时允许没有旧身份，但展示始终明确。 */
  const newPage = after.pages.find(page=>page.id===oldPage.id) || after.pages[0] || seedPages[2];
  return `<div class="compare-grid">${[[before,oldPage,'修改前'],[after,newPage,'修改后']].map(([content,page,label])=>`<div class="compare-card"><div class="compare-label">${label}</div><div class="compare-content"><h3>${escapeHtml(page.title)}</h3><p>${escapeHtml(page.subtitle)}</p><div class="compare-cta" style="--compare-accent:${content.accent}">${escapeHtml(page.cta)}</div></div></div>`).join('')}</div><div class="change-item">${icon('check')}<span>${oldPage.cta===newPage.cta?'主要操作文案保持一致':`按钮文案：${escapeHtml(oldPage.cta)} → ${escapeHtml(newPage.cta)}`}</span></div><div class="change-item">${icon('palette')}<span>主题色：${before.accent===after.accent?'保持一致':`${before.accent} → ${after.accent}`}</span></div><div class="change-item">${icon('layers')}<span>页面数量：${before.pages.length} → ${after.pages.length}；版本恢复会恢复整份原型内容。</span></div>${footer}`;
}
/** 打开 Agent 候选比较；过时候选禁用采纳并保留当前工作。 */
function compareCandidate() {
  if (!state.candidate) return;
  /** 当前内容版本变化后，候选无法再安全应用。 */
  const stale = state.candidate.baseRevision!==state.revision;
  openModal('只调整这一次操作的表达',`<p>候选来源：主会话 · 预设模拟结果。基于 v${state.candidate.baseRevision}，当前 v${state.revision}。</p>${comparisonBody(state.candidate.before,state.candidate.after)}${stale?'<div class="warning-note">当前页面已有新修改。这份候选只能查看，请丢弃后基于当前版本重新发起。</div>':''}<div class="dialog-actions"><button class="button" data-action="discard-candidate">丢弃候选</button><button class="primary" data-action="adopt-candidate" ${stale?'disabled':''}>采纳为新版本</button></div>`,false,'Agent 修改候选');
}
/** 把页面选择带回已有主会话，不新建模块内聊天。 */
function showAgent() {
  $('#conversation').hidden = false; closeDrawers();
  $('#agent-input').value = state.selectedElement==='cta' ? `将「${currentPage().cta}」改得更明确，保持页面结构。` : `细化「${currentPage().name}」的操作文案，保留当前页面结构。`;
  $('#agent-input').focus();
}
/** 主会话任务代次，取消、重建原型或新请求后丢弃迟到的模拟结果。 */
let agentGeneration = 0;
/** 生成可检查的预设候选；保存基线，不直接覆盖页面。 */
function runAgent(event) {
  event.preventDefault();
  if (state.empty || !state.pages.some(page=>page.id==='detail')) { toast('先生成示例页面，再体验局部修改。'); return; }
  /** 冻结用户提交时的版本和内容，用于之后的过时校验。 */
  const before = snapshot();
  /** 版本身份不会随着用户继续编辑而变化。 */
  const baseRevision = state.revision;
  /** 请求身份隔离取消后的迟到计时器。 */
  const generation = ++agentGeneration;
  $('#messages').insertAdjacentHTML('beforeend',`<div class="chat-user">${escapeHtml($('#agent-input').value || '优化这次操作的文案')}</div><div class="message-result" id="agent-progress"><span class="busy-dot"></span> 正在准备修改候选…<p class="chat-meta">模拟任务 · 基于 v${baseRevision}</p><button class="text-button" data-action="cancel-agent">取消生成</button></div>`);
  $('#agent-send').disabled = true; $('#messages').scrollTop = $('#messages').scrollHeight;
  setTimeout(() => {
    if (generation!==agentGeneration) return;
    /** 候选仅修改示例详情页按钮，其他页面与用户基线保持一致。 */
    const after = clone(before); after.pages.find(page=>page.id==='detail').cta = '完成今日阅读';
    state.candidate = {baseRevision,before,after};
    $('#agent-progress')?.remove();
    $('#messages').insertAdjacentHTML('beforeend',`<div class="message-result"><strong>${icon('sparkles')} 修改候选已就绪</strong>将「立即打卡」调整为「完成今日阅读」。页面结构与跳转关系保持一致。<div class="chat-meta">预设模拟 · ${baseRevision===state.revision?'等待采纳':'基线已过时'}</div><button class="button compact" data-action="compare-candidate">查看差异</button></div>`);
    $('#agent-send').disabled = false; persist(); render(); $('#messages').scrollTop = $('#messages').scrollHeight;
  },1100);
}

/** 演示运行态独立于设计稿；重置演示不会改变设计版本。 */
let playerState = {page:'welcome',completed:false,path:['welcome'],resolved:[],subview:null};
/** 启动真实本地演示，优先从固定入口页开始。 */
function startPlayer() {
  if (state.empty || !state.pages.length) { toast('先创建页面，再开始演示。'); return; }
  playerState = {page:state.pages.find(page=>page.id==='welcome')?.id || state.pages[0].id,completed:false,path:[],resolved:[],subview:null};
  playerState.path.push(playerState.page); renderPlayer(); $('#player').showModal();
}
/** 根据窗口尺寸限制演示画板，页面滚动与弹窗焦点由浏览器原生管理。 */
function renderPlayer() {
  /** 演示使用内容副本，临时加载成功和输入状态不写回设计稿。 */
  const page = clone(state.pages.find(item=>item.id===playerState.page) || state.pages[0]);
  if (playerState.resolved.includes(page.id)) page.state = 'normal';
  /** 预览缩放同时受窗口高宽约束，确保手机和窄屏均可点击底部按钮。 */
  const scale = state.device==='desktop' ? Math.min(.78,(window.innerWidth-70)/900,(window.innerHeight-190)/620) : Math.min(.70,(window.innerWidth-58)/390,(window.innerHeight-190)/844);
  $('#player-screen').className = `player-screen-wrapper${state.device==='desktop'?' desktop-player':''}`;
  $('#player-screen').style.setProperty('--player-scale',String(Math.max(.25,scale)));
  $('#player-screen').innerHTML = screenHtml(page,playerState,false);
  if (playerState.subview) {
    $('#player-screen .app-body').innerHTML = `<div class="app-top-nav"><button class="app-back" data-app-action="today" aria-label="返回今日习惯">${icon('chevron-left')}</button><span>${playerState.subview==='records'?'习惯记录':'我的设置'}</span></div><h2 class="app-title">${playerState.subview==='records'?'一点点的累积':'阿光的日常'}</h2><p class="app-description">${playerState.subview==='records'?`阅读已连续 ${playerState.completed?'8':'7'} 天，今天完成 ${playerState.completed?'2':'1'} 项习惯。`:'按照自己的节奏，留一点时间给自己。'}</p><div class="app-bottom"><button class="app-button" data-app-action="today">回到今日习惯</button></div>`;
  }
  $('#player-path').innerHTML = state.pages.map(item=>`<li class="${playerState.path.includes(item.id)?'visited ':''}${item.id===playerState.page?'current':''}">${escapeHtml(item.name)}<small>${item.id===playerState.page?'当前页面':playerState.path.includes(item.id)?'已访问':'尚未访问'}</small></li>`).join('');
  $('#player-state').innerHTML = `今日完成 <strong>${playerState.completed?'2':'1'} / 3</strong><br><small>${playerState.completed?'阅读打卡已写入本次演示状态':'阅读习惯尚未打卡'}</small>`;
  $('#player-page-label').textContent = `${page.name} · ${state.device==='mobile'?'手机':'桌面'}预览`;
}
/** 执行演示操作；跳转结果只依据当前受控流程定义。 */
function runAppAction(action, source) {
  if (action==='next') {
    /** 路由目标来自当前设计版本；断链显式反馈而非静默成功。 */
    const target = state.links[source || playerState.page];
    if (!state.pages.some(page=>page.id===target)) { toast('这个操作还没有连接目标页面。'); return; }
    if (source==='detail' && target==='done') playerState.completed = true;
    playerState.page = target; playerState.subview = null; playerState.path.push(target);
  } else if (action==='today') { playerState.page='today'; playerState.subview=null; playerState.path.push('today'); }
  else if (action==='resolve') playerState.resolved.push(playerState.page);
  else if (action==='records' || action==='profile') playerState.subview = action;
  renderPlayer();
}
/** 添加或修改链接时使用可键盘选择的选项对话框。 */
function editLink(source = state.selectedPage) {
  openModal('点击后，前往哪一页？',`<p>来源：${escapeHtml(state.pages.find(page=>page.id===source)?.name||'当前页')} · 主要操作</p><div class="choice-list">${state.pages.map(page=>`<button class="choice-button${state.links[source]===page.id?' active':''}" data-link-source="${escapeHtml(source)}" data-link-target="${escapeHtml(page.id)}">${icon('layout')}<span><strong>${escapeHtml(page.name)}</strong><small>${escapeHtml(page.role)}</small></span>${state.links[source]===page.id?icon('check'):icon('chevron-right')}</button>`).join('')}</div>`);
}
/** 检查页面链接和入口可达性；设计评审部分明确标注为示例。 */
function runReview() {
  $('#review-results').hidden = false;
  /** 页面 ID 集合用于验证每一条跳转的真实目标。 */
  const ids = new Set(state.pages.map(page=>page.id));
  /** 无目标或目标被删除的链接会生成可定位问题。 */
  const broken = state.pages.filter(page=>!ids.has(state.links[page.id]));
  /** 有界遍历入口路径，避免返回边造成无限循环。 */
  const visited = new Set();
  /** 当前遍历游标，仅检查本原型显式登记的主要操作。 */
  let cursor = ids.has('welcome')?'welcome':state.pages[0]?.id;
  while (ids.has(cursor) && !visited.has(cursor)) { visited.add(cursor); cursor = state.links[cursor]; }
  /** 未到达的页面仍可保留，但不能报告关键流程覆盖。 */
  const unreachable = state.pages.filter(page=>!visited.has(page.id));
  $('#review-results').innerHTML = `<div class="${broken.length?'':'success'}">${icon(broken.length?'warning':'check')}<span>本地连接检查：${broken.length?`${broken.length} 个页面未连接目标（${broken.map(page=>escapeHtml(page.name)).join('、')}）`:`${state.pages.length} 个页面目标均有效`}</span></div><div class="${unreachable.length?'':'success'}">${icon(unreachable.length?'warning':'check')}<span>入口可达性：${visited.size}/${state.pages.length}${unreachable.length?`，未覆盖 ${unreachable.map(page=>escapeHtml(page.name)).join('、')}`:''}</span></div><div>${icon('sparkles')}<span>Agent 评审示例：建议让打卡按钮明确说明完成哪一项习惯。</span></div><div class="muted tiny">检查对象 v${state.revision} · 仅校验登记的链接，实际点击与视觉质量需进入演示验收。</div>`;
}
/** 关闭窄面板抽屉；遮罩仅在确实展示抽屉时出现。 */
/** 抽屉触发器在关闭时恢复键盘焦点，避免焦点遗留在隐藏控件。 */
let drawerTrigger = null;
function closeDrawers() {
  /** 仅抽屉确实打开时恢复触发器，避免普通导航意外抢焦点。 */
  const hadOpenDrawer = Boolean(document.querySelector('.drawer-open'));
  $('#pages-panel').classList.remove('drawer-open'); $('#inspector').classList.remove('drawer-open'); $('#drawer-scrim').hidden = true;
  if (hadOpenDrawer && drawerTrigger?.isConnected) drawerTrigger.focus();
}

/** 打开指定属性或页面抽屉，互斥展示并移动到首个可操作控件。 */
function toggleDrawer(selector) { const wasOpen = $(selector).classList.contains('drawer-open'); closeDrawers(); if (!wasOpen) { drawerTrigger=document.activeElement; $(selector).classList.add('drawer-open'); $('#drawer-scrim').hidden=false; $(selector).querySelector('button')?.focus(); } }

/** 导出当前原型：嵌入全部样式、当前文字与链接，独立 HTML 可离线运行。 */
function exportPrototype() {
  if (state.empty || !state.pages.length) { toast('先创建页面，再导出原型。'); return; }
  /** 同源样式可直接序列化，导出文件不依赖开发服务或网络资源。 */
  const css = Array.from(document.styleSheets).map(sheet => { try { return Array.from(sheet.cssRules).map(rule=>rule.cssText).join('\n'); } catch { return ''; } }).join('\n');
  /** 导出镜像仅包含演示所需的路由，避免把工作台缓存或会话混入交付物。 */
  const links = JSON.stringify(state.links).replace(/</g,'\\u003c');
  /** 生成独立页容器，保留每页的真实按钮。 */
  const pages = state.pages.map((page,index)=>`<section data-export-page="${escapeHtml(page.id)}"${index?' hidden':''}>${screenHtml(page,{completed:false},false)}</section>`).join('');
  /** 导出脚本处理页面跳转和本地反馈，明确不连接真实后台。 */
  const script = `const links=${links};let completed=false;function show(id){document.querySelectorAll('[data-export-page]').forEach(p=>p.hidden=p.dataset.exportPage!==id);document.querySelectorAll('.element-selected').forEach(n=>n.classList.remove('element-selected'));}document.addEventListener('click',e=>{const b=e.target.closest('[data-app-action]');if(!b)return;const a=b.dataset.appAction;const source=b.dataset.source;if(a==='next'){const target=links[source];if(!document.querySelector('[data-export-page="'+target+'"]')){alert('此操作尚未连接目标页面');return;}if(source==='detail'&&target==='done'){completed=true;document.querySelectorAll('[data-export-page="today"] .progress-circle strong').forEach(n=>n.textContent='2 / 3');document.querySelectorAll('[data-export-page="done"] .streak-card strong').forEach(n=>n.textContent='8');document.querySelectorAll('[data-export-page="today"] .habit-icon.reading + .habit-copy small').forEach(n=>n.textContent='今日已完成 · 连续 8 天');}show(target);}else if(a==='today'){show('today');}else if(a==='records'){alert('示例记录：阅读连续 '+(completed?'8':'7')+' 天');}else if(a==='profile'){alert('示例账户：阿光');}else if(a==='resolve'){alert('此文件保留设计稿中的边界状态；请在工作台切换为正常状态后导出。');}});document.querySelectorAll('.element-selected').forEach(n=>n.classList.remove('element-selected'));`;
  /** 文件标题和页面内容已转义，源码结束标签单独拼接避免嵌入歧义。 */
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(state.title)} · 交互原型</title><style>${css}\nhtml,body{overflow:auto;height:auto;min-height:100%;background:#edf0e9;color:#25352b}body{display:flex;flex-direction:column;align-items:center;padding:18px 10px}.export-note{font-size:11px;margin:0 0 12px;color:#6e7b66}.screen{box-shadow:0 12px 48px #25352b18;max-width:calc(100vw - 20px)}.screen.editing [data-element]{outline:none}.element-selected{outline:none!important}@media(max-width:430px){body{padding:12px 0}.screen{width:100vw;max-width:none;border-radius:0}.desktop-screen{zoom:.42}}</style></head><body><p class="export-note">${escapeHtml(state.title)} · v${state.revision} · 演示原型 / 模拟数据</p>${pages}<script>${script}</scr`+`ipt></body></html>`;
  /** 浏览器下载链接在触发后延迟释放，确保文件完整交付。 */
  const url = URL.createObjectURL(new Blob([html],{type:'text/html;charset=utf-8'}));
  /** 原型文件名使用固定安全前缀，避免用户名称中的路径字符。 */
  const anchor = document.createElement('a'); anchor.href=url; anchor.download=`shiguang-prototype-v${state.revision}.html`; anchor.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
  toast('已导出可独立打开的 HTML 演示原型。');
}

/** 新建原型对话框；提交仅重置当前演示数据，不接触真实项目。 */
function newPrototypeDialog() {
  openModal('从一个用户目标开始',`<p>先确定用户想完成的任务，Agent 再把它拆成页面与关键路径。</p><form id="new-prototype-form" class="intro-form"><div><label class="form-field" for="new-title">原型名称</label><input id="new-title" required maxlength="50" value="我的新原型"></div><div><label class="form-field" for="new-brief">希望用户完成什么</label><textarea id="new-brief" required placeholder="例如：让新用户找到适合自己的习惯，并完成第一次打卡。"></textarea></div><p class="dialog-note">本原型每次展示一个设计文件。新建会替换当前浏览器示例，可先导出保留；生成使用固定的拾光示例。</p><div class="dialog-actions"><button class="button" type="button" data-action="close-modal">取消</button><button class="primary" type="submit">创建设计文件</button></div></form>`);
}
/** 填充样例页面，模拟由需求到页面的生成过程。 */
function generateSample() {
  /** 模拟任务代次用于停止后的迟到结果隔离。 */
  const generation = ++agentGeneration;
  /** 冻结生成基线；用户期间编辑后不应用迟到结果。 */
  const baseRevision = state.revision;
  $('#artboard-strip').innerHTML = `<div class="empty-view" style="width:100%"><span class="busy-dot"></span><h2>正在准备页面结构</h2><p>示例任务：欢迎 → 今日习惯 → 习惯详情 → 完成反馈</p><button class="button" data-action="cancel-generation">取消生成</button></div>`;
  setTimeout(()=>{ if (generation!==agentGeneration) return; if (baseRevision!==state.revision) { toast('页面已有新修改，本次示例生成未覆盖当前内容。'); render(); return; } checkpoint(); state.pages=clone(seedPages); state.links={welcome:'today',today:'detail',detail:'done',done:'today'}; state.empty=false; state.selectedPage='welcome'; state.candidate=null; commitChange('生成四页习惯养成示例','Agent 生成 · 模拟'); toast('示例页面已生成，可以开始演示和调整。'); },1200);
}
/** 全部显式操作入口；未知操作不给出虚假成功反馈。 */
function handleAction(action) {
  if (action==='home') { state.view='design'; render(); }
  else if (action==='flow') { state.view='flow'; closeDrawers(); render(); }
  else if (action==='definition') showDefinition();
  else if (action==='toggle-focus') $('#app-shell').classList.toggle('focus-mode');
  else if (action==='toggle-chat') $('#conversation').hidden = !$('#conversation').hidden;
  else if (action==='ask-agent') showAgent();
  else if (action==='theme') { state.theme=state.theme==='light'?'dark':'light'; persist(); render(); }
  else if (action==='toggle-pages') toggleDrawer('#pages-panel');
  else if (action==='toggle-inspector') toggleDrawer('#inspector');
  else if (action==='close-drawers') closeDrawers();
  else if (action==='close-modal') closeModal();
  else if (action==='play') startPlayer();
  else if (action==='close-player') $('#player').close();
  else if (action==='player-reset') { $('#player').close(); startPlayer(); }
  else if (action==='export') exportPrototype();
  else if (action==='style') showStyles();
  else if (action==='apply-style') { if (state.styleChoice!==state.accent) { checkpoint(); state.accent=state.styleChoice; commitChange('调整全局主题色'); } closeModal(); toast('主题色已应用到全部页面，可撤销。'); }
  else if (action==='zoom-out' || action==='zoom-in' || action==='zoom-fit') { state.zoom=action==='zoom-fit'?(state.device==='mobile'?.58:.55):Math.min(1,Math.max(.25,state.zoom+(action==='zoom-in'?.08:-.08))); renderCanvas(); }
  else if (action==='device') openModal('选择演示设备',`<p>切换后调整示例页面布局，文字和流程保持一致。</p><div class="choice-list"><button class="choice-button${state.device==='mobile'?' active':''}" data-device="mobile">${icon('phone')}<span><strong>手机 App</strong><small>390 × 844 · 纵向交互</small></span>${icon('chevron-right')}</button><button class="choice-button${state.device==='desktop'?' active':''}" data-device="desktop">${icon('desktop')}<span><strong>桌面 Web</strong><small>900 × 620 · 示例宽屏布局</small></span>${icon('chevron-right')}</button></div>`);
  else if (action==='undo' || action==='redo') {
    /** 撤销与重做交换内容快照，随后产生可追溯的新版本。 */
    const source = action==='undo'?state.undo:state.redo;
    /** 目标栈保存当前内容供反向操作恢复。 */
    const target = action==='undo'?state.redo:state.undo;
    if (!source.length) return;
    target.push(snapshot()); Object.assign(state,source.pop()); commitChange(action==='undo'?'撤销上一次编辑':'重做上一次编辑');
  } else if (action==='compare-candidate') compareCandidate();
  else if (action==='discard-candidate') { state.candidate=null; if ($('#modal').open) closeModal(); persist(); render(); toast('已丢弃候选，当前版本保持不变。'); }
  else if (action==='adopt-candidate') {
    if (!state.candidate || state.candidate.baseRevision!==state.revision) { toast('候选已过时，请基于当前版本重新生成。'); return; }
    checkpoint(); Object.assign(state,clone(state.candidate.after)); state.candidate=null; closeModal(); commitChange('明确阅读打卡按钮文案','Agent 候选 · 已采纳'); toast('已采纳修改，旧版本仍可恢复。');
  } else if (action==='cancel-agent') { agentGeneration+=1; $('#agent-progress')?.remove(); $('#agent-send').disabled=false; toast('已取消生成，页面保持不变。'); }
  else if (action==='edit-link') editLink();
  else if (action==='review') runReview();
  else if (action==='add-page') openModal('添加页面',`<form id="add-page-form"><label for="page-name">页面名称</label><input id="page-name" required maxlength="30" placeholder="例如：习惯设置"><p class="dialog-note">新增页会进入页面列表，可继续编辑内容并连接目标。</p><div class="dialog-actions"><button class="button" type="button" data-action="close-modal">取消</button><button class="primary" type="submit">添加页面</button></div></form>`);
  else if (action==='new-project') newPrototypeDialog();
  else if (action==='generate') generateSample();
  else if (action==='restore-sample') { state.title='习惯养成 App'; generateSample(); }
  else if (action==='cancel-generation') { agentGeneration+=1; render(); toast('生成已取消，可重新开始。'); }
  else if (action==='about') openModal('如何体验这份原型',`<p>① 点击「演示」，完成欢迎 → 今日习惯 → 阅读详情 → 打卡反馈。</p><p>② 返回编辑模式，选中页面里的标题或按钮，在属性栏修改文字，或进入主会话体验 Agent 候选。</p><p>③ 打开「风格探索」比较配色，进入「版本」恢复修改，最后导出独立 HTML。</p><div class="warning-note">真实生效：页面交互、编辑、撤销、版本恢复、本地保存和导出。<br>预设模拟：Agent 生成、修改内容与设计评审。当前示例不连接模型或生产数据。</div><p class="dialog-note">桌面宽度不足时，页面列表与属性面板收进抽屉。支持深浅主题、键盘操作与 Escape 关闭对话框。</p><div class="dialog-actions"><button class="primary" data-action="close-modal">开始体验</button></div>`);
}

/** 页面统一事件委托，保证动态重绘后功能继续可用。 */
document.addEventListener('click',event=>{
  /** 事件命中的元素用于分辨演示、画板选择和宿主动作。 */
  const target = event.target;
  if (!(target instanceof Element)) return;
  /** 演示模式优先处理示例 App 动作，不执行设计面板选择。 */
  const appButton = target.closest('[data-app-action]');
  if (appButton && target.closest('#player')) { runAppAction(appButton.dataset.appAction,appButton.dataset.source); return; }
  /** 编辑模式只选中稳定元素，阻止按钮执行示例业务。 */
  const element = target.closest('#artboard-strip [data-element]');
  if (element) { state.selectedPage=element.dataset.page; state.selectedElement=element.dataset.element; render(); return; }
  /** 通用操作入口全部由显式操作名分发。 */
  const actionButton = target.closest('[data-action]');
  if (actionButton && !actionButton.disabled) { handleAction(actionButton.dataset.action); return; }
  /** 页面导航支持缩略图、画板和流程节点三种入口。 */
  const pageButton = target.closest('[data-select-page],[data-open-page]');
  if (pageButton) { state.selectedPage=pageButton.dataset.selectPage||pageButton.dataset.openPage; state.selectedElement='page'; if (pageButton.dataset.openPage) {state.view='design';state.canvasMode='single';} render(); closeDrawers(); if (state.canvasMode==='overview' && !pageButton.classList.contains('artboard-shell')) $(`[data-board="${state.selectedPage}"]`)?.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'nearest',inline:'center'}); return; }
  /** 以下选项都只接受在原型中声明的枚举或数据身份。 */
  const option = target.closest('[data-view],[data-canvas-mode],[data-inspector-tab],[data-select-element],[data-color],[data-page-state],[data-device],[data-style-choice],[data-link-target],[data-edit-link],[data-compare-version],[data-restore-version]');
  if (!option) return;
  if (option.dataset.view) { state.view=option.dataset.view; closeDrawers(); render(); }
  else if (option.dataset.canvasMode) { state.canvasMode=option.dataset.canvasMode; render(); }
  else if (option.dataset.inspectorTab) { state.inspectorTab=option.dataset.inspectorTab; renderInspector(); }
  else if (option.dataset.selectElement) { state.selectedElement=option.dataset.selectElement; render(); }
  else if (option.dataset.color) { checkpoint(); state.accent=option.dataset.color; commitChange('手动调整全局主题色'); }
  else if (option.dataset.pageState) { checkpoint(); currentPage().state=option.dataset.pageState; commitChange(`切换${currentPage().name}的边界状态`); }
  else if (option.dataset.device) { state.device=option.dataset.device; state.zoom=state.device==='mobile'?.58:.55; closeModal(); persist(); render(); }
  else if (option.dataset.styleChoice) { state.styleChoice=option.dataset.styleChoice; document.querySelectorAll('[data-style-choice]').forEach(button=>{button.classList.toggle('selected',button===option);button.setAttribute('aria-pressed',String(button===option));}); }
  else if (option.dataset.linkTarget) { checkpoint(); state.links[option.dataset.linkSource]=option.dataset.linkTarget; closeModal(); commitChange('调整页面跳转目标'); }
  else if (option.dataset.editLink) editLink(option.dataset.editLink);
  else if (option.dataset.compareVersion) {
    /** 按显式历史 ID 比较同一内容快照。 */
    const version = state.history.find(item=>item.id===Number(option.dataset.compareVersion));
    if (version) openModal(`v${version.id} 与当前版本`,comparisonBody(version.snapshot,snapshot())+`<p class="dialog-note">当前版本 v${state.revision}。比较展示详情页主要操作、主题色和页面数量；恢复会应用整份历史快照。</p>`);
  } else if (option.dataset.restoreVersion) {
    /** 恢复版本创建新的记录，原始历史快照保留。 */
    const version = state.history.find(item=>item.id===Number(option.dataset.restoreVersion));
    if (version) { checkpoint(); Object.assign(state,clone(version.snapshot)); if (!state.pages.some(page=>page.id===state.selectedPage)) state.selectedPage=state.pages[0]?.id||'welcome'; commitChange(`恢复 v${version.id} 的原型内容`); toast(`已恢复 v${version.id}，并保留此前版本。`); }
  }
});
/** 属性输入在提交或失焦时形成一个撤销步骤，输入过程中不重建焦点。 */
document.addEventListener('change',event=>{
  if (event.target instanceof HTMLInputElement && event.target.dataset.property) {
    /** 字段名称来自固定的属性面板，不接受任意对象路径。 */
    const key = event.target.dataset.property;
    if (!['name','title','subtitle','cta'].includes(key)) return;
    /** 名称和按钮必填，其他文案允许清空。 */
    const value = event.target.value;
    if ((key==='name'||key==='cta') && !value.trim()) { event.target.value=currentPage()[key]; toast('页面名称和主要操作不能留空。'); return; }
    if (value===currentPage()[key]) return;
    checkpoint(); currentPage()[key]=value; commitChange(`调整${currentPage().name}的${key==='name'?'名称':elementName(key)}`);
  }
});
/** 表单提交使用浏览器内置必填验证，并在业务边界统一创建新版本。 */
document.addEventListener('submit',event=>{
  if (event.target.id==='agent-form') { runAgent(event); return; }
  if (event.target.id==='add-page-form') {
    event.preventDefault(); if (state.pages.length>=30) { toast('此原型最多演示 30 个页面。'); return; }
    /** 页面名经输入约束和渲染转义；身份用随机 UUID 防止同名冲突。 */
    const name = $('#page-name').value.trim(); if (!name) return;
    /** 新页面使用独立 ID，不以可修改名称作为关系键。 */
    const id = `page-${crypto.randomUUID().slice(0,8)}`;
    checkpoint(); state.pages.push({id,name,role:'自定义页面',title:name,subtitle:'描述这一页帮助用户完成什么。',cta:'返回今日习惯',state:'normal'}); state.links[id]='today'; state.selectedPage=id; state.selectedElement='page'; state.canvasMode='single'; state.empty=false; closeModal(); commitChange(`添加${name}`);
  } else if (event.target.id==='new-prototype-form') {
    event.preventDefault(); checkpoint(); agentGeneration+=1; $('#agent-send').disabled=false;
    state.history=[]; state.undo=[]; state.redo=[]; state.revision=0;
    state.title=$('#new-title').value.trim()||'我的新原型'; state.brief=$('#new-brief').value.trim(); state.pages=[]; state.links={}; state.empty=true; state.candidate=null; state.view='design'; closeModal(); commitChange('新建设计文件');
  }
});
/** Escape 关闭抽屉，撤销快捷键只在非输入区域生效。 */
document.addEventListener('keydown',event=>{
  if (event.key==='Escape') closeDrawers();
  /** 抽屉打开时循环键盘焦点，避免 Tab 到达遮罩背后的操作。 */
  const drawer = document.querySelector('.drawer-open');
  if (event.key==='Tab' && drawer && !$('#modal').open) {
    /** 只包含可见且可操作的焦点目标。 */
    const controls = Array.from(drawer.querySelectorAll('button:not(:disabled),input,textarea,[tabindex="0"]')).filter(control=>control.getClientRects().length);
    /** 首尾边界保持在抽屉内，外部焦点也被重新带回。 */
    const first = controls[0], last = controls[controls.length-1];
    if (first && (!drawer.contains(document.activeElement) || (event.shiftKey && document.activeElement===first) || (!event.shiftKey && document.activeElement===last))) { event.preventDefault(); (event.shiftKey?last:first).focus(); }
  }
  if ((event.metaKey||event.ctrlKey) && event.key.toLowerCase()==='z' && !event.target.matches('input,textarea,[contenteditable]') && !$('#modal').open && !$('#player').open) { event.preventDefault(); handleAction(event.shiftKey?'redo':'undo'); }
  if ((event.key==='Enter'||event.key===' ') && event.target.matches('.artboard-shell')) { event.preventDefault(); state.selectedPage=event.target.dataset.selectPage; state.selectedElement='page'; render(); }
});
/** 点击抽屉外部或原生对话框背景时关闭，不修改数据。 */
$('#drawer-scrim').addEventListener('click',closeDrawers);
$('#modal').addEventListener('click',event=>{ if(event.target===$('#modal')) { const bounds=$('#modal').getBoundingClientRect(); if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom) closeModal(); } });
/** 窗口大小变化只调整演示缩放，设计内容与用户选择保持不变。 */
window.addEventListener('resize',()=>{if($('#player').open) renderPlayer();});

loadState();
/** 首次打开建立三个明确标识的示例历史，便于体验版本比较和恢复。 */
if (!state.history.length && !state.empty) {
  /** 初稿内容快照，用于演示真正可恢复的历史差异。 */
  const initial = snapshot(); initial.accent='#d7b8a4'; initial.pages[0].title='让好习惯，\n慢慢发生。';
  /** 第二版只改变风格，第三版细化首页文案。 */
  const second = clone(initial); second.accent='#bbd6a6';
  state.history=[{id:3,title:'细化首次使用与打卡体验',author:'Agent 草稿 · 已采纳',time:'示例：10:42',snapshot:snapshot()},{id:2,title:'采用自然留白方向',author:'手动采纳',time:'示例：10:28',snapshot:second},{id:1,title:'建立四页主要流程',author:'Agent 生成 · 模拟',time:'示例：10:16',snapshot:initial}];
}
render();
