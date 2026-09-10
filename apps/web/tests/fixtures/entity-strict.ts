import type { Page } from "@playwright/test";

// Isolated scenario data and API adapter for the agreed element workflow DTOs.
// The route guard aborts unknown writes; no request reaches a real provider.
export const strictEntityIds = {
  projectA: "11111111-1111-4111-8111-111111111111",
  projectB: "22222222-2222-4222-8222-222222222222",
  character: "33333333-3333-4333-8333-333333333331",
  secondCharacter: "33333333-3333-4333-8333-333333333332",
  scene: "44444444-4444-4444-8444-444444444444",
  prop: "55555555-5555-4555-8555-555555555555",
  inputFile: "66666666-6666-4666-8666-666666666661",
  outputFile: "66666666-6666-4666-8666-666666666662",
  historicalFile: "66666666-6666-4666-8666-666666666663",
  foreignFile: "66666666-6666-4666-8666-666666666664",
  firstCharacterRef: "77777777-7777-4777-8777-777777777771",
  secondCharacterRef: "77777777-7777-4777-8777-777777777772",
  shot: "88888888-8888-4888-8888-888888888888",
} as const;

export function createStrictEntityScenario() {
  const ids = strictEntityIds;
  return {
    projects: [
      { id: ids.projectA, name: "三元素项目A" },
      { id: ids.projectB, name: "三元素项目B" },
    ],
    // Separate source inputs, current outputs and historical output records.
    elements: [
      {
        id: ids.character,
        revision: 1,
        kind: "character",
        name: "邮差",
        description: "蓝制服",
        voice: "male-qn-qingse",
        three_view: false,
      },
      {
        id: ids.secondCharacter,
        revision: 1,
        kind: "character",
        name: "女孩",
        description: "黄雨衣",
        voice: "female-shaonv",
        three_view: false,
      },
      {
        id: ids.scene,
        revision: 1,
        kind: "scene",
        name: "邮局",
        description: "木制柜台",
        voice: "",
        three_view: false,
      },
      {
        id: ids.prop,
        revision: 1,
        kind: "prop",
        name: "信封",
        description: "红色封蜡",
        voice: "",
        three_view: false,
      },
    ],
    edits: {
      [ids.character]: "红制服草稿",
      [ids.scene]: "石制柜台草稿",
      [ids.prop]: "蓝色封蜡草稿",
    },
    inputImages: [{ entityId: ids.character, fileId: ids.inputFile }],
    outputImages: [
      {
        entityId: ids.character,
        fileId: ids.outputFile,
        confirmed: true,
        stale: false,
      },
    ],
    historicalImages: [
      {
        entityId: ids.character,
        fileId: ids.historicalFile,
        confirmed: false,
        stale: true,
      },
    ],
    foreignImages: [{ projectId: ids.projectB, fileId: ids.foreignFile }],
    references: [
      {
        refId: ids.firstCharacterRef,
        entityId: ids.character,
        fileId: ids.outputFile,
      },
      {
        refId: ids.secondCharacterRef,
        entityId: ids.secondCharacter,
        fileId: null,
      },
    ],
  };
}

export function responseGate() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export type StrictEntityRequest = {
  method: string;
  path: string;
  body: unknown;
};

// Register before endpoint mocks. Unknown API access is aborted, not forwarded
// to a development/production service. This keeps future paid scenarios mocked.
export async function isolateStrictEntityApi(page: Page) {
  const writes: StrictEntityRequest[] = [];
  const unhandled: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      !path.startsWith("/api/v1/") ||
      ["GET", "HEAD"].includes(request.method())
    )
      return;
    let body: unknown = request.postData();
    if (request.headers()["content-type"]?.includes("application/json"))
      body = request.postDataJSON();
    writes.push({ method: request.method(), path, body });
  });
  await page.route("**/api/v1/**", async (route) => {
    unhandled.push(
      `${route.request().method()} ${new URL(route.request().url()).pathname}`,
    );
    await route.abort("blockedbyclient");
  });
  return { writes, unhandled };
}

export async function setupStrictEntityPage(page: Page) {
  const scenario = createStrictEntityScenario();
  const guard = await isolateStrictEntityApi(page);
  const ids = strictEntityIds;
  const boardVersion = "99999999-9999-4999-8999-999999999999";
  let entities = scenario.elements.map((e, i) => ({
    ...e,
    version_id: `10000000-0000-4000-8000-00000000000${i}`,
    input_file_id: null as string | null,
    output_file_id: null as string | null,
    library_asset_id: null,
    library_version: null,
  }));
  let archived: typeof entities = [];
  const board = {
    id: "board-strict",
    kind: "board",
    revision: 1,
    version_id: boardVersion,
    source_version_id: "script-v1",
    stale: false,
    body: {
      schemaVersion: 2,
      scriptId: "script-v1",
      shots: [
        {
          id: ids.shot,
          prompt: "邮差走进邮局",
          duration: 5,
          dialogue: "你好",
          dialogues: [
            {
              id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              speaker: "邮差",
              emotion: "平静",
              text: "你好",
              voice: "male-qn-qingse",
            },
          ],
          refs: {
            characters: [ids.firstCharacterRef, ids.secondCharacterRef],
            scenes: [],
            props: [],
            positions: [],
          },
        },
      ],
    },
  };
  const state = {
    saveStatus: 200,
    batchAbortOnce: false,
    blockDelete: true,
    saveGate: null as ReturnType<typeof responseGate> | null,
    uploads: 0,
    batchRequests: [] as { key: string; body: unknown }[],
    saveRequests: [] as {
      key: string;
      body: { base_board_version_id: string | null; items: typeof entities };
    }[],
    bindRequests: [] as { path: string; body: unknown }[],
    get entities() {
      return entities;
    },
    get archived() {
      return archived;
    },
  };
  const projects = scenario.projects.map((p) => ({
    ...p,
    market: "zh",
    revision: 1,
    stage: "idea",
    status: "in_progress",
    type_id: null,
    updated_at: "2026-09-10T00:00:00Z",
    generation_settings: {
      revision: 1,
      aspect_ratio: "16:9",
      resolution: "720P",
    },
  }));
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      method = request.method(),
      url = new URL(request.url()),
      path = url.pathname;
    const root = `/api/v1/projects/${ids.projectA}`;
    if (path.includes("/settings/resolve/"))
      return route.fulfill({
        json: {
          model: { value: { provider: "fixture", model: "isolated-image" } },
          style: { name: "卡通" },
          specification: { aspect_ratio: "16:9", resolution: "720P" },
        },
      });
    if (path === root + "/entities/batch" && method === "PUT") {
      const body = request.postDataJSON();
      state.saveRequests.push({
        key: request.headers()["idempotency-key"],
        body,
      });
      await state.saveGate?.promise;
      if (state.saveStatus !== 200)
        return route.fulfill({
          status: state.saveStatus,
          json: { detail: "元素版本冲突，全部修改未保存" },
        });
      entities = entities.map((e) => {
        const edit = body.items.find((d: { id: string }) => d.id === e.id);
        return edit ? { ...e, ...edit, revision: e.revision + 1 } : e;
      });
      for (const edit of body.items)
        if (!entities.some((e) => e.id === edit.id))
          entities.push({ ...edit, revision: 1, version_id: edit.id });
      return route.fulfill({
        json: {
          entities,
          board_version_id: boardVersion,
          affected_shot_ids: [],
        },
      });
    }
    if (path === root + "/entities/image-batches" && method === "POST") {
      state.batchRequests.push({
        key: request.headers()["idempotency-key"],
        body: request.postDataJSON(),
      });
      if (state.batchAbortOnce && state.batchRequests.length === 1)
        return route.abort("failed");
      return route.fulfill({
        status: 202,
        json: { jobs: [{ id: "image-batch-job", state: "queued" }] },
      });
    }
    if (
      path.startsWith(root + "/entities/") &&
      path.endsWith("/shot-bindings") &&
      method === "POST"
    ) {
      const body = request.postDataJSON();
      state.bindRequests.push({ path, body });
      return route.fulfill({
        json: {
          board_version_id: boardVersion,
          ref_id:
            body.mode === "replace"
              ? ids.firstCharacterRef
              : "77777777-7777-4777-8777-777777777773",
          affected_shot_ids: [ids.shot],
        },
      });
    }
    if (path.startsWith(root + "/entities/") && method === "DELETE") {
      if (state.blockDelete)
        return route.fulfill({
          status: 409,
          json: { detail: "元素仍被镜头引用，不能删除" },
        });
      const id = path.split("/").at(-1)!;
      archived = entities.filter((e) => e.id === id);
      entities = entities.filter((e) => e.id !== id);
      return route.fulfill({ json: { id, archived: true } });
    }
    if (path === root + "/files" && method === "POST") {
      state.uploads++;
      return route.fulfill({
        status: 201,
        json: { id: ids.inputFile, filename: "input.png", mime: "image/png" },
      });
    }
    if (method !== "GET") return route.fallback();
    if (path === "/api/v1/projects")
      return route.fulfill({
        json: { items: projects, total: projects.length },
      });
    if (projects.some((p) => path === `/api/v1/projects/${p.id}`))
      return route.fulfill({ json: projects.find((p) => path.endsWith(p.id)) });
    if (path === "/api/v1/library/assets") return route.fulfill({ json: [] });
    if (path === "/api/v1/settings")
      return route.fulfill({
        json: {
          project_types: [],
          prompt_count: 0,
          text_configured: true,
          text_model: "fixture",
          enabled_job_kinds: [],
        },
      });
    if (path.includes("/bindings/"))
      return route.fulfill({ json: { revision: 0, value: null } });
    if (path.endsWith("/entities"))
      return route.fulfill({ json: path.startsWith(root) ? entities : [] });
    if (path.includes("/entities/") && path.endsWith("/versions")) {
      const id = path.split("/").at(-2);
      return route.fulfill({
        json: [...entities, ...archived].filter((e) => e.id === id),
      });
    }
    if (path.endsWith("/stages/board"))
      return route.fulfill({
        json: {
          item: board,
          confirmation: { version_id: boardVersion },
          reports: [],
        },
      });
    if (path.includes("/stages/"))
      return route.fulfill({
        json: { item: null, confirmation: null, reports: [] },
      });
    if (path.endsWith("/idea")) return route.fulfill({ json: null });
    if (path.endsWith("/stories"))
      return route.fulfill({
        json: {
          items: [],
          total: 0,
          selected_version_id: null,
          selection_revision: 0,
        },
      });
    if (path.endsWith("/storyboard/import/assets") || path.endsWith("/reports"))
      return route.fulfill({ json: [] });
    if (path.includes("/media/shots/") && path.endsWith("/settings"))
      return route.fulfill({
        json: {
          revision: 0,
          overrides: {},
          effective: {
            model: { value: { model: "工程测试视频模型" } },
            specification: { aspect_ratio: "16:9", resolution: "720P" },
          },
          sources: {},
        },
      });
    if (path.endsWith("/conversation"))
      return route.fulfill({ json: { messages: [], proposals: [] } });
    if (path.includes("/files/"))
      return route.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
          "base64",
        ),
      });
    if (
      [
        "/resources",
        "/versions",
        "/files",
        "/reference-images",
        "/media/results",
        "/media/tasks",
        "/media/line-bindings",
        "/media/reference-bindings",
        "/jobs",
      ].some((suffix) => path.endsWith(suffix))
    )
      return route.fulfill({ json: [] });
    return route.fallback();
  });
  await page.goto("/");
  await page
    .locator(".cards article")
    .filter({ hasText: "三元素项目A" })
    .getByRole("button", { name: "继续创作 →" })
    .click();
  await page.getByRole("button", { name: "4　分镜" }).click();
  return { ...guard, state, ids, boardVersion, scenario };
}
