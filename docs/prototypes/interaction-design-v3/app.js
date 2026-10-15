'use strict';

/** V3 独立存储键，不读取或改写 V1 与 DutyDeck 业务数据。 */
const storageKey = 'dutydeck.interaction-design.prototype.v3';
/** 页面分组是信息架构，不代替页面之间的流程连接。 */
const initialGroups = [
  {id:'onboarding',name:'首次使用',order:0},
  {id:'core',name:'核心流程',order:1},
  {id:'settings',name:'设置与异常',order:2},
];
/** 初始页面分组映射；页面排序与流程排序保持独立。 */
const initialPageGroups = {welcome:'onboarding',today:'core',detail:'core',done:'core'};
/** 设计状态是唯一可保存的内容；选择、体验进度和候选不混入设计版本。 */
let state = {pages:clone(seedPages).map(page=>({...page,entry:page.id==='welcome',groupId:initialPageGroups[page.id]||'core',order:page.id==='welcome'?0:page.id==='today'?0:page.id==='detail'?1:2})),groups:clone(initialGroups),groupCollapsed:{},links:{welcome:'today',today:'detail',detail:'done',done:'today'},accent:'#bbd6a6',revision:3,history:[],theme:'light',device:'mobile',selectedPage:'today',selectedElement:'',sidebarCollapsed:false};
/** 本次体验状态；重置体验不撤销设计内容。 */
let runtime = {completed:false,verifiedCompletion:false,evidenceRevision:3,path:['today'],scenarios:{},subview:null};
/** 编辑器临时状态；任务序号用于取消与迟到结果保护。 */
const ui = {mode:'play',selection:null,candidate:null,previewCandidate:false,busy:false,ticket:0,messages:[],undo:[],redo:[],focusBeforeModal:null,toastTimer:null,dragPage:null,pageMenu:null};
/** 记录抽屉的打开入口，收起后恢复键盘焦点；不进入设计快照。 */
ui.sidebarTrigger=null;

/** 取内容快照，供候选、历史和撤销使用；返回独立纯数据。 */
function snapshot() { return clone({pages:state.pages,groups:state.groups,groupCollapsed:state.groupCollapsed,links:state.links,accent:state.accent}); }
/** 校验缓存内容，只接受本示例四个稳定页面和已登记字段。 */
function validSnapshot(value) {
  return value && /^#[0-9a-f]{6}$/i.test(value.accent) && value.links && typeof value.links==='object' && Array.isArray(value.groups) && value.groups.length>0 && value.groups.length<30 && value.groups.every(group=>typeof group.id==='string'&&typeof group.name==='string'&&group.name.length<80&&Number.isFinite(group.order)) && Array.isArray(value.pages) && value.pages.length>0 && value.pages.length<100 && seedPages.every(seed=>value.pages.filter(page=>page.id===seed.id).length===1) && value.pages.every(page=>['name','title','subtitle','cta','role','groupId'].every(field=>typeof page[field]==='string' && page[field].length<2000) && typeof page.entry==='boolean' && Number.isFinite(page.order) && ['normal','empty','loading','error'].includes(page.state) && value.groups.some(group=>group.id===page.groupId)) && Object.values(value.links).every(target=>typeof target==='string');
}
/** 读取独立缓存；损坏的数据自动退回种子，避免阻止评审。 */
function loadState() {
  try {
    /** 缓存先校验，再逐项接收，避免恢复任意运行时属性。 */
    const saved = JSON.parse(localStorage.getItem(storageKey)||'null');
    if (saved?.format===3 && validSnapshot(saved.design)) {
      Object.assign(state,clone(saved.design));
      state.revision=Number.isSafeInteger(saved.revision)&&saved.revision>0?saved.revision:3;
      state.theme=saved.theme==='dark'?'dark':'light'; state.device=saved.device==='desktop'?'desktop':'mobile';
      state.sidebarCollapsed=Boolean(saved.sidebarCollapsed); state.groupCollapsed=saved.design.groupCollapsed||{};
      state.history=Array.isArray(saved.history)?saved.history.filter(item=>Number.isSafeInteger(item.id)&&typeof item.title==='string'&&validSnapshot(item.snapshot)).slice(0,20):[];
    }
  } catch { /* 私密模式或损坏缓存仍可在内存中体验。 */ }
  if (!state.history.length) state.history=[{id:state.revision,title:'四页初稿',author:'示例初始版本',snapshot:snapshot()}];
}
/** 保存设计与有限历史；返回写入是否成功，并展示真实结果。 */
function persist() {
  try {
    localStorage.setItem(storageKey,JSON.stringify({format:3,design:snapshot(),revision:state.revision,history:state.history,theme:state.theme,device:state.device,sidebarCollapsed:state.sidebarCollapsed}));
    $('#save-status').textContent='已保存到本机浏览器'; return true;
  } catch { $('#save-status').textContent='仅保存在本次页面中'; return false; }
}
/** 显示轻量反馈，不抢焦点；输入面向用户的文字。 */
function toast(message) { clearTimeout(ui.toastTimer); $('#toast').textContent=message; $('#toast').hidden=false; ui.toastTimer=setTimeout(()=>{$('#toast').hidden=true;},3600); }
/** 当前设计页面；身份固定，因此选择与修改有稳定目标。 */
function currentPage() { return state.pages.find(page=>page.id===state.selectedPage); }
/** 返回当前入口页面；入口身份独立于页面名称和目录分组。 */
function entryPage() { return state.pages.find(page=>page.entry) || state.pages[0]; }
/** 受控字段的用户名称，避免展示技术键名。 */
function fieldName(field) { return ({title:'主标题',subtitle:'说明文字',cta:'主要操作',accent:'主题配色'})[field]||'页面'; }
/** 内容变更统一递增版本，旧候选随后自动失效。 */
function commit(description, mutate, author='手动修改') {
  ui.undo.push(snapshot()); ui.undo=ui.undo.slice(-20); ui.redo=[];
  mutate(); recordRevision(description,author);
}
/** 记录已生效内容并重绘；运行态只清除子页面，不自动重置打卡结果。 */
function recordRevision(description,author) {
  state.revision+=1; state.history.unshift({id:state.revision,title:description,author,snapshot:snapshot()}); state.history=state.history.slice(0,20);
  runtime.path=[];runtime.verifiedCompletion=false;runtime.evidenceRevision=state.revision;
  ui.previewCandidate=false; runtime.subview=null; persist(); render();
}
/** 回放撤销或重做快照，产生新版本以保持候选基线单调。 */
function travel(direction) {
  /** 来源栈和目标栈分别对应撤销或重做方向。 */
  const source=direction==='undo'?ui.undo:ui.redo;
  const target=direction==='undo'?ui.redo:ui.undo;
  if (!source.length) return;
  target.push(snapshot()); Object.assign(state,source.pop()); recordRevision(direction==='undo'?'撤销上一步修改':'重做上一步修改','手动修改');
  if ($('#modal').open) showHistory();
}
/** 按容器真实尺寸计算设备缩放；只缩放一个活动页面。 */
function fitPreview() {
  /** 移动/桌面保持各自真实 CSS 布局尺寸。 */
  const width=state.device==='desktop'?900:390;
  const height=state.device==='desktop'?620:844;
  const area=$('#preview-space');
  const box=area.getBoundingClientRect();
  const css=getComputedStyle(area);
  const availableWidth=box.width-parseFloat(css.paddingLeft)-parseFloat(css.paddingRight);
  const availableHeight=box.height-parseFloat(css.paddingTop)-parseFloat(css.paddingBottom);
  const scale=Math.max(.08,Math.min(1,availableWidth/width,availableHeight/height));
  $('#device-frame').style.setProperty('--screen-width',`${width}px`); $('#device-frame').style.setProperty('--screen-height',`${height}px`); $('#device-frame').style.setProperty('--preview-scale',String(scale));
  $('#device-size').textContent=`${width} × ${height} · ${Math.round(scale*100)}%`;
}
/** 从当前版本生成临时预览页；候选预览不会写回当前设计。 */
function previewPage() {
  /** 展示数据副本可以安全应用候选与本次体验状态。 */
  const page=clone(currentPage());
  if (ui.previewCandidate && ui.candidate?.page===page.id && ui.candidate.field!=='accent') page[ui.candidate.field]=ui.candidate.after;
  page.state=runtime.scenarios[page.id]||page.state;
  return page;
}
/** 同步目录浮层与入口状态；不重绘预览，也不改变预览缩放，返回 void。 */
function syncPageSidebar() {
  $('#prototype-sidebar').classList.toggle('collapsed',state.sidebarCollapsed);
  $('#prototype-sidebar').hidden=state.sidebarCollapsed;
  $('#prototype-sidebar').setAttribute('aria-hidden',String(state.sidebarCollapsed));
  $('#page-sidebar-backdrop').hidden=state.sidebarCollapsed;
  document.querySelectorAll('[data-action="toggle-page-sidebar"]').forEach(button=>{
    button.setAttribute('aria-controls','prototype-sidebar');
    button.setAttribute('aria-expanded',String(!state.sidebarCollapsed));
    button.classList.toggle('active',!state.sidebarCollapsed);
  });
}
/** 设置目录浮层开关；open 为目标状态，source 为打开入口，restoreFocus 控制收起时的焦点恢复，返回 void。 */
function setPageSidebar(open,source=null,restoreFocus=true) {
  // 快捷键可从窄屏主会话直接返回目录，避免把焦点送进不可见的工作区。
  if(open&&$('.studio').classList.contains('chat-open')){$('.studio').classList.remove('chat-open');syncLayoutControls();fitPreview();}
  if(open===!state.sidebarCollapsed)return;
  closePageMenu(false);
  if(open)ui.sidebarTrigger=source||$('.sidebar-toggle-header');
  state.sidebarCollapsed=!open;
  syncPageSidebar();persist();
  if(open)$('#page-search-input').focus({preventScroll:true});
  else if(restoreFocus){
    /** 原入口可能被主会话或专注模式隐藏，退回始终可用的工作区入口。 */
    const trigger=ui.sidebarTrigger?.getClientRects().length?ui.sidebarTrigger:$('.sidebar-toggle-header');
    trigger.focus({preventScroll:true});
  }
}
/** 渲染可折叠的分组页面目录；目录顺序不推断流程顺序。 */
function renderPageDirectory() {
  const query=($('#page-search-input')?.value||'').trim().toLowerCase();
  const sortedGroups=[...state.groups].sort((a,b)=>a.order-b.order);
  const visiblePages=state.pages.filter(page=>!query||[page.name,page.role,page.title].some(value=>value.toLowerCase().includes(query)));
  $('#sidebar-page-count').textContent=String(state.pages.length);
  syncPageSidebar();
  $('#page-directory').innerHTML=sortedGroups.map((group,groupIndex)=>{
    const pages=visiblePages.filter(page=>page.groupId===group.id).sort((a,b)=>(a.order??0)-(b.order??0));
    if(query&&!pages.length)return '';
    const collapsed=Boolean(state.groupCollapsed[group.id]);
    return `<section class="page-group" data-group-id="${escapeHtml(group.id)}"><header class="page-group-header" data-drop-group="${escapeHtml(group.id)}"><button class="group-toggle" data-action="toggle-group" data-toggle-group="${escapeHtml(group.id)}" aria-expanded="${!collapsed}"><span data-icon="chevron-${collapsed?'right':'down'}"></span><strong>${escapeHtml(group.name)}</strong><small>${pages.length}</small></button><div class="group-actions"><button class="icon-button" data-action="add-page" data-group-id="${escapeHtml(group.id)}" aria-label="在${escapeHtml(group.name)}中新建页面"><span data-icon="plus"></span></button><button class="icon-button" data-action="rename-group" data-group-id="${escapeHtml(group.id)}" aria-label="重命名${escapeHtml(group.name)}"><span data-icon="pencil"></span></button><button class="icon-button" data-action="delete-group" data-group-id="${escapeHtml(group.id)}" aria-label="删除${escapeHtml(group.name)}"><span data-icon="trash"></span></button></div></header>${collapsed?'':`<div class="group-pages" data-drop-group="${escapeHtml(group.id)}">${pages.map((page,index)=>`<div draggable="true" class="directory-page${page.id===state.selectedPage?' active':''}" data-drag-page="${escapeHtml(page.id)}" data-group-id="${escapeHtml(group.id)}"><button class="directory-page-nav" data-page-nav="${escapeHtml(page.id)}" aria-current="${page.id===state.selectedPage?'page':'false'}"><span class="page-drag" data-icon="grip"></span><span class="page-index">${String(index+1).padStart(2,'0')}</span><span class="page-copy"><strong>${escapeHtml(page.name)}</strong><small>${escapeHtml(page.role)}</small></span>${page.entry?'<span class="entry-badge">入口</span>':''}</button><button class="page-more" data-action="page-menu" data-page-id="${escapeHtml(page.id)}" aria-label="管理${escapeHtml(page.name)}" aria-haspopup="menu" aria-controls="page-context-menu" aria-expanded="false">•••</button></div>`).join('')}</div>`}</section>`;
  }).join('')+(query&&!visiblePages.length?'<p class="directory-empty">没有匹配的页面</p>':'');
  $('#directory-status').textContent=query?`${visiblePages.length} 个匹配`:'拖拽排序 · 可移动分组';
  hydrateIcons($('#prototype-sidebar'));
}
/** 渲染预览与导航；主会话输入不随页面跳转被重建。 */
function render() {
  document.documentElement.dataset.theme=state.theme;
  $('#revision-label').textContent=`v${state.revision}`;
  $('#stage').classList.toggle('inspect',ui.mode==='inspect');
  $('#stage').classList.toggle('has-selection',Boolean(ui.selection)&&ui.mode==='inspect');
  document.querySelectorAll('[data-mode]').forEach(button=>{button.classList.toggle('active',button.dataset.mode===ui.mode);button.setAttribute('aria-pressed',String(button.dataset.mode===ui.mode));});
  document.querySelectorAll('[data-device]').forEach(button=>{button.classList.toggle('active',button.dataset.device===state.device);button.setAttribute('aria-pressed',String(button.dataset.device===state.device));});
  $('#live-screen').innerHTML=screenHtml(previewPage(),runtime,ui.mode==='inspect');
  if(ui.mode==='inspect') $('#live-screen').querySelectorAll('[data-element]').forEach(element=>{element.tabIndex=0;if(element.tagName!=='BUTTON')element.setAttribute('role','button');element.setAttribute('aria-label',`选择${fieldName(element.dataset.element)}：${element.textContent.trim()}`);});
  if (ui.previewCandidate && ui.candidate?.field==='accent') $('#live-screen .screen').style.setProperty('--app-accent',ui.candidate.after);
  if (runtime.subview) renderSubview();
  $('#preview-location').textContent=runtime.subview?({records:'习惯记录',profile:'我的设置'})[runtime.subview]:currentPage().name;
  $('#scenario-select').value=runtime.scenarios[state.selectedPage]||currentPage().state;
  $('#scenario-select').disabled=Boolean(runtime.subview)||ui.previewCandidate;
  $('#stage-hint').innerHTML=ui.previewCandidate?`${icon('sparkles')}正在查看候选外观 · 采纳后可体验` : ui.mode==='inspect'?`${icon('cursor')}点击标题、说明或按钮，选中后修改`:'<span class="live-dot"></span>直接点击体验 · 数据为本地示例';
  $('#candidate-preview-bar').hidden=!ui.previewCandidate;
  $('#journey-progress').textContent=`本次体验 · ${runtime.completed?'阅读已打卡，今日完成 2 / 3':'阅读尚未打卡'}`;
  renderPageDirectory(); renderSelection(); renderContext(); renderCandidate(); hydrateIcons(); fitPreview();
}
/** 记录与个人页作为示例子视图，可返回且不产生新设计页面。 */
function renderSubview() {
  $('#live-screen .app-body').innerHTML=`<div class="app-top-nav"><button class="app-back" data-app-action="today" aria-label="返回今日习惯">${icon('chevron-left')}</button><span>${runtime.subview==='records'?'习惯记录':'我的设置'}</span></div><h2 class="app-title">${runtime.subview==='records'?'一点点的累积':'阿光的日常'}</h2><p class="app-description">${runtime.subview==='records'?`阅读已连续 ${runtime.completed?'8':'7'} 天，今天完成 ${runtime.completed?'2':'1'} 项习惯。`:'按照自己的节奏，留一点时间给自己。'}</p><div class="app-bottom"><button class="app-button" data-app-action="today">回到今日习惯</button></div>`;
}
/** 更新上下文引用，主会话只接收明确选中身份。 */
function renderContext() {
  $('#context-label').textContent=ui.selection?`${currentPage().name} / ${fieldName(ui.selection.field)} · v${state.revision}`:'拾光 · 整个原型';
  $('#context-chip [data-action="clear-selection"]').hidden=!ui.selection;
}
/** 选中后才展示编辑卡；只允许标题、说明、主要操作三个字段。 */
function renderSelection() {
  $('#selection-card').hidden=!(ui.selection&&ui.mode==='inspect');
  if (!ui.selection || ui.mode!=='inspect') return;
  /** 当前字段和值来自已登记稳定身份。 */
  const field=ui.selection.field;
  $('#selection-card').innerHTML=`<div class="selection-title"><strong>${fieldName(field)}</strong><button class="icon-button" data-action="clear-selection" aria-label="关闭编辑卡">${icon('close')}</button></div><p>${escapeHtml(currentPage().name)} · 仅修改这个元素</p><form id="element-form"><label for="element-copy">显示文字</label><textarea id="element-copy" maxlength="200" rows="3" required>${escapeHtml(currentPage()[field])}</textarea><div class="selection-actions"><button type="submit" class="button">保存文字</button><button type="button" class="button primary" data-action="ask-selection">${icon('sparkles')}交给 Agent</button></div></form>${field==='cta'?`<div class="selection-link">${icon('arrow-right')}点击后前往 ${escapeHtml(state.pages.find(page=>page.id===state.links[state.selectedPage])?.name||'未连接')}<button class="text-button" data-action="flow">修改</button></div>`:''}`;
}
/** 清除元素并返回可运行预览；输入模式名称。 */
function setMode(mode) {
  ui.mode=mode; ui.previewCandidate=false; runtime.subview=null;
  if (mode==='play') {ui.selection=null;state.selectedElement='';}
  render();
}
/** 跳到指定页面；导航与体验动作都使用明确页面身份。 */
function navigate(id,fromInteraction=false) {
  if (!state.pages.some(page=>page.id===id)) {toast('这个操作没有连接有效页面，请在流程里补齐。');return;}
  state.selectedPage=id; state.selectedElement=''; ui.selection=null; runtime.subview=null; ui.previewCandidate=false;
  if (fromInteraction) runtime.path.push(id);
  render();
}
/** 页面业务动作只在体验模式执行，编辑模式点击不会打卡或跳转。 */
function runAppAction(action,source) {
  if (ui.previewCandidate) {toast('这是候选外观，采纳后可体验交互。');return;}
  if (action==='next') {
    /** 先验证目标，再更新本次体验状态。 */
    const target=state.links[source||state.selectedPage];
    if (!state.pages.some(page=>page.id===target)) {toast('这个操作尚未连接目标页面。');return;}
    if (source==='detail'&&target==='done') {runtime.completed=true;runtime.verifiedCompletion=true;}
    navigate(target,true);
  } else if (action==='today') navigate('today',true);
  else if (action==='resolve') {runtime.scenarios[state.selectedPage]='normal';render();}
  else if (action==='records'||action==='profile') {runtime.subview=action;render();}
}
/** 同步布局按钮的图标、说明和可访问状态；无入参，返回 void，不重绘预览。 */
function syncLayoutControls() {
  /** 专注模式只管理应用布局，与页面内容及本次体验状态无关。 */
  const focused=$('.studio').classList.contains('focus-mode');
  const focusButton=$('[data-action="focus"]');
  focusButton.title=focused?'退出专注 · Esc':'专注预览';
  focusButton.setAttribute('aria-label',focused?'退出专注':'专注预览');
  focusButton.setAttribute('aria-pressed',String(focused));
  focusButton.classList.toggle('active',focused);
  focusButton.innerHTML=icon(focused?'collapse':'expand');
  /** 主会话在手机上覆盖显示，在桌面上占独立列；入口跟随当前可见状态。 */
  const chatVisible=!focused&&(matchMedia('(max-width:760px)').matches?$('.studio').classList.contains('chat-open'):!$('.studio').classList.contains('chat-hidden'));
  document.querySelectorAll('[data-action="chat"]').forEach(button=>{
    button.title=chatVisible?'收起主会话':'打开主会话';
    button.setAttribute('aria-label',button.title);
    button.setAttribute('aria-controls','conversation');
    button.setAttribute('aria-expanded',String(chatVisible));
    button.classList.toggle('active',chatVisible);
  });
}
/** 开关专注布局；active 指定目标状态，返回 void，退出时保留进入前的主会话开关。 */
function setFocusMode(active) {
  if(active)setPageSidebar(false,null,false);
  $('.studio').classList.toggle('focus-mode',active);
  syncLayoutControls();fitPreview();
  $('[data-action="focus"]').focus({preventScroll:true});
}
/** 主会话显隐；forceOpen 为 true 时确保打开，返回 void；窄屏使用全高视图。 */
function toggleChat(forceOpen=false) {
  if (matchMedia('(max-width:760px)').matches) {
    $('.studio').classList.toggle('chat-open',forceOpen||!$('.studio').classList.contains('chat-open'));
    $('.studio').classList.remove('chat-hidden','focus-mode');
    if ($('.studio').classList.contains('chat-open')) $('.mobile-close').focus(); else $('.mobile-chat-fab').focus();
  } else {
    $('.studio').classList.remove('focus-mode');
    $('.studio').classList.toggle('chat-hidden',forceOpen?false:!$('.studio').classList.contains('chat-hidden'));
  }
  syncLayoutControls();fitPreview();
}
/** 添加主会话消息；用户输入只作为文本展示。 */
function appendMessage(role,text) {ui.messages.push({role,text});ui.messages=ui.messages.slice(-12);renderMessages();}
/** 展示本轮消息与真实忙碌状态，滚动到新结果。 */
function renderMessages() {
  $('#dynamic-messages').innerHTML=ui.messages.map(message=>`<article class="message ${message.role==='user'?'user-message':'agent-message'}"><div class="message-label">${message.role==='user'?'你':`${icon('sparkles')} DutyDeck · 模拟`}</div><p>${escapeHtml(message.text)}</p></article>`).join('')+(ui.busy?'<div class="busy-dots" aria-label="正在准备候选"><i></i><i></i><i></i></div>':'');
  $('.send-button').disabled=ui.busy||Boolean(ui.candidate); $('.cancel-task').hidden=!ui.busy;
  $('#messages').scrollTop=$('#messages').scrollHeight;
}
/** 生成明确标识的预设候选；支持文案和配色，未知意图不伪装已实现。 */
function runAgent(prompt) {
  if (ui.busy) return;
  if (ui.candidate) {toast('先采纳或丢弃当前候选，再继续下一项修改。');return;}
  toggleChat(true); appendMessage('user',prompt);
  /** 演示只识别明确支持的意图，避免任意输入得到虚假成功。 */
  const styleIntent=/配色|颜色|暖色|视觉|风格/.test(prompt);
  const copyIntent=/文案|明确|标题|按钮|文字|简洁/.test(prompt);
  if (!styleIntent&&!copyIntent) {appendMessage('agent','这是交互评审稿，尚未连接真实模型。目前可以体验「文案更明确」「换一种配色」两类预设修改，或直接手动编辑。');return;}
  /** 冻结选区、版本与内容；生成期间的导航不改变修改对象。 */
  const pageId=ui.selection?.page||'detail';
  const field=styleIntent?'accent':ui.selection?.field||'cta';
  const page=state.pages.find(item=>item.id===pageId);
  const baseRevision=state.revision;
  const before=field==='accent'?state.accent:page[field];
  /** 示例候选文案按目标页给出；不推断真实用户业务。 */
  const alternatives={welcome:{title:'从今天，\n开始一点改变。',subtitle:'为自己留一点时间。\n一个小习惯，就从今天开始。',cta:'开始第一个习惯'},today:{title:'今天，也照顾好自己',subtitle:'一件件来，让小习惯慢慢发生。',cta:'开始今日阅读'},detail:{title:'留给阅读的 20 分钟',subtitle:'放下忙碌，翻开喜欢的书',cta:'完成今日阅读'},done:{title:'今天的坚持，已记下。',subtitle:'阅读已完成。\n明天，我们再向前一小步。',cta:'查看今日进度'}};
  const after=styleIntent?(before==='#dfc29e'?'#bbd6a6':'#dfc29e'):alternatives[pageId][field];
  if (before===after) {appendMessage('agent','当前内容已经是这组演示候选。你可以选中其他元素，或手动输入想要的文案。');return;}
  const ticket=++ui.ticket; ui.busy=true; renderMessages();
  setTimeout(()=>{
    if (ticket!==ui.ticket) return;
    ui.busy=false; ui.candidate={page:pageId,field,before,after,baseRevision,title:styleIntent?'换成温暖的沙色':'让下一步更明确'};
    appendMessage('agent',styleIntent?'已准备一组配色候选，布局、文字和页面流程保持一致。先看看视觉，再决定是否采纳。':`已准备「${page.name} / ${fieldName(field)}」的修改候选，只调整这一处内容。`);
    renderCandidate(); renderMessages();
    if (matchMedia('(max-width:760px)').matches&&!$('.studio').classList.contains('chat-open')) toast('候选已就绪，打开主会话查看。');
  },950);
}
/** 渲染候选差异；版本不一致时明确阻止采纳。 */
function renderCandidate() {
  $('#mobile-candidate-dot').hidden=!ui.candidate;
  $('.send-button').disabled=ui.busy||Boolean(ui.candidate);
  if (!ui.candidate) {$('#candidate-slot').innerHTML='';return;}
  /** 候选只携带单字段 patch，不复制覆盖整个项目。 */
  const candidate=ui.candidate;
  const stale=candidate.baseRevision!==state.revision;
  $('#candidate-slot').innerHTML=`<article class="candidate-card"><h3>${icon('sparkles')}${escapeHtml(candidate.title)}</h3><p class="candidate-meta">${candidate.field==='accent'?'全部页面 · 配色':`${escapeHtml(state.pages.find(page=>page.id===candidate.page).name)} · ${fieldName(candidate.field)}`} · 基于 v${candidate.baseRevision}</p><div class="diff-line before">− ${escapeHtml(candidate.before)}</div><div class="diff-line after">＋ ${escapeHtml(candidate.after)}</div>${stale?'<p class="candidate-warning">当前稿已更新。这个候选保留供参考，不能覆盖新修改。</p>':''}<div class="candidate-actions"><button class="button" data-action="preview-candidate">预览候选</button><button class="button primary" data-action="adopt" ${stale?'disabled':''}>采纳修改</button><button class="text-button" data-action="discard">丢弃</button></div></article>`;
}
/** 采纳前重新检查基线，随后只应用候选字段。 */
function adoptCandidate() {
  if (!ui.candidate) return;
  if (ui.candidate.baseRevision!==state.revision) {toast('当前稿已经变化，请重新生成候选。');return;}
  /** 先取独立引用再清理候选，避免重绘时误判其过时。 */
  const candidate=ui.candidate; ui.candidate=null; ui.previewCandidate=false; ui.selection=null; state.selectedElement=''; state.selectedPage=candidate.page; ui.mode='play';
  commit(candidate.title,()=>{if(candidate.field==='accent') state.accent=candidate.after;else state.pages.find(page=>page.id===candidate.page)[candidate.field]=candidate.after;},'Agent 候选 · 用户采纳');
  appendMessage('agent',`已采纳为 v${state.revision}。右侧继续体验，也可以在版本记录中撤销。`);toast('修改已采纳，可以继续体验。');
}
/** 打开辅助弹窗，保留发起按钮用于关闭后恢复焦点。 */
function openModal(title,body) {
  if (!$('#modal').open) ui.focusBeforeModal=document.activeElement;
  $('#modal-title').textContent=title; $('#modal-body').innerHTML=body; hydrateIcons($('#modal'));
  if (!$('#modal').open) $('#modal').showModal();
}
/** 关闭弹窗后返回触发器，无数据副作用。 */
function closeModal() {$('#modal').close();}
/** 展示跳转关系与流程检查；无入参，返回 void，页面定位统一使用目录。 */
function showFlow() {
  openModal('交互流程',`<p class="modal-copy">设置每个页面点击主要操作后的去向，再检查连接或从入口体验。</p>${state.pages.map(page=>`<div class="flow-row"><span>${escapeHtml(page.name)}<small>${escapeHtml(page.cta)}</small></span>${icon('arrow-right')}<select data-link-source="${page.id}" aria-label="${escapeHtml(page.name)}的跳转目标">${state.pages.map(target=>`<option value="${target.id}" ${state.links[page.id]===target.id?'selected':''}>${escapeHtml(target.name)}</option>`).join('')}<option value="" ${!state.links[page.id]?'selected':''}>暂未连接</option></select></div>`).join('')}<div class="modal-footer"><button class="button" data-action="check">${icon('check')}检查流程</button><button class="button primary" data-action="start-from-flow">从入口体验</button></div>`);
}
/** 计算登记链接的有效性与可达性，不把静态检查声称为真实业务验收。 */
function showChecks() {
  /** 有限集合防止循环流程导致无限遍历。 */
  const ids=new Set(state.pages.map(page=>page.id));
  const broken=state.pages.filter(page=>!ids.has(state.links[page.id]));
  const reachable=new Set();
  let cursor=entryPage()?.id||'';
  while(ids.has(cursor)&&!reachable.has(cursor)){reachable.add(cursor);cursor=state.links[cursor];}
  /** 本次实际点击轨迹与结构检查分别呈现。 */
  const visited=new Set(runtime.path);
  const total=state.pages.length;
  openModal('检查这条用户流程',`<p class="modal-copy">针对当前版本 v${state.revision} 的本地检查，结果来自实际页面连接和本版本的体验记录。</p><div class="check-row">${icon(broken.length?'warning':'check')}<div>${broken.length?`${broken.length} 处操作尚未连接目标`:`${total} 个页面操作均连接有效页面`}<small>${broken.length?broken.map(page=>escapeHtml(page.name)).join('、'):`检查范围：当前目录中的 ${total} 个页面`}</small></div></div><div class="check-row">${icon(reachable.size===total?'check':'warning')}<div>从入口可以到达 ${reachable.size} / ${total} 个页面<small>${reachable.size===total?`登记的 ${total} 个页面都可从入口到达`:`未到达：${state.pages.filter(page=>!reachable.has(page.id)).map(page=>escapeHtml(page.name)).join('、')}`}</small></div></div><div class="check-row">${icon(runtime.verifiedCompletion?'check':'play')}<div>${runtime.verifiedCompletion?'本版本已体验阅读打卡':'本版本尚未体验阅读打卡'}<small>本版本通过实际交互到达 ${visited.size} / ${total} 页；页面导航仅定位，不计为流程验证。</small></div></div><p class="modal-copy">修改或恢复版本后，需要重新体验。视觉质量、业务规则和真实接口尚需人工评审。</p><div class="modal-footer"><button class="button" data-action="flow">查看连接</button><button class="button primary" data-action="start-from-flow">从入口体验</button></div>`);
}
/** 历史恢复建立新版本；撤销栈仅对应本次浏览器会话。 */
function showHistory() {
  openModal('版本记录',`<p class="modal-copy">每次采纳或手动修改都保存一个版本。恢复旧内容会产生新版本，保留已有历史。</p><div class="history-tools"><button class="button" data-action="undo" ${!ui.undo.length?'disabled':''}>${icon('undo')}撤销</button><button class="button" data-action="redo" ${!ui.redo.length?'disabled':''}>${icon('redo')}重做</button></div>${state.history.map(item=>`<div class="history-row"><span>v${item.id}</span><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.author)}</small></div>${item.id===state.revision?'<small>当前版本</small>':`<button class="button" data-restore="${item.id}">恢复内容</button>`}</div>`).join('')}`);
}
/** 给出 V1/V2 对比，帮助评审工作方式而非只比较装饰。 */
function showComparison() {
  openModal('页面导航版本对比',`<p class="modal-copy">V3 保留 V2 的体验优先，把页面目录改成可分组、可排序的侧栏。底部不再承担页面导航。</p><table class="compare-table"><thead><tr><th>关注点</th><th>V2 · 底部步骤</th><th>V3 · 分组侧栏</th></tr></thead><tbody><tr><td>页面导航</td><td>底部固定展示全部页面</td><td>侧栏分组、搜索、折叠</td></tr><tr><td>页面数量</td><td>适合少量流程页面</td><td>可持续增加页面</td></tr><tr><td>排序与组织</td><td>示例顺序</td><td>拖拽排序、跨组移动</td></tr><tr><td>流程关系</td><td>步骤条容易混淆</td><td>与目录独立的流程视图</td></tr></tbody></table><div class="compare-links"><a class="button" href="../interaction-design-v2/" target="_blank" rel="noopener">打开 V2 ${icon('arrow-up-right')}</a><a class="button" href="../../superpowers/specs/2026-10-14-interaction-design-v3.md" target="_blank" rel="noopener">V3 设计说明 ${icon('book')}</a></div>`);
}
/** 打开新建或重命名分组表单；分组操作不改变页面连接。 */
function showGroupForm(groupId='',rename=false) {
  const group=state.groups.find(item=>item.id===groupId);
  openModal(rename?'重命名页面分组':'新建页面分组',`<form id="group-form"><p class="modal-copy">${rename?'重命名不会改变页面连接或页面内容。':'分组用于整理页面目录，页面之间的跳转仍在交互流程里单独维护。'}</p><label class="form-label" for="group-name">分组名称</label><input class="modal-input" id="group-name" name="name" maxlength="40" required value="${escapeHtml(group?.name||'')}" placeholder="例如：首次使用"><div class="modal-footer"><button type="button" class="button" data-action="close-modal">取消</button><button type="submit" class="button primary">${rename?'保存名称':'创建分组'}</button></div></form>`);
  $('#group-form').dataset.groupId=groupId; $('#group-form').dataset.rename=String(rename); $('#group-name').focus();
}
/** 打开新建页面表单；新页面默认归入当前分组或第一个分组。 */
function showPageForm(groupId='') {
  const fallback=groupId||currentPage()?.groupId||state.groups[0]?.id||'';
  openModal('新建页面',`<form id="page-form"><p class="modal-copy">新页面会进入目录，但不会自动加入任何跳转；请在“交互流程”中登记连接。</p><label class="form-label" for="page-name">页面名称</label><input class="modal-input" id="page-name" name="name" maxlength="60" required placeholder="例如：订单确认"><label class="form-label" for="page-group">所属分组</label><select class="modal-input" id="page-group" name="group">${state.groups.map(group=>`<option value="${escapeHtml(group.id)}" ${group.id===fallback?'selected':''}>${escapeHtml(group.name)}</option>`).join('')}</select><div class="modal-footer"><button type="button" class="button" data-action="close-modal">取消</button><button type="submit" class="button primary">创建页面</button></div></form>`);
  $('#page-name').focus();
}
/** 关闭悬浮菜单；restoreFocus 指定是否把键盘焦点还给页面菜单按钮。 */
function closePageMenu(restoreFocus=true) {
  /** 保存触发器身份，以便目录重绘后仍能恢复焦点。 */
  const previous=ui.pageMenu;
  previous?.anchor?.setAttribute('aria-expanded','false');
  ui.pageMenu=null;
  /** 菜单节点独立于滚动侧栏，收起时清除临时内容。 */
  const menu=$('#page-context-menu');
  if(menu){menu.hidden=true;menu.innerHTML='';}
  if(restoreFocus&&previous){
    /** 操作可能重绘或删除原页面，优先按稳定页面身份寻找新触发器。 */
    const anchor=previous.anchor?.isConnected?previous.anchor:document.querySelector(`.page-more[data-page-id="${CSS.escape(previous.pageId)}"]`);
    (anchor||$('#page-search-input')).focus({preventScroll:true});
  }
}
/** 把页面管理菜单定位到触发器附近；窄屏时自动限制在视口内。 */
function positionPageMenu(anchor) {
  /** 通过菜单实际尺寸定位，仅在打开菜单和子菜单时测量。 */
  const menu=$('#page-context-menu'); if(!menu||!anchor)return;
  const rect=anchor.getBoundingClientRect();
  const left=Math.max(8,Math.min(window.innerWidth-menu.offsetWidth-8,rect.right-menu.offsetWidth));
  const preferredTop=rect.bottom+4+menu.offsetHeight<=innerHeight-8?rect.bottom+4:rect.top-menu.offsetHeight-4;
  const top=Math.max(8,Math.min(window.innerHeight-menu.offsetHeight-8,preferredTop));
  menu.style.left=`${left}px`; menu.style.top=`${top}px`;
}
/** 展开或收起移动子菜单；open 指定可见状态，focusFirst 用于键盘进入。 */
function setMoveMenu(open,focusFirst=false) {
  /** 子菜单及其按钮仅在当前页面菜单中查找，避免影响其他弹窗。 */
  const parent=$('#page-context-menu .page-menu-parent');
  const submenu=$('#page-context-menu .page-menu-submenu');
  if(!parent||!submenu||!ui.pageMenu)return;
  parent.closest('.page-menu-submenu-wrap').classList.toggle('open',open);
  parent.setAttribute('aria-expanded',String(open));
  positionPageMenu(ui.pageMenu.anchor);
  if(open&&!matchMedia('(max-width:760px)').matches){
    /** 桌面子菜单优先向右展开，空间不足时翻转到左侧，并限制高度。 */
    const rect=parent.getBoundingClientRect();
    const left=rect.right+submenu.offsetWidth+4<=innerWidth-8?rect.right+4:rect.left-submenu.offsetWidth-4;
    submenu.style.left=`${Math.max(8,Math.min(innerWidth-submenu.offsetWidth-8,left))}px`;
    submenu.style.top=`${Math.max(8,Math.min(innerHeight-submenu.offsetHeight-8,rect.top-4))}px`;
  }
  if(open&&focusFirst)submenu.querySelector('button:not(:disabled)')?.focus();
}
/** 打开页面行旁的悬浮菜单；移动到使用二级悬浮菜单，其他操作保持单击直达。 */
function showPageMenu(pageId,anchor) {
  /** 菜单始终绑定被点击的页面，不把该点击解释为切换预览。 */
  const page=state.pages.find(item=>item.id===pageId); if(!page)return;
  if(ui.pageMenu?.pageId===pageId){closePageMenu();return;}
  closePageMenu(false);
  /** 固定菜单容器避免被目录的滚动区域裁切。 */
  const menu=$('#page-context-menu');
  menu.innerHTML=`<div class="page-menu-heading"><span>${icon('layout')}</span><strong>${escapeHtml(page.name)}</strong></div><div class="page-menu-divider"></div><button class="page-menu-item" role="menuitem" data-action="duplicate-page" data-page-id="${escapeHtml(page.id)}">${icon('copy')}<span>复制页面</span></button><button class="page-menu-item" role="menuitem" data-action="rename-page" data-page-id="${escapeHtml(page.id)}">${icon('pencil')}<span>重命名</span></button><div class="page-menu-submenu-wrap"><button class="page-menu-item page-menu-parent" role="menuitem" aria-haspopup="menu" aria-expanded="false" data-action="show-move-menu" data-page-id="${escapeHtml(page.id)}">${icon('flow')}<span>移动到</span>${icon('chevron-right')}</button><div class="page-menu-submenu" role="menu" aria-label="移动到分组">${state.groups.map(group=>`<button class="page-menu-item" role="menuitem" data-action="move-page-to" data-page-id="${escapeHtml(page.id)}" data-group-id="${escapeHtml(group.id)}" ${group.id===page.groupId?'disabled':''}>${icon(group.id===page.groupId?'check':'folder')}<span>${escapeHtml(group.name)}</span>${group.id===page.groupId?'<small>当前</small>':''}</button>`).join('')}</div></div><div class="page-menu-divider"></div><button class="page-menu-item" role="menuitem" data-action="set-entry" data-page-id="${escapeHtml(page.id)}" ${page.entry?'disabled':''}>${icon('leaf')}<span>${page.entry?'当前是入口':'设为入口'}</span></button><button class="page-menu-item danger" role="menuitem" data-action="delete-page" data-page-id="${escapeHtml(page.id)}" ${page.entry?'disabled':''}>${icon('trash')}<span>删除</span></button>`;
  menu.hidden=false; ui.pageMenu={pageId,anchor}; anchor.setAttribute('aria-expanded','true');
  menu.setAttribute('aria-label',`${page.name}的操作`);
  menu.querySelectorAll('button').forEach(button=>{button.tabIndex=-1;});
  positionPageMenu(anchor); menu.querySelector('button:not(:disabled)').focus({preventScroll:true});
}
/** 更新页面分组与顺序；目录排序和流程连接保持独立。 */
function movePage(pageId,groupId,targetId='') {
  const page=state.pages.find(item=>item.id===pageId); const group=state.groups.find(item=>item.id===groupId); if(!page||!group)return;
  commit(`移动${page.name}到${group.name}`,()=>{
    page.groupId=groupId;
    const groupPages=state.pages.filter(item=>item.groupId===groupId&&item.id!==pageId).sort((a,b)=>(a.order??0)-(b.order??0));
    const targetIndex=targetId?groupPages.findIndex(item=>item.id===targetId):-1;
    groupPages.splice(targetIndex<0?groupPages.length:targetIndex,0,page);
    groupPages.forEach((item,index)=>{item.order=index;});
  });
}
/** 删除页面时清理指向它的连接；入口页和最后一个页面受保护。 */
function deletePage(pageId) {
  const page=state.pages.find(item=>item.id===pageId); if(!page||page.entry||state.pages.length<=1){toast('入口页面或最后一个页面不能删除。');return;}
  commit(`删除页面${page.name}`,()=>{state.pages=state.pages.filter(item=>item.id!==pageId);delete state.links[pageId];Object.keys(state.links).forEach(source=>{if(state.links[source]===pageId)state.links[source]='';});state.selectedPage=state.pages[0]?.id||'';});
  closePageMenu(); closeModal(); toast('页面已删除，原有跳转已标记为未连接。');
}
/** 复制页面只复制页面内容与目录归属，不复制入口身份或页面入站连接。 */
function duplicatePage(pageId) {
  const page=state.pages.find(item=>item.id===pageId); if(!page)return;
  const id=`page-${Date.now().toString(36)}`;
  commit(`复制页面${page.name}`,()=>{const order=state.pages.filter(item=>item.groupId===page.groupId).reduce((max,item)=>Math.max(max,item.order??-1),-1)+1;state.pages.push({...clone(page),id,name:`${page.name} 副本`,entry:false,order});state.links[id]=state.links[page.id]||'';state.selectedPage=id;});
  closePageMenu(); closeModal(); toast('页面副本已创建，可在流程视图中单独连接。');
}
/** 删除空分组；有页面的分组必须先移动页面，避免目录内容被悄悄丢弃。 */
function deleteGroup(groupId) {
  const group=state.groups.find(item=>item.id===groupId); if(!group)return;
  if(state.groups.length<=1){toast('至少保留一个页面分组。');return;}
  if(state.pages.some(page=>page.groupId===groupId)){toast('请先把页面移动到其他分组，再删除这个分组。');return;}
  commit(`删除分组${group.name}`,()=>{state.groups=state.groups.filter(item=>item.id!==groupId);delete state.groupCollapsed[groupId];});
  toast('空分组已删除。');
}
/** 导出函数在独立文件内运行，只含示例业务动作，不包含工作台或主会话。 */
function exportedRuntime() {
  /** 导出资源内的数据、CSS 与模板全部内联，无网络依赖。 */
  const data=JSON.parse(document.getElementById('prototype-data').textContent);
  let current=Object.entries(data.pages).find(([,page])=>page.entry)?.[0]||Object.keys(data.pages)[0]; let completed=false; let resolved=new Set();
  /** 根据当前页模板刷新实际可点击内容，返回后保持打卡反馈。 */
  function show() {
    document.getElementById('export-screen').innerHTML=data.pages[current][resolved.has(current)?'normal':'initial'];
    document.querySelectorAll('.element-selected').forEach(node=>node.classList.remove('element-selected'));
    if(completed){
      document.querySelectorAll('.progress-circle strong').forEach(node=>node.textContent='2 / 3');
      document.querySelectorAll('.progress-circle').forEach(node=>node.style.background='conic-gradient(#a6c192 0deg 240deg,#e3eadb 0deg 360deg)');
      document.querySelectorAll('.habit-icon.reading + .habit-copy small').forEach(node=>node.textContent='今日已完成 · 连续 8 天');
      document.querySelectorAll('.habit-icon.reading').forEach(node=>{const check=node.parentElement.querySelector('.habit-check');check.classList.add('done');check.textContent='✓';});
      document.querySelectorAll('.detail-stats>div:first-child b,.streak-card strong').forEach(node=>node.textContent='8');
    }
    fit();
  }
  /** 导出预览按窗口缩放，保证移动设备能够点到底部动作。 */
  function fit(){const scale=Math.min(1,(innerWidth-28)/data.width,(innerHeight-95)/data.height);document.getElementById('export-frame').style.cssText=`width:${data.width*scale}px;height:${data.height*scale}px`;document.getElementById('export-screen').style.cssText=`width:${data.width}px;height:${data.height}px;transform:scale(${scale});transform-origin:top left`;}
  document.addEventListener('click',event=>{
    const button=event.target.closest('[data-app-action],[data-reset]'); if(!button)return;
    if(button.hasAttribute('data-reset')){current=Object.entries(data.pages).find(([,page])=>page.entry)?.[0]||Object.keys(data.pages)[0];completed=false;resolved=new Set();show();return;}
    const action=button.dataset.appAction;
    if(action==='next'){const target=data.links[button.dataset.source||current];if(!data.pages[target]){alert('这个操作尚未连接目标页面');return;}if(current==='detail'&&target==='done')completed=true;current=target;show();}
    else if(action==='today'){current='today';show();}
    else if(action==='resolve'){resolved.add(current);show();}
    else if(action==='records'||action==='profile'){const body=document.querySelector('.app-body');body.innerHTML=`<div class="app-top-nav"><button class="app-back" data-app-action="today" aria-label="返回今日习惯">←</button><span>${action==='records'?'习惯记录':'我的设置'}</span></div><h2 class="app-title">${action==='records'?'一点点的累积':'阿光的日常'}</h2><p class="app-description">${action==='records'?`今天已完成 ${completed?'2':'1'} 项习惯。`:'按照自己的节奏，留一点时间给自己。'}</p><div class="app-bottom"><button class="app-button" data-app-action="today">回到今日习惯</button></div>`;}
  });
  window.addEventListener('resize',fit); show();
}
/** 导出已采纳版本的独立 HTML，绝不混入未采纳候选或主会话正文。 */
function exportPrototype() {
  /** 只收集同源样式，静态原型不存在跨域资源。 */
  const css=Array.from(document.styleSheets).map(sheet=>Array.from(sheet.cssRules).map(rule=>rule.cssText).join('\n')).join('\n');
  const pages={};
  state.pages.forEach(page=>{pages[page.id]={entry:Boolean(page.entry),initial:screenHtml(page,{completed:false},false),normal:screenHtml({...page,state:'normal'},{completed:false},false)};});
  const data=JSON.stringify({pages,links:state.links,width:state.device==='desktop'?900:390,height:state.device==='desktop'?620:844}).replace(/</g,'\\u003c');
  const script=`(${exportedRuntime.toString()})();`;
  const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>拾光 · v${state.revision}</title><style>${css}\nhtml,body{height:100%;overflow:hidden;background:#f0f2ec;color:#25352b}body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:12px}header{font-size:11px;display:flex;align-items:center;gap:16px}header button{border:1px solid #d4dccd;border-radius:5px;padding:3px 9px}#export-frame{box-shadow:0 12px 50px #25352b12;border-radius:20px}.screen:not(.editing) [data-element]{outline:none}</style></head><body><header>拾光 · v${state.revision} · 模拟数据<button data-reset>重新体验</button></header><div id="export-frame"><div id="export-screen"></div></div><script type="application/json" id="prototype-data">${data}</scr`+`ipt><script>${script}</scr`+`ipt></body></html>`;
  const url=URL.createObjectURL(new Blob([html],{type:'text/html;charset=utf-8'}));
  const anchor=document.createElement('a');anchor.href=url;anchor.download=`shiguang-v2-revision-${state.revision}.html`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  toast(`已导出 v${state.revision} 当前版本${ui.candidate?'，不包含未采纳候选':''}。`);
}
/** 统一工具入口；每个可见操作都有实际结果。 */
function handleAction(action,sourceElement) {
  if(action==='theme'){state.theme=state.theme==='light'?'dark':'light';persist();render();}
  else if(action==='compare')showComparison();
  else if(action==='flow')showFlow();
  else if(action==='check')showChecks();
  else if(action==='history')showHistory();
  else if(action==='close-modal')closeModal();
  else if(action==='chat')toggleChat();
  else if(action==='show-prototype'){
    $('.studio').classList.remove('chat-open');setPageSidebar(false,null,false);
    syncLayoutControls();fitPreview();$('#stage').focus({preventScroll:true});
  }
  else if(action==='context')openModal('我的产品实验室','<p class="modal-copy">当前项目：拾光 · 习惯养成 App。原型、主会话与修改候选属于同一个项目。本评审稿仅包含这一份示例，不读取真实项目文件。</p><button class="button primary" data-action="close-modal">继续设计</button>');
  else if(action==='focus')setFocusMode(!$('.studio').classList.contains('focus-mode'));
  else if(action==='restart'||action==='start-from-flow'){const start=entryPage()?.id||state.pages[0]?.id||'';runtime={completed:false,verifiedCompletion:false,evidenceRevision:state.revision,path:[start],scenarios:{},subview:null};ui.mode='play';navigate(start);if($('#modal').open)closeModal();toast(`已从${entryPage()?.name||'入口'}重新开始，设计内容保持不变。`);}
  else if(action==='clear-selection'){ui.selection=null;state.selectedElement='';render();}
  else if(action==='ask-selection'){toggleChat(true);$('#agent-input').value=`让这处${fieldName(ui.selection.field)}更明确，保留其他内容。`;$('#agent-input').focus();}
  else if(action==='suggest-copy'){if(!ui.selection){navigate('detail');}runAgent(ui.selection?`让这处${fieldName(ui.selection.field)}文案更明确，保留其他内容。`:'让打卡按钮文案更明确，保留其他内容。');}
  else if(action==='suggest-style')runAgent('换一种温暖的配色，保留布局和文字。');
  else if(action==='cancel'){ui.ticket+=1;ui.busy=false;renderMessages();appendMessage('agent','这次修改已取消，当前版本保持不变。');}
  else if(action==='preview-candidate'){
    if(!ui.candidate)return;
    state.selectedPage=ui.candidate.page;runtime.subview=null;runtime.scenarios[state.selectedPage]='normal';ui.mode='play';state.selectedElement='';ui.selection=null;ui.previewCandidate=true;render();
    if(matchMedia('(max-width:760px)').matches){$('.studio').classList.remove('chat-open');syncLayoutControls();$('.mobile-chat-fab').focus();fitPreview();}
  }
  else if(action==='leave-candidate'){ui.previewCandidate=false;render();}
  else if(action==='adopt')adoptCandidate();
  else if(action==='discard'){ui.candidate=null;ui.previewCandidate=false;render();renderMessages();toast('候选已丢弃，当前稿未改变。');}
  else if(action==='undo'||action==='redo')travel(action);
  else if(action==='export')exportPrototype();
  else if(action==='toggle-page-sidebar')setPageSidebar(state.sidebarCollapsed,sourceElement);
  else if(action==='close-page-sidebar')setPageSidebar(false);
  else if(action==='add-group')showGroupForm();
  else if(action==='add-page')showPageForm(sourceElement?.closest('[data-group-id]')?.dataset.groupId||'');
  else if(action==='rename-group')showGroupForm(sourceElement?.closest('[data-group-id]')?.dataset.groupId||'',true);
  else if(action==='delete-group')deleteGroup(sourceElement?.closest('[data-group-id]')?.dataset.groupId||'');
  else if(action==='toggle-group'){const groupId=sourceElement?.closest('[data-toggle-group]')?.dataset.toggleGroup;if(groupId){state.groupCollapsed[groupId]=!state.groupCollapsed[groupId];persist();render();}}
  else if(action==='page-menu')showPageMenu(sourceElement?.closest('[data-page-id]')?.dataset.pageId||'',sourceElement);
  else if(action==='duplicate-page')duplicatePage(sourceElement?.closest('[data-page-id]')?.dataset.pageId||'');
  else if(action==='show-move-menu')setMoveMenu(true);
  else if(action==='move-page-to'){
    const pageId=sourceElement?.dataset.pageId; const groupId=sourceElement?.dataset.groupId;
    if(pageId&&groupId){movePage(pageId,groupId);closePageMenu();toast('页面已移动到新分组。');}
  }
  else if(action==='delete-page')deletePage(sourceElement?.closest('[data-page-id]')?.dataset.pageId||'');
  else if(action==='set-entry'){
    const pageId=sourceElement?.closest('[data-page-id]')?.dataset.pageId;
    if(pageId&&state.pages.some(page=>page.id===pageId)){commit('更换入口页面',()=>{state.pages.forEach(page=>{page.entry=page.id===pageId;});});closePageMenu();closeModal();toast('入口页面已更新。');}
  }
  else if(action==='rename-page'){
    const pageId=sourceElement?.closest('[data-page-id]')?.dataset.pageId; const page=state.pages.find(item=>item.id===pageId);
    if(page){closePageMenu();openModal('重命名页面',`<form id="page-rename-form" data-page-id="${escapeHtml(page.id)}"><label class="form-label" for="page-rename">页面名称</label><input class="modal-input" id="page-rename" name="name" maxlength="60" required value="${escapeHtml(page.name)}"><div class="modal-footer"><button type="button" class="button" data-action="close-modal">取消</button><button type="submit" class="button primary">保存名称</button></div></form>`);$('#page-rename').focus();}
  }
}

/** 动态界面统一委托，编辑选择优先于 App 操作。 */
document.addEventListener('click',event=>{
  /** 当前点击的受控按钮或选区节点。 */
  const target=event.target;
  if(ui.pageMenu&&!target.closest('#page-context-menu')&&!target.closest('.page-more'))closePageMenu(false);
  // 浮层外的会话或工具点击可以继续工作；工作区遮罩只收起目录，避免穿透点击。
  if(!state.sidebarCollapsed&&!target.closest('#prototype-sidebar,#page-context-menu,#modal,[data-action="toggle-page-sidebar"],#page-sidebar-backdrop'))setPageSidebar(false,null,false);
  if(target.closest('#live-screen')){
    if(ui.mode==='inspect'){
      const element=target.closest('[data-element]');
      if(element&&['title','subtitle','cta'].includes(element.dataset.element)){ui.selection={page:state.selectedPage,field:element.dataset.element};state.selectedElement=element.dataset.element;render();$('#element-copy').focus();}
      else toast('可以选择页面中的标题、说明文字或主要操作。');
      return;
    }
    const button=target.closest('[data-app-action]');if(button)runAppAction(button.dataset.appAction,button.dataset.source);return;
  }
  const mode=target.closest('[data-mode]');if(mode){setMode(mode.dataset.mode);return;}
  const device=target.closest('[data-device]');if(device){state.device=device.dataset.device;persist();render();return;}
  const action=target.closest('[data-action]');if(action){handleAction(action.dataset.action,action);return;}
  const pageButton=target.closest('[data-page-nav]');if(pageButton){setPageSidebar(false);navigate(pageButton.dataset.pageNav);return;}
  const restore=target.closest('[data-restore]');if(restore){const item=state.history.find(version=>version.id===Number(restore.dataset.restore));if(item){commit(`恢复 v${item.id} 的内容`,()=>Object.assign(state,clone(item.snapshot)));showHistory();}return;}
  if(target===$('#modal')){const box=$('#modal').getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)closeModal();}
});
/** 文案保存与 Agent 请求是独立提交，不隐式保存输入框中尚未确认的文字。 */
document.addEventListener('submit',event=>{
  if(event.target.id==='agent-form'){event.preventDefault();const prompt=$('#agent-input').value.trim();if(prompt){runAgent(prompt);$('#agent-input').value='';}else toast('先描述要修改的内容，或选择下方的示例操作。');}
  else if(event.target.id==='element-form'){
    event.preventDefault();if(!ui.selection)return;
    const value=$('#element-copy').value.trim();if(!value){toast('显示文字不能为空。');return;}
    const field=ui.selection.field;if(value===currentPage()[field]){toast('内容没有变化。');return;}
    commit(`修改${currentPage().name}的${fieldName(field)}`,()=>{currentPage()[field]=value;});toast('文字已保存。');$('#element-copy')?.focus();
  }
  else if(event.target.id==='group-form'){
    event.preventDefault();
    const form=event.target; const name=new FormData(form).get('name')?.toString().trim(); if(!name){toast('分组名称不能为空。');return;}
    const groupId=form.dataset.groupId||''; const rename=form.dataset.rename==='true';
    if(rename){const group=state.groups.find(item=>item.id===groupId);if(group){commit(`重命名分组${group.name}`,()=>{group.name=name;});closeModal();toast('分组名称已更新。');}}
    else {if(state.groups.some(group=>group.name===name)){toast('已经存在同名分组。');return;}const id=`group-${Date.now().toString(36)}`;commit(`创建分组${name}`,()=>{state.groups.push({id,name,order:Math.max(-1,...state.groups.map(group=>group.order??0))+1});});closeModal();toast('分组已创建。');}
  }
  else if(event.target.id==='page-form'){
    event.preventDefault(); const form=event.target; const values=new FormData(form); const name=values.get('name')?.toString().trim(); const groupId=values.get('group')?.toString()||state.groups[0]?.id||''; const group=state.groups.find(item=>item.id===groupId); if(!name||!group){toast('请填写页面名称并选择分组。');return;}
    const id=`page-${Date.now().toString(36)}`; commit(`创建页面${name}`,()=>{const order=state.pages.filter(page=>page.groupId===groupId).reduce((max,page)=>Math.max(max,page.order??-1),-1)+1;state.pages.push({id,name,role:'自定义页面',title:name,subtitle:'为这张页面添加说明',cta:'继续',state:'normal',entry:false,groupId,order});state.selectedPage=id;});closeModal();toast('页面已创建，请在交互流程中补充连接。');
  }
  else if(event.target.id==='page-rename-form'){
    event.preventDefault(); const form=event.target; const page=state.pages.find(item=>item.id===form.dataset.pageId); const name=new FormData(form).get('name')?.toString().trim(); if(!page||!name){toast('页面名称不能为空。');return;} commit(`重命名页面${page.name}`,()=>{page.name=name;});closeModal();toast('页面名称已更新。');
  }
});
/** 状态切换只影响体验；连接修改才进入设计版本。 */
document.addEventListener('change',event=>{
  if(event.target.id==='scenario-select'){runtime.scenarios[state.selectedPage]=event.target.value;render();}
  else if(event.target.matches('[data-link-source]')){const source=event.target.dataset.linkSource;const target=event.target.value;commit('调整页面跳转',()=>{state.links[source]=target;});showFlow();toast('页面连接已更新。');}
});
/** 页面搜索只影响目录可见项，不改变当前页面和流程连接。 */
document.addEventListener('input',event=>{if(event.target.id==='page-search-input')renderPageDirectory();});
/** 目录拖拽只修改页面目录顺序；不改写流程连接。 */
document.addEventListener('dragstart',event=>{const page=event.target.closest('[data-drag-page]');if(!page)return;ui.dragPage=page.dataset.dragPage;page.classList.add('dragging');event.dataTransfer?.setData('text/plain',ui.dragPage);if(event.dataTransfer)event.dataTransfer.effectAllowed='move';});
document.addEventListener('dragover',event=>{const dropTarget=event.target.closest('[data-drop-group],[data-drag-page]');if(!dropTarget||!ui.dragPage)return;event.preventDefault();document.querySelectorAll('.drag-over').forEach(node=>node.classList.remove('drag-over'));dropTarget.classList.add('drag-over');if(event.dataTransfer)event.dataTransfer.dropEffect='move';});
document.addEventListener('drop',event=>{const dropTarget=event.target.closest('[data-drag-page],[data-drop-group]');if(!dropTarget||!ui.dragPage)return;event.preventDefault();const pageId=ui.dragPage;const targetId=dropTarget.dataset.dragPage||'';const groupId=dropTarget.dataset.groupId||dropTarget.dataset.dropGroup||'';if(pageId!==targetId&&groupId)movePage(pageId,groupId,targetId);ui.dragPage=null;document.querySelectorAll('.drag-over,.dragging').forEach(node=>node.classList.remove('drag-over','dragging'));});
document.addEventListener('dragend',()=>{ui.dragPage=null;document.querySelectorAll('.drag-over,.dragging').forEach(node=>node.classList.remove('drag-over','dragging'));});
document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'&&!$('#modal').open){event.preventDefault();closePageMenu(false);setPageSidebar(true);$('#page-search-input').focus({preventScroll:true});}});
/** Escape 退回上一级编辑状态；输入时不拦截系统撤销。 */
document.addEventListener('keydown',event=>{
  if(ui.pageMenu){
    /** 键盘上下键只遍历当前一级菜单，移动子菜单用左右键进出。 */
    const parent=$('#page-context-menu .page-menu-parent');
    const submenuOpen=parent?.getAttribute('aria-expanded')==='true';
    if(event.key==='Escape'){
      event.preventDefault();
      if(submenuOpen){setMoveMenu(false);parent.focus();}else closePageMenu();
      return;
    }
    if(event.key==='Tab'){closePageMenu();return;}
    if(event.target.closest('#page-context-menu')){
      if(event.key==='ArrowRight'&&event.target===parent){event.preventDefault();setMoveMenu(true,true);return;}
      if(event.key==='ArrowLeft'&&submenuOpen){event.preventDefault();setMoveMenu(false);parent.focus();return;}
      if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
        event.preventDefault();
        /** 子菜单与主菜单各自维护焦点顺序，并略过禁用项。 */
        const inSubmenu=Boolean(event.target.closest('.page-menu-submenu'));
        const items=Array.from($('#page-context-menu').querySelectorAll('button:not(:disabled)')).filter(button=>Boolean(button.closest('.page-menu-submenu'))===inSubmenu);
        const index=items.indexOf(document.activeElement);
        const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;
        items[next]?.focus();return;
      }
    }
  }
  if(event.key==='Escape'&&!$('#modal').open&&!state.sidebarCollapsed){event.preventDefault();setPageSidebar(false);return;}
  if(event.key==='Escape'&&!$('#modal').open&&$('.studio').classList.contains('focus-mode')){event.preventDefault();setFocusMode(false);return;}
  if(ui.mode==='inspect'&&(event.key==='Enter'||event.key===' ')&&event.target.matches('#live-screen [data-element]:not(button)')){event.preventDefault();event.target.click();return;}
  if(event.key==='Escape'&&!$('#modal').open){if($('.studio').classList.contains('chat-open'))toggleChat();else if(ui.selection){ui.selection=null;state.selectedElement='';render();$('[data-mode="inspect"]').focus();}else if(ui.previewCandidate){ui.previewCandidate=false;render();}else if(ui.mode==='inspect'){setMode('play');$('[data-mode="play"]').focus();}}
  if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='z'&&!event.target.matches('textarea,input,select')){event.preventDefault();travel(event.shiftKey?'redo':'undo');}
});
/** 鼠标悬停展开移动菜单，触屏仍可点击同一入口。 */
$('#page-context-menu').addEventListener('pointerover',event=>{
  if(event.pointerType!=='mouse'||!ui.pageMenu)return;
  /** 只处理鼠标首次进入某一菜单项，不重复测量同一项内部的图标。 */
  const item=event.target.closest('.page-menu-item');
  if(!item||item.contains(event.relatedTarget)||item.closest('.page-menu-submenu'))return;
  setMoveMenu(item.classList.contains('page-menu-parent'));
});
/** 目录滚动后关闭菜单，避免菜单指向已滚出视口的页面。 */
$('#page-directory').addEventListener('scroll',()=>{if(ui.pageMenu)closePageMenu(false);});
/** 原生 dialog 在 Escape 与显式关闭时都恢复发起位置。 */
$('#modal').addEventListener('close',()=>{
  /** 重命名后目录会重绘，按页面身份恢复菜单触发器焦点。 */
  const previous=ui.focusBeforeModal;
  const target=previous?.isConnected?previous:previous?.dataset.pageId?document.querySelector(`.page-more[data-page-id="${CSS.escape(previous.dataset.pageId)}"]`):null;
  target?.focus({preventScroll:true});
});
/** 监听实际预览容器，侧栏或选区变化都能立即重新适配。 */
const previewObserver=new ResizeObserver(fitPreview);previewObserver.observe($('#preview-space'));
window.addEventListener('resize',()=>{if(ui.pageMenu)closePageMenu(false);if(!matchMedia('(max-width:760px)').matches)$('.studio').classList.remove('chat-open');syncLayoutControls();fitPreview();});
loadState();runtime.evidenceRevision=state.revision;persist();render();syncLayoutControls();
