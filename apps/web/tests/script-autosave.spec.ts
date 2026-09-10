import { test, expect } from "@playwright/test";
const pid = "11111111-1111-4111-8111-111111111111";
test("script single body saves precise version before generating board", async ({
  page,
}) => {
  let item = {
    id: "script",
    kind: "script",
    revision: 1,
    version_id: "script-v1",
    source_version_id: "story-v1",
    stale: false,
    body: { text: "原始正文", estimatedSeconds: 30, scenes: [] },
  };
  const saves: any[] = [];
  const generated: any[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = [];
    if (path === "/api/v1/projects")
      data = {
        items: [
          {
            id: pid,
            name: "剧本测试",
            revision: 1,
            status: "in_progress",
            stage: "script",
          },
        ],
        total: 1,
      };
    else if (path === `/api/v1/projects/${pid}`)
      data = { id: pid, name: "剧本测试", revision: 1 };
    else if (path.endsWith("/settings"))
      data = { project_types: [], enabled_job_kinds: [] };
    else if (path.endsWith("/idea")) data = null;
    else if (path.endsWith("/stories"))
      data = { items: [], total: 0, selection_revision: 0 };
    else if (path.includes("/bindings/"))
      data = { revision: 1, value: { resource_id: null } };
    else if (path.endsWith("/conversation"))
      data = { messages: [], proposals: [] };
    else if (path.endsWith("/stages/script")) {
      if (route.request().method() === "PUT") {
        const payload = route.request().postDataJSON();
        saves.push(payload);
        item = {
          ...item,
          body: payload.body,
          revision: 2,
          version_id: "script-v2",
        };
        data = item;
      } else data = { item, confirmation: null, reports: [] };
    } else if (path.endsWith("/stages/board/generate")) {
      generated.push(route.request().postDataJSON());
      data = {
        id: "job",
        kind: "board.generate",
        state: "queued",
        snapshot: {},
        project_id: pid,
      };
    } else if (path.includes("/stages/"))
      data = { item: null, confirmation: null, reports: [] };
    await route.fulfill({ json: data });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "继续创作 →" }).click();
  await page.getByRole("button", { name: "3　剧本" }).click();
  await expect(page.getByLabel("剧本正文")).toHaveValue("原始正文");
  await expect(
    page.getByRole("button", { name: "保存剧本", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("估算秒数", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("场景结构（保存后按正文同步）", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("本次分镜生成要求")).toHaveCount(0);
  await page.getByLabel("剧本正文").fill("编辑后的完整剧本");
  await page.getByRole("button", { name: "确认剧本并AI生成分镜" }).click();
  await expect.poll(() => generated.length).toBe(1);
  expect(saves[0].body.text).toBe("编辑后的完整剧本");
  expect(saves[0].body.estimatedSeconds).toBe(30);
  expect(generated[0].source_version_id).toBe("script-v2");
});

for (const scenario of [
  "autosave",
  "conflict",
  "lost response",
  "clean refresh",
] as const) {
  test(`script ${scenario} preserves version and draft safety`, async ({
    page,
  }) => {
    let item = {
      id: "script",
      kind: "script",
      revision: 1,
      version_id: "script-v1",
      source_version_id: "story-v1",
      stale: false,
      body: { text: "原始正文", estimatedSeconds: 30, scenes: [] },
    };
    let saves = 0;
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let data: unknown = [];
      if (path === "/api/v1/projects")
        data = {
          items: [
            {
              id: pid,
              name: "剧本测试",
              revision: 1,
              status: "in_progress",
              stage: "script",
            },
          ],
          total: 1,
        };
      else if (path === `/api/v1/projects/${pid}`)
        data = { id: pid, name: "剧本测试", revision: 1 };
      else if (path.endsWith("/settings"))
        data = { project_types: [], enabled_job_kinds: [] };
      else if (path.endsWith("/idea")) data = null;
      else if (path.endsWith("/stories"))
        data = { items: [], total: 0, selection_revision: 0 };
      else if (path.includes("/bindings/"))
        data = { revision: 1, value: { resource_id: null } };
      else if (path.endsWith("/conversation"))
        data = { messages: [], proposals: [] };
      else if (path.endsWith("/stages/script")) {
        if (route.request().method() === "PUT") {
          const payload = route.request().postDataJSON();
          saves++;
          if (scenario === "conflict")
            return route.fulfill({ status: 409, json: { detail: "版本冲突" } });
          if (scenario === "lost response" && saves > 1)
            return route.fulfill({ status: 409, json: { detail: "版本冲突" } });
          item = {
            ...item,
            body: payload.body,
            revision: 2,
            version_id: "script-v2",
          };
          if (scenario === "lost response") return route.abort("failed");
          data = item;
        } else data = { item, confirmation: null, reports: [] };
      } else if (path.includes("/stages/"))
        data = { item: null, confirmation: null, reports: [] };
      await route.fulfill({ json: data });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "继续创作 →" }).click();
    await page.getByRole("button", { name: "3　剧本" }).click();
    await expect(page.getByLabel("剧本正文")).toHaveValue("原始正文");
    if (scenario !== "clean refresh")
      await page.getByLabel("剧本正文").fill("本地草稿");
    if (scenario === "clean refresh" || scenario === "conflict")
      item = {
        ...item,
        revision: 2,
        version_id: "script-v2",
        body: { ...item.body, text: "服务端新版" },
      };
    if (scenario === "clean refresh")
      await expect(page.getByLabel("剧本正文")).toHaveValue("服务端新版", {
        timeout: 6000,
      });
    else {
      await expect.poll(() => saves).toBe(1);
      await expect(page.getByLabel("剧本正文")).toHaveValue("本地草稿");
      if (scenario === "lost response") {
        await page
          .getByRole("button", { name: "重试保存", exact: true })
          .click();
        await expect(
          page.getByRole("button", { name: "重试保存", exact: true }),
        ).toHaveCount(0);
        await expect(
          page.getByText("当前版本 v2", { exact: false }),
        ).toBeVisible();
      } else if (scenario === "conflict") {
        await expect(
          page.getByRole("button", { name: "核对并恢复当前版本" }),
        ).toBeVisible();
        await expect(page.getByLabel("剧本正文")).toHaveValue("本地草稿");
        await page.getByRole("button", { name: "核对并恢复当前版本" }).click();
        await expect(page.getByLabel("剧本正文")).toHaveValue("服务端新版");
        await page.getByText("保留的草稿（1）", { exact: true }).click();
        await expect(
          page.getByRole("region", { name: "保留草稿 1" }),
        ).toContainText("本地草稿");
      } else
        await expect(
          page.getByText("已自动保存", { exact: true }),
        ).toBeVisible();
    }
  });
}
