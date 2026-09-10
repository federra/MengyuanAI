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
    else if (p === "/api/v1/settings")
      body = {
        project_types: [],
        prompt_count: 0,
        text_configured: true,
        text_model: "fixture",
        enabled_job_kinds: [],
      };
    else if (p.includes("/bindings/")) body = { revision: 0, value: null };
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
    await page.getByRole("button", { name: "继续创作 →" }).first().click();
    await expect(page.getByLabel("一句话创意")).toBeEnabled();
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
