/** Read-only production visual evidence. Blocks all writes including model calls. */
import {chromium} from '../apps/web/node_modules/playwright/index.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const pid='8916ef02-2715-468f-86fa-c5dfc84673a8';
const project=await fetch(`http://127.0.0.1:8010/api/v1/projects/${pid}`).then(r=>r.json());
await mkdir('evidence/project-board-polish',{recursive:true});
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const results=[];
try{const page=await browser.newPage({viewport:{width:1920,height:1080}});const blocked=[];const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/api/v1/**',r=>{if(r.request().method()==='GET')return r.continue();blocked.push(r.request().method()+' '+new URL(r.request().url()).pathname);return r.abort()});await page.goto('http://127.0.0.1:5180/');await page.locator('.cards article').filter({has:page.getByRole('heading',{name:project.name,exact:true})}).getByRole('button',{name:'继续创作 →'}).click();await page.getByRole('button',{name:/4\s+分镜/}).click();await page.locator('.reference-square').first().waitFor();await page.locator('.heading-project-info strong').waitFor();
for(const theme of ['light','dark','sky','noir']){await page.getByLabel('UI主题').selectOption(theme);for(const width of [1440,1920,2560]){await page.setViewportSize({width,height:1080});const geometry=await page.locator('main').evaluate(n=>({maxWidth:getComputedStyle(n).maxWidth,width:n.getBoundingClientRect().width}));assert.equal(geometry.maxWidth,'none');results.push({theme,width,geometry});}
await page.setViewportSize({width:1920,height:1080});await page.screenshot({path:`evidence/project-board-polish/${theme}-board.png`});for(const kind of ['角色','场景','道具']){await page.getByRole('button',{name:kind+'管理',exact:true}).click();const d=page.getByRole('dialog',{name:kind+'管理',exact:true});await d.locator('.entity-catalog-table').waitFor();await d.screenshot({path:`evidence/project-board-polish/${theme}-${kind}.png`});await d.getByRole('button',{name:'关闭元素管理'}).click();}}
assert.equal(blocked.length,0);assert.equal(errors.length,0);await writeFile('evidence/project-board-polish/live.json',JSON.stringify({projectId:pid,results,blocked,errors,providerCalls:0},null,2));console.log(JSON.stringify({checks:results.length,blocked,errors}));}finally{await browser.close()}
