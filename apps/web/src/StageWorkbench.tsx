import {
  AI_TEXT,
  GenerationOutput,
  notifyTextJob,
  useTextGeneration,
} from "./TextGeneration";
import { ShotReferences } from "./ShotReferences";
import { BoardImport } from "./BoardImport";
import { useEffect, useRef, useState } from "react";
import {
  useMedia,
  BoardMedia,
  MediaToolbar,
  ShotVideo,
  ShotAudio,
  ShotPosition,
} from "./MediaWorkbench";
import { EntityManager } from "./EntityManager";
import { api, unwrap, type MediaFile } from "./api";
import type { components } from "./generated/api";
import { readDraft, storeDraft, removeDraft, durableCommand } from "./commands";
import { MethodSelector, awaitMethodSaves } from "./Configuration";
type Content = components["schemas"]["ContentOut"];
type Body =
  components["schemas"]["ScriptBody"] | components["schemas"]["BoardBody"];
type Stage = "script" | "board";
type StageDraft = { body: Body; revision: number; source: string };
const path = (pid: string, iid: string) => ({ pid, iid });
export async function generateStage(
  pid: string,
  stage: Stage,
  source: string,
  instruction = "",
) {
  await awaitMethodSaves(pid, stage === "script" ? "script" : "storyboard");
  const current = unwrap(
    await api.GET("/api/v1/projects/{pid}/stages/{stage}", {
      params: { path: { pid, stage } },
    }),
  );
  const pendingKey = `sf.${pid}.generate.${stage}.${source}`;
  const body = readDraft<components["schemas"]["StageGenerate"]>(
    pendingKey,
  ) || {
    source_version_id: source,
    target_revision: current.item?.revision || 0,
    instruction,
  };
  localStorage.setItem(pendingKey, JSON.stringify(body));
  const cmd = durableCommand(`${pid}:generate:${stage}`, body);
  const result = await api.POST(
    "/api/v1/projects/{pid}/stages/{stage}/generate",
    {
      params: { path: { pid, stage }, header: { "idempotency-key": cmd.key } },
      body,
    },
  );
  // A 409 is a definitive pre-enqueue rejection. Network/5xx outcomes remain
  // frozen so retrying a possibly accepted paid request cannot create a new job.
  if (result.response.status === 409) {
    cmd.done();
    removeDraft(pendingKey);
  }
  notifyTextJob(unwrap(result));
  cmd.done();
  removeDraft(pendingKey);
}
export function QualityPanel({
  pid,
  item,
  disabled,
  onChanged,
}: {
  pid: string;
  item: Content;
  disabled: boolean;
  onChanged: () => Promise<void>;
}) {
  const [reports, setReports] = useState<components["schemas"]["ReportOut"][]>(
      [],
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  async function load() {
    setReports(
      unwrap(
        await api.GET("/api/v1/projects/{pid}/contents/{iid}/reports", {
          params: { path: path(pid, item.id) },
        }),
      ),
    );
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
    const t = setInterval(
      () => void load().catch((e) => setError(e.message)),
      2500,
    );
    return () => clearInterval(t);
  }, [pid, item.id, item.version_id]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await load();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "请求中断，提交记录保留");
    } finally {
      setBusy(false);
    }
  }
  const reviewJob = useTextGeneration({
    kind: `${item.kind}.review`,
    itemId: item.id,
    versionId: item.version_id,
  });
  const latest = reports[0];
  return (
    <section className="quality">
      <h3>
        {item.kind === "script"
          ? "剧本质检"
          : item.kind === "board"
            ? "分镜质检"
            : "故事质检"}{" "}
        · 建议供参考
      </h3>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <GenerationOutput label="质检结果" job={reviewJob} />
      {!latest && <p className="muted">暂无质检报告，仍可保留当前版本继续。</p>}
      {reports.map((r) => (
        <details key={r.id} open={r === latest}>
          <summary>
            {r.stale || r.version_id !== item.version_id
              ? "报告已过期"
              : {
                  pending: "质检中",
                  succeeded: "质检建议",
                  failed: "质检失败",
                  unknown: "质检待核实",
                }[r.state] || r.state}{" "}
            · {r.version_id.slice(0, 8)}
          </summary>
          <div className="quality-report">
            {r.error && <p>{r.error}</p>}
            <p>{String(r.output?.summary || "")}</p>
            {(Array.isArray(r.output?.issues) ? r.output.issues : []).map(
              (v, i) => {
                const issue = v as Record<string, unknown>;
                return (
                  <div key={i}>
                    <p>
                      {String(issue.message || "")}
                      <br />
                      依据：{String(issue.evidence || "")}
                      <br />
                      建议：{String(issue.suggestion || "")}
                    </p>
                  </div>
                );
              },
            )}
          </div>
        </details>
      ))}
      <div className="actions">
        <button
          disabled={disabled || busy}
          onClick={() =>
            void run(async () => {
              const body = { base_version_id: item.version_id };
              const cmd = durableCommand(`${pid}:review:${item.id}`, body);
              notifyTextJob(
                unwrap(
                  await api.POST(
                    "/api/v1/projects/{pid}/contents/{iid}/review",
                    {
                      params: {
                        path: path(pid, item.id),
                        header: { "idempotency-key": cmd.key },
                      },
                      body,
                    },
                  ),
                ),
              );
              cmd.done();
            })
          }
        >
          重新质检
        </button>
        <button
          disabled={
            disabled ||
            busy ||
            !latest ||
            latest.state !== "succeeded" ||
            latest.stale ||
            latest.version_id !== item.version_id
          }
          onClick={() =>
            void run(async () => {
              await awaitMethodSaves(
                pid,
                item.kind === "board" ? "storyboard" : item.kind,
              );
              const body = {
                base_version_id: item.version_id,
                report_id: latest.id,
                text: "",
              };
              const cmd = durableCommand(`${pid}:repair:${item.id}`, body);
              notifyTextJob(
                unwrap(
                  await api.POST(
                    "/api/v1/projects/{pid}/contents/{iid}/repair",
                    {
                      params: {
                        path: path(pid, item.id),
                        header: { "idempotency-key": cmd.key },
                      },
                      body,
                    },
                  ),
                ),
              );
              cmd.done();
              setNotice("修复建议生成中，完成后在导演助手比较并采用。");
            })
          }
        >
          按报告生成修复建议
        </button>
        <button
          disabled={disabled || busy}
          onClick={() =>
            void run(async () => {
              unwrap(
                await api.POST(
                  "/api/v1/projects/{pid}/contents/{iid}/confirm",
                  {
                    params: { path: path(pid, item.id) },
                    body: { version_id: item.version_id },
                  },
                ),
              );
              setNotice("已记录保留当前版继续，未将质检报告改为通过。");
            })
          }
        >
          保留当前版继续
        </button>
      </div>
    </section>
  );
}
export function StageWorkbench({
  pid,
  stage,
  onNext,
  refreshJobs,
}: {
  pid: string;
  stage: Stage;
  onNext: () => void;
  refreshJobs: () => Promise<void>;
}) {
  const key = `sf.${pid}.stage.${stage}`;
  const responseEpoch = useRef(0),
    observedRevision = useRef(0);
  const cached = readDraft<StageDraft>(key);
  const [preserved, setPreserved] = useState<StageDraft[]>(
    () => readDraft<StageDraft[]>(key + ".preserved") || [],
  );
  const [item, setItem] = useState<Content | null>(null),
    [body, setBody] = useState<Body | null>(cached?.body || null),
    [base, setBase] = useState(cached?.revision || 0),
    [source, setSource] = useState(cached?.source || ""),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [files, setFiles] = useState<MediaFile[]>([]),
    [versions, setVersions] = useState<components["schemas"]["VersionOut"][]>(
      [],
    ),
    [conversation, setConversation] = useState<
      components["schemas"]["ConversationOut"]
    >({ messages: [], proposals: [] }),
    [request, setRequest] = useState(readDraft<string>(key + ".message") || ""),
    [mode, setMode] = useState<"fixed" | "closed" | "floating">("fixed");
  const running = useRef(false);
  const persisted = useRef<Content | null>(null);
  const latestServer = useRef<Content | null>(null);
  const local = useRef({ body, base, source });
  local.current = { body, base, source };
  const generating = useTextGeneration({
    kind: `${stage}.generate`,
    itemId: item?.id,
    targetRevision: item?.revision || 0,
  });
  const advising = useTextGeneration({
    kind: [`${stage}.revise`, `${stage}.repair`],
    itemId: item?.id,
    versionId: item?.version_id,
  });
  async function refresh() {
    const epoch = responseEpoch.current;
    const s = unwrap(
      await api.GET("/api/v1/projects/{pid}/stages/{stage}", {
        params: { path: { pid, stage } },
      }),
    );
    if (
      epoch !== responseEpoch.current ||
      (s.item?.revision || 0) < observedRevision.current
    )
      return latestServer.current;
    latestServer.current = s.item;
    const previous = persisted.current;
    const draft = local.current;
    if (
      s.item &&
      (!draft.body ||
        (previous &&
          draft.base === previous.revision &&
          draft.source === (previous.source_version_id || "") &&
          JSON.stringify(draft.body) === JSON.stringify(previous.body)))
    ) {
      persisted.current = s.item;
      setBody(s.item.body as Body);
      setBase(s.item.revision);
      setSource(s.item.source_version_id || "");
    } else if (!previous && s.item) persisted.current = s.item;
    observedRevision.current = s.item?.revision || 0;
    setItem(s.item);
    setConfirmed(!!s.item && s.confirmation?.version_id === s.item.version_id);
    return s.item;
  }
  useEffect(() => {
    let live = true;
    void refresh()
      .then((i) => {
        if (!live) return;
        if (!cached && i) {
          setBody(i.body as Body);
          setBase(i.revision);
          setSource(i.source_version_id || "");
        }
        setLoaded(true);
      })
      .catch((e) => setError(e.message));
    void api
      .GET("/api/v1/projects/{pid}/files", { params: { path: { pid } } })
      .then(unwrap)
      .then(setFiles)
      .catch((e) => setError(e.message));
    const t = setInterval(
      () => void refresh().catch((e) => setError(e.message)),
      2500,
    );
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [pid, stage]);
  useEffect(() => {
    if (loaded && body) storeDraft(key, { body, revision: base, source });
  }, [loaded, body, base, source, key]);
  useEffect(() => storeDraft(key + ".message", request), [request, key]);
  useEffect(() => {
    if (!item) return;
    const iid = item.id;
    let live = true;
    async function poll() {
      const [c, v] = await Promise.all([
        api.GET("/api/v1/projects/{pid}/contents/{iid}/conversation", {
          params: { path: { pid, iid } },
        }),
        api.GET("/api/v1/projects/{pid}/contents/{iid}/versions", {
          params: { path: { pid, iid } },
        }),
      ]);
      if (live) {
        setConversation(unwrap(c));
        setVersions(unwrap(v));
      }
    }
    void poll().catch((e) => setError(e.message));
    const t = setInterval(
      () => void poll().catch((e) => setError(e.message)),
      2500,
    );
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [item?.id, item?.version_id, pid]);
  // First asynchronous generation may arrive after an empty stage was opened.
  useEffect(() => {
    if (item && !body) {
      setBody(item.body as Body);
      setBase(item.revision);
      setSource(item.source_version_id || "");
    }
  }, [item, body]);
  const sourceMismatch = !!item && source !== item.source_version_id;
  const dirty =
    !!item &&
    (sourceMismatch || JSON.stringify(body) !== JSON.stringify(item.body));
  function preserveDraft() {
    if (!body) return;
    const draft = { body, revision: base, source };
    if (preserved.some((d) => JSON.stringify(d) === JSON.stringify(draft)))
      return;
    const next = [...preserved, draft];
    // Fail closed: do not replace edits if their recovery copy cannot be stored.
    localStorage.setItem(key + ".preserved", JSON.stringify(next));
    setPreserved(next);
  }
  function historySource(version: components["schemas"]["VersionOut"]) {
    // VersionOut links manual edits to previous versions of this same item.
    // The versions endpoint returns the complete item history; follow those
    // links until reaching its cross-stage source, as ContentOut does server-side.
    const seen = new Set<string>();
    let current = version;
    while (current.source_version_id) {
      if (seen.has(current.id))
        throw new Error("历史来源链异常，请载入最新版本");
      seen.add(current.id);
      const previous = versions.find((v) => v.id === current.source_version_id);
      if (!previous) return current.source_version_id;
      current = previous;
    }
    throw new Error("历史版本缺少来源，请载入最新版本");
  }
  async function run(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await refresh();
      await refreshJobs();
    } catch (e) {
      setError(e instanceof Error ? e.message : "连接中断，草稿与提交记录保留");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  function accept(next: Content) {
    if (next.revision < observedRevision.current)
      throw new Error("服务端已有更新版本，草稿已保留，请核对最新正文后继续。");
    responseEpoch.current++;
    persisted.current = next;
    latestServer.current = next;
    observedRevision.current = next.revision;
    setItem(next);
    setBody(next.body as Body);
    setBase(next.revision);
    setSource(next.source_version_id || "");
  }
  async function saveScript(): Promise<Content> {
    if (
      !item ||
      !body ||
      !String((body as components["schemas"]["ScriptBody"]).text || "").trim()
    )
      throw new Error("请填写剧本正文");
    if (sourceMismatch)
      throw new Error("剧本来源已变化，草稿保留，请恢复最新正文后核对修改。");
    if (!dirty && base === item.revision) return item;
    const payload = { revision: base, source_version_id: source, body };
    const response = await api.PUT("/api/v1/projects/{pid}/stages/{stage}", {
      params: { path: { pid, stage } },
      body: payload,
    });
    let next: Content;
    if (response.response.status === 409) {
      const latest = await refresh();
      if (
        !latest ||
        latest.source_version_id !== source ||
        latest.revision !== base + 1 ||
        latest.body.estimatedSeconds !==
          (body as components["schemas"]["ScriptBody"]).estimatedSeconds ||
        String(latest.body.text) !==
          String((body as components["schemas"]["ScriptBody"]).text)
      ) {
        throw new Error("剧本版本冲突，草稿已保留，请核对最新正文后继续。");
      }
      next = latest;
    } else next = unwrap(response);
    accept(next);
    storeDraft(key, {
      body: next.body,
      revision: next.revision,
      source: next.source_version_id || "",
    });
    return next;
  }
  useEffect(() => {
    if (
      stage !== "script" ||
      !loaded ||
      !dirty ||
      busy ||
      error ||
      generating ||
      sourceMismatch ||
      !String(
        (body as components["schemas"]["ScriptBody"] | null)?.text || "",
      ).trim()
    )
      return;
    const timer = setTimeout(
      () =>
        void run(async () => {
          await saveScript();
        }),
      700,
    );
    return () => clearTimeout(timer);
  }, [
    stage,
    loaded,
    body,
    base,
    dirty,
    busy,
    error,
    sourceMismatch,
    generating,
  ]);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{stage === "script" ? "剧本" : "分镜"}工作台</h1>
          <p>
            {stage === "script"
              ? "把故事写成可拍摄的剧本，逐步完善场景、动作与台词。"
              : "逐镜整理台词、图片引用与画面提示词，让每个镜头都有清晰依据。"}
          </p>
        </div>
      </div>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {stage === "board" && (
        <>
          <EntityManager key={pid} pid={pid} />
          <BoardImport
            pid={pid}
            baseVersion={item?.version_id || null}
            disabled={!loaded || busy || !!generating}
            preserve={preserveDraft}
            onImported={(next) => {
              storeDraft(key, {
                body: next.body,
                revision: next.revision,
                source: next.source_version_id || "",
              });
              accept(next);
              setConfirmed(false);
              setConversation({ messages: [], proposals: [] });
              setVersions([]);
              setNotice(
                "分镜整表已替换并保存。请检查图片描述与台词后重新确认；旧版与草稿可恢复。",
              );
              requestAnimationFrame(() => {
                const table = document.querySelector(
                  ".board-editor .table-wrap",
                );
                if (table) {
                  table.scrollTop = 0;
                  table.scrollLeft = 0;
                }
              });
              void refreshJobs();
            }}
          />
        </>
      )}
      {!item || !body ? (
        <section className="empty">
          <GenerationOutput
            label={stage === "script" ? "剧本正文" : "分镜内容"}
            job={generating}
          />
          <p>
            {!loaded
              ? "读取中…"
              : stage === "script"
                ? "请先确定故事并生成剧本。"
                : "请先确认剧本并生成分镜。"}
          </p>
        </section>
      ) : (
        <div className={`editor-with-director ${mode}`}>
          <section
            className={`panel story-editor ${stage === "script" ? "script-editor" : "board-panel"}`}
          >
            <div className="row">
              <h3>
                当前版本 v{item.revision}
                {confirmed ? " · 已确认" : ""}
              </h3>
              <small>草稿基准 v{base}</small>
            </div>
            {stage === "script" && (
              <SourceStory key={source} pid={pid} versionId={source} />
            )}
            {sourceMismatch && (
              <p role="alert">
                草稿来源与当前版本不同，暂不能保存。请保留草稿并载入最新版本，再对照复制需要的修改。
              </p>
            )}
            {item.stale && (
              <p role="alert">上游已更新，此版本已过期。请从上游重新生成。</p>
            )}
            {stage === "script" && (
              <p role="status">
                {busy
                  ? "保存中…"
                  : error
                    ? "保存失败，草稿已保留"
                    : dirty
                      ? "待自动保存"
                      : "已自动保存"}
              </p>
            )}
            {stage === "board" && (
              <GenerationOutput label="分镜内容" job={generating} />
            )}
            <fieldset disabled={busy || !!generating} className="editor-fields">
              {stage === "script" ? (
                <>
                  <label className="field">
                    剧本正文
                    <textarea
                      aria-label="剧本正文"
                      className="story-text"
                      readOnly={!!generating}
                      aria-busy={!!generating}
                      value={
                        generating
                          ? AI_TEXT
                          : (body as components["schemas"]["ScriptBody"]).text
                      }
                      onChange={(e) =>
                        setBody({ ...body, text: e.target.value } as Body)
                      }
                    />
                  </label>
                </>
              ) : (
                <BoardMedia
                  key={`${pid}:${item.version_id}`}
                  pid={pid}
                  version={item.version_id}
                  enabled={
                    !busy &&
                    !dirty &&
                    base === item.revision &&
                    !item.stale &&
                    confirmed
                  }
                  onFiles={setFiles}
                >
                  <BoardEditor
                    pid={pid}
                    body={body as components["schemas"]["BoardBody"]}
                    setBody={setBody}
                    files={files}
                  />
                </BoardMedia>
              )}
            </fieldset>
            <div className="actions">
              {stage === "board" && (
                <button
                  disabled={busy || !!generating || sourceMismatch}
                  onClick={() =>
                    void run(async () => {
                      accept(
                        unwrap(
                          await api.PUT(
                            "/api/v1/projects/{pid}/stages/{stage}",
                            {
                              params: { path: { pid, stage } },
                              body: {
                                revision: base,
                                source_version_id: source,
                                body,
                              },
                            },
                          ),
                        ),
                      );
                      setNotice("已保存新版本。");
                    })
                  }
                >
                  保存分镜
                </button>
              )}
              {(stage === "board" ||
                !!error ||
                sourceMismatch ||
                base !== item.revision) && (
                <button
                  disabled={busy || !!generating}
                  onClick={() =>
                    void run(async () => {
                      const latest = await refresh();
                      if (latest) {
                        preserveDraft();
                        accept(latest);
                        setNotice(
                          "已载入最新完整内容及其来源；原草稿保留在下方，可对照复制修改。",
                        );
                      }
                    })
                  }
                >
                  {stage === "script"
                    ? "核对并恢复当前版本"
                    : "保留草稿并载入最新版本"}
                </button>
              )}
              {stage === "script" && error && (
                <button
                  disabled={busy || !!generating || sourceMismatch}
                  onClick={() =>
                    void run(async () => {
                      await saveScript();
                    })
                  }
                >
                  重试保存
                </button>
              )}
            </div>
            {preserved.length > 0 && (
              <details className="preserved-drafts">
                <summary>保留的草稿（{preserved.length}）</summary>
                <p>
                  载入前的正文、版本与来源保留如下，可选取文字复制到当前编辑区。
                </p>
                {preserved.map((draft, index) => (
                  <section key={index} aria-label={`保留草稿 ${index + 1}`}>
                    <small>
                      草稿基准 v{draft.revision} · 来源：{draft.source}
                    </small>
                    <ContentPreview body={draft.body} />
                    <details>
                      <summary>完整草稿数据（含引用与稳定 ID）</summary>
                      <pre className="preserve-text">
                        {JSON.stringify(draft, null, 2)}
                      </pre>
                    </details>
                  </section>
                ))}
              </details>
            )}
            {stage === "script" ? (
              <div className="method-actions">
                <MethodSelector pid={pid} stage="storyboard" />
                <button
                  className="primary"
                  disabled={
                    busy ||
                    !!generating ||
                    sourceMismatch ||
                    !String(
                      (body as components["schemas"]["ScriptBody"]).text || "",
                    ).trim()
                  }
                  onClick={() =>
                    void run(async () => {
                      const saved = await saveScript();
                      await generateStage(pid, "board", saved.version_id);
                      onNext();
                    })
                  }
                >
                  确认剧本并AI生成分镜
                </button>
              </div>
            ) : (
              <p className="muted">
                确认分镜使用“保留当前版继续”。生成任务保留输入快照；参考图须人工确认后才能用于视频。
              </p>
            )}
            <details className="version-history">
              <summary>版本历史（{versions.length}）</summary>
              {versions.map((v) => (
                <details key={v.id}>
                  <summary>
                    v{v.revision} · {v.origin}
                  </summary>
                  <ContentPreview body={v.body} />
                  <button
                    disabled={busy || !!generating}
                    onClick={() =>
                      void run(async () => {
                        const historicalSource = historySource(v);
                        preserveDraft();
                        setBody(v.body as Body);
                        setBase(item.revision);
                        setSource(historicalSource);
                        setNotice(
                          "历史版已按原来源载入，替换前草稿已保留；来源一致时可保存为新版本。",
                        );
                      })
                    }
                  >
                    载入为草稿
                  </button>
                </details>
              ))}
            </details>
          </section>
          {mode === "closed" ? (
            <button
              className="director-toggle"
              onClick={() => setMode("fixed")}
            >
              展开导演助手
            </button>
          ) : (
            <section className="panel director">
              <div className="row">
                <h2>AI导演助手</h2>
                <button
                  aria-label="悬浮导演助手"
                  onClick={() =>
                    setMode(mode === "floating" ? "fixed" : "floating")
                  }
                >
                  {mode === "floating" ? "固定" : "悬浮"}
                </button>
                <button
                  aria-label="收起导演助手"
                  onClick={() => setMode("closed")}
                >
                  收起
                </button>
              </div>
              <QualityPanel
                pid={pid}
                item={item}
                disabled={
                  busy || !!generating || dirty || base !== item.revision
                }
                onChanged={async () => {
                  await refresh();
                  await refreshJobs();
                }}
              />

              <GenerationOutput label="建议正文" job={advising} />
              <div className="conversation">
                {conversation.messages.map((m) => (
                  <p className="preserve-text" key={m.id}>
                    {m.role === "user" ? "我" : "导演"}：{m.text}
                  </p>
                ))}
              </div>
              <label className="field">
                修改要求
                <textarea
                  aria-label="修改要求"
                  disabled={busy || !!generating}
                  value={request}
                  onChange={(e) => setRequest(e.target.value)}
                />
              </label>
              <MethodSelector
                pid={pid}
                stage={stage === "script" ? "script" : "storyboard"}
              />
              <button
                className="primary"
                disabled={
                  busy ||
                  !!generating ||
                  !!advising ||
                  dirty ||
                  base !== item.revision ||
                  !request.trim()
                }
                onClick={() =>
                  void run(async () => {
                    await awaitMethodSaves(
                      pid,
                      stage === "script" ? "script" : "storyboard",
                    );
                    const input = {
                      base_version_id: item.version_id,
                      text: request,
                    };
                    const cmd = durableCommand(
                      `${pid}:message:${item.id}`,
                      input,
                    );
                    notifyTextJob(
                      unwrap(
                        await api.POST(
                          "/api/v1/projects/{pid}/contents/{iid}/messages",
                          {
                            params: {
                              path: path(pid, item.id),
                              header: { "idempotency-key": cmd.key },
                            },
                            body: input,
                          },
                        ),
                      ),
                    );
                    cmd.done();
                    setRequest("");
                  })
                }
              >
                发送修改要求
              </button>
              {conversation.proposals.map((p) => (
                <details
                  className="proposal"
                  key={p.id}
                  open={!p.applied_version_id}
                >
                  <summary>
                    {p.applied_version_id
                      ? "已采用"
                      : p.base_version_id !== item.version_id
                        ? "建议已过期"
                        : "AI建议版"}
                  </summary>
                  <p>{String(p.output.changeSummary || "")}</p>
                  <ContentPreview
                    body={
                      (p.output.body || p.output) as Record<string, unknown>
                    }
                  />
                  <button
                    disabled={
                      busy ||
                      !!generating ||
                      dirty ||
                      base !== item.revision ||
                      !!p.applied_version_id ||
                      p.base_version_id !== item.version_id
                    }
                    onClick={() =>
                      void run(async () =>
                        accept(
                          unwrap(
                            await api.POST(
                              "/api/v1/projects/{pid}/proposals/{proposal_id}/apply",
                              { params: { path: { pid, proposal_id: p.id } } },
                            ),
                          ),
                        ),
                      )
                    }
                  >
                    采用此版
                  </button>
                </details>
              ))}
            </section>
          )}
        </div>
      )}
    </>
  );
}
function ContentPreview({ body }: { body: Record<string, unknown> }) {
  const shots = body.shots as components["schemas"]["Shot"][] | undefined;
  return (
    <div className="preserve-text">
      {String((body as components["schemas"]["ScriptBody"]).text || "")}
      {shots?.map((s, i) => (
        <p key={s.id}>
          镜头 {i + 1} · {s.prompt}
          <br />
          {s.dialogues.map((d) => `${d.speaker}：${d.text}`).join("\n")}
        </p>
      ))}
    </div>
  );
}
function BoardEditor({
  pid,
  body,
  setBody,
  files,
}: {
  pid: string;
  body: components["schemas"]["BoardBody"];
  setBody: (b: Body) => void;
  files: MediaFile[];
}) {
  type Shot = components["schemas"]["Shot"];
  const media = useMedia();
  function change(index: number, shot: Shot) {
    setBody({
      ...body,
      shots: body.shots.map((s, i) =>
        i === index
          ? {
              ...shot,
              dialogue: shot.dialogues
                .map((d) => d.text)
                .join("\n")
                .trim(),
            }
          : s,
      ),
    });
  }
  function move(i: number, step: number) {
    media.notice(
      "镜头顺序已调整：可能影响叙事连续性与前镜尾帧引用，请检查后保存并重新确认。",
    );
    const shots = [...body.shots];
    [shots[i], shots[i + step]] = [shots[i + step], shots[i]];
    setBody({ ...body, shots });
  }
  return (
    <div className="board-editor">
      <MediaToolbar body={body} />
      <div className="table-wrap">
        <table className="board-table">
          <thead>
            <tr>
              <th>序号</th>
              <th>多段台词</th>
              <th>图片引用</th>
              <th>提示词 / 时长</th>
              <th>视频</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {body.shots.map((s, i) => (
              <tr key={s.id} data-shot-id={s.id}>
                <td>
                  <h3>镜头 {i + 1}</h3>
                  <details>
                    <summary>稳定 ID</summary>
                    <small>{s.id}</small>
                  </details>
                </td>
                <td>
                  {s.dialogues.map((d, j) => (
                    <div
                      className="dialogue-line"
                      key={d.id}
                      data-line-id={d.id}
                    >
                      {(["speaker", "emotion", "text", "voice"] as const).map(
                        (f) => (
                          <label
                            className={
                              "field " + (f === "text" ? "line-text" : "")
                            }
                            key={f}
                          >
                            {
                              {
                                speaker: "说话人",
                                emotion: "情绪",
                                text: "台词",
                                voice: "音色",
                              }[f]
                            }
                            {f === "text" ? (
                              <textarea
                                rows={3}
                                value={d[f]}
                                onChange={(e) =>
                                  change(i, {
                                    ...s,
                                    dialogues: s.dialogues.map((line, k) =>
                                      j === k
                                        ? { ...line, [f]: e.target.value }
                                        : line,
                                    ),
                                  })
                                }
                              />
                            ) : (
                              <input
                                value={
                                  f === "speaker"
                                    ? media.bindings.find(
                                        (b) => b.line_id === d.id,
                                      )?.name || d[f]
                                    : d[f]
                                }
                                readOnly={
                                  f === "speaker" &&
                                  !!media.bindings.find(
                                    (b) => b.line_id === d.id,
                                  )?.entity_id
                                }
                                onChange={(e) =>
                                  change(i, {
                                    ...s,
                                    dialogues: s.dialogues.map((line, k) =>
                                      j === k
                                        ? { ...line, [f]: e.target.value }
                                        : line,
                                    ),
                                  })
                                }
                              />
                            )}
                          </label>
                        ),
                      )}
                      <ShotAudio shot={s} lineId={d.id} />
                      <button
                        disabled={s.dialogues.length === 1}
                        onClick={() =>
                          change(i, {
                            ...s,
                            dialogues: s.dialogues.filter((_, k) => k !== j),
                          })
                        }
                      >
                        删除台词
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() =>
                      change(i, {
                        ...s,
                        dialogues: [
                          ...s.dialogues,
                          {
                            id: crypto.randomUUID(),
                            speaker: "",
                            emotion: "",
                            text: "",
                            voice: "",
                          },
                        ],
                      })
                    }
                  >
                    添加台词
                  </button>
                </td>
                <td>
                  <details open>
                    <summary>图片引用（角色 / 场景 / 道具 / 站位）</summary>
                    <ShotPosition
                      shot={s}
                      onBind={(id) =>
                        change(i, {
                          ...s,
                          refs: {
                            ...s.refs,
                            positions: [...(s.refs.positions || []), id],
                          },
                        })
                      }
                    />
                    <ShotReferences
                      shot={s}
                      files={files}
                      onChange={(refs) => change(i, { ...s, refs })}
                    />
                  </details>
                </td>
                <td>
                  <label className="field">
                    画面描述
                    <textarea
                      rows={7}
                      value={s.prompt}
                      onChange={(e) =>
                        change(i, { ...s, prompt: e.target.value })
                      }
                    />
                  </label>
                  <label className="field">
                    镜头秒数
                    <input
                      type="number"
                      min="0.1"
                      step="0.1"
                      value={s.duration}
                      onChange={(e) =>
                        change(i, { ...s, duration: Number(e.target.value) })
                      }
                    />
                  </label>
                </td>
                <td>
                  <ShotVideo shot={s} previousShotId={body.shots[i - 1]?.id} />
                </td>
                <td>
                  {" "}
                  <div className="shot-actions">
                    <button disabled={!i} onClick={() => move(i, -1)}>
                      上移镜头
                    </button>
                    <button
                      disabled={i === body.shots.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      下移镜头
                    </button>
                    <button
                      disabled={body.shots.length === 1}
                      onClick={() =>
                        setBody({
                          ...body,
                          shots: body.shots.filter((_, j) => j !== i),
                        })
                      }
                    >
                      删除镜头
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        onClick={() =>
          setBody({
            ...body,
            shots: [
              ...body.shots,
              {
                id: crypto.randomUUID(),
                dialogue: "",
                dialogues: [
                  {
                    id: crypto.randomUUID(),
                    speaker: "",
                    emotion: "",
                    text: "",
                    voice: "",
                  },
                ],
                prompt: "新镜头",
                duration: 3,
                refs: { characters: [], scenes: [], props: [], positions: [] },
              },
            ],
          })
        }
      >
        添加镜头
      </button>
    </div>
  );
}

export function IdeaDirector({
  pid,
  item,
  disabled,
  onAdopt,
  mode,
  setMode,
}: {
  pid: string;
  item: Content | null;
  mode: "fixed" | "closed" | "floating";
  setMode: (mode: "fixed" | "closed" | "floating") => void;
  disabled: boolean;
  onAdopt: (i: Content) => void;
}) {
  const key = `sf.${pid}.idea.message`;
  const [request, setRequest] = useState(readDraft<string>(key) || ""),
    [conversation, setConversation] = useState<
      components["schemas"]["ConversationOut"]
    >({ messages: [], proposals: [] }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => storeDraft(key, request), [key, request]);
  useEffect(() => {
    if (!item) return;
    const iid = item.id;
    let live = true;
    async function load() {
      const c = unwrap(
        await api.GET("/api/v1/projects/{pid}/contents/{iid}/conversation", {
          params: { path: path(pid, iid) },
        }),
      );
      if (live) setConversation(c);
    }
    void load().catch((e) => setError(e.message));
    const t = setInterval(
      () => void load().catch((e) => setError(e.message)),
      2500,
    );
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [pid, item?.id]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "提交中断，草稿保留");
    } finally {
      setBusy(false);
    }
  }
  return mode === "closed" ? (
    <button className="director-toggle" onClick={() => setMode("fixed")}>
      展开创意助手
    </button>
  ) : (
    <section className="panel director">
      <div className="row">
        <h2>AI导演助手</h2>
        <button
          aria-label="悬浮创意助手"
          onClick={() => setMode(mode === "floating" ? "fixed" : "floating")}
        >
          {mode === "floating" ? "固定" : "悬浮"}
        </button>
        <button aria-label="收起创意助手" onClick={() => setMode("closed")}>
          收起
        </button>
      </div>
      <p className="muted">完善一句话创意，采用建议后才更新。</p>
      {error && <p role="alert">{error}</p>}
      <div className="suggestions">
        <strong>创意建议</strong>
        {["强化核心冲突", "明确主角目标", "优化故事转折"].map((text) => (
          <button
            key={text}
            disabled={!item || disabled || busy}
            onClick={() => setRequest(text)}
          >
            {text}
          </button>
        ))}
      </div>
      <div className="conversation">
        {conversation.messages.map((m) => (
          <p key={m.id} className={m.role}>
            {m.text}
          </p>
        ))}
      </div>
      <label className="field">
        创意修改要求
        <textarea
          disabled={!item || disabled || busy}
          value={request}
          onChange={(e) => setRequest(e.target.value)}
        />
      </label>
      <button
        className="primary"
        disabled={!item || disabled || busy || !request.trim()}
        onClick={() =>
          void run(async () => {
            if (!item) return;
            const body = { base_version_id: item?.version_id, text: request };
            const cmd = durableCommand(`${pid}:message:${item.id}`, body);
            unwrap(
              await api.POST("/api/v1/projects/{pid}/contents/{iid}/messages", {
                params: {
                  path: path(pid, item.id),
                  header: { "idempotency-key": cmd.key },
                },
                body,
              }),
            );
            cmd.done();
            setRequest("");
          })
        }
      >
        发送创意修改要求
      </button>
      {conversation.proposals.map((p) => (
        <details key={p.id} open={!p.applied_version_id}>
          <summary>
            {p.applied_version_id
              ? "已采用"
              : p.base_version_id !== item?.version_id
                ? "建议已过期"
                : "AI创意建议"}
          </summary>
          <ContentPreview
            body={(p.output.body || p.output) as Record<string, unknown>}
          />
          <button
            disabled={
              disabled ||
              busy ||
              !!p.applied_version_id ||
              p.base_version_id !== item?.version_id
            }
            onClick={() =>
              void run(async () =>
                onAdopt(
                  unwrap(
                    await api.POST(
                      "/api/v1/projects/{pid}/proposals/{proposal_id}/apply",
                      { params: { path: { pid, proposal_id: p.id } } },
                    ),
                  ),
                ),
              )
            }
          >
            采用创意建议
          </button>
        </details>
      ))}
    </section>
  );
}

function SourceStory({
  pid,
  versionId,
}: {
  pid: string;
  versionId: string | null;
}) {
  const [version, setVersion] = useState<
      components["schemas"]["VersionOut"] | null
    >(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    setVersion(null);
    setError("");
  }, [pid, versionId]);
  async function load() {
    if (version || loading) return;
    setLoading(true);
    setError("");
    try {
      if (!versionId) throw new Error("此剧本缺少原故事版本标识");
      const found = unwrap(
        await api.GET("/api/v1/projects/{pid}/versions/{version_id}", {
          params: { path: { pid, version_id: versionId } },
        }),
      );
      setVersion(found);
    } catch (e) {
      setError(e instanceof Error ? e.message : "原故事读取失败");
    } finally {
      setLoading(false);
    }
  }
  return (
    <details
      className="source-story"
      onToggle={(e) => {
        if (e.currentTarget.open) void load();
      }}
    >
      <summary>原故事（生成来源）</summary>
      <small>源版本：{versionId || "缺失"}</small>
      {loading && <p>读取原故事版本…</p>}
      {error && (
        <p role="alert">
          {error}
          <button onClick={() => void load()}>重试读取原故事</button>
        </p>
      )}
      {version && (
        <>
          <h3>
            {String(version.body.title || "原故事")} · v{version.revision}
          </h3>
          <p className="preserve-text">{String(version.body.text || "")}</p>
        </>
      )}
    </details>
  );
}
