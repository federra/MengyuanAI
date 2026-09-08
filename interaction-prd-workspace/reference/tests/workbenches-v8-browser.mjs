const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
import assert from 'node:assert/strict';
const b=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const page=await b.newPage({viewport:{width:1600,height:1050}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
const base=(process.env.PRD_URL||'http://127.0.0.1:4173')+'/content/prototypes/pages/';
const state=()=>page.evaluate(async()=>{const {C}=await import('../shared/studio-ui.js');return C.s});
try{
 await page.goto(base+'projects.html');await page.locator('#project-create').waitFor();
 await page.locator('#project-name').fill('V8工作流验证');await page.locator('#project-aspect').selectOption('16:9');await page.locator('#project-resolution').selectOption('4K');await page.getByText('创建并开始 →',{exact:true}).click();await page.waitForURL('**/creation.html');
 await page.locator('[data-method-id="writingMethod"]').first().selectOption('prompt-novel');
 const methodBefore=await page.locator('.generation-action-row').evaluate(e=>e.querySelector('.method-select').compareDocumentPosition(e.querySelector('#start-story'))&Node.DOCUMENT_POSITION_FOLLOWING);assert.ok(methodBefore);
 await page.locator('#start-story').click();await page.waitForURL('**/story.html');assert.equal(await page.locator('.story-choice').count(),3);assert.equal(await page.locator('#director-panel [data-method-id="writingMethod"]').inputValue(),'prompt-novel');
 await page.locator('[data-method-id="scriptMethod"]').selectOption('prompt-script');await page.locator('#choose-story').click();await page.waitForURL('**/script.html');await page.locator('#repair-script').waitFor();
 await page.locator('#repair-script').waitFor();assert.ok((await state()).scriptReport.issues.length);assert.equal(await page.locator('#director-panel [data-method-id="scriptMethod"]').inputValue(),'prompt-script');await page.locator('[data-method-id="boardMethod"]').selectOption('prompt-storyboard');await page.screenshot({path:'/private/tmp/prd-v8-script.png',fullPage:true});
 await page.locator('#to-board').click();await page.waitForURL('**/storyboard.html');await page.locator('#board-quality').waitFor();assert.equal(await page.locator('dialog[open]').count(),0);assert.ok((await state()).report.issues.length);assert.equal(await page.locator('#director-panel [data-method-id="boardMethod"]').inputValue(),'prompt-storyboard');
 await page.locator('#approve-board').click();assert.equal(await page.locator('#generate-assets').isEnabled(),true);assert.ok((await state()).report.issues.length);
 assert.equal(await page.locator('[data-reference-previous]').first().isDisabled(),true);
 await page.locator('#generate-assets').click();await page.locator('#confirm-assets').click();await page.locator('#approve-assets').click();await page.locator('[data-video]').first().click();await page.locator('#chain-state strong').filter({hasText:'本轮生成完成'}).waitFor();
 await page.locator('[data-reference-previous]').first().click();await page.locator('.video-frame-corner').first().waitFor();let s=await state();assert.ok(s.shots[1].prompt.includes('@['+s.shots[1].previousFrame.id+']'));assert.equal(s.shots[1].previousFrame.sourceVideoId,s.shots[0].video.id);assert.equal(s.aspect,'16:9');assert.equal(s.resolution,'4K');
 await page.locator('#ui-theme').selectOption('sky');await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'/private/tmp/prd-v8-board.png',fullPage:true});
 await page.locator('.video-frame-corner').first().click();assert.equal(await page.locator('dialog[open] img').count(),1);await page.locator('#close-studio').click();
 await page.goto(base+'finishing.html');assert.equal(await page.locator('#export-resolution').inputValue(),'4K');assert.equal((await state()).aspect,'16:9');
 await page.goto(base+'storyboard.html');const old=(await state()).boardVersion;await page.locator('#director-input').fill('加强动作连续性');await page.locator('#director-send').click();s=await state();assert.equal(s.boardVersion,old+1);assert.ok(s.history.some(x=>x.boardVersion===old));assert.equal(await page.locator('dialog[open]').count(),0);
 await page.locator('#approve-board').click();assert.ok((await state()).report.issues.length);await page.locator('#repair-board').click();assert.equal((await state()).report.issues.length,0);await page.locator('#approve-board').click();await page.locator('#toggle-director').click();assert.ok(await page.locator('.director-collapsed').count());
 assert.deepEqual(errors,[]);console.log('PASS: project specs → shared methods → QC bypass → assets → video → frame binding/preview → export inheritance → repeat board history/no modal.');
 console.log('ERRORS',errors);
}finally{await b.close()}
