import {chromium} from '../apps/web/node_modules/playwright/index.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1920,height:1080}}),writes=[],errors=[],checks=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/v1/**',r=>{if(r.request().method()==='GET')return r.continue();writes.push(r.request().method());return r.abort()});
 await page.goto('http://127.0.0.1:5180');
 await page.locator('.cards article').filter({has:page.getByRole('heading',{name:'8848',exact:true})}).getByRole('button',{name:'继续创作 →'}).click();await page.getByRole('button',{name:/4\s+分镜/}).click();
 const first=page.getByLabel('提示词预览').first();await first.getByRole('link',{name:'@阿伦·韦克',exact:true}).first().waitFor();
 const dir='evidence/inline-image-links';await mkdir(dir,{recursive:true});
 for(const theme of ['light','dark','sky','noir']){
  await page.getByLabel('UI主题').selectOption(theme);
  const text=await first.textContent();assert(text.includes('阿伦·韦克（@阿伦·韦克）'));
  await first.screenshot({path:`${dir}/${theme}-prompt.png`});
  await first.getByRole('link',{name:'@阿伦·韦克',exact:true}).first().click();
  const modal=page.getByRole('dialog',{name:'完整图片'});await modal.getByRole('img').waitFor();
  assert(await modal.getByRole('img').evaluate(img=>img.complete&&img.naturalWidth>0));
  await modal.screenshot({path:`${dir}/${theme}-preview.png`});
  await page.keyboard.press('Escape');assert.equal(await modal.isVisible(),false);checks.push({theme,inlineRole:true,preview:true});
 }
 assert.equal(writes.length,0);assert.equal(errors.length,0);await writeFile(`${dir}/live.json`,JSON.stringify({checks,writes,errors},null,2));console.log('Four themes inline links and decoded images passed');
}finally{await browser.close()}
