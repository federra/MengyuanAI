/** Native Chrome page zoom; isolated profile and API substitutes, never production data. */
import { chromium } from '../apps/web/node_modules/playwright/index.mjs';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'evidence/production');
await mkdir(output,{recursive:true});
const profile=await mkdtemp(path.join(tmpdir(),'mengyuan-zoom-'));
const context=await chromium.launchPersistentContext(profile,{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,viewport:null,args:['--window-size=1440,1000']});
const report={browserMode:'Chrome headless (native browser page zoom)',screenshotMethod:'CDP Page.captureScreenshot fromSurface:true; avoids Playwright zoom capture override',roundingToleranceCSSPx:1,method:'Native Chrome settings appearance #zoomLevel selectOption("2"), isolated persistent profile, viewport:null; no CSS/pinch/device emulation',date:new Date().toISOString(),origin:'http://127.0.0.1:5182',checks:[]};
try{
 const native=await context.newPage();
 await native.goto('chrome://settings/appearance');
 await native.locator('#zoomLevel').selectOption('1');
 const page=await context.newPage();
 const pid='11111111-1111-4111-8111-111111111111';
 await page.route('**/api/v1/**',async route=>{
  const p=new URL(route.request().url()).pathname;
  let body=[];
  if(p==='/api/v1/projects')body={items:[1,2,3].map(n=>({id:n===1?pid:`00000000-0000-4000-8000-00000000000${n}`,name:`独立验收项目${n}`,market:'zh',revision:1,stage:'idea',status:'in_progress',generation_settings:{aspect_ratio:'16:9',resolution:'720P',width:1280,height:720},type_id:null,updated_at:'2026-09-10T00:00:00Z'})),total:3,statistics:{total:3,in_progress:3,completed:0,failed_jobs:0}};
  else if(p==='/api/v1/settings')body={project_types:[],prompt_count:0,text_configured:true,text_model:'fixture',enabled_job_kinds:[]};
  else if(p.includes('/bindings/'))body={revision:0,value:null};
  else if(p.endsWith('/idea'))body=null;
  else if(p.endsWith('/stories'))body={items:[],total:0,selected_version_id:null,selection_revision:0};
  else if(p.includes('/stages/'))body={item:null,confirmation:null,reports:[]};
  await route.fulfill({json:body});
 });
 await page.goto(report.origin);
 await page.getByRole('heading',{name:'独立验收项目1'}).waitFor();
 const capture=async(file)=>{const session=await context.newCDPSession(page);const result=await session.send('Page.captureScreenshot',{format:'png',fromSurface:true});await writeFile(file,Buffer.from(result.data,'base64'));await session.detach();};
 const metrics=()=>page.evaluate(()=>({innerWidth,innerHeight,outerWidth,outerHeight,devicePixelRatio,visualViewportScale:visualViewport.scale,bodyScrollWidth:document.body.scrollWidth,documentClientWidth:document.documentElement.clientWidth}));
 report.baseline=await metrics();
 await native.locator('#zoomLevel').selectOption('2');
 report.nativeSelected=await native.locator('#zoomLevel').inputValue();
 await page.bringToFront();
 await page.reload();
 await page.getByRole('heading',{name:'独立验收项目1'}).waitFor();
 report.zoomed=await metrics();
 if(Math.abs(report.zoomed.devicePixelRatio/report.baseline.devicePixelRatio-2)>.01||Math.abs(report.baseline.innerWidth/report.zoomed.innerWidth-2)>.03||report.zoomed.visualViewportScale!==1)throw Error('Native200%zoom metrics not established');
 async function reachable(locator,name){
  await locator.scrollIntoViewIfNeeded();
  await locator.click({trial:true});
  const box=await locator.boundingBox();
  const viewport=await metrics();
  if(!box||box.x<-.5||box.y<-.5||box.x+box.width>viewport.innerWidth+1||box.y+box.height>viewport.innerHeight+1)throw Error(name+' not within viewport after scroll');
  report.checks.push({name,reachable:true,box});
 }
 await reachable(page.locator('.project-create input').first(),'project name input');
 await page.locator('.project-create input').first().fill('200%缩放交互检查');
 await capture(path.join(output,'native-zoom200-project-input.png'));
 await reachable(page.getByRole('button',{name:'创建项目',exact:true}),'project create button');
 await capture(path.join(output,'native-zoom200-projects.png'));
 await reachable(page.getByRole('button',{name:'继续创作 →'}).first(),'continue creation button');
 await page.getByRole('button',{name:'继续创作 →'}).first().click();
 await page.getByLabel('一句话创意').fill('非真人卡通，三镜，两句台词。');
 await reachable(page.getByLabel('一句话创意'),'idea input');
 await capture(path.join(output,'native-zoom200-idea-input.png'));
 await page.getByLabel('故事数量').fill('2');
 await reachable(page.getByLabel('故事数量'),'story count input');
 await reachable(page.getByRole('button',{name:'AI生成故事方案',exact:true}),'generate story button');
 await capture(path.join(output,'native-zoom200-idea.png'));
 await page.getByRole('button',{name:'设置',exact:true}).click();
 await page.getByRole('dialog',{name:'设置',exact:true}).waitFor();
 await reachable(page.getByRole('dialog').getByRole('button',{name:'保存模型配置',exact:true}),'settings modal save button');
 await reachable(page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}),'settings modal close button');
 await capture(path.join(output,'native-zoom200-settings-modal.png'));
 report.dialog=await page.getByRole('dialog').boundingBox();
 await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();
 report.modalClosed=await page.getByRole('dialog').count()===0||!await page.getByRole('dialog').isVisible();
 report.focusRestored=await page.getByRole('button',{name:'设置',exact:true}).evaluate(el=>el===document.activeElement);
 report.pass=true;
}catch(error){report.pass=false;report.error=String(error);throw error;}
finally{await writeFile(path.join(output,'native-zoom200-verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await context.close();await rm(profile,{recursive:true,force:true});}
