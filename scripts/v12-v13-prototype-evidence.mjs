/** Read-only PRD evidence; fixture data lives only in an isolated browser context. */
import { chromium } from '../apps/web/node_modules/playwright/index.mjs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.join(root, 'interaction-prd-workspace');
const output = path.resolve(process.env.PROTOTYPE_EVIDENCE_DIR || path.join(root, 'evidence/prototype'));
const manifest = JSON.parse(await readFile(path.join(workspace, 'interaction-prd.json'), 'utf8'));
const pages = ['projects', 'creation', 'story', 'script', 'storyboard', 'finishing', 'assets', 'tasks', 'settings'];
const pageFiles = Object.fromEntries(pages.map(id => {
  const entry = manifest.pages.find(p => p.id === id);
  if (!entry?.file) throw new Error('Manifest page missing: ' + id);
  return [id, entry.file];
}));
const baselineFiles = [...Object.values(pageFiles), ...['workflow-store.js', 'studio-hub.js', 'studio-board.js', 'studio-shot-controls.js', 'typography.css', 'workspace.css', 'ui-themes.css'].map(f => 'prototypes/shared/' + f)];
const hashes = {};
for (const name of baselineFiles) hashes[name] = createHash('sha256').update(await readFile(path.join(workspace, name))).digest('hex');
let origin = process.env.PROTOTYPE_URL || 'http://127.0.0.1:4173';
let server;
async function sameSource(url) {
  try {
    for (const name of baselineFiles) {
      const response = await fetch(url + '/content/' + name, {signal: AbortSignal.timeout(3000)});
      if (!response.ok || createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex') !== hashes[name]) return false;
    }
    return true;
  } catch { return false; }
}
if (!await sameSource(origin)) {
  const types = {'.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml'};
  server = createServer(async (req, res) => {
    try {
      if (req.method !== 'GET') {res.writeHead(405).end(); return;}
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (!pathname.startsWith('/content/')) {res.writeHead(404).end(); return;}
      const file = path.resolve(workspace, pathname.slice('/content/'.length));
      if (!file.startsWith(workspace + path.sep)) {res.writeHead(403).end(); return;}
      const body = await readFile(file);
      res.writeHead(200, {'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store'}).end(body);
    } catch {res.writeHead(404).end();}
  });
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(4183, '127.0.0.1', resolve);});
  origin = 'http://127.0.0.1:4183';
}
await mkdir(output, {recursive: true});
const report = {origin, viewport: {width:1440,height:900}, fixture: '3 projects / 3 stories / 3 shots, two dialogue lines; media absent', hashes, captures: [], failures: []};
const browser = await chromium.launch({headless:true, channel:'chrome'});
try {
  const context = await browser.newContext({viewport:report.viewport, reducedMotion:'reduce'});
  await context.route('**/*', route => {
    const request = route.request(), url = request.url();
    if (request.method() !== 'GET' || (!url.startsWith(origin + '/') && !url.startsWith('data:'))) return route.abort();
    return route.continue();
  });
  const page = await context.newPage();
  await page.goto(origin + '/content/' + pageFiles.creation);
  await page.waitForSelector('h1');
  await page.evaluate(async () => {
    const m = await import('/content/prototypes/shared/workflow-store.js');
    const h = m.hub(), s = m.initial();
    s.projectId = 'evidence-project-1'; s.title = '邮差收到未来的信'; s.idea = '邮差收到未来的信'; s.market = '中文'; s.duration = 12;
    m.setGeneration(s, {aspect:'16:9', resolution:'720P', model:'演示视频模型'});
    s.topics = [0,1,2].map(i => ({...m.makeTopic(s,i), id:'evidence-story-' + i, title:['未来来信','最后一站','空白信封'][i], generatedAt:1788998400000, batchId:'evidence-batch-1'}));
    m.selectNovel(s,s.topics[0]); m.buildScript(s); m.selectFinal(s,s.scriptDraft);
    s.pendingScript=false; s.pendingBoard=false; s.shots=m.makeShots(s);
    s.shots.forEach((sh,i) => {sh.dialogues=i<2?[{id:'evidence-line-'+i,speaker:'邮差',emotion:'克制',voice:'默认音色',text:['这封信来自明天。','我想把选择留给今天。'][i]}]:[];sh.dialogue=sh.dialogues.map(d=>d.text).join('\n');sh.duration=4;});
    s.boardScriptId=s.final.id;s.boardVersion=1;s.boardConfirmed=1;s.storyCount=3;
    h.projects=[{id:s.projectId,name:s.title,type:'剧情短片',market:'中文',updatedAt:1788998400000,workflow:s},...[2,3].map(i=>{const w=m.initial();w.projectId='evidence-project-'+i;w.title='短片项目 '+i;m.setGeneration(w,{aspect:'16:9',resolution:'720P',model:'演示视频模型'});return {id:w.projectId,name:w.title,type:'剧情短片',market:'中文',updatedAt:1788998400000-i,workflow:w};})];
    h.activeId=s.projectId; m.putHub(h);
  });
  async function stable() {
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.addStyleTag({content:'*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}.toast{display:none!important}'});
    await page.evaluate(async()=>{await document.fonts.ready;window.gsap?.globalTimeline?.progress(1);});
    await page.waitForTimeout(100);
  }
  async function capture(theme, id) {
    await stable();
    const file = theme + '-' + id + '.png';
    const measurements = await page.evaluate(() => {
      const samples={};
      for(const selector of ['h1','h2','.sidebar .nav-link','.studio-steps','.studio-steps .nav-link','.button.primary','textarea','#story-count','.model-tree-node','.model-tree-child','.clip-specs','dialog[open]']) {
        const node=document.querySelector(selector);if(!node)continue;const s=getComputedStyle(node),r=node.getBoundingClientRect();
        samples[selector]={fontFamily:s.fontFamily,fontSize:s.fontSize,fontWeight:s.fontWeight,lineHeight:s.lineHeight,letterSpacing:s.letterSpacing,height:r.height,width:r.width,x:r.x,y:r.y,color:s.color,background:s.backgroundColor};
      }
      return {samples, horizontalOverflow:document.documentElement.scrollWidth>innerWidth, boardColumns:document.querySelectorAll('.board thead th').length, projectCards:document.querySelectorAll('.project-card').length, dialogTitle:document.querySelector('dialog[open] h2')?.textContent||null};
    });
    await page.screenshot({path:path.join(output,file),fullPage:false});
    report.captures.push({theme,id,file,...measurements});
  }
  for (const theme of ['light','dark','sky','noir']) {
    await page.evaluate(theme=>localStorage.setItem('mengyuan-prototype-theme',theme),theme);
    for (const id of pages) {
      try {
        await page.goto(origin + '/content/' + pageFiles[id]);await page.waitForSelector('h1');
        await capture(theme,id);
      } catch(error) {report.failures.push({theme,id,error:String(error)});}
    }
    const dialogs=[
      ['storyboard','elements','[data-elements="角色"]'],
      ['storyboard','shot-settings','[data-shot-settings]'],
      ['storyboard','board-import','#import-board-json'],
      ['storyboard','generation-settings','#generation-settings'],
      ['settings','settings-model','[data-setting="system"]'],
      ['settings','settings-prompts','[data-setting="prompts"]'],
      ['settings','settings-styles','[data-setting="styles"]'],
    ];
    for(const [id,name,selector] of dialogs) {
      try {
        await page.goto(origin + '/content/' + pageFiles[id]);await page.waitForSelector('h1');await stable();
        await page.locator(selector).first().click();await page.waitForSelector('dialog[open]');
        await capture(theme,name);
      } catch(error) {report.failures.push({theme,id:name,error:String(error)});}
    }
  }
  console.log(JSON.stringify({output,captures:report.captures.length,failures:report.failures},null,2));
} finally {
  await writeFile(path.join(output,'measurements.json'),JSON.stringify(report,null,2)+'\n');
  await browser.close();if(server) await new Promise(resolve=>server.close(resolve));
}
if(report.failures.length)process.exitCode=1;
