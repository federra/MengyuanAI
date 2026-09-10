import {chromium} from '../apps/web/node_modules/playwright/index.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1920,height:1080}}),writes=[],errors=[];
 await page.route('**/api/v1/**',r=>{if(r.request().method()==='GET')return r.continue();writes.push(r.request().method());return r.abort()});
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:5180/');
 await page.locator('.cards article').filter({has:page.getByRole('heading',{name:'8848',exact:true})}).getByRole('button',{name:'继续创作 →'}).click();
 await page.getByRole('button',{name:/4\s+分镜/}).click();
 await page.getByRole('button',{name:'角色管理',exact:true}).click();
 const d=page.getByRole('dialog',{name:'角色管理',exact:true});
 await d.getByRole('button',{name:'保存修改',exact:true}).waitFor();
 await page.waitForFunction(()=>{const d=document.querySelector('dialog.entity-dialog');return d&&[...d.querySelectorAll('button')].some(b=>b.textContent==='保存修改'&&!b.disabled)});
 const result={project:'8848',saveEnabled:await d.getByRole('button',{name:'保存修改',exact:true}).isEnabled(),pending:await d.locator('.settings-dialog-footer small').allTextContents(),writes,errors,providerCalls:0};
 assert.equal(writes.length,0);assert.equal(errors.length,0);
 await mkdir('evidence/generated-image-save',{recursive:true});await d.screenshot({path:'evidence/generated-image-save/role-save-enabled.png'});await writeFile('evidence/generated-image-save/live.json',JSON.stringify(result,null,2));console.log(result);
}finally{await browser.close()}
