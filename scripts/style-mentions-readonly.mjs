import {chromium} from '../apps/web/node_modules/playwright/index.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1920,height:1080}}), writes=[],errors=[],checks=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/v1/**',r=>{if(r.request().method()==='GET')return r.continue();writes.push(r.request().method());return r.abort()});
 await page.goto('http://127.0.0.1:5180');
 await page.locator('.cards article').filter({has:page.getByRole('heading',{name:'8848',exact:true})}).getByRole('button',{name:'继续创作 →'}).click();
 await page.getByRole('button',{name:/4\s+分镜/}).click();
 const input=page.getByRole('textbox',{name:'提示词',exact:true}).first();await input.waitFor();
 const dir='evidence/style-mentions';await mkdir(dir,{recursive:true});
 for(const theme of ['light','dark','sky','noir']){
  await page.getByLabel('UI主题').selectOption(theme);
  await input.press('ControlOrMeta+End');await input.pressSequentially('@');
  const d=page.getByRole('dialog',{name:'选择引用图片'});await d.getByRole('img').first().waitFor();
  const count=await d.getByRole('img').count();assert(count>0);
  await d.screenshot({path:`${dir}/${theme}-picker.png`});
  await page.keyboard.press('Escape');assert.equal(await d.isVisible(),false);
  const text=await input.inputValue();assert(!/@\[[0-9a-f-]{36}\]/.test(text));
  checks.push({theme,imageChoices:count,namedReferences:true});
 }
 const resources=await page.request.get('http://127.0.0.1:8010/api/v1/settings/resources?kind=style');const rows=await resources.json();
 for(const name of ['现代电影','古风写意','清新动画'])assert(rows.some(r=>r.name===name&&r.content.length>80));
 assert.equal(writes.length,0);assert.equal(errors.length,0);
 await writeFile(`${dir}/live.json`,JSON.stringify({checks,writes,errors,seedNames:['现代电影','古风写意','清新动画']},null,2));console.log('Four theme image picker and three persisted presets verified');
}finally{await browser.close()}
