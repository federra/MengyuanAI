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
  await page.getByText("本次写作指令与风格", { exact: true }).click();
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
  await page.getByRole("button", { name: "保存剧本", exact: true }).click();
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
  await page.getByLabel("story方法").last().selectOption("");
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
  await page.getByLabel("story方法").last().selectOption("");
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
  await page.getByLabel("创意修改要求").fill("保留创意草稿");
  await page.getByRole("button", { name: "悬浮创意助手" }).click();
  await expect(page.locator(".editor-with-director.floating")).toBeVisible();
  await page.getByRole("button", { name: "收起创意助手" }).click();
  await expect(page.locator(".editor-with-director.closed")).toBeVisible();
  await page.getByRole("button", { name: "展开创意助手" }).click();
  await expect(page.getByLabel("创意修改要求")).toHaveValue("保留创意草稿");
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

test("review round: script source uses immutable old story and instruction recovery freezes text", async ({
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
  await page.getByLabel("本次分镜生成要求").fill("保留长镜头");
  await page.getByRole("button", { name: "确认剧本并AI生成分镜" }).click();
  await expect.poll(() => requests.length).toBe(1);
  await page.getByLabel("本次分镜生成要求").fill("新草稿不能改变未确认请求");
  await page.reload();
  await page.getByRole("button", { name: "继续创作 →" }).click();
  await expect(page.getByLabel("本次分镜生成要求")).toHaveValue(
    "新草稿不能改变未确认请求",
  );
  await page.getByRole("button", { name: "确认剧本并AI生成分镜" }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0].body.instruction).toBe("保留长镜头");
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
    await page.getByLabel("本次剧本生成要求").fill("第一条指令");
    await page.getByRole("button", { name: "确定故事并AI生成剧本" }).click();
    await expect(
      page.getByText("生成冲突或响应未知", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "继续创作 →" }).click();
    await page.getByLabel("本次剧本生成要求").fill("修订后的指令");
    await page.getByRole("button", { name: "确定故事并AI生成剧本" }).click();
    await expect.poll(() => requests.length).toBe(2);
    if (status === 409) {
      expect(requests[1].body).toEqual({
        source_version_id: "story-v1",
        target_revision: 2,
        instruction: "修订后的指令",
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
      name: stage === "script" ? "剧本正文" : "画面描述",
      exact: true,
    });
    await expect(editor).toHaveValue("旧生成内容");
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
    await expect(editor).toHaveValue("尚未保存的旧来源编辑");
    await page.getByRole("button", { name: "保留草稿并载入最新版本" }).click();
    await expect(editor).toHaveValue("新来源生成的完整内容");
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
    await page
      .getByRole("button", {
        name: stage === "script" ? "保存剧本" : "保存分镜",
        exact: true,
      })
      .click();
    await expect(
      page.getByText("已保存新版本。", { exact: true }),
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
    await expect(
      page.getByRole("button", {
        name: stage === "script" ? "保存剧本" : "保存分镜",
        exact: true,
      }),
    ).toBeEnabled();
    // Explicitly loading an old-source history must retain its lineage, never relabel it.
    await page.getByText("v1 · generation", { exact: true }).click();
    await page
      .getByRole("button", { name: "载入为草稿", exact: true })
      .last()
      .click();
    await expect(editor).toHaveValue("旧生成内容");
    await expect(
      page.getByRole("button", {
        name: stage === "script" ? "保存剧本" : "保存分镜",
        exact: true,
      }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "保留草稿并载入最新版本" }).click();
    await expect(editor).toHaveValue("基于新来源的人工修改");
    await page.reload();
    await page.getByRole("button", { name: "继续创作 →" }).click();
    await expect(editor).toHaveValue("基于新来源的人工修改");
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
    await page
      .getByRole("button", {
        name: stage === "script" ? "保存剧本" : "保存分镜",
        exact: true,
      })
      .click();
    await expect(
      page.getByText("已保存新版本。", { exact: true }),
    ).toBeVisible();
    expect(saved[1].source_version_id).toBe(source2);
    expect(saved[1].revision).toBe(3);
  });
}
