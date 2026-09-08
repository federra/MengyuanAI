import {methodLabels,methodsFor,selectMethod} from './method-catalog.js';
import {read,write,hub} from './workflow-store.js';
import {esc,toast} from './components.js';
export {esc,toast};
export const C={s:read(),render:()=>{},settings:()=>{}};
export const $=id=>document.getElementById(id);
export function save(){try{write(C.s);return true}catch{toast('本地保存失败，当前编辑仍保留。请减少媒体文件后重试。');return false}}
export function on(id,fn){if($(id))$(id).onclick=fn;}
export function modal(title,body,footer=''){const d=$('studio-dialog');d.innerHTML=`<div class="panel-header"><h2 id="studio-dialog-title">${esc(title)}</h2><button class="icon-button" id="close-studio" aria-label="关闭详情">×</button></div>${body}${footer?`<div class="dialog-footer">${footer}</div>`:''}`;on('close-studio',()=>d.close());d.showModal();return d;}
export function confirm(title,body,fn){const d=modal(title,`<p>${esc(body)}</p>`,'<button class="button" id="cancel-change">返回</button><button class="button primary" id="accept-change">确认</button>');on('cancel-change',()=>d.close());on('accept-change',()=>{d.close();fn()});}
export function methodMarkup(key){const m=C.s[key],list=methodsFor(hub(),key);return `<div class="method-select"><label>${methodLabels[key]}<select data-method-id="${key}">${list.map(a=>`<option value="${esc(a.id)}" ${a.id===m?.resourceId?'selected':''}>${esc(a.name)}</option>`).join('')}</select></label><button class="text-button method-inspect" data-inspect-method="${key}">${m?.mode==='skill'?'Skill':'提示词模板'} · 查看 / 配置</button></div>`;}
export function bindMethods(root=document){root.querySelectorAll('[data-method-id]').forEach(e=>e.onchange=()=>{selectMethod(C.s,hub(),e.dataset.methodId,e.value);save();C.render()});root.querySelectorAll('[data-inspect-method]').forEach(b=>b.onclick=()=>C.editMethod(C.s[b.dataset.inspectMethod].resourceId));}
export const wait=ms=>new Promise(r=>setTimeout(r,ms));
