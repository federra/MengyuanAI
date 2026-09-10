import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const ctx=await browser.newContext({viewport:{width:1440,height:900}}),p=await ctx.newPage(),errors=[];
p.on('pageerror',e=>errors.push(e.message));
const goto=async id=>{await p.goto(`http://127.0.0.1:4173/content/prototypes/pages/${id}.html`);await p.locator('.page-heading').waitFor()};
const hub=()=>p.evaluate(()=>JSON.parse(localStorage.getItem('mengyuan-hub-v4')));
try{
 await goto('projects');
 assert.ok(await p.locator('#project-create').evaluate(e=>!!(e.compareDocumentPosition(document.querySelector('#project-library'))&Node.DOCUMENT_POSITION_FOLLOWING)));
 assert.equal(await p.locator('.project-grid').evaluate(e=>getComputedStyle(e).gridTemplateColumns.split(' ').length),3);
 await p.locator('#project-name').fill('V12 独立原型验证');await p.locator('#project-aspect').selectOption('16:9');await p.locator('#project-resolution').selectOption('4K');await p.locator('#create-project').click();await p.locator('#start-story').waitFor();
 assert.equal(await p.locator('#director-panel').count(),0);
 assert.ok((await p.locator('#idea-content').boundingBox()).height<=125);
 const method=await p.locator('.idea-generation-row .method-select').boundingBox(),button=await p.locator('#start-story').boundingBox();assert.ok(button.x>method.x+method.width);const select=await p.locator('[data-method-id=writingMethod]').boundingBox();assert.ok(Math.abs(button.y-select.y)<3,JSON.stringify({select,button}));
 await p.locator('#story-count').fill('4');await p.locator('#start-story').click();assert.ok(p.url().includes('creation.html'));
 for(const n of [1,2,3]){
  await goto('creation');await p.locator('#story-count').fill(String(n));await p.locator('#start-story').click();await p.locator('#choose-story').waitFor();
  const h=await hub(),s=h.projects.find(x=>x.id===h.activeId).workflow,batch=s.topics[0].batchId;
  assert.equal(s.topics.filter(t=>t.batchId===batch).length,n);assert.equal(s.jobs.find(j=>j.step==='novel').input.storyCount,n);
  assert.ok(await p.locator('#director-panel').isVisible());assert.equal(await p.locator('#more-stories').innerText(),`再生成 ${n} 个方案`);
 }
 await p.locator('#more-stories').click();assert.equal(await p.locator('.story-choice').count(),3);await p.locator('#page-down').click();assert.equal(await p.locator('.story-choice').count(),3);
 for(const theme of ['light','dark','sky','noir']){
  await goto('projects');await p.locator('#ui-theme').selectOption(theme);assert.equal(await p.locator('.project-grid').evaluate(e=>getComputedStyle(e).gridTemplateColumns.split(' ').length),3);
  await p.screenshot({path:`/private/tmp/v12-projects-${theme}.png`,fullPage:true});await goto('creation');assert.equal(await p.locator('#story-count').inputValue(),'3');assert.equal(await p.locator('#director-panel').count(),0);assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await p.screenshot({path:`/private/tmp/v12-creation-${theme}.png`});
 }
 await goto('story');await p.locator('#story-text').evaluate(e=>e.style.height='1400px');await p.evaluate(()=>scrollTo(0,500));await p.waitForTimeout(100);
 const nav=await p.locator('.studio-steps').boundingBox(),top=await p.locator('.topbar').boundingBox();assert.ok(Math.abs(nav.y-(top.y+top.height))<2,JSON.stringify({nav,top}));
 await goto('creation');await p.locator('#story-file').setInputFiles({name:'故事.txt',mimeType:'text/plain',buffer:Buffer.from('这是完整上传的故事。主角回家与家人团聚。')});await p.locator('#choose-story').waitFor();assert.equal(await p.locator('.story-choice').count(),1);assert.equal(await p.locator('#story-text').inputValue(),'这是完整上传的故事。主角回家与家人团聚。');assert.deepEqual(errors,[]);
 console.log('PASS V12: project order / 3 columns, 1–3 stories and snapshots, invalid count, history, TXT, assistant boundary, horizontal controls, four themes, sticky navigation.');
}finally{await browser.close()}
