/** Read-only real local UI check; all API writes are blocked, no provider calls. */
import { chromium } from '../apps/web/node_modules/playwright/index.mjs';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import path from 'node:path';
const origin = 'http://127.0.0.1:5180';
const output = path.resolve('evidence/script-loading/live');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'script-readonly-'));
const report = { origin, writes: [], errors: [], themes: [], native200: [], providerCalls: 0 };
let context;
try {
 context = await chromium.launchPersistentContext(profile, { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, viewport: null, args: ['--window-size=1440,1000'] });
 await context.route('**/api/v1/**', route => {
  const req = route.request();
  if (req.method() === 'GET') return route.continue();
  report.writes.push({method:req.method(),url:req.url()});
  return route.abort();
 });
 const settings = await context.newPage();
 await settings.goto('chrome://settings/appearance');
 await settings.locator('#zoomLevel').selectOption('1');
 const page = await context.newPage();
 page.on('pageerror', e => report.errors.push(e.message));
 await page.goto(origin);
 await page.locator('article').filter({has:page.getByRole('heading',{name:'M2 真实媒体验收 · 卡通小动物送果子 · 三镜',exact:true})}).getByRole('button',{name:'继续创作 →',exact:true}).click();
 await page.getByRole('button',{name:/3\s+剧本/}).click();
 const editor=page.getByRole('textbox',{name:'剧本正文',exact:true});
 await editor.waitFor();
 assert((await editor.inputValue()).length>10);
 for (const label of ['保存剧本','保留草稿并载入最新版本']) assert.equal(await page.getByRole('button',{name:label,exact:true}).count(),0);
 for (const label of ['估算秒数','本次分镜生成要求']) assert.equal(await page.getByLabel(label,{exact:true}).count(),0);
 assert.equal(await page.getByRole('heading',{name:'场景结构',exact:true}).count(),0);
 const capture=async name=>{ const cdp=await context.newCDPSession(page); const r=await cdp.send('Page.captureScreenshot',{format:'png',fromSurface:true});await writeFile(path.join(output,name),Buffer.from(r.data,'base64'));await cdp.detach(); };
 for(const theme of ['light','dark','sky','noir']) {
  await page.getByLabel('UI主题',{exact:true}).selectOption(theme);
  await editor.scrollIntoViewIfNeeded();
  await capture(theme+'-script.png'); report.themes.push(theme);
 }
 await settings.locator('#zoomLevel').selectOption('2');
 await page.bringToFront(); await page.reload();
 await page.locator('article').filter({has:page.getByRole('heading',{name:'M2 真实媒体验收 · 卡通小动物送果子 · 三镜',exact:true})}).getByRole('button',{name:'继续创作 →',exact:true}).click();
 await page.getByRole('button',{name:/3\s+剧本/}).click();
 await editor.waitFor();
 report.metrics=await page.evaluate(()=>({innerWidth,devicePixelRatio,scale:visualViewport.scale}));
 assert.equal(report.metrics.innerWidth,720); assert.equal(report.metrics.devicePixelRatio,2);assert.equal(report.metrics.scale,1);
 for(const [locator,name] of [[editor,'剧本正文'],[page.getByRole('button',{name:'确认剧本并AI生成分镜',exact:true}),'生成分镜']]) {
  await locator.scrollIntoViewIfNeeded();await locator.click({trial:true});
  await locator.evaluate(el=>Promise.all(el.getAnimations().map(a=>a.finished.catch(()=>{}))));
  const box=await locator.boundingBox(); assert(box.x>=0 && box.x+box.width<=721);
  const styles=await locator.evaluate(el=>{const s=getComputedStyle(el);return {color:s.color,background:s.background,disabled:el.disabled,action:s.getPropertyValue("--action")};});
  report.native200.push({name,reachable:true,box,styles});await capture('native200-'+name+'.png');
 }
 assert.deepEqual(report.writes,[]);assert.deepEqual(report.errors,[]);report.passed=true;
} finally {
 if(context) await context.close();await rm(profile,{recursive:true,force:true});
 await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
}
console.log(JSON.stringify(report,null,2));
