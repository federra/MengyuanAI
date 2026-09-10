/** Live local UI only: every API write is blocked. Never generates or changes project content. */
import { chromium } from "../apps/web/node_modules/playwright/index.mjs";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import path from "node:path";
const output = path.resolve("evidence/compact-live"),
  profile = await mkdtemp(path.join(tmpdir(), "compact-live-"));
await mkdir(output, { recursive: true });
const report = {
  writes: [],
  errors: [],
  checks: [],
  themes: [],
  providerCalls: 0,
};
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    viewport: null,
    args: ["--window-size=1440,1000"],
  });
  await context.route("**/api/v1/**", (route) => {
    if (route.request().method() === "GET") return route.continue();
    report.writes.push(route.request().url());
    return route.abort();
  });
  const settings = await context.newPage();
  await settings.goto("chrome://settings/appearance");
  await settings.locator("#zoomLevel").selectOption("1");
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(e.message));
  const capture = async (name) => {
    await page.evaluate(() =>
      Promise.all(
        document.getAnimations().map((a) => a.finished.catch(() => {})),
      ),
    );
    const c = await context.newCDPSession(page);
    const r = await c.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    });
    await writeFile(
      path.join(output, name + ".png"),
      Buffer.from(r.data, "base64"),
    );
    await c.detach();
  };
  const openBoard = async () => {
    await page.goto("http://127.0.0.1:5180/");
    await page
      .locator("article")
      .filter({
        has: page.getByRole("heading", {
          name: "M2 真实媒体验收 · 卡通小动物送果子 · 三镜",
          exact: true,
        }),
      })
      .getByRole("button", { name: "继续创作 →", exact: true })
      .click();
    await page.getByRole("button", { name: /4\s+分镜/ }).click();
    await page.locator(".board-table").waitFor();
  };
  await openBoard();
  await page.getByRole("button", { name: "收起页面栏", exact: true }).click();
  assert.equal(
    Math.round((await page.locator(".app-sidebar").boundingBox()).width),
    68,
  );
  await page.getByRole("button", { name: "收起导演助手", exact: true }).click();
  for (const theme of ["light", "dark", "sky", "noir"]) {
    await page.getByLabel("UI主题", { exact: true }).selectOption(theme);
    await page.evaluate(() => scrollTo(0, 0));
    const toolbar = page.getByRole("toolbar", { name: "分镜工具栏" });
    await toolbar.waitFor();
    const names = await toolbar
      .locator(
        ":scope > button, :scope > .actions > button, :scope > div > button",
      )
      .allTextContents();
    report.themes.push({ theme, toolbar: names });
    assert.deepEqual(await page.locator(".board-table th").allTextContents(), [
      "序号",
      "台词",
      "角色/场景/道具",
      "提示词",
      "视频",
      "操作",
    ]);
    await capture(theme + "-board");
    for (const label of [
      "角色管理",
      "场景管理",
      "道具管理",
      "批量配音",
      "批量站位图",
      "生成设置",
      "导入分镜 JSON",
    ]) {
      const trigger = toolbar.getByRole("button", { name: label, exact: true });
      await trigger.click();
      const d = page.getByRole("dialog", { name: label, exact: true });
      await d.waitFor();
      assert(await d.isVisible());
      if (["角色管理", "场景管理", "道具管理"].includes(label)) {
        const imageAction = d
          .getByRole("button", { name: /^管理.+图片$/ })
          .first();
        if (await imageAction.count()) {
          await imageAction.click();
          await page
            .locator(".entity-reference-panel[aria-busy=false]")
            .waitFor();
        }
      }
      for (let n = 0; n < 3; n++) {
        await page.keyboard.press("Tab");
        assert(await d.evaluate((el) => el.contains(document.activeElement)));
      }
      await capture(theme + "-" + label.replaceAll(" ", ""));
      await d.getByRole("button", { name: /^关闭/ }).first().click();
      await page.waitForFunction(
        (el) => el === document.activeElement,
        await trigger.elementHandle(),
      );
    }
  }
  await settings.locator("#zoomLevel").selectOption("2");
  await page.bringToFront();
  await page.reload();
  await openBoard();
  report.zoom = await page.evaluate(() => ({
    innerWidth,
    devicePixelRatio,
    scale: visualViewport.scale,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert.equal(report.zoom.innerWidth, 720);
  assert.equal(report.zoom.devicePixelRatio, 2);
  assert.equal(report.zoom.scale, 1);
  assert(report.zoom.scrollWidth <= 720);
  await page.getByRole("button", { name: "收起导演助手", exact: true }).click();
  for (const name of ["角色管理", "场景管理", "道具管理", "生成设置", "导入分镜 JSON"]) {
    const b = page
      .getByRole("toolbar", { name: "分镜工具栏" })
      .getByRole("button", { name, exact: true });
    await b.scrollIntoViewIfNeeded();
    await b.click();
    const d = page.getByRole("dialog", { name, exact: true });
    await capture("native200-" + name.replaceAll(" ", ""));
    await d.getByRole("button", { name: /^关闭/ }).first().click();
    report.checks.push(name + " at native200 reachable");
  }
  assert.deepEqual(report.writes, []);
  assert.deepEqual(report.errors, []);
  report.passed = true;
} finally {
  if (context) await context.close();
  await rm(profile, { recursive: true, force: true });
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2),
  );
}
console.log(JSON.stringify(report, null, 2));
