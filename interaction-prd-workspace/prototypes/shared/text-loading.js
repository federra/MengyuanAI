import {C} from './studio-ui.js';
const active=new Map();
export function beginText(target,selector){const token={state:C.s,target,selector};active.set(target,token);paintText();return token}
export function endText(token){if(active.get(token.target)===token)active.delete(token.target);paintText()}
export function paintText(){document.querySelectorAll('.ai-text-loading').forEach(e=>e.remove());for(const token of active.values()){if(token.state!==C.s)continue;const el=document.querySelector(token.selector);if(!el)continue;const box=document.createElement('div');box.className='ai-text-loading';box.setAttribute('role','status');box.textContent='AI生成中...';if(el.matches('textarea')){el.parentElement.style.position='relative';box.style.cssText='position:absolute;inset:24px 1px 1px;background:var(--surface,#fff);color:var(--text,#20252a);padding:14px;pointer-events:none';el.parentElement.append(box)}else{box.style.cssText='padding:16px;border:1px solid var(--border,#aaa);white-space:pre-wrap';el.prepend(box)}}}

// A user edit always takes precedence over a display-only loading veil.
document.addEventListener?.("input",e=>{for(const token of active.values())if(e.target.matches?.(token.selector)){active.delete(token.target);paintText()}},true);
