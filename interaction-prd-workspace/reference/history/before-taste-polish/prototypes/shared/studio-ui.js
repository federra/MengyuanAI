import {read,write} from './workflow-store.js';
import {esc,toast} from './components.js';
export {esc,toast};
export const C={s:read(),render:()=>{},settings:()=>{}};
export const $=id=>document.getElementById(id);
export function save(){try{write(C.s);return true}catch{toast('本地保存失败，当前编辑仍保留。请减少媒体文件后重试。');return false}}
export function on(id,fn){if($(id))$(id).onclick=fn;}
export function modal(title,body,footer=''){const d=$('studio-dialog');d.innerHTML=`<div class="panel-header"><h2 id="studio-dialog-title">${esc(title)}</h2><button class="icon-button" id="close-studio" aria-label="关闭详情">×</button></div>${body}${footer?`<div class="dialog-footer">${footer}</div>`:''}`;on('close-studio',()=>d.close());d.showModal();return d;}
export function confirm(title,body,fn){const d=modal(title,`<p>${esc(body)}</p>`,'<button class="button" id="cancel-change">返回</button><button class="button primary" id="accept-change">确认</button>');on('cancel-change',()=>d.close());on('accept-change',()=>{d.close();fn()});}
export function methodMarkup(key){const m=C.s[key];return `<div class="method-select"><label>${key==='writingMethod'?'写作':'剧本'}方式<select data-method-mode="${key}"><option value="skill" ${m.mode==='skill'?'selected':''}>${key==='writingMethod'?'写作':'剧本'} skill</option><option value="prompt" ${m.mode==='prompt'?'selected':''}>${key==='writingMethod'?'写作':'剧本'}提示词</option></select></label><details><summary>查看 / 编辑指令</summary><label class="field">${m.mode==='skill'?'Skill 内容（示例，可自定义）':'本次提示词'}<textarea data-method-text="${key}">${esc(m.text)}</textarea></label><p class="helper">选择和内容会随任务保存；此处未读取或运行机器上的真实 skill。</p></details></div>`;}
export function bindMethods(root=document){root.querySelectorAll('[data-method-mode]').forEach(e=>e.onchange=()=>{const m=C.s[e.dataset.methodMode];m.mode=e.value;m.version++;save()});root.querySelectorAll('[data-method-text]').forEach(e=>e.oninput=()=>{const m=C.s[e.dataset.methodText];m.text=e.value;m.version++;save()});}
export const wait=ms=>new Promise(r=>setTimeout(r,ms));
