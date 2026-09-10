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
  const selected: string | null = null;
  const selectionRevision = 0;
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
  let generatedVersion: string | null = null;
  await page.route("**/stages/script/generate", async (route) => {
    generatedVersion = route.request().postDataJSON().source_version_id;
    await route.abort();
  });
  await expect(page.getByRole("button", { name: "采用此版" })).toBeVisible();
  await expect(page.getByLabel("故事正文")).toHaveValue(story.body.text);
  await page.getByRole("button", { name: "采用此版" }).click();
  await expect(page.getByLabel("故事正文")).toHaveValue(proposal.output.text);
  await expect(page.getByRole("button", { name: "确定此故事" })).toHaveCount(0);
  await page.getByRole("button", { name: "确定故事并AI生成剧本" }).click();
  await expect.poll(() => generatedVersion).toBe("story-v2");
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
  await page.evaluate(
    (key) => localStorage.removeItem(key),
    `sf.${project.id}.stage`,
  );
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

test("named method generation preserves binding and command across reload", async ({
  page,
}) => {
  const keys: string[] = [];
  await page.route("**/story-batches", async (route) => {
    keys.push(route.request().headers()["idempotency-key"]);
    await route.abort("failed");
  });
  await expect(page.getByLabel("story方法").first()).toHaveValue("method-1");
  await page.getByRole("button", { name: "再生成3个方案" }).click();
  await expect.poll(() => keys.length).toBe(1);
  await page.reload();
  await page.getByRole("button", { name: "继续创作 →" }).click();
  await page.getByRole("button", { name: "再生成3个方案" }).click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).toBe(keys[0]);
});

test("script stage exposes editable content and settings exposes model tree", async ({
  page,
}) => {
  await page.getByRole("button", { name: "3　剧本" }).click();
  await expect(page.getByRole("heading", { name: "剧本工作台" })).toBeVisible();
  await expect(page.getByText("请先确定故事并生成剧本。")).toBeVisible();
  await page.getByRole("button", { name: "系统设置", exact: true }).click();
  await page.getByRole("button", { name: /大模型配置/ }).click();
  await expect(
    page.getByRole("button", { name: "生文", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
});

test("model tree keyboard independent drafts inheritance and prompt guard", async ({
  page,
}) => {
  const bindings: Record<string, any> = {};
  let writes = 0;
  await page.route("**/bindings/**", async (route) => {
    const key = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/").pop()!,
    );
    if (route.request().method() === "PUT") {
      const b = route.request().postDataJSON();
      bindings[key] = {
        revision: (bindings[key]?.revision || 0) + 1,
        value: b.value,
      };
      writes++;
    }
    await route.fulfill({
      json: bindings[key] || { revision: 0, value: null },
    });
  });
  await page.getByRole("button", { name: "系统设置", exact: true }).click();
  await page.getByRole("button", { name: /大模型配置/ }).click();
  await page.getByLabel("模型名称", { exact: true }).fill("draft text");
  await page.getByRole("button", { name: "生图", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "生文", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("button", { name: "生图", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await page.getByLabel("模型名称", { exact: true }).fill("draft image");
  await page.getByRole("button", { name: "生文", exact: true }).click();
  await expect(page.getByLabel("模型名称", { exact: true })).toHaveValue(
    "draft text",
  );
  expect(writes).toBe(0);
  await page.getByRole("button", { name: "生文", exact: true }).press("Space");
  await page.getByRole("button", { name: "故事质检", exact: true }).click();
  await expect(page.getByLabel("沿用类别默认模型")).toBeChecked();
  await page.getByLabel("沿用类别默认模型").uncheck();
  await page.getByLabel("模型名称", { exact: true }).fill("override");
  await page.getByRole("button", { name: "保存模型配置" }).click();
  await expect
    .poll(() => bindings["model:step:storyReview"]?.value?.capability)
    .toBe("text");
  await page.getByLabel("沿用类别默认模型").check();
  await page.getByRole("button", { name: "保存模型配置" }).click();
  await expect.poll(() => bindings["model:step:storyReview"]?.value).toBe(null);
  await page.getByRole("tab", { name: "提示词", exact: true }).click();
  await expect(
    page.locator(".resource-nav").first().getByRole("button"),
  ).toHaveCount(29);
  await page.getByLabel("场景提示词正文").fill("未保存的提示词");
  await page.getByRole("button", { name: "剧本生成", exact: true }).click();
  await expect(
    page.getByText("当前场景有未保存草稿，请先保存再切换。"),
  ).toBeVisible();
  await expect(page.getByLabel("场景提示词正文")).toHaveValue("未保存的提示词");
});

test("resource library writes shared versions visible in settings", async ({
  page,
}) => {
  let resource = {
    id: "prompt-shared",
    name: "共用提示词",
    kind: "prompt",
    stage: "story",
    revision: 1,
    content: "原始正文",
    required_variables: [],
  };
  await page.route("**/resources*", (route) =>
    route.fulfill({ json: [resource] }),
  );
  await page.route("**/resources/prompt-shared", async (route) => {
    if (route.request().method() === "PUT") {
      resource = {
        ...resource,
        ...route.request().postDataJSON(),
        revision: resource.revision + 1,
      };
    }
    await route.fulfill({ json: resource });
  });
  await page.getByRole("button", { name: "资产", exact: true }).click();
  await page.getByLabel("资源类型").selectOption("prompt");
  await page.getByRole("button", { name: "共用提示词 · v1" }).click();
  await page.getByLabel("资源正文", { exact: true }).fill("资源库写入的正文");
  await page.getByRole("button", { name: "保存资源", exact: true }).click();
  await expect.poll(() => resource.revision).toBe(2);
  await page.getByRole("button", { name: "系统设置", exact: true }).click();
  await page.getByRole("button", { name: /大模型配置/ }).click();
  await page.getByRole("tab", { name: "提示词", exact: true }).click();
  await page.getByLabel("场景模板").selectOption("prompt-shared");
  await expect(page.getByLabel("场景提示词正文")).toHaveValue(
    "资源库写入的正文",
  );
});

test("script and board editing proposal QC continuation stable identities and recovery", async ({
  page,
}) => {
  const scriptBody = {
    text: "场景一：邮差开门。",
    scenes: [
      {
        id: "scene-1",
        heading: "场景一",
        actions: ["邮差开门。"],
        dialogues: [],
      },
    ],
    estimatedSeconds: 12,
  };
  let script: any = {
    ...story,
    id: "script",
    kind: "script",
    version_id: "script-v1",
    body: scriptBody,
    source_version_id: "story-v1",
  };
  let board: any = null;
  let confirmation: any = null;
  let proposal: any = null;
  let report: any = {
    id: "report",
    version_id: "script-v1",
    source_version_id: "story-v1",
    job_id: "review-job",
    state: "succeeded",
    output: {
      summary: "加强动机",
      issues: [
        {
          id: "issue",
          message: "动机不足",
          evidence: "直接开门",
          suggestion: "先犹豫",
        },
      ],
    },
    error: null,
    stale: false,
    created_at: project.updated_at,
  };
  const shot = (id: string) => ({
    id,
    prompt: "邮差开门",
    duration: 3,
    dialogue: "你好",
    dialogues: [
      {
        id: id + "-line",
        speaker: "邮差",
        emotion: "平静",
        text: "你好",
        voice: "",
      },
    ],
    refs: { characters: [], scenes: [], props: [], positions: [] },
  });
  await page.route("**/stages/*", async (route) => {
    const isScript = route.request().url().endsWith("/script");
    if (route.request().method() === "PUT") {
      const b = route.request().postDataJSON();
      if (isScript)
        script = {
          ...script,
          revision: script.revision + 1,
          version_id: "script-v2",
          body: b.body,
        };
      else board = { ...board, revision: board.revision + 1, body: b.body };
      await route.fulfill({ json: isScript ? script : board });
      return;
    }
    await route.fulfill({
      json: {
        item: isScript ? script : board,
        confirmation,
        reports: [report],
      },
    });
  });
  await page.route("**/stages/board/generate", async (route) => {
    expect(route.request().postDataJSON().source_version_id).toBe(
      script.version_id,
    );
    board = {
      ...script,
      id: "board",
      kind: "board",
      version_id: "board-v1",
      revision: 1,
      source_version_id: script.version_id,
      body: {
        schemaVersion: 2,
        scriptId: script.version_id,
        shots: [shot("shot-1"), shot("shot-2")],
      },
    };
    await route.fulfill({ status: 202, json: { id: "job" } });
  });
  await page.route("**/reports", (route) => route.fulfill({ json: [report] }));
  await page.route("**/contents/script/conversation", (route) =>
    route.fulfill({
      json: { messages: [], proposals: proposal ? [proposal] : [] },
    }),
  );
  await page.route("**/contents/script/messages", async (route) => {
    proposal = {
      id: "stage-proposal",
      base_version_id: script.version_id,
      output: {
        body: { ...script.body, text: "邮差犹豫后开门。" },
        changeSummary: "增加犹豫",
      },
      applied_version_id: null,
      created_at: project.updated_at,
    };
    await route.fulfill({ status: 202, json: { id: "modify-job" } });
  });
  await page.route("**/proposals/stage-proposal/apply", async (route) => {
    script = {
      ...script,
      version_id: "script-v3",
      revision: 3,
      body: { ...script.body, text: proposal.output.body.text },
    };
    proposal.applied_version_id = script.version_id;
    await route.fulfill({ json: script });
  });
  await page.route("**/confirm", async (route) => {
    confirmation = route.request().postDataJSON();
    await route.fulfill({
      json: {
        ...confirmation,
        decision: "keep_current",
        report_state: "succeeded",
      },
    });
  });
  await page.getByRole("button", { name: "3　剧本" }).click();
  await page.getByLabel("剧本正文").fill("人工改写：邮差开门。");
  await expect.poll(() => script.revision).toBe(2);
  await page.getByLabel("修改要求").fill("增加犹豫");
  await page.getByRole("button", { name: "发送修改要求" }).click();
  await expect(page.getByRole("button", { name: "采用此版" })).toBeVisible();
  await expect(page.getByLabel("剧本正文")).toHaveValue("人工改写：邮差开门。");
  await page.getByRole("button", { name: "采用此版" }).click();
  await expect(page.getByLabel("剧本正文")).toHaveValue("邮差犹豫后开门。");
  await page.getByRole("button", { name: "保留当前版继续" }).click();
  await expect.poll(() => confirmation?.version_id).toBe("script-v3");
  expect(report.state).toBe("succeeded");
  await page.getByRole("button", { name: "确认剧本并AI生成分镜" }).click();
  await expect(page.locator("[data-shot-id]")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "删除台词" }).first(),
  ).toBeDisabled();
  await page.getByRole("button", { name: "下移镜头" }).first().click();
  await expect(page.locator("[data-shot-id]").first()).toHaveAttribute(
    "data-shot-id",
    "shot-2",
  );
  await expect(page.locator("[data-line-id]").first()).toHaveAttribute(
    "data-line-id",
    "shot-2-line",
  );
  await page.getByRole("button", { name: "添加台词" }).first().click();
  await page.getByRole("button", { name: "保存分镜", exact: true }).click();
  await expect.poll(() => board.body.shots[0].dialogues.length).toBe(2);
  const keys: string[] = [];
  await page.route("**/contents/board/messages", async (route) => {
    keys.push(route.request().headers()["idempotency-key"]);
    await route.abort();
  });
  await page.getByLabel("修改要求").fill("加强动作");
  await page.getByRole("button", { name: "发送修改要求" }).click();
  await expect.poll(() => keys.length).toBe(1);
  await page.getByRole("button", { name: "任务记录", exact: true }).click();
  await page.getByRole("button", { name: "创作", exact: true }).click();
  await expect(page.getByRole("heading", { name: "分镜工作台" })).toBeVisible();
  await expect(page.getByLabel("修改要求")).toHaveValue("加强动作");
  await page.getByRole("button", { name: "发送修改要求" }).click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).toBe(keys[0]);
  for (const theme of ["light", "dark", "sky"]) {
    await page.getByLabel("UI主题").selectOption(theme);
    await page.screenshot({
      path: `test-results/board-${theme}.png`,
      fullPage: true,
    });
  }
});

test("paid generation waits for method binding and keeps frozen target after lost response", async ({
  page,
}) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  let submitted = false;
  await page.route("**/bindings/project*/method%3Astory", async (route) => {
    if (route.request().method() === "PUT") await gate;
    await route.fulfill({
      json: { revision: 2, value: { resource_id: "method-1" } },
    });
  });
  await page.route("**/bindings/project*/method:story", async (route) => {
    if (route.request().method() === "PUT") await gate;
    await route.fulfill({
      json: { revision: 2, value: { resource_id: "method-1" } },
    });
  });
  await page.route("**/story-batches", async (route) => {
    submitted = true;
    await route.abort();
  });
  await page.locator(".director").getByLabel("story方法").selectOption("");
  await page.getByRole("button", { name: "再生成3个方案" }).click();
  await page.waitForTimeout(100);
  expect(submitted).toBe(false);
  release();
  await expect.poll(() => submitted).toBe(true);
  let revision = 0;
  const requests: any[] = [];
  await page.route("**/stages/script", (route) =>
    route.fulfill({
      json: {
        item: revision ? { ...story, revision } : null,
        reports: [],
        confirmation: null,
      },
    }),
  );
  await page.route("**/stages/script/generate", async (route) => {
    requests.push({
      key: route.request().headers()["idempotency-key"],
      body: route.request().postDataJSON(),
    });
    revision = 1;
    await route.abort();
  });
  await page.getByRole("button", { name: "确定故事并AI生成剧本" }).click();
  await expect.poll(() => requests.length).toBe(1);
  await page.reload();
  await page.getByRole("button", { name: "继续创作 →" }).click();
  await page.getByRole("button", { name: "确定故事并AI生成剧本" }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[1].body.target_revision).toBe(0);
});

test("failed method save is isolated to its project and stage", async ({
  page,
}) => {
  const second = {
    ...project,
    id: "22222222-2222-4222-8222-222222222222",
    name: "第二个项目",
  };
  let secondSubmitted = 0;
  await page.route("**/bindings/**", async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (
      route.request().method() === "PUT" &&
      path.includes(project.id) &&
      path.endsWith("method:story")
    ) {
      await route.fulfill({
        status: 409,
        json: { detail: "方法版本冲突，保留选择" },
      });
      return;
    }
    await route.fulfill({
      json: { revision: 1, value: { resource_id: "method-1" } },
    });
  });
  await page.locator(".director").getByLabel("story方法").selectOption("");
  await expect(
    page.getByText("方法版本冲突，保留选择", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "再生成3个方案" }).click();
  await expect(page.getByText(/方法配置尚未保存/)).toBeVisible();
  await page.route("**/projects?*", (route) =>
    route.fulfill({ json: { items: [project, second], total: 2 } }),
  );
  await page.route(`**/projects/${second.id}`, (route) =>
    route.fulfill({ json: second }),
  );
  await page.route(`**/projects/${second.id}/story-batches`, async (route) => {
    secondSubmitted++;
    await route.abort();
  });
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await page.getByLabel("项目排序").selectOption("updated_asc");
  await page
    .getByRole("article")
    .filter({ hasText: "第二个项目" })
    .getByRole("button", { name: "继续创作 →" })
    .click();
  await expect(page.getByLabel("故事正文")).toBeVisible();
  await page.getByRole("button", { name: "再生成3个方案" }).click();
  await expect.poll(() => secondSubmitted).toBe(1);
});

test("review round: assistant modes preserve drafts and QC is in director", async ({
  page,
}) => {
  await page.getByRole("button", { name: "1　创意" }).click();
  await page.getByLabel("一句话创意").fill("保留创意草稿");
  await expect(page.getByRole("button", { name: "悬浮创意助手" })).toHaveCount(
    0,
  );
  await page.getByLabel("UI主题").selectOption("dark");
  await expect(page.getByLabel("一句话创意")).toHaveValue("保留创意草稿");
  for (const stage of ["script", "board"]) {
    const item = {
      ...story,
      id: stage,
      kind: stage,
      source_version_id: stage === "script" ? "story-old" : "script-v1",
      body:
        stage === "script"
          ? { text: "剧本正文", scenes: [], estimatedSeconds: 10 }
          : { schemaVersion: 2, scriptId: "script-v1", shots: [] },
    };
    await page.route(`**/stages/${stage}`, (route) =>
      route.fulfill({ json: { item, reports: [], confirmation: null } }),
    );
    await page
      .getByRole("button", { name: stage === "script" ? "3　剧本" : "4　分镜" })
      .click();
    await page.getByLabel("修改要求").fill(stage + "草稿");
    await expect(page.locator(".director .quality")).toBeVisible();
    await page.getByRole("button", { name: "悬浮导演助手" }).click();
    await expect(page.locator(".editor-with-director.floating")).toBeVisible();
    await page.getByRole("button", { name: "悬浮导演助手" }).click();
    await expect(page.locator(".editor-with-director.fixed")).toBeVisible();
    await page.getByRole("button", { name: "收起导演助手" }).click();
    await page.getByRole("button", { name: "展开导演助手" }).click();
    await expect(page.getByLabel("修改要求")).toHaveValue(stage + "草稿");
  }
});

test("review round: script source uses immutable old story and generation recovery freezes request", async ({
  page,
}) => {
  const oldVersion = {
    id: "story-old",
    revision: 1,
    body: { ...story.body, text: "原始故事不可替换为最新版" },
    source_version_id: "idea-v1",
    origin: "generation",
    created_at: project.updated_at,
  };
  await page.route("**/versions/story-old", (route) =>
    route.fulfill({ json: oldVersion }),
  );
  await page.route("**/stages/script", (route) =>
    route.fulfill({
      json: {
        item: {
          ...story,
          id: "script",
          kind: "script",
          source_version_id: "story-old",
          body: { text: "剧本", scenes: [], estimatedSeconds: 10 },
        },
        reports: [],
        confirmation: null,
      },
    }),
  );
  await page.getByRole("button", { name: "3　剧本" }).click();
  await page.getByText("原故事（生成来源）", { exact: true }).click();
  await expect(
    page.getByText("原始故事不可替换为最新版", { exact: true }),
  ).toBeVisible();
  const requests: any[] = [];
  await page.route("**/stages/board/generate", async (route) => {
    requests.push({
      body: route.request().postDataJSON(),
      key: route.request().headers()["idempotency-key"],
    });
    await route.abort();
  });
  await expect(page.getByLabel("本次分镜生成要求")).toHaveCount(0);
  await page.getByRole("button", { name: "确认剧本并AI生成分镜" }).click();
  await expect.poll(() => requests.length).toBe(1);
  await page.reload();
  await page.getByRole("button", { name: "继续创作 →" }).click();
  await expect(page.getByLabel("本次分镜生成要求")).toHaveCount(0);
  await page.getByRole("button", { name: "确认剧本并AI生成分镜" }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0].body.instruction).toBe("");
});

test("review round: pinned prompt revision is displayed and preserved until explicit upgrade", async ({
  page,
}) => {
  const old = {
    id: "pinned",
    name: "固定版本模板",
    kind: "prompt",
    stage: "novel",
    revision: 1,
    content: "旧版 {{oldVariable}}",
    required_variables: ["oldVariable"],
  };
  const latest = {
    ...old,
    revision: 2,
    content: "新版 {{newVariable}}",
    required_variables: ["newVariable"],
  };
  let saved: any = null;
  await page.route("**/resources?*", (route) =>
    route.fulfill({ json: [latest] }),
  );
  await page.route("**/resources/pinned?*", (route) =>
    route.fulfill({ json: old }),
  );
  await page.route("**/bindings/**", async (route) => {
    if (route.request().method() === "PUT") {
      saved = route.request().postDataJSON().value;
    }
    await route.fulfill({
      json: { revision: 1, value: { resource_id: "pinned", revision: 1 } },
    });
  });
  await page.route("**/settings/preview", (route) =>
    route.fulfill({ json: { content: "示例预览" } }),
  );
  await page.getByRole("button", { name: "系统设置", exact: true }).click();
  await page.getByRole("button", { name: /大模型配置/ }).click();
  await page.getByRole("tab", { name: "提示词", exact: true }).click();
  await expect(page.getByLabel("场景提示词正文")).toHaveValue(old.content);
  await expect(page.getByLabel("oldVariable", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "保存并用于此场景" }).click();
  await expect.poll(() => saved?.revision).toBe(1);
  expect(saved.content).toBe(old.content);
  await page.getByRole("button", { name: "升级为最新模板版本" }).click();
  await expect(page.getByLabel("场景提示词正文")).toHaveValue(latest.content);
  await expect(page.getByLabel("newVariable", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "保存并用于此场景" }).click();
  await expect.poll(() => saved?.revision).toBe(2);
});

for (const status of [409, 503]) {
  test(`final recovery: generation ${status} distinguishes rejected from uncertain command`, async ({
    page,
  }) => {
    let revision = 1;
    const requests: any[] = [];
    await page.route("**/stages/script", (route) =>
      route.fulfill({
        json: { item: { ...story, revision }, confirmation: null, reports: [] },
      }),
    );
    await page.route("**/stages/script/generate", async (route) => {
      requests.push({
        body: route.request().postDataJSON(),
        key: route.request().headers()["idempotency-key"],
      });
      revision = 2;
      await route.fulfill({
        status: requests.length === 1 ? status : 202,
        json:
          requests.length === 1
            ? { detail: "生成冲突或响应未知" }
            : { id: "job" },
      });
    });
    await page.getByRole("button", { name: "确定故事并AI生成剧本" }).click();
    await expect(
      page.getByText("生成冲突或响应未知", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "继续创作 →" }).click();
    await page.getByRole("button", { name: "确定故事并AI生成剧本" }).click();
    await expect.poll(() => requests.length).toBe(2);
    if (status === 409) {
      expect(requests[1].body).toEqual({
        source_version_id: "story-v1",
        target_revision: 2,
        instruction: "",
      });
      expect(requests[1].key).not.toBe(requests[0].key);
    } else expect(requests[1]).toEqual(requests[0]);
  });
}

for (const stage of ["script", "board"] as const) {
  test(`final recovery: regenerated ${stage} loads exact latest source and preserves old drafts`, async ({
    page,
  }) => {
    const source1 = stage === "script" ? "story-v1" : "script-v1";
    const source2 = stage === "script" ? "story-v2" : "script-v2";
    const makeBody = (source: string, text: string) =>
      stage === "script"
        ? { text, scenes: [], estimatedSeconds: 10 }
        : {
            schemaVersion: 2,
            scriptId: source,
            shots: [
              {
                id: "shot-1",
                prompt: text,
                duration: 3,
                dialogue: "",
                dialogues: [],
                refs: { characters: [], scenes: [], props: [], positions: [] },
              },
            ],
          };
    const old = {
      ...story,
      id: stage,
      kind: stage,
      version_id: `${stage}-v1`,
      source_version_id: source1,
      body: makeBody(source1, "旧生成内容"),
    };
    let current = { ...old };
    const saved: any[] = [];
    const history: any[] = [
      {
        ...old,
        id: old.version_id,
        origin: "generation",
        created_at: project.updated_at,
      },
    ];
    await page.route(`**/stages/${stage}`, async (route) => {
      if (route.request().method() === "PUT") {
        const b = route.request().postDataJSON();
        saved.push(b);
        if (
          b.source_version_id !== current.source_version_id ||
          b.revision !== current.revision ||
          (stage === "board" && b.body.scriptId !== current.source_version_id)
        ) {
          await route.fulfill({
            status: 409,
            json: { detail: "来源或版本冲突" },
          });
          return;
        }
        const previous = current.version_id;
        current = {
          ...current,
          body: b.body,
          revision: current.revision + 1,
          version_id: `${stage}-v${current.revision + 1}`,
        };
        history.unshift({
          ...current,
          id: current.version_id,
          source_version_id: previous,
          origin: "manual",
          created_at: project.updated_at,
        });
        await route.fulfill({ json: current });
      } else
        await route.fulfill({
          json: { item: current, confirmation: null, reports: [] },
        });
    });
    await page.route(`**/contents/${stage}/versions`, (route) =>
      route.fulfill({ json: history }),
    );
    await page
      .getByRole("button", { name: stage === "script" ? "3　剧本" : "4　分镜" })
      .click();
    const editor = page.getByRole("textbox", {
      name: stage === "script" ? "剧本正文" : "提示词",
      exact: true,
    });
    async function expectEditor(value: string) {
      if(stage === "board") {
        const toggle=page.getByRole('button',{name:/^(编辑提示词|返回图片链接预览)$/});
        await toggle.waitFor();
        if(await toggle.innerText()==='编辑提示词')await toggle.click();
      }
      await expect(editor).toHaveValue(value);
    }
    await expectEditor("旧生成内容");
    await editor.fill("尚未保存的旧来源编辑");
    // Another completed generation has a new upstream version while the cached draft survives.
    current = {
      ...old,
      revision: 2,
      version_id: `${stage}-v2`,
      source_version_id: source2,
      body: makeBody(source2, "新来源生成的完整内容"),
    };
    history.unshift({
      ...current,
      id: current.version_id,
      origin: "generation",
      created_at: project.updated_at,
    });
    await page.reload();
    await page.getByRole("button", { name: "继续创作 →" }).click();
    await expectEditor("尚未保存的旧来源编辑");
    await page
      .getByRole("button", {
        name:
          stage === "script" ? "核对并恢复当前版本" : "保留草稿并载入最新版本",
      })
      .click();
    await expectEditor("新来源生成的完整内容");
    await page.getByText("保留的草稿（1）", { exact: true }).click();
    await expect(page.getByLabel("保留草稿 1")).toContainText(
      "尚未保存的旧来源编辑",
    );
    await expect(page.getByLabel("保留草稿 1")).toContainText(source1);
    await page.screenshot({
      path: `test-results/recovery-${stage}.png`,
      fullPage: true,
    });
    await editor.fill("基于新来源的人工修改");
    if (stage === "board")
      await page.getByRole("button", { name: "保存分镜", exact: true }).click();
    await expect(
      page.getByText(stage === "script" ? "已自动保存" : "已保存新版本。", {
        exact: true,
      }),
    ).toBeVisible();
    expect(saved[0].source_version_id).toBe(source2);
    expect(saved[0].revision).toBe(2);
    if (stage === "board") expect(saved[0].body.scriptId).toBe("script-v2");
    // Manual history links to a same-item predecessor, not directly to the upstream source.
    await page.getByText(/^版本历史（/).click();
    await page.getByText("v3 · manual", { exact: true }).click();
    await page
      .getByRole("button", { name: "载入为草稿", exact: true })
      .first()
      .click();
    if(stage === "board" && await page.getByRole('button',{name:'编辑提示词',exact:true}).isVisible())
      await page.getByRole('button',{name:'编辑提示词',exact:true}).click();
    await expect(editor).toBeEnabled();
    // Explicitly loading an old-source history must retain its lineage, never relabel it.
    await page.getByText("v1 · generation", { exact: true }).click();
    await page
      .getByRole("button", { name: "载入为草稿", exact: true })
      .last()
      .click();
    await expectEditor("旧生成内容");
    if (stage === "board")
      await expect(
        page.getByRole("button", { name: "保存分镜", exact: true }),
      ).toBeDisabled();
    else {
      const savesBefore = saved.length;
      await page.waitForTimeout(850);
      expect(saved).toHaveLength(savesBefore);
    }
    await page
      .getByRole("button", {
        name:
          stage === "script" ? "核对并恢复当前版本" : "保留草稿并载入最新版本",
      })
      .click();
    await expectEditor("基于新来源的人工修改");
    await page.reload();
    await page.getByRole("button", { name: "继续创作 →" }).click();
    await expectEditor("基于新来源的人工修改");
    await page.getByText(/^保留的草稿（/).click();
    await expect(page.getByLabel("保留草稿 1", { exact: true })).toContainText(
      "尚未保存的旧来源编辑",
    );
    await expect(page.getByLabel("保留草稿 3", { exact: true })).toContainText(
      source1,
    );
    if (stage === "board")
      await expect(
        page.getByLabel("保留草稿 3", { exact: true }),
      ).toContainText('"scriptId": "script-v1"');
    await editor.fill("恢复后的再次保存");
    if (stage === "board")
      await page.getByRole("button", { name: "保存分镜", exact: true }).click();
    await expect(
      page.getByText(stage === "script" ? "已自动保存" : "已保存新版本。", {
        exact: true,
      }),
    ).toBeVisible();
    expect(saved[1].source_version_id).toBe(source2);
    expect(saved[1].revision).toBe(3);
  });
}

test("model credentials stay out of drafts and test only the saved route", async ({
  page,
}) => {
  let binding = {
    revision: 1,
    value: {
      provider: "deepseek",
      model: "fixture",
      endpoint: "https://api.deepseek.com",
      credential_ref: "DUMMY_UI_KEY",
      capability: "text",
      timeout_seconds: 10,
    },
  };
  let credential = {
    configured: false,
    source: "none",
    revision: 0,
    binding_revision: 1,
  };
  const writes: any[] = [],
    tests: any[] = [];
  await page.route("**/bindings/**", async (route) => {
    if (route.request().method() === "PUT")
      binding = {
        revision: binding.revision + 1,
        value: route.request().postDataJSON().value,
      };
    await route.fulfill({ json: binding });
  });
  await page.route("**/model-credentials/**", async (route) => {
    if (route.request().url().endsWith("/test")) {
      tests.push(route.request().postDataJSON());
      await route.fulfill({
        json: {
          state: "ok",
          latency_ms: 12,
          usage: { total_tokens: 8 },
          binding_revision: binding.revision,
          credential_revision: credential.revision,
        },
      });
      return;
    }
    if (route.request().method() === "PUT") {
      writes.push(route.request().postDataJSON());
      credential = {
        configured: true,
        source: "stored",
        revision: 1,
        binding_revision: binding.revision,
      };
    }
    await route.fulfill({
      json: { ...credential, binding_revision: binding.revision },
    });
  });
  await page.getByRole("button", { name: "系统设置", exact: true }).click();
  await page.getByRole("button", { name: /大模型配置/ }).click();
  const password = page.getByLabel("API 密钥", { exact: true });
  await expect(password).toHaveAttribute("type", "password");
  await password.fill("dummy-ui-secret");
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "dummy-ui-secret",
  );
  await page
    .getByRole("button", { name: "保存 API 密钥", exact: true })
    .click();
  await expect(password).toHaveValue("");
  expect(writes[0]).toEqual({
    secret: "dummy-ui-secret",
    base_version: 0,
    binding_revision: 1,
  });
  await page
    .getByRole("button", { name: "测试已保存的连接", exact: true })
    .click();
  await expect(page.getByText(/连接成功/)).toBeVisible();
  expect(tests[0]).toEqual({ base_version: 1, binding_revision: 1 });
  await page
    .getByLabel("服务地址", { exact: true })
    .fill("https://other.example");
  await expect(
    page.getByRole("button", { name: "测试已保存的连接", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText(/连接成功/)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "保存 API 密钥", exact: true }),
  ).toBeDisabled();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "dummy-ui-secret",
  );
});

test("late connection response is discarded after model route changes", async ({
  page,
}) => {
  let binding = {
    revision: 1,
    value: {
      provider: "deepseek",
      model: "fixture",
      endpoint: "https://api.deepseek.com",
      credential_ref: "DUMMY_LATE_KEY",
      capability: "text",
      timeout_seconds: 10,
    },
  };
  let finish: (() => void) | undefined;
  await page.route("**/bindings/**", async (route) => {
    if (route.request().method() === "PUT")
      binding = {
        revision: binding.revision + 1,
        value: route.request().postDataJSON().value,
      };
    await route.fulfill({ json: binding });
  });
  await page.route("**/model-credentials/**", async (route) => {
    if (route.request().url().endsWith("/test")) {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      await route.fulfill({
        json: {
          state: "ok",
          latency_ms: 12,
          usage: {},
          binding_revision: 1,
          credential_revision: 1,
        },
      });
    } else
      await route.fulfill({
        json: {
          configured: true,
          source: "stored",
          revision: 1,
          binding_revision: binding.revision,
        },
      });
  });
  await page.getByRole("button", { name: "系统设置", exact: true }).click();
  await page.getByRole("button", { name: /大模型配置/ }).click();
  await page
    .getByRole("button", { name: "测试已保存的连接", exact: true })
    .click();
  await expect.poll(() => !!finish).toBe(true);
  await page.getByLabel("模型名称", { exact: true }).fill("new-model");
  await page.getByRole("button", { name: "保存模型配置", exact: true }).click();
  await expect.poll(() => binding.revision).toBe(2);
  await expect(
    page.getByText("模型有未保存修改或版本已变化，请先保存模型配置。"),
  ).toHaveCount(0);
  finish!();
  await expect(
    page.getByRole("button", { name: "测试已保存的连接", exact: true }),
  ).toBeEnabled();
  await expect(page.getByText(/连接成功/)).toHaveCount(0);
});

test("UI alignment: four themes and settings dismissal preserve editor and model drafts", async ({
  page,
}) => {
  await page
    .getByLabel("故事正文", { exact: true })
    .fill("UI验收：未保存故事草稿");
  for (const theme of ["dark", "sky", "noir", "light"]) {
    await page
      .getByRole("combobox", { name: "UI主题", exact: true })
      .selectOption(theme);
    await expect(page.getByLabel("故事正文", { exact: true })).toHaveValue(
      "UI验收：未保存故事草稿",
    );
  }
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .getByLabel("模型名称", { exact: true })
    .fill("unsaved-model-draft");
  await page.getByRole("tab", { name: "提示词", exact: true }).click();
  await page.getByRole("tab", { name: "模型", exact: true }).click();
  await expect(page.getByLabel("模型名称", { exact: true })).toHaveValue(
    "unsaved-model-draft",
  );
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "设置", exact: true }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "设置", exact: true }),
  ).toBeFocused();
  await expect(page.getByLabel("故事正文", { exact: true })).toHaveValue(
    "UI验收：未保存故事草稿",
  );
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByLabel("模型名称", { exact: true })).toHaveValue(
    "unsaved-model-draft",
  );
});

test("M2 element editor keeps draft across closing and theme changes, surfaces conflicts", async ({
  page,
}) => {
  const entity = {
    id: "entity-1",
    version_id: "entity-v1",
    revision: 1,
    kind: "character",
    name: "邮差",
    description: "蓝制服",
    voice: "",
    three_view: false,
  };
  await page.route("**/entities", (route) => route.fulfill({ json: [entity] }));
  await page.route("**/entities/batch", (route) =>
    route.fulfill({
      status: 409,
      json: { detail: "元素已更新，请读取最新版本并合并草稿" },
    }),
  );
  await page.getByRole("button", { name: "4　分镜" }).click();
  await page.getByRole("button", { name: "角色管理", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "角色管理", exact: true });
  await expect(dialog).toBeVisible();

  await dialog.getByLabel("元素描述").fill("人工草稿：红制服");
  await dialog.getByRole("button", { name: "关闭元素管理" }).click();
  await page.getByLabel("UI主题").selectOption("noir");
  await page.getByRole("button", { name: "角色管理", exact: true }).click();
  await expect(dialog.getByLabel("元素描述")).toHaveValue("人工草稿：红制服");
  await dialog.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("元素已更新");
  await expect(dialog.getByLabel("元素描述")).toHaveValue("人工草稿：红制服");
  await dialog.screenshot({ path: "test-results/m2-element-dialog.png" });
  await dialog.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "角色管理", exact: true }),
  ).toBeFocused();
});

test("M2 reference preview and explicit confirmation use saved image identity", async ({
  page,
}) => {
  await page.route(`**/api/v1/projects/${project.id}`, (route) =>
    route.fulfill({
      json: { ...project, generation_settings: { revision: 1 } },
    }),
  );
  const entity = {
    id: "entity-1",
    version_id: "ev1",
    revision: 1,
    kind: "character",
    name: "邮差",
    description: "蓝制服",
    voice: "",
    three_view: false,
  };
  const image = {
    id: "image-1",
    entity_id: "entity-1",
    entity_version_id: "ev1",
    file_id: "file-1",
    kind: "character",
    name: "邮差",
    stale: false,
    confirmed: false,
  };
  await page.route("**/entities", (route) => route.fulfill({ json: [entity] }));
  await page.route("**/reference-images", (route) =>
    route.fulfill({ json: [image] }),
  );
  await page.route("**/reference-images/image-1/confirm", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      specification_revision: 1,
    });
    image.confirmed = true;
    await route.fulfill({ json: image });
  });
  await page.getByRole("button", { name: "4　分镜" }).click();
  await page.getByRole("button", { name: "角色管理", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "角色管理", exact: true });
  await dialog
    .getByRole("button", { name: "邮差图片详情", exact: true })
    .click();
  await expect(
    dialog.getByRole("link", { name: "预览邮差参考图" }),
  ).toHaveAttribute("href", `/api/v1/projects/${project.id}/files/file-1`);
  await dialog.getByRole("button", { name: "确认此参考图" }).click();
  await expect(dialog.getByText("已确认", { exact: true })).toBeVisible();
});

test("M2 recovers multiple new drafts including description-only drafts", async ({
  page,
}) => {
  await page.route("**/entities", (route) => route.fulfill({ json: [] }));
  await page.getByRole("button", { name: "4　分镜" }).click();
  await page.getByRole("button", { name: "角色管理", exact: true }).click();
  const d = page.getByRole("dialog", { name: "角色管理", exact: true });
  await d.getByRole("button", { name: "新增角色", exact: true }).click();
  await d.getByLabel("元素描述").first().fill("未命名草稿");
  await d.getByRole("button", { name: "新增角色", exact: true }).click();
  await d.getByLabel("元素名称").nth(1).fill("第二草稿");
  await d.getByRole("button", { name: "新增角色", exact: true }).click();
  await expect(d.getByLabel("元素描述").first()).toHaveValue("未命名草稿");
  await expect(d.getByLabel("元素名称").nth(1)).toHaveValue("第二草稿");
});

test("M2 conflict draft can be compared and saved against refreshed revision", async ({
  page,
}) => {
  const entity = {
    id: "entity-1",
    version_id: "v1",
    revision: 1,
    kind: "character",
    name: "邮差",
    description: "蓝制服",
    voice: "",
    three_view: false,
  };
  await page.route("**/entities", (route) => route.fulfill({ json: [entity] }));
  await page.route("**/reference-images", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/entities/batch", (route) => {
    const body = route.request().postDataJSON().items[0];
    if (body.revision !== entity.revision)
      return route.fulfill({ status: 409, json: { detail: "元素已更新" } });
    Object.assign(entity, body, { revision: entity.revision + 1 });
    return route.fulfill({
      json: {
        entities: [entity],
        board_version_id: null,
        affected_shot_ids: [],
      },
    });
  });
  await page.getByRole("button", { name: "4　分镜" }).click();
  await page.getByRole("button", { name: "角色管理", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "角色管理", exact: true });
  await dialog
    .getByRole("button", { name: "邮差图片详情", exact: true })
    .click();
  await dialog.getByLabel("元素描述").first().fill("红制服草稿");
  entity.revision = 2;
  entity.description = "其他窗口的绿制服";
  await dialog.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("元素已更新");
  await dialog.getByRole("button", { name: "关闭元素管理" }).click();
  await page.getByRole("button", { name: "角色管理", exact: true }).click();
  await dialog.getByRole("button", { name: "版本冲突：比较版本" }).click();
  await expect(
    dialog.getByRole("heading", { name: "已保存版本 v2" }),
  ).toBeVisible();
  await expect(dialog.getByLabel("元素描述").first()).toHaveValue("红制服草稿");
  await expect(
    dialog.getByText("当前已保存描述：其他窗口的绿制服", { exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "将此草稿合并到最新版本", exact: true })
    .click();
  await dialog.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("已统一保存");
  expect(entity.revision).toBe(3);
  expect(entity.description).toBe("红制服草稿");
});

async function setupMediaBoard(
  page: import("@playwright/test").Page,
  emotion = "坚定",
) {
  const shot = {
    id: "shot-media",
    prompt: "邮差打开信封",
    duration: 5,
    dialogue: "原始台词",
    dialogues: [
      {
        id: "line-media",
        speaker: "邮差",
        emotion,
        text: "原始台词",
        voice: "male-qn-qingse",
      },
    ],
    refs: { characters: [], scenes: [], props: [], positions: [] },
  };
  const item = {
    ...story,
    id: "board-media",
    kind: "board",
    version_id: "board-media-v1",
    source_version_id: "script-v1",
    body: { schemaVersion: 2, scriptId: "script-v1", shots: [shot] },
  };
  await page.route("**/stages/board", (route) =>
    route.fulfill({
      json: {
        item,
        confirmation: { version_id: item.version_id },
        reports: [],
      },
    }),
  );
  await page.getByRole("button", { name: "4　分镜" }).click();
  return { shot, item };
}

test("M2 media submission preserves command after lost response and keeps explicit performance", async ({
  page,
}) => {
  const keys: string[] = [];
  await page.route("**/media/audio", async (route) => {
    keys.push(route.request().headers()["idempotency-key"]);
    expect(route.request().postDataJSON()).toMatchObject({
      line_id: "line-media",
      emotion: "happy",
      speed: 1,
    });
    if (keys.length === 1) return route.abort("failed");
    return route.fulfill({ status: 202, json: { id: "audio-job" } });
  });
  await setupMediaBoard(page);
  await page.getByRole("button", { name: "配置配音", exact: true }).click();
  await page
    .getByRole("combobox", { name: "配音表现", exact: true })
    .selectOption("happy");
  await page
    .getByRole("button", { name: "生成第1段配音", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog", { name: "配置配音", exact: true })
      .getByRole("alert")
      .filter({ hasText: /fetch|Failed|操作/i }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "继续创作 →" }).click();
  await page.getByRole("button", { name: "4　分镜" }).click();
  await page.getByRole("button", { name: "配置配音", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "配音表现", exact: true }),
  ).toHaveValue("happy");
  await page
    .getByRole("button", { name: "生成第1段配音", exact: true })
    .click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).toBe(keys[0]);
  await page
    .getByRole("dialog", { name: "配置配音", exact: true })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "台词", exact: true }),
  ).toHaveValue("原始台词");
  await page
    .getByRole("textbox", { name: "台词", exact: true })
    .fill("未保存草稿");
  await page.getByRole("button", { name: "配置配音", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "生成第1段配音", exact: true }),
  ).toBeDisabled();
});

test("M2 media reload renders exact stored audio video and stale state", async ({
  page,
}) => {
  await page.route("**/media/results", (route) =>
    route.fulfill({
      json: [
        {
          id: "video-v1",
          job_id: "video-job",
          kind: "media.video",
          target_id: "shot-media",
          file_id: "video-file",
          tail_file_id: "tail-file",
          metadata: { duration: 5 },
          stale: true,
          confirmed: false,
        },
        {
          id: "audio-v1",
          job_id: "audio-job",
          kind: "media.audio",
          target_id: "line-media",
          file_id: "audio-file",
          tail_file_id: null,
          metadata: { duration: 6 },
          stale: false,
          confirmed: false,
        },
      ],
    }),
  );
  await setupMediaBoard(page);
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    `/api/v1/projects/${project.id}/files/video-file`,
  );
  await expect(page.locator("audio")).toHaveAttribute(
    "src",
    `/api/v1/projects/${project.id}/files/audio-file`,
  );
  await expect(
    page.getByText("最近结果 · 待更新", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "配置配音", exact: true }).click();
  await expect(page.getByText(/长于镜头，请调整时长或语速/)).toBeVisible();
  await page
    .getByRole("dialog", { name: "配置配音", exact: true })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.getByRole("button", { name: "收起导演助手" }).click();
  await page
    .locator(".board-editor")
    .screenshot({ path: "test-results/m2-media-workbench.png" });
});

test("asset AK SK are write-only and never enter browser drafts", async ({
  page,
}) => {
  let saved = false;
  await page.route("**/settings/asset-credentials", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      expect(body.access_key).toBe("dummy-asset-ak");
      expect(body.secret_key).toBe("dummy-asset-sk");
      expect(body.bucket).toBe("mengyuanaibucket");
      saved = true;
    }
    await route.fulfill({
      json: {
        configured: saved,
        revision: saved ? 1 : 0,
        configuration: null,
        connection_state: "not_tested",
      },
    });
  });
  await page.getByRole("button", { name: "系统设置", exact: true }).click();
  await page.getByRole("button", { name: /大模型配置/ }).click();
  await page.getByRole("button", { name: "生视频", exact: true }).click();
  await page.getByText("方舟素材上传与审核配置", { exact: true }).click();
  const ak = page.getByLabel("素材 Access Key", { exact: true });
  const sk = page.getByLabel("素材 Secret Key", { exact: true });
  await expect(ak).toHaveAttribute("type", "password");
  await ak.fill("dummy-asset-ak");
  await sk.fill("dummy-asset-sk");
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "dummy-asset",
  );
  await page
    .getByRole("button", { name: "保存素材配置与 AK/SK", exact: true })
    .click();
  await expect(ak).toHaveValue("");
  await expect(sk).toHaveValue("");
  await expect(page.getByRole("status")).toContainText("尚未验证");
  await page.route("**/settings/asset-credentials", (route) =>
    route.fulfill({
      json: {
        configured: true,
        revision: 2,
        configuration: {
          bucket: "changed-remote-bucket",
          region: "cn-beijing",
          project_name: "another-project",
        },
        connection_state: "not_tested",
      },
    }),
  );
  await page
    .getByRole("button", {
      name: "读取最新素材配置基准（保留输入）",
      exact: true,
    })
    .click();
  await expect(page.getByLabel("TOS 桶名", { exact: true })).toHaveValue(
    "mengyuanaibucket",
  );
  await expect(
    page.getByRole("button", {
      name: "检查已保存的读取权限（可能产生请求费）",
      exact: true,
    }),
  ).toBeDisabled();
});

test("M3 saves export draft, restores unsaved edits and blocks incomplete media", async ({
  page,
}) => {
  const draft = {
    board_version_id: null,
    filename: "我的作品",
    clips: [],
    fps: 24,
    fit: "pad",
    narration: true,
    subtitles: true,
    original_audio: false,
    voice_volume: 1,
    original_volume: 0.5,
    music_file_id: null,
    music_volume: 0.15,
    continuity_ack: false,
  };
  let state = {
    revision: 0,
    draft,
    specification: {
      width: 1280,
      height: 720,
      aspect_ratio: "16:9",
      resolution: "720P",
    },
    blockers: ["请先确认当前分镜"],
    timeline: [],
    exports: [],
  };
  await page.route("**/finishing", async (route) => {
    if (route.request().method() === "PUT") {
      state = {
        ...state,
        revision: state.revision + 1,
        draft: route.request().postDataJSON().draft,
      };
    }
    await route.fulfill({ json: state });
  });
  await page.getByRole("button", { name: /5.*导出/ }).click();
  await page.getByLabel("成片文件名").fill("我的三镜");
  await page.getByRole("button", { name: "保存剪辑" }).click();
  await expect(page.getByText("已保存剪辑 v1", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "生成真实 MP4" }),
  ).toBeDisabled();
  await page.getByLabel("成片文件名").fill("未保存的剪辑");
  await page.reload();
  await page.getByRole("button", { name: "继续创作 →" }).click();
  await expect(page.getByLabel("成片文件名")).toHaveValue("未保存的剪辑");
});

function finishingFixture() {
  return {
    revision: 0,
    draft: {
      board_version_id: null,
      filename: "初始剪辑",
      clips: [],
      fps: 24,
      fit: "pad",
      narration: true,
      subtitles: true,
      original_audio: false,
      voice_volume: 1,
      original_volume: 0.5,
      music_file_id: null,
      music_volume: 0.15,
      continuity_ack: false,
    },
    specification: {
      width: 1280,
      height: 720,
      aspect_ratio: "16:9",
      resolution: "720P",
    },
    blockers: ["缺少视频"],
    timeline: [],
    exports: [],
  };
}

test("M3 late polling cannot roll back saved revision", async ({ page }) => {
  let state = finishingFixture();
  let hold = false;
  let held = false;
  let release = () => {};
  await page.route("**/finishing", async (route) => {
    if (route.request().method() === "PUT") {
      state = {
        ...state,
        revision: 1,
        draft: route.request().postDataJSON().draft,
      };
      await route.fulfill({ json: state });
    } else {
      const snapshot = structuredClone(state);
      if (hold && !held) {
        held = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      await route.fulfill({ json: snapshot });
    }
  });
  await page.getByRole("button", { name: /5.*导出/ }).click();
  await expect(page.getByLabel("成片文件名")).toHaveValue("初始剪辑");
  hold = true;
  await expect.poll(() => held).toBe(true);
  await page.getByLabel("成片文件名").fill("新保存");
  await page.getByRole("button", { name: "保存剪辑" }).click();
  await expect(page.getByText("已保存剪辑 v1", { exact: true })).toBeVisible();
  release();
  await page.waitForTimeout(250);
  await expect(page.getByText("已保存剪辑 v1", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "保留草稿，使用最新保存基准" }),
  ).toHaveCount(0);
});

test("M3 late music upload cannot overwrite a reentered draft", async ({
  page,
}) => {
  let release = () => {};
  let started = false;
  await page.route("**/finishing", (route) =>
    route.fulfill({ json: finishingFixture() }),
  );
  await page.route("**/finishing/music", async (route) => {
    started = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ json: { id: "music-file" } });
  });
  await page.getByRole("button", { name: /5.*导出/ }).click();
  await page.getByLabel("上传背景音乐").setInputFiles({
    name: "music.mp3",
    mimeType: "audio/mpeg",
    buffer: Buffer.from("fixture"),
  });
  await expect.poll(() => started).toBe(true);
  await page.getByRole("button", { name: /2.*故事/ }).click();
  await page.getByRole("button", { name: /5.*导出/ }).click();
  await page.getByLabel("成片文件名").fill("返回后新草稿");
  release();
  await page.waitForTimeout(250);
  await page.reload();
  await page.getByRole("button", { name: "继续创作 →" }).click();
  await expect(page.getByLabel("成片文件名")).toHaveValue("返回后新草稿");
});

test("V13 six columns place TTS under its dialogue in all themes", async ({
  page,
}) => {
  await setupMediaBoard(page);
  for (const theme of ["light", "dark", "sky", "noir"]) {
    await page.getByLabel("UI主题").selectOption(theme);
    await expect(page.locator(".board-table thead th")).toHaveText([
      "序号",
      "台词",
      "角色/场景/道具",
      "提示词",
      "视频",
      "操作",
    ]);
    const line = page.locator('[data-line-id="line-media"]');
    await expect(
      line.getByRole("button", { name: "配置配音", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("columnheader", { name: "独立音频 TTS" }),
    ).toHaveCount(0);
  }
});

test("V13 shot configuration saves only its overrides and restores focus", async ({
  page,
}) => {
  let settings = {
    shot_id: "shot-media",
    board_version_id: "board-media-v1",
    revision: 0,
    overrides: {},
    effective: {
      model: {
        value: {
          provider: "fixture",
          model: "video-fixture",
          endpoint: "https://example.test",
          capability: "video",
          credential_ref: "VIDEO_KEY",
        },
        source: "system",
        revision: 1,
      },
      specification: { aspect_ratio: "16:9", resolution: "720P" },
    },
    sources: {
      model: "system",
      aspect_ratio: "project",
      resolution: "project",
    },
  };
  await page.route("**/media/shots/shot-media/settings**", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      expect(body).toMatchObject({
        board_version_id: "board-media-v1",
        revision: 0,
        overrides: { aspect_ratio: "1:1" },
      });
      settings = {
        ...settings,
        revision: 1,
        overrides: body.overrides,
        effective: {
          ...settings.effective,
          specification: { aspect_ratio: "1:1", resolution: "720P" },
        },
      };
    }
    await route.fulfill({ json: settings });
  });
  await setupMediaBoard(page);
  await page.getByRole("button", { name: "本镜模型", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "本镜生成设置" });
  await dialog.getByLabel("本镜画幅").selectOption("1:1");
  await dialog
    .getByRole("button", { name: "保存本镜设置", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("已保存");
  await dialog.getByRole("button", { name: "关闭单镜设置" }).click();
  await expect(
    page.getByRole("button", { name: "本镜模型", exact: true }),
  ).toBeFocused();
  await expect(page.locator(".shot-specification")).toContainText("1:1");
});

test("V13 JSON import replaces the whole table and keeps it after reload", async ({
  page,
}) => {
  const original = await setupMediaBoard(page);
  let current = original.item;
  await page.route("**/stages/board", (route) =>
    route.fulfill({ json: { item: current, confirmation: null, reports: [] } }),
  );
  await page.route("**/stages/script", (route) =>
    route.fulfill({
      json: {
        item: { ...story, kind: "script", version_id: "script-v1" },
        confirmation: { version_id: "script-v1" },
        reports: [],
      },
    }),
  );
  const next = {
    ...original.item,
    version_id: "board-imported-v2",
    revision: 2,
    body: {
      ...original.item.body,
      shots: [
        {
          ...original.shot,
          id: "imported-shot",
          prompt: "导入后整表新镜头",
          dialogues: [
            {
              ...original.shot.dialogues[0],
              id: "imported-line",
              text: "全新的台词",
            },
          ],
          dialogue: "全新的台词",
        },
      ],
    },
  };
  const stats = { shots: 1, dialogues: 1, assets: 0, totalSeconds: 5 };
  await page.route("**/storyboard/import/preview", (route) =>
    route.fulfill({
      json: {
        previewId: "preview-1",
        contentHash: "a".repeat(64),
        sourceScriptVersionId: "script-v1",
        baseBoardVersionId: "board-media-v1",
        stats,
        warnings: [],
      },
    }),
  );
  const committed = {
    boardVersionId: next.version_id,
    item: next,
    shots: next.body.shots,
    idMapping: {},
    assets: [],
    stats,
  };
  await page.route("**/storyboard/import/commit", async (route) => {
    current = next;
    await route.abort("failed");
  });
  await page.route("**/storyboard/import/commits/*", (route) =>
    route.fulfill({ json: committed }),
  );
  await page
    .getByRole("button", { name: "导入分镜 JSON", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "导入分镜 JSON" });
  await dialog.getByLabel("分镜 JSON 文件").setInputFiles({
    name: "board.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"format":"shortfilm-storyboard-import"}'),
  });
  await dialog.getByRole("button", { name: "校验并预览", exact: true }).click();
  await expect(
    dialog.getByText("1 镜 · 1 句台词 · 0 项素材 · 5 秒"),
  ).toBeVisible();
  await dialog.getByLabel("分镜 JSON 文件").setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from([255, 254, 253]),
  });
  await expect(dialog.getByRole("alert")).toContainText("UTF-8");
  await expect(
    dialog.getByRole("button", { name: "确认整表替换", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('[data-shot-id="shot-media"]')).toHaveCount(1);
  await dialog.getByLabel("分镜 JSON 文件").setInputFiles({
    name: "board.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"format":"shortfilm-storyboard-import"}'),
  });
  await dialog.getByRole("button", { name: "校验并预览", exact: true }).click();
  await dialog
    .getByRole("button", { name: "确认整表替换", exact: true })
    .click();
  await expect(
    page.getByLabel("提示词预览"),
  ).toHaveText("导入后整表新镜头");
  await expect(page.locator('[data-shot-id="shot-media"]')).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "继续创作 →" }).click();
  await page.getByRole("button", { name: "4　分镜" }).click();
  await expect(
    page.getByLabel("提示词预览"),
  ).toHaveText("导入后整表新镜头");
});

test("U01–U07 four themes nine pages measured evidence", async ({
  page,
  browser,
}) => {
  test.setTimeout(120000);
  const { mkdir, writeFile } = await import("node:fs/promises");
  const out = new URL("../../../evidence/production/", import.meta.url)
    .pathname;
  await mkdir(out, { recursive: true });
  const measures: unknown[] = [];
  const board = await setupMediaBoard(page);
  await page.getByRole("button", { name: "2　故事" }).click();
  await page.evaluate(
    (pid) => localStorage.removeItem(`sf.${pid}.stage.board`),
    project.id,
  );
  const shots = Array.from({ length: 11 }, (_, i) => ({
    ...board.shot,
    id: `shot-${i}`,
    prompt: `镜头${i + 1}：邮差沿着石板路寻找未来的自己。保持角色服饰与空间关系一致。`,
    dialogues: [
      {
        ...board.shot.dialogues[0],
        id: `line-${i}`,
        text: "这封信来自未来，我会找到答案。",
      },
    ],
  }));
  await page.route("**/stages/board", (route) =>
    route.fulfill({
      json: {
        item: { ...board.item, body: { ...board.item.body, shots } },
        confirmation: { version_id: board.item.version_id },
        reports: [],
      },
    }),
  );
  await page.route("**/stages/script", (route) =>
    route.fulfill({
      json: {
        item: {
          ...story,
          id: "script",
          kind: "script",
          version_id: "script-v1",
          source_version_id: "story-v1",
          body: {
            text: "邮差收到未来的来信。\n".repeat(35),
            scenes: [],
            estimatedSeconds: 55,
          },
        },
        confirmation: null,
        reports: [],
      },
    }),
  );
  await page.route("**/finishing", (route) =>
    route.fulfill({ json: finishingFixture() }),
  );
  await page.route("**/media/shots/*/settings**", (route) =>
    route.fulfill({
      json: {
        revision: 0,
        overrides: {},
        effective: {
          model: { value: null },
          specification: { aspect_ratio: "16:9", resolution: "720P" },
        },
        sources: {},
      },
    }),
  );
  await page.route("**/api/v1/projects?**", (route) =>
    route.fulfill({
      json: {
        items: [1, 2, 3].map((n) => ({
          ...project,
          id: n === 1 ? project.id : `project-${n}`,
          name: n === 1 ? project.name : `独立验收项目${n}`,
        })),
        total: 3,
        statistics: { total: 3, in_progress: 3, completed: 0, failed_jobs: 0 },
      },
    }),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  async function capture(name: string, theme: string) {
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => scrollTo(0, 0));
    await page.mouse.move(0, 0);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await page.screenshot({ path: `${out}${name}-${theme}.png` });
    if (
      [
        "projects",
        "creation",
        "story",
        "script",
        "storyboard",
        "finishing",
        "assets",
        "tasks",
        "settings",
      ].includes(name)
    ) {
      await expect(page.locator(".app-sidebar")).toHaveCSS("width", "188px");
      await page
        .getByRole("button", { name: "收起页面栏", exact: true })
        .click();
      await expect(page.locator(".app-sidebar")).toHaveCSS("width", "68px");
      await page.screenshot({ path: `${out}${name}-${theme}-collapsed.png` });
      await page
        .getByRole("button", { name: "展开页面栏", exact: true })
        .click();
    }
    const value = await page.evaluate(() => {
      const selectors = [
        "h1",
        "h2",
        ".primary-navigation button",
        ".stages button",
        "button.primary",
        "textarea",
        ".board-table th",
        ".inline-tts > button",
        ".shot-specification",
      ];
      return {
        width: innerWidth,
        height: innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        nodes: selectors.flatMap((selector) =>
          Array.from(document.querySelectorAll<HTMLElement>(selector))
            .filter((e) => e.getClientRects().length)
            .slice(0, 3)
            .map((e) => {
              const s = getComputedStyle(e),
                r = e.getBoundingClientRect();
              return {
                selector,
                font: s.fontFamily,
                size: s.fontSize,
                weight: s.fontWeight,
                color: s.color,
                background: s.backgroundColor,
                height: r.height,
              };
            }),
        ),
      };
    });
    measures.push({ page: name, theme, ...value });
    expect(
      value.scrollWidth,
      `${name}/${theme} page overflow`,
    ).toBeLessThanOrEqual(value.width);
  }
  for (const theme of ["light", "dark", "sky", "noir"]) {
    await page.getByLabel("UI主题").selectOption(theme);
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "项目", exact: true })
      .click();
    await page.getByRole("button", { name: "项目排序" }).count();
    // Reload the fixture list through a real UI filter action.
    await page.getByLabel("项目排序").selectOption("name");
    await page.getByLabel("项目排序").selectOption("updated_desc");
    await expect(page.locator(".cards article")).toHaveCount(3);
    await capture("projects", theme);
    await page.getByRole("button", { name: "继续创作 →" }).first().click();
    for (const [index, name] of [
      "creation",
      "story",
      "script",
      "storyboard",
      "finishing",
    ].entries()) {
      await page
        .getByRole("button", {
          name: `${index + 1}　${["创意", "故事", "剧本", "分镜", "导出"][index]}`,
        })
        .click();
      await expect(page.locator("main h1")).toBeVisible();
      if (name === "storyboard")
        await expect(page.locator(".board-table tbody tr")).toHaveCount(11);
      if (name === "finishing")
        await expect(page.getByLabel("成片文件名")).toBeVisible();
      await capture(name, theme);
      if (name === "creation") {
        const fields = await Promise.all([
          page.getByLabel("story方法").boundingBox(),
          page.getByLabel("故事数量").boundingBox(),
          page
            .getByRole("button", { name: "AI生成故事方案", exact: true })
            .boundingBox(),
        ]);
        expect(
          Math.max(...fields.map((r) => r!.y)) -
            Math.min(...fields.map((r) => r!.y)),
        ).toBeLessThanOrEqual(2);
      }
      if (name === "storyboard") {
        await page
          .getByRole("button", { name: "本镜模型", exact: true })
          .first()
          .click();
        await expect(
          page.getByRole("combobox", { name: "本镜画幅", exact: true }),
        ).toBeVisible();
        await capture("shot-settings", theme);
        for (let k = 0; k < 9; k++) {
          await page.keyboard.press("Tab");
          expect(
            await page
              .getByRole("dialog")
              .evaluate((el) => el.contains(document.activeElement)),
          ).toBe(true);
        }
        await page.getByRole("button", { name: "关闭单镜设置" }).click();
        await page
          .getByRole("button", { name: "导入分镜 JSON", exact: true })
          .click();
        await capture("board-import", theme);
        await page.getByRole("button", { name: "关闭分镜导入" }).click();
        await page
          .getByRole("button", { name: "角色管理", exact: true })
          .click();
        await capture("elements", theme);
        await page.getByRole("button", { name: "关闭元素管理" }).click();
        await page.locator(".board-editor .table-wrap").evaluate((e) => {
          e.scrollLeft = e.scrollWidth;
        });
        await capture("storyboard-right", theme);
        await page.locator(".board-editor .table-wrap").evaluate((e) => {
          e.scrollLeft = 0;
        });
      }
    }
    for (const [label, name] of [
      ["资产", "assets"],
      ["任务记录", "tasks"],
      ["系统设置", "settings"],
    ]) {
      await page
        .getByRole("navigation", { name: "主导航" })
        .getByRole("button", { name: label, exact: true })
        .click();
      await capture(name, theme);
      if (name === "settings") {
        await page.getByRole("button", { name: "设置", exact: true }).click();
        await expect(
          page.getByRole("tab", { name: "模型", exact: true }),
        ).toBeVisible();
        await capture("settings-model", theme);
        for (const tab of ["提示词", "风格模板"]) {
          const control = page.getByRole("tab", { name: tab, exact: true });
          if (await control.count()) {
            await control.click();
            await expect(control).toHaveAttribute("aria-selected", "true");
            await capture(`settings-${tab}`, theme);
          }
        }
        await page
          .getByRole("dialog", { name: "设置", exact: true })
          .getByRole("button", { name: "关闭", exact: true })
          .click();
      }
    }
  }
  for (const size of [
    { width: 1280, height: 800 },
    { width: 1920, height: 1080 },
    { width: 720, height: 450 },
  ]) {
    await page.setViewportSize(size);
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "创作", exact: true })
      .click();
    await page.getByRole("button", { name: "1　创意" }).click();
    await capture(`viewport-${size.width}`, "noir");
    await expect(
      page.getByRole("button", { name: "AI生成故事方案", exact: true }),
    ).toBeVisible();
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "3　剧本" }).click();
  await page.getByLabel("剧本正文").evaluate((e) => {
    e.style.height = "1400px";
  });
  await page.evaluate(() => scrollTo(0, 600));
  await expect
    .poll(async () =>
      Math.round((await page.locator(".stages").boundingBox())!.y),
    )
    .toBe(68);
  const nav = await page.locator(".stages").boundingBox(),
    top = await page.locator(".app-topbar").boundingBox();
  expect(Math.abs(nav!.y - (top!.y + top!.height))).toBeLessThanOrEqual(2);
  measures.push({
    browser: browser.version(),
    reducedMotion: true,
    zoom200:
      "720x450 CSS layout viewport equivalent; physical browser zoom separately pending",
  });
  await writeFile(`${out}measurements.json`, JSON.stringify(measures, null, 2));
});

test("story generation saves the visible draft before submitting its exact version", async ({
  page,
}) => {
  const events: string[] = [];
  await page.route("**/stories/story", async (route) => {
    expect(route.request().postDataJSON().body.text).toBe(
      "编辑后马上生成的故事全文",
    );
    events.push("save");
    await route.fulfill({
      json: {
        ...story,
        revision: 2,
        version_id: "story-v2",
        body: { ...story.body, text: "编辑后马上生成的故事全文" },
      },
    });
  });
  await page.route("**/stages/script/generate", async (route) => {
    expect(route.request().postDataJSON().source_version_id).toBe("story-v2");
    events.push("generate");
    await route.abort();
  });
  await page.getByLabel("故事正文").fill("编辑后马上生成的故事全文");
  await page.getByRole("button", { name: "确定故事并AI生成剧本" }).click();
  await expect.poll(() => events).toEqual(["save", "generate"]);
  await expect(
    page.getByRole("button", { name: "保存修改", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("本次剧本生成要求")).toHaveCount(0);
});

test("automatic story save failure pauses retries and preserves the draft", async ({
  page,
}) => {
  let attempts = 0;
  await page.route("**/stories/story", async (route) => {
    attempts++;
    await route.fulfill({
      status: 409,
      json: { detail: "故事已更新，草稿保留" },
    });
  });
  await page.getByLabel("故事正文").fill("不应被服务端旧版本覆盖的草稿");
  await expect.poll(() => attempts).toBe(1);
  await expect(
    page.getByRole("alert").filter({ hasText: "故事版本冲突，草稿已保留" }),
  ).toBeVisible();
  await page.waitForTimeout(1600);
  expect(attempts).toBe(1);
  await expect(page.getByLabel("故事正文")).toHaveValue(
    "不应被服务端旧版本覆盖的草稿",
  );
});

test("story review lives in the director and more candidates follow the cards", async ({
  page,
}) => {
  await expect(
    page
      .locator(".director")
      .getByRole("button", { name: "重新质检", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".story-editor")
      .getByRole("button", { name: "重新质检", exact: true }),
  ).toHaveCount(0);
  const more = await page
    .getByRole("button", { name: "再生成3个方案" })
    .boundingBox();
  const cards = await page
    .locator(".candidates .candidate")
    .last()
    .boundingBox();
  expect(cards).not.toBeNull();
  expect(more!.y).toBeGreaterThanOrEqual(cards!.y + cards!.height);
  for (const theme of ["light", "dark", "sky", "noir"]) {
    await page.getByLabel("UI主题").selectOption(theme);
    await page.screenshot({
      path: `test-results/flow-story-${theme}.png`,
      fullPage: true,
    });
  }
});

test("slow story and conversation polls do not overlap or roll back a saved version", async ({
  page,
}) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let storyPolls = 0;
  let conversationPolls = 0;
  let current = { ...story };
  await page.route(/\/stories(?:\?.*)?$/, async (route) => {
    storyPolls++;
    const snapshot = current;
    if (storyPolls === 1) await gate;
    await route.fulfill({
      json: {
        items: [snapshot],
        total: 1,
        selected_version_id: null,
        selection_revision: 0,
      },
    });
  });
  await page.route("**/conversation", async (route) => {
    conversationPolls++;
    await gate;
    await route.fulfill({ json: { messages: [], proposals: [] } });
  });
  await expect.poll(() => storyPolls).toBe(1);
  await expect.poll(() => conversationPolls).toBe(1);
  await page.waitForTimeout(2800);
  expect(storyPolls).toBe(1);
  expect(conversationPolls).toBe(1);
  await page.route("**/stories/story", async (route) => {
    current = {
      ...story,
      version_id: "story-v2",
      revision: 2,
      body: { ...story.body, text: route.request().postDataJSON().body.text },
    };
    await route.fulfill({ json: current });
  });
  await page.getByLabel("故事正文").fill("慢轮询不能回滚的新版本");
  await expect(page.locator(".candidate.current")).toContainText("v2");
  release();
  await page.waitForTimeout(150);
  await expect(page.locator(".candidate.current")).toContainText("v2");
  await expect(page.getByLabel("故事正文")).toHaveValue(
    "慢轮询不能回滚的新版本",
  );
});

for (const state of [
  "queued",
  "running",
  "waiting_provider",
  "waiting_dependency",
]) {
  test(`inline story generation ${state} keeps the existing candidate editable without saving status`, async ({
    page,
  }) => {
    let jobs: unknown[] = [
      {
        id: "inline-job",
        project_id: project.id,
        kind: "story.generate",
        state,
        snapshot: { idea_version_id: idea.version_id },
        created_at: project.updated_at,
      },
    ];
    const writes: string[] = [];
    await page.route("**/jobs", (route) => route.fulfill({ json: jobs }));
    await page.route("**/stories/story", async (route) => {
      writes.push(route.request().postData() ?? "");
      await route.fulfill({ json: story });
    });
    await page.getByRole("button", { name: "任务记录", exact: true }).click();
    await page.getByRole("button", { name: "创作", exact: true }).click();
    const editor = page.getByLabel("故事正文", { exact: true });
    const output = page.getByLabel("新故事方案", { exact: true });
    await expect(output).toHaveValue("AI生成中...");
    await expect(output).toHaveAttribute("readonly", "");
    await expect(editor).toHaveValue(story.body.text);
    await expect(editor).toBeEditable();
    jobs = [
      {
        id: "inline-job",
        project_id: project.id,
        kind: "story.generate",
        state: "failed",
        snapshot: { idea_version_id: idea.version_id },
        created_at: project.updated_at,
      },
    ];
    await expect(output).toHaveCount(0);
    await expect(editor).toHaveValue(story.body.text);
    expect(writes).toEqual([]);
  });
}

test("inline story generation ignores unrelated jobs and unknown results", async ({
  page,
}) => {
  const jobs = [
    {
      project_id: "another-project",
      kind: "story.generate",
      state: "running",
      snapshot: { idea_version_id: idea.version_id },
    },
    {
      project_id: project.id,
      kind: "story.generate",
      state: "running",
      snapshot: { idea_version_id: "old-idea" },
    },
    ...["unknown", "failed", "succeeded"].map((state) => ({
      project_id: project.id,
      kind: "story.generate",
      state,
      snapshot: { idea_version_id: idea.version_id },
    })),
  ].map((job, i) => ({
    ...job,
    id: `unrelated-${i}`,
    created_at: project.updated_at,
  }));
  await page.route("**/jobs", (route) => route.fulfill({ json: jobs }));
  await page.getByRole("button", { name: "任务记录", exact: true }).click();
  await page.getByRole("button", { name: "创作", exact: true }).click();
  await expect(page.getByLabel("故事正文", { exact: true })).toHaveValue(
    story.body.text,
  );
});

test("inline initial story generation has a target textbox before any candidate exists", async ({
  page,
}) => {
  await page.route("**/stories?**", (route) =>
    route.fulfill({
      json: {
        items: [],
        total: 0,
        selected_version_id: null,
        selection_revision: 0,
      },
    }),
  );
  await page.route("**/stories", (route) =>
    route.fulfill({
      json: {
        items: [],
        total: 0,
        selected_version_id: null,
        selection_revision: 0,
      },
    }),
  );
  await page.route("**/jobs", (route) =>
    route.fulfill({
      json: [
        {
          id: "first-job",
          project_id: project.id,
          kind: "story.generate",
          state: "running",
          snapshot: { idea_version_id: idea.version_id },
          created_at: project.updated_at,
        },
      ],
    }),
  );
  await page.getByRole("button", { name: "任务记录", exact: true }).click();
  await page.getByRole("button", { name: "创作", exact: true }).click();
  await expect(page.getByLabel("故事正文", { exact: true })).toHaveValue(
    "AI生成中...",
  );
});

test("inline director generation uses its suggestion textbox and never replaces story text", async ({
  page,
}) => {
  await page.route("**/jobs", (route) =>
    route.fulfill({
      json: [
        {
          id: "director-job",
          project_id: project.id,
          kind: "story.revise",
          state: "running",
          snapshot: { item_id: story.id, base_version_id: story.version_id },
          created_at: project.updated_at,
        },
      ],
    }),
  );
  await page.getByRole("button", { name: "任务记录", exact: true }).click();
  await page.getByRole("button", { name: "创作", exact: true }).click();
  await expect(page.getByLabel("建议正文", { exact: true })).toHaveValue(
    "AI生成中...",
  );
  await expect(page.getByLabel("故事正文", { exact: true })).toHaveValue(
    story.body.text,
  );
});

for (const stage of ["script", "board"] as const) {
  for (const operation of ["generate", "revise", "review", "repair"]) {
    test(`inline ${stage} ${operation} renders only its target and restores after completion`, async ({
      page,
    }) => {
      const item = {
        ...story,
        id: stage,
        kind: stage,
        version_id: `${stage}-v1`,
        source_version_id: stage === "script" ? story.version_id : "script-v1",
        body:
          stage === "script"
            ? { text: "原始剧本", scenes: [], estimatedSeconds: 15 }
            : {
                schemaVersion: 2,
                scriptId: "script-v1",
                shots: [
                  {
                    id: "s1",
                    prompt: "原始画面",
                    duration: 3,
                    dialogue: "",
                    dialogues: [],
                    refs: {
                      characters: [],
                      scenes: [],
                      props: [],
                      positions: [],
                    },
                  },
                ],
              },
      };
      let state = "running";
      const writes: string[] = [];
      await page.route(`**/stages/${stage}`, async (route) => {
        if (route.request().method() === "PUT")
          writes.push(route.request().postData() ?? "");
        await route.fulfill({
          json: { item, confirmation: null, reports: [] },
        });
      });
      await page.route("**/jobs", (route) =>
        route.fulfill({
          json: [
            {
              id: "stage-job",
              project_id: project.id,
              kind: `${stage}.${operation}`,
              state,
              snapshot: {
                item_id: item.id,
                base_version_id: item.version_id,
                target_revision: 1,
              },
              created_at: project.updated_at,
            },
          ],
        }),
      );
      await page
        .getByRole("button", {
          name: stage === "script" ? "3　剧本" : "4　分镜",
        })
        .click();
      const label =
        operation === "generate"
          ? stage === "script"
            ? "剧本正文"
            : "分镜内容"
          : operation === "review"
            ? "质检结果"
            : "建议正文";
      const target = page.getByLabel(label, { exact: true });
      await expect(target).toHaveValue("AI生成中...");
      await expect(target).toHaveAttribute("readonly", "");
      if (operation !== "generate") {
        if(stage === "board") await expect(page.getByLabel('提示词预览')).toHaveText('原始画面');
        else await expect(page.getByRole('textbox',{name:'剧本正文',exact:true})).toHaveValue('原始剧本');
      }
      if (stage === "script" && operation === "generate") {
        await page.setViewportSize({ width: 1440, height: 900 });
        for (const theme of ["light", "dark", "sky", "noir"]) {
          await page.getByLabel("UI主题").selectOption(theme);
          await page.screenshot({
            path: `../../evidence/script-loading/${theme}-script-generating.png`,
            fullPage: true,
          });
        }
      }
      state = "succeeded";
      if (stage === "script" && operation === "generate")
        await expect(target).toHaveValue("原始剧本");
      else await expect(target).toHaveCount(0);
      expect(writes).toEqual([]);
    });
  }
}

test("compact storyboard toolbar follows the eight action order", async ({
  page,
}) => {
  await setupMediaBoard(page);
  const toolbar = page.getByRole("toolbar", { name: "分镜工具栏" });
  await expect(toolbar.getByRole("button")).toHaveText([
    "角色管理",
    "场景管理",
    "道具管理",
    "批量配音",
    "批量站位图",
    "生成设置",
    "导入分镜 JSON",
    "界面设置",
  ]);
  for (const button of await toolbar.getByRole("button").all()) {
    const bounds = await button.boundingBox();
    expect(bounds, await button.innerText()).not.toBeNull();
    expect(bounds!.height, await button.innerText()).toBeGreaterThanOrEqual(44);
  }
  const heading = await page
    .getByRole("heading", { name: "分镜工作台" })
    .boundingBox();
  const controls = await toolbar.boundingBox();
  expect(controls!.y).toBeGreaterThanOrEqual(heading!.y + heading!.height);
});

for (const kind of ["audio", "images"] as const) {
  test(`compact batch ${kind} previews before submitting and retains failed selection`, async ({
    page,
  }) => {
    const requests: unknown[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/media/${kind}`, async (route) => {
      requests.push(route.request().postDataJSON());
      await gate;
      await route.fulfill({
        status: 409,
        json: { detail: "批量测试冲突，请保留配置后重试" },
      });
    });
    await setupMediaBoard(page, "happy");
    const name = kind === "audio" ? "批量配音" : "批量站位图";
    const trigger = page
      .getByRole("toolbar", { name: "分镜工具栏" })
      .getByRole("button", { name, exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name, exact: true });
    await expect(dialog).toBeVisible();
    expect(requests).toHaveLength(0);
    const selection = dialog.getByRole("checkbox").first();
    await expect(selection).toBeChecked();
    const submit = dialog.getByRole("button", {
      name: /^(提交所选任务|提交中…)$/,
    });
    await submit.click();
    await expect.poll(() => requests.length).toBe(1);
    await expect(submit).toBeDisabled();
    await submit.evaluate((button: HTMLButtonElement) => button.click());
    expect(requests).toHaveLength(1);
    release();
    await expect(
      dialog.getByRole("alert").filter({ hasText: "批量测试冲突" }),
    ).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(selection).toBeChecked();
    await expect(submit).toBeEnabled();
    expect(requests[0]).toMatchObject({
      board_version_id: "board-media-v1",
      shot_id: "shot-media",
      ...(kind === "audio" ? { line_id: "line-media", emotion: "happy" } : {}),
    });
  });
}

test("compact batch accepted job survives a results refresh failure without resubmission", async ({
  page,
}) => {
  let accepted = 0;
  await page.route("**/media/audio", async (route) => {
    accepted++;
    await route.fulfill({ status: 202, json: { id: "accepted-audio-job" } });
  });
  await page.route("**/media/results", async (route) => {
    if (accepted)
      return route.fulfill({
        status: 503,
        json: { detail: "结果刷新暂不可用" },
      });
    await route.fulfill({ json: [] });
  });
  await setupMediaBoard(page, "happy");
  await page
    .getByRole("toolbar", { name: "分镜工具栏" })
    .getByRole("button", { name: "批量配音", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "批量配音", exact: true });
  await dialog
    .getByRole("button", { name: "提交所选任务", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("已提交 1 项");
  await expect(dialog.getByRole("checkbox").first()).not.toBeChecked();
  await expect(
    dialog.getByRole("button", { name: "提交所选任务", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "关闭批量配音" }).click();
  await page
    .getByRole("toolbar", { name: "分镜工具栏" })
    .getByRole("button", { name: "批量配音", exact: true })
    .click();
  await expect(dialog.getByRole("checkbox").first()).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "提交所选任务", exact: true }),
  ).toBeDisabled();
  expect(accepted).toBe(1);
});

test("compact batch unknown response freezes and reuses the original paid command", async ({
  page,
}) => {
  const requests: { key: string; body: unknown }[] = [];
  await page.route("**/media/audio", async (route) => {
    requests.push({
      key: route.request().headers()["idempotency-key"],
      body: route.request().postDataJSON(),
    });
    if (requests.length === 1) return route.abort("failed");
    await route.fulfill({ status: 202, json: { id: "recovered-audio-job" } });
  });
  await setupMediaBoard(page, "happy");
  const trigger = page
    .getByRole("toolbar", { name: "分镜工具栏" })
    .getByRole("button", { name: "批量配音", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "批量配音", exact: true });
  const performance = dialog.getByRole("combobox", {
    name: "镜头1台词1配音表现",
  });
  await performance.selectOption("sad");
  await dialog
    .getByRole("button", { name: "提交所选任务", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByRole("button", { name: "关闭批量配音" }).click();
  await trigger.click();
  await expect(performance).toBeDisabled();
  await expect(performance).toHaveValue("sad");
  await dialog
    .getByRole("button", { name: "提交所选任务", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("已提交 1 项");
  expect(requests).toHaveLength(2);
  expect(requests[0].key).toBeTruthy();
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[1].body).toMatchObject({
    emotion: "sad",
    line_id: "line-media",
    board_version_id: "board-media-v1",
  });
  await dialog.getByRole("button", { name: "关闭批量配音" }).click();
  await trigger.click();
  await expect(dialog.getByRole("checkbox").first()).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "提交所选任务", exact: true }),
  ).toBeDisabled();
  expect(requests).toHaveLength(2);
});
