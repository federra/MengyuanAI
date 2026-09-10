/** Approved local upgrade smoke test. Creates one named QA project; no AI endpoints. */
import {chromium} from '../apps/web/node_modules/playwright/index.mjs';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const origin='http://127.0.0.1:8010', destination='evidence/entity-live-upgrade.json';
await mkdir('evidence',{recursive:true});
async function api(path,body,method=body?'POST':'GET') {
 const r=await fetch(origin+path,{method,headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},...(body?{body:JSON.stringify(body)}:{})});assert(r.ok,`${method} ${path}: ${r.status}`);return r.json();
}
let report;
try{report=JSON.parse(await readFile(destination,'utf8'));}catch{report={projectId:null,writes:[],checks:[],providerCalls:0};}
if(!report.projectId){const p=await api('/api/v1/projects',{name:'三类元素交互工程验收 · 2026-09-10（无模型调用）'});report.projectId=p.id;await writeFile(destination,JSON.stringify(report,null,2));}
const pid=report.projectId,root=`/api/v1/projects/${pid}`;
let entities=await api(root+'/entities');
if(!entities.length){await api(root+'/entities/batch',{base_board_version_id:null,items:[['character','卡通小松鼠'],['scene','卡通森林邮局'],['prop','卡通信封']].map(([kind,name])=>({id:crypto.randomUUID(),revision:0,kind,name,description:'升级工程验收初始描述',voice:'',three_view:false,input_file_id:null,output_file_id:null}))},'PUT');}
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 await page.route('**/api/v1/**',route=>{
   const r=route.request(),p=new URL(r.url()).pathname;
   if(r.method()==='GET')return route.continue();
   if(p===root+'/entities/batch'&&r.method()==='PUT'){report.writes.push({path:p,method:r.method()});return route.continue();}
   report.checks.push('blocked unexpected write '+p);return route.abort();
 });
 await page.goto('http://127.0.0.1:5180/');
 await page.locator('article').filter({has:page.getByRole('heading',{name:'三类元素交互工程验收 · 2026-09-10（无模型调用）',exact:true})}).getByRole('button',{name:'继续创作 →',exact:true}).click();
 await page.getByRole('button',{name:/4\s+分镜/}).click();
 const cases=[['角色','卡通小松鼠统一保存'],['场景','卡通森林邮局统一保存'],['道具','卡通信封统一保存']];
 for(const [kind,value] of cases){await page.getByRole('button',{name:kind+'管理',exact:true}).click();const d=page.getByRole('dialog',{name:kind+'管理',exact:true});await d.getByLabel('元素描述').fill(value);await d.getByRole('button',{name:'关闭元素管理'}).click();}
 await page.getByRole('button',{name:'角色管理',exact:true}).click();
 let d=page.getByRole('dialog',{name:'角色管理',exact:true});
 await d.getByRole('button',{name:'保存修改',exact:true}).click();
 await d.getByRole('status').filter({hasText:'已统一保存'}).waitFor();
 await d.screenshot({path:'evidence/entity-live-saved.png'});
 entities=await api(root+'/entities');assert.equal(entities.length,3);assert(cases.every(([,description])=>entities.some(e=>e.description===description)));
 assert.equal(report.writes.length,1);report.checks.push('one real HTTP transaction saved three kinds');
 await page.reload();
 await page.locator('article').filter({has:page.getByRole('heading',{name:'三类元素交互工程验收 · 2026-09-10（无模型调用）',exact:true})}).getByRole('button',{name:'继续创作 →',exact:true}).click();
 await page.getByRole('button',{name:/4\s+分镜/}).click();
 for(const [kind,value] of cases){await page.getByRole('button',{name:kind+'管理',exact:true}).click();d=page.getByRole('dialog',{name:kind+'管理',exact:true});assert.equal(await d.getByLabel('元素描述').inputValue(),value);await d.getByRole('button',{name:'关闭元素管理'}).click();}
 report.checks.push('browser reload retained all three descriptions');
 const jobs=await api(root+'/jobs');assert.equal(jobs.length,0);report.checks.push('QA project has zero model jobs');report.passed=true;
} finally {await browser.close();await writeFile(destination,JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify(report,null,2));
