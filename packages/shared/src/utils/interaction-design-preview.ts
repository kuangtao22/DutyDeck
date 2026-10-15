import type { PrototypeDraft } from '../types/interaction-design'

/** 预览消息只报告稳定身份，父窗口仍必须核对 event.source 与当前 iframe。 */
export interface PrototypePreviewMessage {
  type: 'prototype-select' | 'prototype-navigate'
  token: string
  pageId: string
  revision: number
  elementId?: string
  targetPageId?: string
}

/** 预览创建参数；资源必须由宿主读取已授权模块资产后提供。 */
export interface PrototypePreviewOptions {
  mode: 'play' | 'select'
  token: string
  revision: number
  assets: Record<string, string>
}

/** 序列化内联脚本数据，避免正文的闭合标签逃逸脚本。 */
function scriptData(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

/** 仅允许已校验的离线位图，拒绝协议或 SVG 可执行内容。 */
function replaceAssets(html: string, assets: Record<string, string>): string {
  return html.replace(/prototype-asset:([A-Za-z0-9_-]+)/g, (_match, id: string) => {
    const value = assets[id]
    return value && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(value) ? value : 'data:,'
  })
}

/** 解析有界消息；token/source/page/revision 的当前性由父页面复核。 */
export function parsePrototypePreviewMessage(value: unknown): PrototypePreviewMessage | null {
  if (!value || typeof value !== 'object') return null
  const message = value as Record<string, unknown>
  const id = (item: unknown): item is string => typeof item === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(item)
  if (!id(message.token) || !id(message.pageId) || !Number.isSafeInteger(message.revision) || Number(message.revision) < 0) return null
  if (message.type === 'prototype-select' && id(message.elementId)) return { type: message.type, token: message.token, pageId: message.pageId, revision: Number(message.revision), elementId: message.elementId }
  if (message.type === 'prototype-navigate' && id(message.targetPageId)) return { type: message.type, token: message.token, pageId: message.pageId, revision: Number(message.revision), targetPageId: message.targetPageId, ...(id(message.elementId) ? { elementId: message.elementId } : {}) }
  return null
}

/**
 * 构建单页 srcDoc；宿主必须设置 sandbox="allow-scripts" 并禁止 iframe 的跨文档导航。
 * 选择模式在捕获阶段拦截点击，体验模式仅把声明过的路由交给父页面。
 */
export function buildPrototypePreview(draft: PrototypeDraft, pageId: string, options: PrototypePreviewOptions): string {
  const page = draft.pages.find((item) => item.id === pageId)
  if (!page) throw new Error('页面不存在')
  const context = scriptData({ pageId, token: options.token, revision: options.revision, mode: options.mode, pages: draft.pages.map((item) => item.id), flows: draft.flows.filter((item) => item.fromPageId === pageId) })
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'"
  const bridge = `<script>(()=>{
    const config=${context};document.currentScript.remove();
    const host=parent,post=host.postMessage.bind(host),listen=EventTarget.prototype.addEventListener;
    const stop=Event.prototype.stopImmediatePropagation,prevent=Event.prototype.preventDefault;
    const closest=Element.prototype.closest,attr=Element.prototype.getAttribute;
    let mode=config.mode;
    const on=(type,fn)=>Reflect.apply(listen,window,[type,fn,true]);
    const cancel=e=>{Reflect.apply(prevent,e,[]);Reflect.apply(stop,e,[])};
    const get=(el,name)=>el?Reflect.apply(attr,el,[name]):null;
    const near=(el,selector)=>el instanceof Element?Reflect.apply(closest,el,[selector]):null;
    on('message',e=>{if(e.source!==host||!e.data||e.data.token!==config.token||e.data.type!=='prototype-mode')return;if(e.data.mode==='play'||e.data.mode==='select'){mode=e.data.mode;cancel(e)}});
    on('click',e=>{
      const element=near(e.target,'[data-prototype-element]'),elementId=get(element,'data-prototype-element');
      if(mode==='select'){cancel(e);if(e.isTrusted&&elementId)post({type:'prototype-select',token:config.token,pageId:config.pageId,revision:config.revision,elementId},'*');return}
      const route=near(e.target,'[data-prototype-page]');
      const flow=config.flows.find(item=>item.elementId===elementId);
      const targetPageId=flow?flow.targetPageId:get(route,'data-prototype-page');
      if(targetPageId){cancel(e);if(e.isTrusted&&config.pages.includes(targetPageId))post({type:'prototype-navigate',token:config.token,pageId:config.pageId,revision:config.revision,elementId:elementId||undefined,targetPageId},'*');return}
      if(near(e.target,'a[href],area[href]'))cancel(e);
    });
    on('auxclick',e=>{if(near(e.target,'a[href],area[href]'))cancel(e)});
    on('submit',cancel);
    for(const type of ['pointerdown','mousedown','keydown','beforeinput'])on(type,e=>{if(mode==='select'&&(type!=='keydown'||e.key==='Enter'||e.key===' '))cancel(e)});
  })()</script>`
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer">${bridge}${replaceAssets(page.html, options.assets)}`
}

/**
 * 结构检查仅检查 HTML 声明与页面连通性，不执行脚本、不证明真实交互已完成。
 * 输入是已通过领域 schema 校验的 draft；返回可读问题列表。
 */
export function validatePrototypeStructure(draft: PrototypeDraft): string[] {
  const issues: string[] = []
  const edges = new Map<string, Set<string>>()
  for (const page of draft.pages) {
    /** 去掉不会产生页面元素的注释和原始文本，避免脚本文字伪造静态连接。 */
    const markup = page.html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    /** 逐个解析开始标签的属性，带引号属性中的 > 不截断标签。 */
    const declarations = [...markup.matchAll(/<[a-z][a-z0-9:-]*(?:[^>"']|"[^"]*"|'[^']*')*>/gi)].map((tag) => {
      /** 属性名大小写按 HTML 规则处理，重复属性沿用浏览器的首个值。 */
      const attributes = new Map<string, string>()
      for (const attribute of tag[0].matchAll(/\s+([^\s=<>/'"]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        /** 已解析的属性名称与未解码的声明值。 */
        const name = attribute[1]!.toLowerCase()
        if (!attributes.has(name)) attributes.set(name, attribute[2] ?? attribute[3] ?? attribute[4] ?? '')
      }
      return { elementId: attributes.get('data-prototype-element'), targetPageId: attributes.get('data-prototype-page') }
    })
    /** 同页流程优先于元素上的 HTML 路由，必须与预览桥保持一致。 */
    const flows = draft.flows.filter((item) => item.fromPageId === page.id)
    const elements = declarations.flatMap((item) => item.elementId ? [item.elementId] : [])
    if (new Set(elements).size !== elements.length) issues.push(`${page.name}：受控元素 ID 重复`)
    const targets = new Set<string>()
    for (const declaration of declarations) {
      /** 同元素声明被流程覆盖时既报告冲突，也不把失效声明计入可达图。 */
      const flow = flows.find((item) => item.elementId === declaration.elementId)
      if (flow && declaration.targetPageId && flow.targetPageId !== declaration.targetPageId) {
        issues.push(`${page.name}：元素 ${declaration.elementId} 的 HTML 路由与流程连接冲突，预览采用流程目标 ${flow.targetPageId}`)
      }
      const target = flow?.targetPageId ?? declaration.targetPageId
      if (target) targets.add(target)
    }
    for (const flow of flows) {
      if (!elements.includes(flow.elementId)) issues.push(`${page.name}：连接元素 ${flow.elementId} 不存在`)
    }
    for (const target of targets) if (!draft.pages.some((item) => item.id === target)) issues.push(`${page.name}：导航目标 ${target} 不存在`)
    edges.set(page.id, targets)
    if (/(?:https?:\/\/|file:\/\/|<\s*(?:iframe|object|embed)\b)/i.test(page.html)) issues.push(`${page.name}：包含沙箱不可用的外部资源或嵌套内容`)
  }
  const visited = new Set<string>()
  const pending = [draft.entryPageId]
  while (pending.length) {
    const id = pending.pop()!
    if (visited.has(id)) continue
    visited.add(id)
    for (const target of edges.get(id) ?? []) pending.push(target)
  }
  for (const page of draft.pages) if (!visited.has(page.id)) issues.push(`${page.name}：从入口页不可达`)
  return issues
}

/** 导出独立离线文档；所有页面是惰性 srcDoc 字符串，始终只有一个活动 iframe。 */
export function buildPrototypeExport(draft: PrototypeDraft, assets: Record<string, string>): string {
  const token = 'offline-prototype'
  const pages = draft.pages.map((page) => ({ id: page.id, html: buildPrototypePreview(draft, page.id, { mode: 'play', token, revision: 0, assets }) }))
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>交互原型</title><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}body{overflow:hidden}</style><iframe sandbox="allow-scripts" referrerpolicy="no-referrer" title="交互原型"></iframe><script>(()=>{const pages=${scriptData(pages)},frame=document.querySelector('iframe');let current=${scriptData(draft.entryPageId)};function show(id){const page=pages.find(p=>p.id===id);if(page){current=id;frame.srcdoc=page.html}}window.addEventListener('message',e=>{const m=e.data;if(e.source!==frame.contentWindow||!m||m.type!=='prototype-navigate'||m.token!==${scriptData(token)}||m.pageId!==current||m.revision!==0)return;show(m.targetPageId)});show(current)})()</script></html>`
}
