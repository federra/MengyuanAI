import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const {build}=await import(pathToFileURL(path.join(workspace,'../apps/web/node_modules/esbuild/lib/main.js')));
const pagesDir=path.join(workspace,'prototypes/pages'),manifest=JSON.parse(await fs.readFile(path.join(workspace,'interaction-prd.json'),'utf8'));
const docs={};
for(const file of (await fs.readdir(pagesDir)).filter(x=>x.endsWith('.html'))){
 const abs=path.join(pagesDir,file),id=path.basename(file,'.html');let html=await fs.readFile(abs,'utf8');
 for(const match of [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)]){
  const r=await build({entryPoints:[path.resolve(pagesDir,match[1])],bundle:true,write:false,minify:true,logLevel:'silent'});
  html=html.replace(match[0],()=>'<style>'+r.outputFiles[0].text.replace(/<\/style/gi,'<\\/style')+'</style>');
 }
 for(const match of [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]){
  const src=match[1].match(/src="([^"]+)"/),module=/type="module"/.test(match[1]);let code;
  if(module){const args=src?{entryPoints:[path.resolve(pagesDir,src[1])]}:{stdin:{contents:match[2],resolveDir:pagesDir,sourcefile:file+'.js'}};const r=await build({...args,bundle:true,format:'iife',target:'es2020',write:false,minify:true,logLevel:'silent'});code=r.outputFiles[0].text;}
  else code=src?await fs.readFile(path.resolve(pagesDir,src[1]),'utf8'):match[2];
  html=html.replace(match[0],()=>'<script>'+code.replace(/<\/script/gi,'<\\/script')+'</script>');
 }
 const bridge=`<script>Object.defineProperty(window,'localStorage',{value:parent.demoStorage});document.addEventListener('click',function(e){if(e.defaultPrevented)return;const a=e.target.closest('a');if(!a)return;const id=a.dataset.nav||(a.getAttribute('href')||'').match(/(?:^|\\/)([a-z]+)\\.html(?:$|[?#])/i)?.[1];if(id&&parent.demoPages.includes(id)){e.preventDefault();e.stopImmediatePropagation();parent.openDemoPage(id);}});<\/script>`;
 html=html.replace('<head>','<head>'+bridge).replaceAll('本地交互演示','离线交互演示');docs[id]=Buffer.from(html).toString('base64');
}
const expected=manifest.pages.map(p=>p.id);if(expected.some(id=>!docs[id]))throw Error('Manifest page missing from export');
const payload=JSON.stringify(docs),output=path.join(workspace,'exports/AI短片工坊-可交互原型.html');
const runtime=`const documents=${payload};window.demoPages=Object.keys(documents);const storageKey='ai-shortfilm-standalone-v1';let cache={};try{cache=JSON.parse(localStorage.getItem(storageKey)||'{}')}catch{}const persist=()=>{try{localStorage.setItem(storageKey,JSON.stringify(cache))}catch{document.getElementById('storage-note').hidden=false}};window.demoStorage={getItem:k=>Object.hasOwn(cache,k)?cache[k]:null,setItem:(k,v)=>{cache[k]=String(v);persist()},removeItem:k=>{delete cache[k];persist()},clear:()=>{cache={};persist()},key:i=>Object.keys(cache)[i]||null,get length(){return Object.keys(cache).length}};function decode(s){return new TextDecoder().decode(Uint8Array.from(atob(s),c=>c.charCodeAt(0)))}window.openDemoPage=function(id,update=true){if(!documents[id])id='projects';document.getElementById('demo').srcdoc=decode(documents[id]);document.getElementById('page-picker').value=id;if(update&&location.hash!=='#'+id)location.hash=id;};window.addEventListener('hashchange',()=>{const id=location.hash.slice(1);if(document.getElementById('page-picker').value!==id)openDemoPage(id,false)});document.getElementById('page-picker').onchange=e=>openDemoPage(e.target.value);openDemoPage(location.hash.slice(1)||'projects',false);`;
const names={projects:'项目',creation:'创意工作台',story:'故事工作台',script:'剧本工作台',storyboard:'分镜工作台',finishing:'导出工作台',assets:'资产',tasks:'任务记录',settings:'系统设置',components:'组件示例',states:'状态示例'};
const result=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI短片工坊 · 单文件交互原型</title><style>html,body{height:100%;margin:0;background:#11151d;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}body{display:flex;flex-direction:column}.export-bar{display:flex;align-items:center;gap:16px;padding:8px 16px;color:#dce5f0;font-size:12px;flex-wrap:wrap}.export-bar select{font:inherit;background:#232e3e;color:#fff;border:1px solid #576a82;border-radius:5px;padding:5px 8px}#demo{display:block;flex:1;min-height:0;width:100%;border:0}#storage-note{color:#ffd895}[hidden]{display:none!important}</style></head><body><div class="export-bar"><label>页面 <select id="page-picker">${Object.entries(names).map(([id,n])=>`<option value="${id}">${n}</option>`).join('')}</select></label><span>离线交互原型 · AI与成片为演示 · 数据保存在当前浏览器，转发文件不携带已编辑数据</span><span id="storage-note" hidden>浏览器未允许持久保存；本次编辑仍可跨页面保留。</span></div><iframe id="demo" title="AI短片工坊交互原型"></iframe><script>${runtime.replace(/<\/script/gi,'<\\/script')}</script></body></html>`;
await fs.writeFile(output,result);console.log(JSON.stringify({output,pages:Object.keys(docs).length,bytes:Buffer.byteLength(result)},null,2));
