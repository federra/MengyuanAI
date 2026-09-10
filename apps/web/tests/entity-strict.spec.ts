import { test, expect, type Page } from "@playwright/test";
import { setupStrictEntityPage, responseGate } from "./fixtures/entity-strict";

async function open(page: Page, kind = "角色") {
  await page.getByRole("button", { name: `${kind}管理`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `${kind}管理`, exact: true });
  await expect(dialog.getByLabel("元素名称").first()).toBeVisible();
  await dialog.getByRole("button", {name: /图片详情$/}).first().click();
  return dialog;
}
async function close(page: Page) {
  await page.getByRole("button", { name: "关闭元素管理" }).click();
}

test("whole table keeps two independent role drafts on reopening", async ({
  page,
}) => {
  const fx = await setupStrictEntityPage(page);
  const dialog = await open(page);
  const rows = dialog.locator(".entity-catalog-table tbody tr");
  await rows.nth(0).getByLabel("元素描述").fill("邮差草稿");
  await rows.nth(1).getByLabel("元素描述").fill("女孩草稿");
  await close(page);
  await open(page);
  await expect(rows.nth(0).getByLabel("元素描述")).toHaveValue("邮差草稿");
  await expect(rows.nth(1).getByLabel("元素描述")).toHaveValue("女孩草稿");
  expect(fx.writes).toHaveLength(0);
});

test("strict save all sends one atomic versioned batch and conflict retains every draft", async ({
  page,
}) => {
  const fx = await setupStrictEntityPage(page);
  for (const [kind, value] of [
    ["角色", "红制服草稿"],
    ["场景", "石制柜台草稿"],
    ["道具", "蓝色封蜡草稿"],
  ]) {
    const dialog = await open(page, kind);
    await dialog.getByLabel("元素描述").first().fill(value);
    await close(page);
  }
  const dialog = await open(page);
  fx.state.saveStatus = 409;
  await dialog.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("全部修改未保存");
  expect(fx.state.saveRequests).toHaveLength(1);
  expect(fx.state.saveRequests[0].body).toMatchObject({
    base_board_version_id: fx.boardVersion,
  });
  expect(fx.state.saveRequests[0].body.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: fx.ids.character,
        revision: 1,
        description: "红制服草稿",
        input_file_id: null,
        output_file_id: null,
      }),
      expect.objectContaining({
        id: fx.ids.scene,
        revision: 1,
        description: "石制柜台草稿",
      }),
      expect.objectContaining({
        id: fx.ids.prop,
        revision: 1,
        description: "蓝色封蜡草稿",
      }),
    ]),
  );
  expect(fx.state.saveRequests[0].body.items).toHaveLength(3);
  expect(fx.state.entities.every((e) => e.revision === 1)).toBe(true);
  await close(page);
  for (const [kind, value] of [
    ["角色", "红制服草稿"],
    ["场景", "石制柜台草稿"],
    ["道具", "蓝色封蜡草稿"],
  ]) {
    const current = await open(page, kind);
    await expect(current.getByLabel("元素描述").first()).toHaveValue(value);
    await close(page);
  }
  fx.state.saveStatus = 200;
  await open(page);
  await dialog.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("已统一保存 3 个元素");
  expect(fx.state.saveRequests[1].key).toBeTruthy();
  expect(fx.state.entities.filter((e) => e.revision === 2)).toHaveLength(3);
  expect(
    fx.writes.every(
      (w) => w.path.endsWith("/entities/batch") && w.method === "PUT",
    ),
  ).toBe(true);
});

test("strict uploaded input stays separate from outputs and is saved before generation", async ({
  page,
}) => {
  const fx = await setupStrictEntityPage(page);
  const dialog = await open(page);
  await dialog
    .getByRole("region", { name: "参考输入图" })
    .getByLabel("上传参考图")
    .setInputFiles({
      name: "input.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  await expect(
    dialog.getByRole("region", { name: "参考输入图" }).getByRole("img"),
  ).toHaveAttribute("src", new RegExp(fx.ids.inputFile));
  await expect(
    dialog.getByRole("region", { name: "当前生成图片" }).getByRole("img"),
  ).toHaveCount(0);
  expect(fx.writes.some((w) => w.path.endsWith("/reference-images"))).toBe(
    false,
  );
  await dialog.getByRole("button", { name: "生成图片", exact: true }).click();
  await expect(
    dialog.getByRole("region", { name: "图片生成确认" }),
  ).toHaveCount(0);
  await expect(dialog.getByRole("status")).toContainText("已提交 1 个图片任务");
  expect(fx.state.saveRequests[0].body.items).toEqual([
    expect.objectContaining({
      id: fx.ids.character,
      input_file_id: fx.ids.inputFile,
      output_file_id: null,
    }),
  ]);
  expect(fx.state.batchRequests[0].body).toEqual({
    items: [
      { entity_id: fx.ids.character, entity_revision: 2, instruction: "" },
    ],
  });
  expect(fx.writes.map((w) => w.path.split("/").at(-1))).toEqual([
    "files",
    "batch",
    "image-batches",
  ]);
});

test("strict direct batch unknown submission retries its frozen body and key", async ({
  page,
}) => {
  const fx = await setupStrictEntityPage(page);
  const dialog = await open(page);
  fx.state.batchAbortOnce = true;
  await dialog
    .getByRole("button", { name: "批量生成角色图片", exact: true })
    .click();
  const preview = dialog.getByRole("region", { name: "图片提交恢复" });
  await expect(dialog.getByRole("alert")).toBeVisible();
  await close(page);
  await open(page);
  await expect(
    dialog.getByRole("button", { name: "批量生成角色图片", exact: true }),
  ).toBeDisabled();
  await preview.getByRole("button", { name: "核实并重试原提交" }).click();
  await expect(dialog.getByRole("status")).toContainText("已提交 2 个图片任务");
  expect(fx.state.batchRequests).toHaveLength(2);
  expect(fx.state.batchRequests[0].key).toBeTruthy();
  expect(fx.state.batchRequests[1]).toEqual(fx.state.batchRequests[0]);
  expect(fx.state.batchRequests[0].body).toEqual({
    items: [
      {
        entity_id: fx.ids.character,
        entity_revision: 1,
        instruction: "",
      },
      {
        entity_id: fx.ids.secondCharacter,
        entity_revision: 1,
        instruction: "",
      },
    ],
  });
});

for (const mode of ["add", "replace"] as const)
  test(`strict binding sends saved entity and current board revisions in ${mode} mode`, async ({
    page,
  }) => {
    const fx = await setupStrictEntityPage(page);
    const dialog = await open(page);
    await dialog.getByLabel("元素描述").first().fill("绑定前统一保存");
    await dialog.getByRole("button", { name: "绑定镜头", exact: true }).click();
    const binding = dialog.getByRole("region", {
      name: "绑定镜头",
      exact: true,
    });
    await binding.getByLabel("绑定方式").selectOption(mode);
    await binding.getByRole("button", { name: "确认绑定" }).click();
    await expect(dialog.getByRole("status")).toContainText("已绑定镜头");
    expect(fx.state.bindRequests).toEqual([
      {
        path: `/api/v1/projects/${fx.ids.projectA}/entities/${fx.ids.character}/shot-bindings`,
        body: {
          entity_revision: 2,
          board_version_id: fx.boardVersion,
          shot_id: fx.ids.shot,
          mode,
        },
      },
    ]);
    expect(fx.writes.map((w) => w.path.split("/").at(-1))).toEqual([
      "batch",
      "shot-bindings",
    ]);
  });

test("strict referenced delete retains draft and unreferenced delete archives rather than removing history", async ({
  page,
}) => {
  const fx = await setupStrictEntityPage(page);
  const dialog = await open(page);
  await dialog.getByLabel("元素描述").first().fill("删除失败应保留");
  await dialog
    .getByRole("button", { name: "删除", exact: true })
    .first()
    .click();
  await dialog.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("仍被镜头引用");
  await expect(dialog.getByLabel("元素描述").first()).toHaveValue(
    "删除失败应保留",
  );
  expect(fx.state.entities.some((e) => e.id === fx.ids.character)).toBe(true);
  fx.state.blockDelete = false;
  await dialog.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(
    dialog.getByRole("status").filter({ hasText: "元素已移出管理列表" }),
  ).toBeVisible();
  await expect(
    dialog.locator('.entity-catalog-table input[value="邮差"]'),
  ).toHaveCount(0);
  expect(fx.state.archived[0].id).toBe(fx.ids.character);
  expect(fx.writes.filter((w) => w.method === "DELETE")).toHaveLength(2);
});

test("strict output selection persists its own file without converting it to an input", async ({
  page,
}) => {
  const fx = await setupStrictEntityPage(page);
  await page.route("**/reference-images", (route) =>
    route.fulfill({
      json: [
        {
          id: "output-reference",
          entity_id: fx.ids.character,
          entity_revision: 1,
          file_id: fx.ids.outputFile,
          confirmed: true,
          stale: false,
          name: "邮差输出图",
        },
      ],
    }),
  );
  const dialog = await open(page);
  await dialog.getByRole("button", { name: "选用此图片", exact: true }).click();
  await expect(
    dialog.getByRole("region", { name: "当前生成图片" }).getByRole("img"),
  ).toHaveAttribute("src", new RegExp(fx.ids.outputFile));
  await expect(
    dialog.getByRole("region", { name: "参考输入图" }).getByRole("img"),
  ).toHaveCount(0);
  expect(fx.writes).toHaveLength(0);
  await dialog.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(
    dialog.getByRole("status").filter({ hasText: "已统一保存" }),
  ).toBeVisible();
  expect(fx.state.saveRequests[0].body.items).toEqual([
    expect.objectContaining({
      id: fx.ids.character,
      input_file_id: null,
      output_file_id: fx.ids.outputFile,
      revision: 1,
    }),
  ]);
});

test("strict late project A save cannot replace project B element drafts", async ({
  page,
}) => {
  const fx = await setupStrictEntityPage(page);
  const first = await open(page);
  await first.getByLabel("元素描述").first().fill("项目A挂起保存");
  fx.state.saveGate = responseGate();
  await first.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect.poll(() => fx.state.saveRequests.length).toBe(1);
  await close(page);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "项目", exact: true })
    .click();
  await page
    .locator(".cards article")
    .filter({ hasText: "三元素项目B" })
    .getByRole("button", { name: "继续创作 →" })
    .click();
  await page.getByRole("button", { name: "4　分镜" }).click();
  await page.getByRole("button", { name: "角色管理", exact: true }).click();
  const second = page.getByRole("dialog", { name: "角色管理", exact: true });
  await second.getByRole("button", { name: "新增角色", exact: true }).click();
  await second.getByLabel("元素名称").first().fill("项目B角色草稿");
  await second.getByLabel("元素描述").first().fill("禁止A回执覆盖");
  const saved = page.waitForResponse((r) =>
    r.url().endsWith(`/projects/${fx.ids.projectA}/entities/batch`),
  );
  fx.state.saveGate.release();
  await saved;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(second.getByLabel("元素名称").first()).toHaveValue(
    "项目B角色草稿",
  );
  await expect(second.getByLabel("元素描述").first()).toHaveValue(
    "禁止A回执覆盖",
  );
  await expect(
    second.locator('.entity-catalog-table input[value="邮差"]'),
  ).toHaveCount(0);
});

test("strict library adoption freezes asset version and creates an independent project identity", async ({
  page,
}) => {
  const fx = await setupStrictEntityPage(page);
  const asset = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    version: 3,
    kind: "character",
    name: "资产库邮差",
    description: "库版本三描述",
    voice: "male-qn-qingse",
    three_view: false,
    input_image: null,
    output_image: null,
    created_at: "2026-09-10T00:00:00Z",
  };
  await page.route("**/library/assets", (route) =>
    route.fulfill({ json: [asset] }),
  );
  const adopted: unknown[] = [];
  await page.route(
    `**/projects/${fx.ids.projectA}/library-assets/${asset.id}/adoptions`,
    async (route) => {
      const body = route.request().postDataJSON();
      adopted.push(body);
      fx.state.entities.push({
        ...fx.state.entities[0],
        id: body.id,
        name: asset.name,
        description: asset.description,
        revision: 1,
      });
      await route.fulfill({ status: 201, json: fx.state.entities.at(-1) });
    },
  );
  const dialog = await open(page);
  await dialog.getByText("从资产库加入", { exact: true }).click();
  await dialog
    .getByRole("region", { name: "元素资产库" })
    .getByRole("button", { name: "加入当前项目" })
    .click();
  await expect(
    dialog.getByRole("button", { name: "资产库邮差图片详情", exact: true }),
  ).toBeVisible();
  expect(adopted).toEqual([
    { id: expect.stringMatching(/^[0-9a-f-]{36}$/), library_version: 3 },
  ]);
  expect((adopted[0] as { id: string }).id).not.toBe(asset.id);
  asset.description = "来源后来更改";
  await dialog
    .getByRole("button", { name: "资产库邮差图片详情", exact: true })
    .click();
  await expect(
    dialog.locator(".entity-selected-editor").getByLabel("元素描述"),
  ).toHaveValue("库版本三描述");
});

for (const theme of ["light", "dark", "sky", "noir"]) {
  test(`strict element windows ${theme} keep proportions, focus and actions reachable`, async ({
    page,
  }) => {
    await setupStrictEntityPage(page);
    await page.getByLabel("UI主题", { exact: true }).selectOption(theme);
    for (const name of ["角色管理", "场景管理", "道具管理"]) {
      await page.getByRole("button", { name, exact: true }).click();
      const dialog = page.getByRole("dialog", { name, exact: true });
      await expect(dialog.getByLabel("元素名称").first()).toBeVisible();
      const dimensions = await dialog.evaluate((d) => {
        const r = d.getBoundingClientRect();
        const list = d
          .querySelector(".entity-catalog-table")!
          .getBoundingClientRect();
        const input = d.querySelector("textarea")!.getBoundingClientRect();
        return {
          width: r.width,
          list: list.width,
          input: input.height,
          overflow: d.scrollWidth > d.clientWidth,
        };
      });
      expect(dimensions.width).toBe(1400);
      expect(dimensions.list).toBeGreaterThan(1000);
      expect(dimensions.input).toBe(140);
      expect(dimensions.overflow).toBe(false);
      await dialog.screenshot({
        path: `test-results/entity-${theme}-${name}.png`,
      });
      await dialog.press("Escape");
      await expect(
        page.getByRole("button", { name, exact: true }),
      ).toBeFocused();
    }
  });
}
