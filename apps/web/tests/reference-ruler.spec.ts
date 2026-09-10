import { test, expect } from "@playwright/test";
import { setupStrictEntityPage } from "./fixtures/entity-strict";
for (const theme of ["light", "dark", "sky", "noir"])
  test(`reference ruler ${theme}: whole table, compact controls, persisted visibility`, async ({
    page,
  }) => {
    const fx = await setupStrictEntityPage(page);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.getByLabel("UI主题").selectOption(theme);
    await expect(page.locator("main")).toHaveCSS("max-width", "none");
    const squares = page.locator(".reference-square");
    await expect(squares).toHaveCount(4);
    const boxes = await squares.evaluateAll((nodes) =>
      nodes.map((n) => {
        const r = n.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }),
    );
    expect(boxes.every((b) => b.width === 64 && b.height === 64)).toBe(true);
    expect(new Set(boxes.map((b) => b.x)).size).toBe(1);
    expect(boxes[3].y).toBeGreaterThan(boxes[0].y);
    await expect(page.locator(".dialogue-line .line-voice")).toHaveCount(0);
    await page.getByRole("button", { name: "配置配音", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "配置配音", exact: true });
    await expect(dialog.getByLabel("逐句音色 ID")).toHaveValue(
      "male-qn-qingse",
    );
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "角色管理", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "角色管理", exact: true });
    await expect(dialog.locator(".entity-catalog-table tbody tr")).toHaveCount(
      2,
    );
    await expect(dialog.locator("th")).toHaveText([
      "序号",
      "角色名",
      "描述",
      "音色",
      "参考图",
      "图片",
      "操作",
    ]);
    await dialog.getByLabel("元素描述").first().fill("第一个草稿");
    await dialog.getByLabel("元素描述").nth(1).fill("第二个草稿");
    await page.screenshot({ path: `test-results/ruler-${theme}-entities.png` });
    await dialog.getByRole("button", { name: "关闭元素管理" }).click();
    await page.getByRole("button", { name: "角色管理", exact: true }).click();
    await expect(dialog.getByLabel("元素描述").first()).toHaveValue(
      "第一个草稿",
    );
    await expect(dialog.getByLabel("元素描述").nth(1)).toHaveValue(
      "第二个草稿",
    );
    await dialog.getByRole("button", { name: "关闭元素管理" }).click();
    await page.getByRole("button", { name: "界面设置", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "界面设置", exact: true });
    await dialog.getByLabel("视频", { exact: true }).uncheck();
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(
      page.locator(".board-table th").filter({ hasText: /^视频$/ }),
    ).toBeHidden();
    await page.screenshot({ path: `test-results/ruler-${theme}-board.png` });
    await page.reload();
    await page
      .locator(".cards article")
      .filter({ hasText: "三元素项目A" })
      .getByRole("button", { name: "继续创作 →" })
      .click();
    await page.getByRole("button", { name: "4　分镜" }).click();
    await expect(
      page.locator(".board-table th").filter({ hasText: /^视频$/ }),
    ).toBeHidden();
    expect(fx.writes).toHaveLength(0);
  });
