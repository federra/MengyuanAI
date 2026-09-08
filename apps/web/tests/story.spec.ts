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

test("lost generation response reuses paid command across reload", async ({
  page,
}) => {
  const keys: string[] = [];
  await page.route("**/story-batches", async (route) => {
    keys.push(route.request().headers()["idempotency-key"]);
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "再生成3个方案" }).click();
  await expect.poll(() => keys.length).toBe(1);
  await page.reload();
  await page.getByRole("button", { name: "继续创作 →" }).click();
  await page.getByRole("button", { name: "再生成3个方案" }).click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).toBe(keys[0]);
});

test("saving locks fields and retains current draft on conflict", async ({
  page,
}) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/stories/story", async (route) => {
    await gate;
    await route.fulfill({
      status: 409,
      json: { detail: "故事已更新，草稿保留" },
    });
  });
  await page.getByLabel("故事正文").fill("我的新结局");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByLabel("故事正文")).toBeDisabled();
  await expect(page.getByLabel("修改要求")).toBeDisabled();
  release();
  await expect(page.getByLabel("故事正文")).toBeEnabled();
  await expect(page.getByLabel("故事正文")).toHaveValue("我的新结局");
  await page.getByRole("button", { name: "任务记录", exact: true }).click();
  await page.getByRole("button", { name: "创作", exact: true }).click();
  await expect(page.getByLabel("故事正文")).toHaveValue("我的新结局");
});

test("director request retains identity on module switch and can collapse", async ({
  page,
}) => {
  const keys: string[] = [];
  await page.route("**/contents/story/messages", async (route) => {
    keys.push(route.request().headers()["idempotency-key"]);
    await route.abort("failed");
  });
  await page.getByLabel("修改要求").fill("强化情感冲突");
  await page.getByRole("button", { name: "发送修改要求" }).click();
  await expect.poll(() => keys.length).toBe(1);
  await page.getByRole("button", { name: "任务记录", exact: true }).click();
  await page.getByRole("button", { name: "创作", exact: true }).click();
  await expect(page.getByLabel("修改要求")).toHaveValue("强化情感冲突");
  await page.getByRole("button", { name: "发送修改要求" }).click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).toBe(keys[0]);
  await page.getByRole("button", { name: "收起导演助手" }).click();
  await expect(page.getByLabel("修改要求")).not.toBeVisible();
  await page.getByRole("button", { name: "展开导演助手" }).click();
  await expect(page.getByLabel("修改要求")).toHaveValue("强化情感冲突");
  await page.screenshot({
    path: "test-results/story-workbench.png",
    fullPage: true,
  });
});

test("proposal stays separate until apply; selection saves exact new version", async ({
  page,
}) => {
  let current = { ...story };
  let applied = false;
  let selected: string | null = null;
  let selectionRevision = 0;
  const proposal = {
    id: "proposal",
    base_version_id: "story-v1",
    output: {
      text: "邮差先向父亲道歉，再投递未来的信。",
      changeSummary: "强化亲情动机",
    },
    applied_version_id: null,
    created_at: project.updated_at,
  };
  await page.route(/\/stories(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        items: [current],
        total: 1,
        selected_version_id: selected,
        selection_revision: selectionRevision,
      },
    }),
  );
  await page.route("**/conversation", (route) =>
    route.fulfill({
      json: {
        messages: [
          {
            id: "m",
            job_id: "j",
            role: "assistant",
            text: "强化亲情动机",
            created_at: project.updated_at,
          },
        ],
        proposals: [
          { ...proposal, applied_version_id: applied ? "story-v2" : null },
        ],
      },
    }),
  );
  await page.route("**/proposals/proposal/apply", async (route) => {
    applied = true;
    current = {
      ...story,
      version_id: "story-v2",
      revision: 2,
      body: { ...story.body, text: proposal.output.text },
    };
    await route.fulfill({ json: current });
  });
  await page.route("**/stories/story/select", async (route) => {
    expect(route.request().postDataJSON().version_id).toBe("story-v2");
    selected = "story-v2";
    selectionRevision = 1;
    await route.fulfill({
      json: {
        items: [current],
        total: 1,
        selected_version_id: selected,
        selection_revision: 1,
      },
    });
  });
  await expect(page.getByRole("button", { name: "采用此版" })).toBeVisible();
  await expect(page.getByLabel("故事正文")).toHaveValue(story.body.text);
  await page.getByRole("button", { name: "采用此版" }).click();
  await expect(page.getByLabel("故事正文")).toHaveValue(proposal.output.text);
  await page.getByRole("button", { name: "确定此故事" }).click();
  await expect(
    page.getByRole("button", { name: "此版本已选定" }),
  ).toBeDisabled();
  await expect(page.getByText("已采用", { exact: true })).toBeVisible();
  for (const theme of ["dark", "sky"]) {
    await page.getByLabel("UI主题").selectOption(theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      animations: "disabled",
      path: `test-results/story-${theme}.png`,
      fullPage: true,
    });
  }
});

test("new project waits for server draft before allowing typing", async ({
  page,
}) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/idea", async (route) => {
    await gate;
    await route.fulfill({ json: null });
  });
  await page.reload();
  await page.getByRole("button", { name: "继续创作 →" }).click();
  await expect(page.getByLabel("一句话创意")).toBeDisabled();
  release();
  await expect(page.getByLabel("一句话创意")).toBeEnabled();
  await page.getByLabel("一句话创意").fill("首次输入不会被异步响应覆盖");
  await expect(page.getByLabel("一句话创意")).toHaveValue(
    "首次输入不会被异步响应覆盖",
  );
});

test("skill generation preserves writing mode and command across reload", async ({
  page,
}) => {
  const keys: string[] = [];
  await page.route("**/story-batches", async (route) => {
    keys.push(route.request().headers()["idempotency-key"]);
    await route.abort("failed");
  });
  await page.getByText("本次写作指令与风格", { exact: true }).click();
  await page.getByLabel("写作方式", { exact: true }).selectOption("skill");
  await page.getByRole("button", { name: "再生成3个方案" }).click();
  await expect.poll(() => keys.length).toBe(1);
  await page.reload();
  await page.getByRole("button", { name: "继续创作 →" }).click();
  await page.getByRole("button", { name: "再生成3个方案" }).click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).toBe(keys[0]);
});
