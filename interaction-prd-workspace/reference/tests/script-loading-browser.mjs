import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||path.resolve(root,'../apps/web/node_modules/playwright/index.mjs'));
const out=path.join(root,'evidence/script-loading/prototype');await mkdir(out,{recursive:true});
const server=createServer(async(req,res)=>{try{const file=path.join(root,decodeURIComponent(req.url).replace(/^\/content\//,''));if(!file.startsWith(root+'/'))throw Error();res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');res.end(await readFile(file))}catch{res.writeHead(404);res.end()}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,channel:'chrome'}),ctx=await browser.newContext({viewport:{width:1440,height:1000}}),p=await ctx.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));
try{
 await p.goto(origin+'/content/prototypes/pages/creation.html');await p.locator('#start-story').click();await p.locator('#story-empty-output').waitFor();await p.getByText('AI生成中...',{exact:true}).waitFor();assert.equal(await p.locator('#story-empty-output').inputValue(),'');await p.screenshot({path:path.join(out,'story-initial-loading.png')});await p.locator('#choose-story').click();await p.getByText('AI生成中...',{exact:true}).waitFor();assert.equal(await p.locator('#screenplay').inputValue(),'');await p.screenshot({path:path.join(out,'script-initial-loading.png')});await p.waitForFunction(()=>document.querySelector('#screenplay')?.value.length>0);await p.waitForTimeout(800);
 const draft='【第一场 内景】\n人物：小兔\n动作：小兔打开木门。\n小兔：欢迎回来。\n\n【第二场 外景】\n小鸟飞向树梢。';await p.locator('#screenplay').fill(draft);await p.waitForTimeout(800);assert.equal(await p.locator('#script-save-state').innerText(),'已自动保存');
 for(const theme of ['light','dark','sky','noir']){await p.locator('#ui-theme').selectOption(theme);await p.waitForTimeout(100);assert.equal(await p.locator('#screenplay').inputValue(),draft);await p.screenshot({path:path.join(out,'script-'+theme+'.png')});}
 await p.locator('#director-input').fill('保持场景');await p.locator('#director-send').click();await p.getByText('AI生成中...',{exact:true}).waitFor();assert.equal(await p.locator('#screenplay').inputValue(),draft);await p.screenshot({path:path.join(out,'suggestion-loading.png')});await p.waitForTimeout(800);assert.equal(await p.locator('#screenplay').inputValue(),draft);
 await p.locator('#to-board').click();await p.getByText('AI生成中...',{exact:true}).waitFor();await p.screenshot({path:path.join(out,'board-initial-loading.png')});await p.locator('#storyboard-table').waitFor();
 const snapshot=await p.evaluate(async()=>{const {C}=await import('/content/prototypes/shared/studio-ui.js');return JSON.parse(JSON.stringify(C.s))});assert.equal(snapshot.final.text,draft);assert.ok(!JSON.stringify(snapshot).includes('AI生成中...'));assert.ok(snapshot.shots[0].prompt.includes('小兔打开木门'));assert.deepEqual(errors,[]);await writeFile(path.join(out,'result.json'),JSON.stringify({passed:true,checks:['initial story/script/board loading','four themes full screenplay','700ms autosave','suggestion never overwrites source','exact screenplay feeds board','display state absent from stored workflow'],errors},null,2));console.log('PASS script loading prototype');
}finally{await browser.close();await new Promise(r=>server.close(r))}
