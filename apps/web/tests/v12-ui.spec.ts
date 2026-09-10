import { test, expect } from "@playwright/test";
const pid = "11111111-1111-4111-8111-111111111111";
test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/**", async (route) => {
    const p = new URL(route.request().url()).pathname;
    let body: unknown = [];
    if (p === "/api/v1/projects")
      body = {
        items: [1, 2, 3].map((n) => ({
          id: n === 1 ? pid : `00000000-0000-4000-8000-00000000000${n}`,
          name: `独立验收项目${n}`,
          market: "zh",
          revision: 1,
          stage: "idea",
          status: "in_progress",
          generation_settings: {
            aspectRatio: "16:9",
            resolution: "720P",
            width: 1280,
            height: 720,
          },
          type_id: null,
          updated_at: "2026-09-10T00:00:00Z",
        })),
        total: 3,
        statistics: { total: 3, in_progress: 3, completed: 0, failed_jobs: 0 },
      };
    else if (/^\/api\/v1\/projects\/[^/]+$/.test(p)) {
      const id = p.split("/").at(-1)!;
      const number = id === pid ? 1 : Number(id.at(-1));
      body = {
        id,
        name: `独立验收项目${number}`,
        market: "zh",
        revision: 1,
        stage: "idea",
        status: "in_progress",
        type_id: null,
        generation_settings: {
          aspectRatio: "16:9",
          resolution: "720P",
          width: 1280,
          height: 720,
        },
        updated_at: "2026-09-10T00:00:00Z",
      };
    } else if (p === "/api/v1/settings")
      body = {
        project_types: [],
        prompt_count: 0,
        text_configured: true,
        text_model: "fixture",
        enabled_job_kinds: [],
      };
    else if (p.includes("/bindings/")) body = { revision: 0, value: null };
    else if (p.endsWith("/conversation"))
      body = { messages: [], proposals: [] };
    else if (p.endsWith("/idea")) body = null;
    else if (p.endsWith("/stories"))
      body = {
        items: [],
        total: 0,
        selected_version_id: null,
        selection_revision: 0,
      };
    else if (p.includes("/stages/"))
      body = { item: null, confirmation: null, reports: [] };
    await route.fulfill({ json: body });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "独立验收项目1" }),
  ).toBeVisible();
});
for (const theme of ["light", "dark", "sky", "noir"])
  test(`V12 layout and input controls in ${theme}`, async ({ page }) => {
    await page.getByLabel("UI主题").selectOption(theme);
    const create = await page.locator(".project-create").boundingBox();
    const library = await page.locator(".project-library").boundingBox();
    expect(create!.y + create!.height).toBeLessThanOrEqual(library!.y);
    const cards = await page
      .locator(".cards article")
      .evaluateAll((es) => es.map((e) => e.getBoundingClientRect().y));
    expect(Math.max(...cards) - Math.min(...cards)).toBeLessThanOrEqual(2);
    await page.screenshot({
      path: `test-results/flow-projects-${theme}.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "继续创作 →" }).first().click();
    await expect(page.getByLabel("一句话创意")).toBeEnabled();
    await page.screenshot({
      path: `test-results/flow-idea-${theme}.png`,
      fullPage: true,
    });
    expect((await page.getByLabel("一句话创意").boundingBox())!.height).toBe(
      115,
    );
    await expect(page.getByRole("heading", { name: "AI导演助手" })).toHaveCount(
      0,
    );
    await expect(page.getByLabel("故事数量")).toHaveValue("3");
    await page.getByLabel("一句话创意").fill("非真人卡通，三镜，两句台词。");
    for (const bad of ["", "0", "4", "1.5"]) {
      await page.getByLabel("故事数量").fill(bad);
      await expect(
        page.getByRole("button", { name: "AI生成故事方案", exact: true }),
      ).toBeDisabled();
    }
    await page.getByLabel("故事数量").fill("2");
    await expect(
      page.getByRole("button", { name: "AI生成故事方案", exact: true }),
    ).toBeEnabled();
    await page
      .getByLabel("UI主题")
      .selectOption(theme === "light" ? "dark" : "light");
    await expect(page.getByLabel("故事数量")).toHaveValue("2");
    await expect(page.getByLabel("一句话创意")).toHaveValue(
      "非真人卡通，三镜，两句台词。",
    );
  });

test("idea flow has no manual save or supplemental request controls", async ({
  page,
}) => {
  await page.getByRole("button", { name: "继续创作 →" }).first().click();
  await expect(page.getByLabel("一句话创意")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "保存创意", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "读取最新基准", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("本次补充要求")).toHaveCount(0);
});

test("successful project creation enters the idea stage directly", async ({
  page,
}) => {
  await page.route("**/api/v1/projects", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({
      status: 201,
      json: {
        id: pid,
        name: "新创意项目",
        market: "zh",
        revision: 1,
        stage: "idea",
        status: "in_progress",
        generation_settings: null,
        type_id: null,
        updated_at: "2026-09-10T00:00:00Z",
      },
    });
  });
  await page.getByLabel("项目名称", { exact: true }).fill("新创意项目");
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(page.getByLabel("一句话创意")).toBeEnabled();
});

test("TXT upload opens a single full story and does not generate candidates", async ({
  page,
}) => {
  const fullText =
    "小纸船离开码头。\n" + "它沿着星光寻找自己的家。".repeat(100);
  let imports = 0;
  let generated = 0;
  await page.route("**/stories/import-txt", async (route) => {
    imports++;
    expect(route.request().postDataJSON()).toEqual({
      filename: "纸船.txt",
      text: fullText,
      expected_story_version_id: null,
    });
    expect(route.request().headers()["idempotency-key"]).toBeTruthy();
    await page.route(/\/stories(?:\?.*)?$/, (getRoute) =>
      getRoute.fulfill({
        json: {
          items: [
            {
              id: "txt-story",
              kind: "story",
              revision: 1,
              version_id: "txt-v1",
              body: {
                title: "纸船",
                logline: "",
                direction: "",
                text: fullText,
              },
              batch_id: null,
              source_version_id: null,
              stale: false,
            },
          ],
          total: 1,
          selected_version_id: "txt-v1",
          selection_revision: 1,
          source_mode: "txt",
        },
      }),
    );
    await route.fulfill({
      json: {
        items: [
          {
            id: "txt-story",
            kind: "story",
            revision: 1,
            version_id: "txt-v1",
            body: { title: "纸船", logline: "", direction: "", text: fullText },
            batch_id: null,
            source_version_id: null,
            stale: false,
          },
        ],
        total: 1,
        selected_version_id: "txt-v1",
        selection_revision: 1,
        source_mode: "txt",
      },
    });
  });
  await page.route("**/story-batches", async (route) => {
    generated++;
    await route.abort();
  });
  await page.getByRole("button", { name: "继续创作 →" }).first().click();
  await page.getByLabel("上传TXT故事").setInputFiles({
    name: "纸船.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(fullText),
  });
  await expect(page.getByLabel("故事正文")).toHaveValue(fullText);
  await expect(
    page.getByRole("button", { name: /再生成\d+个方案/ }),
  ).toHaveCount(0);
  expect(imports).toBe(1);
  expect(generated).toBe(0);
});

test("idea edits save automatically with the current candidate count", async ({
  page,
}) => {
  const saves: any[] = [];
  await page.route("**/idea", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    const payload = route.request().postDataJSON();
    saves.push(payload);
    await route.fulfill({
      json: {
        id: "idea",
        kind: "idea",
        revision: 1,
        version_id: "idea-v1",
        body: { text: payload.text, storyCount: payload.story_count },
        batch_id: null,
        source_version_id: null,
        stale: false,
      },
    });
  });
  await page.getByRole("button", { name: "继续创作 →" }).first().click();
  await page.getByLabel("一句话创意").fill("纸船寻找星星的家");
  await page.getByLabel("故事数量").fill("2");
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0]).toMatchObject({ text: "纸船寻找星星的家", story_count: 2 });
  await expect(page.getByLabel("一句话创意")).toHaveValue("纸船寻找星星的家");
});

test("uncertain TXT import reuses frozen command when the same file is selected", async ({
  page,
}) => {
  const requests: any[] = [];
  await page.route("**/stories/import-txt", async (route) => {
    requests.push({
      body: route.request().postDataJSON(),
      key: route.request().headers()["idempotency-key"],
    });
    await route.abort();
  });
  await page.getByRole("button", { name: "继续创作 →" }).first().click();
  const file = {
    name: "纸船.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("小纸船看见了星星。"),
  };
  await page.getByLabel("上传TXT故事").setInputFiles(file);
  await expect.poll(() => requests.length).toBe(1);
  await page.route(/\/stories(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        items: [],
        total: 0,
        selected_version_id: "new-server-story-v2",
        selection_revision: 2,
        source_mode: "idea",
      },
    }),
  );
  await page.reload();
  await page.getByRole("button", { name: "继续创作 →" }).first().click();
  await page.getByLabel("上传TXT故事").setInputFiles(file);
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual(requests[0]);
});

for (const invalid of ["encoding", "size"] as const) {
  test(`invalid TXT ${invalid} preserves current state without sending import`, async ({
    page,
  }) => {
    let imported = false;
    await page.route("**/stories/import-txt", async (route) => {
      imported = true;
      await route.abort();
    });
    await page.getByRole("button", { name: "继续创作 →" }).first().click();
    await page.getByLabel("上传TXT故事").setInputFiles({
      name: "坏文件.txt",
      mimeType: "text/plain",
      buffer:
        invalid === "encoding"
          ? Buffer.from([0xff, 0xfe, 0xff])
          : Buffer.alloc(1024 * 1024 + 1, 65),
    });
    await expect(
      page.getByRole("alert").filter({
        hasText: invalid === "encoding" ? /TXT须使用UTF-8编码/ : /不超过1MB/,
      }),
    ).toBeVisible();
    await expect(page.getByLabel("一句话创意")).toBeVisible();
    expect(imported).toBe(false);
  });
}

test("compact navigation persists preference without losing idea draft", async ({
  page,
}) => {
  const shell = page.locator(".app");
  await expect(
    page.getByRole("button", { name: "收起页面栏", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "继续创作 →" }).first().click();
  await page.getByLabel("一句话创意").fill("侧栏切换保留未保存创意");
  await page.getByLabel("故事数量").fill("2");
  await page.getByRole("button", { name: "收起页面栏", exact: true }).click();
  await expect(shell).toHaveAttribute("data-sidebar-collapsed", "true");
  const navigation = page.getByRole("navigation", { name: "主导航" });
  for (const name of ["项目", "创作", "资产", "任务记录", "系统设置"])
    await expect(
      navigation.getByRole("button", { name, exact: true }),
    ).toBeVisible();
  await page.getByLabel("UI主题").selectOption("noir");
  await navigation.getByRole("button", { name: "项目", exact: true }).click();
  await navigation.getByRole("button", { name: "创作", exact: true }).click();
  await expect(page.getByLabel("一句话创意")).toHaveValue(
    "侧栏切换保留未保存创意",
  );
  await expect(page.getByLabel("故事数量")).toHaveValue("2");
  await expect(shell).toHaveAttribute("data-sidebar-collapsed", "true");
  await page.reload();
  await expect(shell).toHaveAttribute("data-sidebar-collapsed", "true");
  await page.getByRole("button", { name: "展开页面栏", exact: true }).click();
  await expect(shell).toHaveAttribute("data-sidebar-collapsed", "false");
  await page.reload();
  await expect(shell).toHaveAttribute("data-sidebar-collapsed", "false");
});

test("compact generation settings ignores a late save from another project", async ({
  page,
}) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let submitted = false;
  await page.route(`**/projects/${pid}/specification`, async (route) => {
    submitted = true;
    await gate;
    await route.fulfill({
      json: {
        id: pid,
        name: "独立验收项目1",
        market: "zh",
        revision: 2,
        stage: "idea",
        status: "in_progress",
        type_id: null,
        updated_at: "2026-09-10T00:00:00Z",
        generation_settings: {
          revision: 1,
          aspect_ratio: "1:1",
          resolution: "720P",
        },
      },
    });
  });
  await page.getByRole("button", { name: "继续创作 →" }).first().click();
  await page.getByRole("button", { name: "4　分镜" }).click();
  await page
    .getByRole("toolbar", { name: "分镜工具栏" })
    .getByRole("button", { name: "生成设置", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "生成设置", exact: true });
  await dialog.getByRole("button", { name: "保存输出规格" }).click();
  await expect.poll(() => submitted).toBe(true);
  await dialog.getByRole("button", { name: "关闭生成设置" }).click();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "项目", exact: true })
    .click();
  await page
    .locator(".cards article")
    .filter({ hasText: "独立验收项目2" })
    .getByRole("button", { name: "继续创作 →" })
    .click();
  await page.getByLabel("一句话创意").fill("项目二不能被项目一回执切走");
  const saved = page.waitForResponse((response) =>
    response.url().endsWith(`/projects/${pid}/specification`),
  );
  release();
  await saved;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.getByLabel("一句话创意")).toHaveValue(
    "项目二不能被项目一回执切走",
  );
  await expect(
    page.locator("main strong").filter({ hasText: "独立验收项目2" }),
  ).toBeVisible();
});
