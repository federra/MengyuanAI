import { test, expect } from "@playwright/test";

const project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "浏览器故事测试",
  market: "zh",
  revision: 1,
  stage: "idea",
  status: "in_progress",
  generation_settings: null,
  type_id: null,
  updated_at: "2026-09-08T00:00:00Z",
};
const idea = {
  id: "idea",
  kind: "idea",
  revision: 1,
  version_id: "idea-v1",
  body: { text: "邮差收到未来的信" },
  batch_id: null,
  source_version_id: null,
  stale: false,
};
const story = {
  id: "story",
  kind: "story",
  revision: 1,
  version_id: "story-v1",
  body: {
    title: "未来的来信",
    logline: "邮差改变命运",
    direction: "悬疑",
    text: "邮差沿着信中的线索寻找未来的自己。",
  },
  batch_id: "batch",
  source_version_id: "idea-v1",
  stale: false,
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let body: unknown = [];
    if (path === "/api/v1/projects") body = { items: [project], total: 1 };
    else if (path === `/api/v1/projects/${project.id}`) body = project;
    else if (path === "/api/v1/settings")
      body = {
        project_types: [],
        prompt_count: 30,
        text_configured: true,
        text_model: "fixture",
        enabled_job_kinds: [],
      };
    else if (path.includes("/bindings/"))
      body = { revision: 1, value: { resource_id: "method-1" } };
    else if (path.endsWith("/resources"))
      body = [
        {
          id: "method-1",
          name: "人物弧光故事法",
          kind: "skill",
          stage: "story",
          revision: 1,
          content: "强化动机",
          required_variables: [],
        },
      ];
    else if (path.includes("/stages/"))
      body = { item: null, confirmation: null, reports: [] };
    else if (path.endsWith("/idea")) body = idea;
    else if (path.endsWith("/stories"))
      body = {
        items: [story],
        total: 1,
        selected_version_id: null,
        selection_revision: 0,
      };
    else if (path.endsWith("/conversation"))
      body = { messages: [], proposals: [] };
    else if (path.endsWith("/versions"))
      body = [
        {
          id: story.version_id,
          revision: 1,
          body: story.body,
          origin: "generation",
          source_version_id: "idea-v1",
          created_at: project.updated_at,
        },
      ];
    await route.fulfill({ json: body });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "继续创作 →" }).click();
  await expect(page.getByLabel("故事正文")).toBeVisible();
});

test("compact element image action keeps target and unsaved draft", async ({
  page,
}) => {
  const entities = ["邮差", "女孩"].map((name, i) => ({
    id: `entity-${i}`,
    version_id: `ev-${i}`,
    revision: 1,
    kind: "character",
    name,
    description: "蓝制服",
    voice: "",
    three_view: false,
  }));
  await page.route("**/entities", (r) => r.fulfill({ json: entities }));
  await page.route("**/reference-images", (r) => r.fulfill({ json: [] }));
  const submitted: unknown[] = [];
  await page.route("**/media/images", async (r) => {
    submitted.push(r.request().postDataJSON());
    await r.fulfill({ json: { id: "image-task" } });
  });
  await page.getByRole("button", { name: "4　分镜" }).click();
  await page.getByRole("button", { name: "角色管理", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "角色管理", exact: true });
  await dialog
    .getByRole("button", { name: "管理邮差图片", exact: true })
    .click();
  await dialog.screenshot({ path: "test-results/compact-entity.png" });
  await dialog.getByLabel("元素描述").fill("红衣草稿");
  await expect(
    dialog.getByRole("button", { name: "AI生成参考图", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole("button", { name: "管理女孩图片", exact: true })
    .click();
  await expect(dialog.getByLabel("元素名称")).toHaveValue("女孩");
  await dialog
    .getByRole("button", { name: "AI生成参考图", exact: true })
    .click();
  await expect.poll(() => submitted.length).toBe(1);
  expect(submitted[0]).toMatchObject({
    entity_id: "entity-1",
    entity_revision: 1,
  });
  await dialog
    .getByRole("button", { name: "恢复草稿：邮差", exact: true })
    .click();
  await expect(dialog.getByLabel("元素描述")).toHaveValue("红衣草稿");
});

test("compact references hide details and offer only valid confirmed images", async ({
  page,
}) => {
  const shot = {
    id: "shot-media",
    prompt: "打开信封",
    duration: 5,
    dialogue: "",
    dialogues: [
      { id: "line-media", speaker: "", emotion: "", text: "", voice: "" },
    ],
    refs: { characters: ["stable-ref"], scenes: [], props: [], positions: [] },
  };
  const item = {
    ...story,
    id: "board-media",
    kind: "board",
    version_id: "board-media-v1",
    body: { schemaVersion: 2, scriptId: "script-v1", shots: [shot] },
  };
  await page.route("**/stages/board", (r) =>
    r.fulfill({
      json: {
        item,
        confirmation: { version_id: item.version_id },
        reports: [],
      },
    }),
  );
  await page.route("**/files/*", (r) =>
    r.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
        "base64",
      ),
    }),
  );
  await page.route("**/files", (r) =>
    r.fulfill({
      json: ["good", "pending", "old", "position"].map((id) => ({
        id,
        filename: id + ".png",
        mime: "image/png",
      })),
    }),
  );
  await page.route("**/reference-images", (r) =>
    r.fulfill({
      json: [
        { file_id: "good", confirmed: true, stale: false },
        { file_id: "pending", confirmed: false, stale: false },
        { file_id: "old", confirmed: true, stale: true },
      ],
    }),
  );
  await page.route("**/media/results", (r) =>
    r.fulfill({
      json: [
        {
          id: "out-position",
          kind: "image.position",
          file_id: "position",
          confirmed: true,
          stale: false,
          metadata: {},
        },
      ],
    }),
  );
  await page.route("**/media/reference-bindings", (r) =>
    r.fulfill({
      json: [
        {
          shot_id: "shot-media",
          ref_id: "stable-ref",
          file_id: "old",
          revision: 2,
        },
      ],
    }),
  );
  let replacement: unknown;
  await page.route("**/shots/shot-media/references/stable-ref", async (r) => {
    replacement = r.request().postDataJSON();
    await r.fulfill({ json: {} });
  });
  await page.getByRole("button", { name: "4　分镜" }).click();
  const cell = page.locator(".reference-window").first();
  await expect(cell.getByLabel("角色图片引用")).not.toBeVisible();
  await cell.screenshot({ path: "test-results/compact-references.png" });
  await cell.getByText("管理图片", { exact: true }).click();
  const select = cell.getByLabel("替换图片（保留ID）");
  await expect(select.locator('option[value="good"]')).toHaveCount(1);
  await expect(select.locator('option[value="pending"]')).toHaveCount(0);
  await expect(select.locator('option[value="position"]')).toHaveCount(1);
  await expect(select.locator('option[value="old"]')).toHaveAttribute(
    "disabled",
    "",
  );
  await select.selectOption("good");
  await expect
    .poll(() => replacement)
    .toMatchObject({
      file_id: "good",
      revision: 2,
      board_version_id: item.version_id,
    });
});
