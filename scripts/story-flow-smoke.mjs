/** Real Chrome -> HTTP -> FastAPI -> temporary PostgreSQL. No route mocks. */
import { chromium } from '../apps/web/node_modules/playwright/index.mjs';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
const origin = process.argv[2];
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
const output = path.resolve('evidence/story-flow');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const report = { origin, date: new Date().toISOString(), apiMocking: false, checks: [], writes: [], errors: [] };
page.on('pageerror', error => report.errors.push(error.message));
page.on('request', request => {
  if (request.method() !== 'GET' && request.url().includes('/api/v1/'))
    report.writes.push({ method: request.method(), path: new URL(request.url()).pathname });
});
const api = async p => {
  const response = await context.request.get(origin + '/api/v1' + p);
  assert.equal(response.status(), 200, await response.text());
  return response.json();
};
const waitFor = async (operation, predicate, label) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await operation();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw Error('Timed out: ' + label);
};
const createProject = async name => {
  await page.getByLabel('项目名称', { exact: true }).fill(name);
  const saved = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/projects');
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  const response = await saved;
  assert.equal(response.status(), 201, await response.text());
  await page.getByLabel('一句话创意', { exact: true }).waitFor();
  return (await response.json()).id;
};
async function verifyNativeZoom() {
  const profile = await mkdtemp(path.join(tmpdir(), 'storyflow-native-zoom-'));
  let zoomContext;
  const zoom = { origin, date: new Date().toISOString(), apiMocking: false,
    method: 'Chrome native appearance zoom 200%, viewport:null; no CSS/pinch/device emulation',
    screenshotMethod: 'CDP Page.captureScreenshot fromSurface:true', checks: [], writes: [] };
  try {
    zoomContext = await chromium.launchPersistentContext(profile, {
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true, viewport: null, args: ['--window-size=1440,1000'],
    });
    const settings = await zoomContext.newPage();
    await settings.goto('chrome://settings/appearance');
    await settings.locator('#zoomLevel').selectOption('1');
    const app = await zoomContext.newPage();
    app.on('request', request => {
      if (request.method() !== 'GET' && request.url().includes('/api/v1/'))
        zoom.writes.push({ method: request.method(), path: new URL(request.url()).pathname });
    });
    await app.goto(origin);
    await app.getByRole('heading', { name: '真实HTTP烟测 · 纸船', exact: true }).waitFor();
    const metrics = () => app.evaluate(() => ({ innerWidth, innerHeight, outerWidth, outerHeight,
      devicePixelRatio, visualViewportScale: visualViewport.scale,
      bodyScrollWidth: document.body.scrollWidth, documentClientWidth: document.documentElement.clientWidth }));
    zoom.baseline = await metrics();
    await settings.locator('#zoomLevel').selectOption('2');
    zoom.nativeSelected = await settings.locator('#zoomLevel').inputValue();
    await app.bringToFront();
    await app.reload();
    await app.getByRole('heading', { name: '真实HTTP烟测 · 纸船', exact: true }).waitFor();
    zoom.zoomed = await metrics();
    assert.equal(zoom.zoomed.innerWidth, 720);
    assert.equal(zoom.zoomed.devicePixelRatio, 2);
    assert.equal(zoom.zoomed.visualViewportScale, 1);
    assert.equal(zoom.baseline.innerWidth / zoom.zoomed.innerWidth, 2);
    const capture = async name => {
      const cdp = await zoomContext.newCDPSession(app);
      const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      await writeFile(path.join(output, name), Buffer.from(result.data, 'base64'));
      await cdp.detach();
    };
    const reachable = async (locator, name) => {
      await locator.scrollIntoViewIfNeeded();
      await locator.click({ trial: true });
      const box = await locator.boundingBox();
      const viewport = await metrics();
      assert(box && box.x >= -0.5 && box.y >= -0.5 && box.x + box.width <= viewport.innerWidth + 1 && box.y + box.height <= viewport.innerHeight + 1,
        `${name} bounds ${JSON.stringify(box)} viewport ${JSON.stringify(viewport)}`);
      zoom.checks.push({ name, reachable: true, box, bodyScrollWidth: viewport.bodyScrollWidth, viewportWidth: viewport.innerWidth });
    };
    await app.getByLabel('项目名称', { exact: true }).fill('200%按钮可达性草稿');
    await reachable(app.getByRole('button', { name: '创建项目', exact: true }), 'project create button');
    await capture('04-native200-project-create.png');
    await app.locator('article').filter({ has: app.getByRole('heading', { name: '真实HTTP烟测 · 隔离项目', exact: true }) }).getByRole('button', { name: '继续创作 →', exact: true }).click();
    await reachable(app.getByRole('button', { name: '若已有小说故事，可点击上传', exact: true }), 'TXT upload button');
    await capture('05-native200-txt-upload.png');
    await app.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '项目', exact: true }).click();
    await app.locator('article').filter({ has: app.getByRole('heading', { name: '真实HTTP烟测 · 纸船', exact: true }) }).getByRole('button', { name: '继续创作 →', exact: true }).click();
    await reachable(app.getByLabel('故事正文', { exact: true }), 'story full text editor');
    await capture('06-native200-story-editor.png');
    await reachable(app.getByRole('button', { name: '确定故事并AI生成剧本', exact: true }), 'generate script button (trial only)');
    await capture('07-native200-script-button.png');
    await reachable(app.getByRole('button', { name: '重新质检', exact: true }), 'director review button (trial only)');
    await capture('08-native200-director-review.png');
    await reachable(app.getByRole('button', { name: '收起导演助手', exact: true }), 'director close button');
    await app.getByRole('button', { name: '收起导演助手', exact: true }).click();
    await reachable(app.getByRole('button', { name: '展开导演助手', exact: true }), 'director restore button');
    await app.getByRole('button', { name: '展开导演助手', exact: true }).click();
    await reachable(app.getByRole('button', { name: '收起导演助手', exact: true }), 'director close after restore');
    await capture('09-native200-director-controls.png');
    assert.deepEqual(zoom.writes, []);
    zoom.passed = true;
  } catch (error) {
    zoom.passed = false;
    zoom.failure = error.stack;
    throw error;
  } finally {
    if (zoomContext) await zoomContext.close();
    await rm(profile, { recursive: true, force: true });
    zoom.profileCleanedUp = true;
    await writeFile(path.join(output, 'native200-report.json'), JSON.stringify(zoom, null, 2));
  }
}
try {
  await page.goto(origin);
  const pid = await createProject('真实HTTP烟测 · 纸船');
  report.projectId = pid;
  report.checks.push('Created project enters idea stage without an extra navigation click');
  const idea = '小纸船带着一封信寻找星星，请保留完整结局。';
  await page.getByLabel('一句话创意', { exact: true }).fill(idea);
  await page.getByLabel('故事数量', { exact: true }).fill('2');
  const savedIdea = await waitFor(() => api(`/projects/${pid}/idea`), value => value?.body?.text === idea && value.body.story_count === 2, 'idea autosave');
  assert.equal(savedIdea.revision, 1);
  report.checks.push('Debounced idea and count save verified through real HTTP GET');
  const fullText = '  小纸船第一次看见星星。\n' + '它越过池塘，仍然记得送信的约定。\n'.repeat(180) + '\n尾声：信已送达。  ';
  await page.getByLabel('上传TXT故事', { exact: true }).setInputFiles({ name: '纸船全文.txt', mimeType: 'text/plain', buffer: Buffer.from(fullText, 'utf8') });
  await page.getByLabel('故事正文', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('故事正文', { exact: true }).inputValue(), fullText);
  const imported = await api(`/projects/${pid}/stories`);
  assert.equal(imported.source_mode, 'txt');
  assert.equal(imported.total, 1);
  assert.equal(imported.items.length, 1);
  assert.equal(imported.items[0].body.text, fullText);
  assert.equal(await page.getByRole('button', { name: /再生成\d+个方案/ }).count(), 0);
  report.importedBytes = Buffer.byteLength(fullText);
  report.importedSha256 = createHash('sha256').update(fullText).digest('hex');
  report.checks.push('Real TXT upload enters a single story card; UTF-8 full text matches including leading and trailing whitespace');
  await page.screenshot({ path: path.join(output, '01-txt-imported.png'), fullPage: true });
  const edited = fullText + '\n人工补充：小纸船回到了家。';
  await page.getByLabel('故事正文', { exact: true }).fill(edited);
  const editedStories = await waitFor(() => api(`/projects/${pid}/stories`), value => value.items[0]?.body.text === edited, 'story autosave');
  assert.equal(editedStories.items[0].revision, 2);
  const versions = await api(`/projects/${pid}/contents/${imported.items[0].id}/versions`);
  assert.equal(versions.length, 2);
  assert.equal(versions[1].body.text, fullText);
  report.checks.push('Manual story edit autosaves revision 2 while original TXT remains in revision 1');
  await page.reload();
  await page.getByRole('button', { name: '继续创作 →', exact: true }).click();
  await page.getByLabel('故事正文', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('故事正文', { exact: true }).inputValue(), edited);
  report.checks.push('Browser reload and continue-project restore the persisted full text');
  await page.screenshot({ path: path.join(output, '02-story-reloaded.png'), fullPage: true });
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '项目', exact: true }).click();
  const other = await createProject('真实HTTP烟测 · 隔离项目');
  assert.equal(await page.getByLabel('一句话创意', { exact: true }).inputValue(), '');
  assert.equal((await api(`/projects/${other}/stories`)).total, 0);
  assert.equal(await api(`/projects/${other}/idea`), null);
  assert.equal((await api(`/projects/${pid}/stories`)).items[0].body.text, edited);
  const foreign = await context.request.get(origin + `/api/v1/projects/${other}/versions/${imported.items[0].version_id}`);
  assert.equal(foreign.status(), 404);
  assert.deepEqual(await api(`/projects/${pid}/jobs`), []);
  assert.deepEqual(await api(`/projects/${other}/jobs`), []);
  report.checks.push('Second project is empty, foreign story lookup returns 404, first project remains unchanged');
  report.checks.push('Both projects have zero jobs; no generation/review endpoints were called');
  assert(report.writes.every(write => /\/projects$|\/idea$|\/stories\/import-txt$|\/stories\/[a-f\d-]+$/.test(write.path)));
  assert.deepEqual(report.errors, []);
  await verifyNativeZoom();
  report.checks.push('Native Chrome 200%: project create, TXT upload, story editor, script button, director review/close/restore reachable by scrolling; no API writes');
  report.passed = true;
  await page.screenshot({ path: path.join(output, '03-project-isolation.png'), fullPage: true });
} catch (error) {
  report.passed = false;
  report.failure = error.stack;
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
  throw error;
} finally {
  await writeFile(path.join(output, 'browser-report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
