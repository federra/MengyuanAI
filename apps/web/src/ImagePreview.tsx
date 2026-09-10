import { useEffect, useRef } from 'react';
import { trapDialogFocus } from './dialogFocus';
export function ImagePreview({src,title,onClose}:{src:string;title:string;onClose:()=>void}) {
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{dialog.current?.showModal();},[]);
 return <dialog ref={dialog} className="image-preview-dialog" aria-label="完整图片" onKeyDown={e=>{e.stopPropagation();trapDialogFocus(e)}} onClose={onClose}><header><strong>{title}</strong><button autoFocus onClick={()=>dialog.current?.close()}>关闭图片</button></header><img src={src} alt={title}/></dialog>;
}
