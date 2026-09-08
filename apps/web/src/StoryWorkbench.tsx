import { useEffect, useState } from "react";
import { api, unwrap, type Job } from "./api";
import { readDraft, storeDraft, removeDraft, durableCommand } from "./commands";
import {
  StageWorkbench,
  QualityPanel,
  generateStage,
  IdeaDirector,
} from "./StageWorkbench";
import { MethodSelector, awaitMethodSaves } from "./Configuration";
import type { components } from "./generated/api";

type Content = components["schemas"]["ContentOut"];
type StoryBody = components["schemas"]["StoryBody"];
type Page = components["schemas"]["StoriesOut"];
type Conversation = components["schemas"]["ConversationOut"];
type Version = components["schemas"]["VersionOut"];
const states: Record<string, string> = {
  queued: "排队中",
  running: "生成中",
  succeeded: "已完成",
  failed: "失败",
  unknown: "待核实",
};
export function StoryWorkbench({ pid }: { pid: string }) {
  const [stage, updateStage] = useState(
    () => readDraft<string>(`sf.${pid}.stage`) || "创意",
  );
  function setStage(next: string) {
    storeDraft(`sf.${pid}.stage`, next);
    updateStage(next);
  }
  const [ideaMode, setIdeaMode] = useState<"fixed" | "closed" | "floating">(
    "fixed",
  );
  const [idea, setIdea] = useState<Content | null>(null);
  const [text, setText] = useState("");
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [instruction, setInstruction] = useState(
    () => readDraft<string>(`sf.${pid}.instruction`) || "",
  );
  const [page, setPage] = useState<Page>({
    items: [],
    total: 0,
    selection_revision: 0,
    selected_version_id: null,
  });
  const [offset, setOffset] = useState(0);
  const [activeId, setActiveId] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  function commandKey(action: string, body: unknown) {
    return durableCommand(pid + ":" + action, body);
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(
        e instanceof TypeError
          ? "连接中断，草稿与提交记录已保留，请重试"
          : e instanceof Error
            ? e.message
            : "连接失败，草稿已保留",
      );
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    const [p, j] = await Promise.all([
      api.GET("/api/v1/projects/{pid}/stories", {
        params: { path: { pid }, query: { offset } },
      }),
      api.GET("/api/v1/projects/{pid}/jobs", { params: { path: { pid } } }),
    ]);
    setPage(unwrap(p));
    setJobs(
      unwrap(j).filter((j) => /^(idea|story|script|board)\./.test(j.kind)),
    );
  }
  useEffect(() => {
    let live = true;
    void api
      .GET("/api/v1/projects/{pid}/idea", { params: { path: { pid } } })
      .then(unwrap)
      .then((saved) => {
        if (!live) return;
        setIdea(saved);
        const draft = readDraft<{ text: string; revision: number }>(
          `sf.${pid}.idea`,
        );
        setText(draft?.text ?? String(saved?.body.text || ""));
        setRevision(draft?.revision ?? saved?.revision ?? 0);
        setLoaded(true);
        if (saved && !readDraft<string>(`sf.${pid}.stage`)) setStage("故事");
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [pid]);
  useEffect(() => {
    let live = true;
    const poll = async () => {
      try {
        const [p, j] = await Promise.all([
          api.GET("/api/v1/projects/{pid}/stories", {
            params: { path: { pid }, query: { offset } },
          }),
          api.GET("/api/v1/projects/{pid}/jobs", { params: { path: { pid } } }),
        ]);
        if (live) {
          setPage(unwrap(p));
          setJobs(
            unwrap(j).filter((j) =>
              /^(idea|story|script|board)\./.test(j.kind),
            ),
          );
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "无法读取状态");
      }
    };
    void poll();
    const timer = setInterval(poll, 2500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [pid, offset]);
  useEffect(() => {
    if (loaded) storeDraft(`sf.${pid}.idea`, { text, revision });
  }, [text, revision, loaded, pid]);
  const active = page.items.find((i) => i.id === activeId) || page.items[0];
  async function saveIdea() {
    const saved = unwrap(
      await api.PUT("/api/v1/projects/{pid}/idea", {
        params: { path: { pid } },
        body: { text, revision },
      }),
    );
    setIdea(saved);
    setRevision(saved.revision);
    removeDraft(`sf.${pid}.idea`);
    return saved;
  }
  async function generate() {
    await awaitMethodSaves(pid, "story");
    const saved = await saveIdea();
    const body = {
      idea_version_id: saved.version_id,
      instruction,
      style: "",
      writing_mode: "prompt" as const,
    };
    const cmd = commandKey("generate", body);
    unwrap(
      await api.POST("/api/v1/projects/{pid}/story-batches", {
        params: { path: { pid }, header: { "idempotency-key": cmd.key } },
        body,
      }),
    );
    cmd.done();
    setOffset(0);
    setStage("故事");
    setNotice("生成任务已保存，可以离开页面，稍后回来继续。");
    await refresh();
  }
  return (
    <>
      <div className="stages">
        {["创意", "故事", "剧本", "分镜", "导出"].map((s, i) => (
          <button
            className={stage === s ? "current" : ""}
            key={s}
            onClick={() => setStage(s)}
          >
            {i + 1}　{s}
          </button>
        ))}
      </div>
      {error && (
        <div role="alert" className="alert">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="notice">
          {notice}
        </div>
      )}
      {stage === "创意" && (
        <div className={`editor-with-director ${ideaMode}`}>
          <section className="panel">
            <h2>创意工作台</h2>
            <label className="field">
              一句话创意
              <textarea
                disabled={busy || !loaded}
                aria-label="一句话创意"
                rows={5}
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={10000}
              />
            </label>
            <div className="actions">
              <button
                disabled={busy || !loaded || !text.trim()}
                onClick={() =>
                  void run(async () => {
                    await saveIdea();
                    setNotice("创意版本已保存");
                  })
                }
              >
                保存创意
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const saved = unwrap(
                      await api.GET("/api/v1/projects/{pid}/idea", {
                        params: { path: { pid } },
                      }),
                    );
                    setIdea(saved);
                    setRevision(saved?.revision || 0);
                    if (!loaded) setText(String(saved?.body.text || ""));
                    setLoaded(true);
                    setNotice("已读取最新基准，输入草稿保留，请合并后保存。");
                  })
                }
              >
                读取最新基准
              </button>
            </div>
            <GenerationControls
              {...{
                instruction,
                setInstruction,
                pid,
              }}
            />
            <button
              className="primary"
              disabled={busy || !loaded || !text.trim()}
              onClick={() => void run(generate)}
            >
              AI生成3个故事方案
            </button>
          </section>
          <IdeaDirector
            mode={ideaMode}
            setMode={setIdeaMode}
            pid={pid}
            item={idea}
            disabled={busy || !idea || text !== String(idea.body.text)}
            onAdopt={(i) => {
              setIdea(i);
              setText(String(i.body.text));
              setRevision(i.revision);
            }}
          />
        </div>
      )}
      {stage === "故事" && (
        <>
          <div className="row workbench-heading">
            <h2>故事工作台</h2>
            <button
              disabled={busy || !loaded || !text.trim()}
              onClick={() => void run(generate)}
            >
              再生成3个方案
            </button>
          </div>
          <details className="panel">
            <summary>本次写作指令与风格</summary>
            <GenerationControls
              {...{
                instruction,
                setInstruction,
                pid,
              }}
            />
            <small>
              使用已保存创意 v{idea?.revision || 0}
              ；创意草稿改变时会先保存新版本。
            </small>
          </details>
          {active ? (
            <div className="story-layout">
              <section className="candidates panel">
                <h2>故事候选</h2>
                {page.items.map((s) => (
                  <button
                    className={
                      s.id === active.id ? "candidate current" : "candidate"
                    }
                    key={s.id}
                    onClick={() => setActiveId(s.id)}
                  >
                    <strong>{String(s.body.title)}</strong>
                    <span>{String(s.body.logline)}</span>
                    <small>
                      v{s.revision}
                      {s.stale ? " · 来自旧创意" : ""}
                      {page.selected_version_id === s.version_id
                        ? " · 已选定"
                        : ""}
                    </small>
                  </button>
                ))}
                <div className="pagination">
                  <button
                    aria-label="较新候选"
                    disabled={!offset}
                    onClick={() => setOffset(Math.max(0, offset - 3))}
                  >
                    ↑
                  </button>
                  <span>
                    {Math.floor(offset / 3) + 1}/{Math.ceil(page.total / 3)}
                  </span>
                  <button
                    aria-label="较旧候选"
                    disabled={offset + 3 >= page.total}
                    onClick={() => setOffset(offset + 3)}
                  >
                    ↓
                  </button>
                </div>
              </section>
              <StoryEditor
                key={active.id}
                {...{ pid, story: active, page, refresh, setStage }}
              />
            </div>
          ) : (
            <section className="empty">
              <h2>等待你的第一个故事</h2>
              <p>在创意工作台输入一句话；任务完成后这里会出现三个方向。</p>
              <button onClick={() => setStage("创意")}>回到创意</button>
            </section>
          )}
        </>
      )}
      {(stage === "剧本" || stage === "分镜") && (
        <StageWorkbench
          key={stage}
          pid={pid}
          stage={stage === "剧本" ? "script" : "board"}
          onNext={() => setStage("分镜")}
          refreshJobs={refresh}
        />
      )}
      {stage === "导出" && (
        <section className="empty">
          <h2>导出工作台</h2>
          <p>
            图像、配音、视频生成与真实 MP4 导出将在 M2–M3
            接入。当前可确认分镜并保留文本版本。
          </p>
        </section>
      )}
      {jobs.length > 0 && (
        <section className="panel story-jobs">
          <h2>文本任务</h2>
          {jobs
            .filter((j) => j.state !== "succeeded")
            .map((job) => (
              <TextJob key={job.id} job={job} refresh={refresh} />
            ))}
          <details>
            <summary>
              已完成任务（{jobs.filter((j) => j.state === "succeeded").length}）
            </summary>
            {jobs
              .filter((j) => j.state === "succeeded")
              .map((job) => (
                <TextJob key={job.id} job={job} refresh={refresh} />
              ))}
          </details>
        </section>
      )}
    </>
  );
}

function GenerationControls({
  instruction,
  setInstruction,
  pid,
}: {
  instruction: string;
  setInstruction: (s: string) => void;
  pid: string;
}) {
  return (
    <div className="generation-controls">
      <MethodSelector pid={pid} stage="story" />
      <label className="field">
        本次补充要求
        <textarea
          rows={3}
          value={instruction}
          maxLength={10000}
          onChange={(e) => {
            setInstruction(e.target.value);
            storeDraft(`sf.${pid}.instruction`, e.target.value);
          }}
        />
      </label>
      <p className="muted">成片风格与画幅使用项目统一生成规格。</p>
    </div>
  );
}

function StoryEditor({
  pid,
  story,
  page,
  refresh,
  setStage,
}: {
  setStage: (stage: string) => void;
  pid: string;
  story: Content;
  page: Page;
  refresh: () => Promise<void>;
}) {
  const [generationInstruction, setGenerationInstruction] = useState(
    () => readDraft<string>(`sf.${pid}.generate.script.instruction`) || "",
  );
  useEffect(
    () =>
      storeDraft(
        `sf.${pid}.generate.script.instruction`,
        generationInstruction,
      ),
    [pid, generationInstruction],
  );
  const draftKey = `sf.${pid}.${story.id}`;
  const saved = readDraft<{ body: StoryBody; revision: number }>(draftKey);
  const [body, setBody] = useState<StoryBody>(
    saved?.body || (story.body as StoryBody),
  );
  const [base, setBase] = useState(saved?.revision || story.revision);
  const [request, setRequest] = useState(
    () => readDraft<string>(draftKey + ".message") || "",
  );
  const [conversation, setConversation] = useState<Conversation>({
    messages: [],
    proposals: [],
  });
  const [versions, setVersions] = useState<Version[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mode, setMode] = useState<"fixed" | "closed" | "floating">("fixed");

  const dirty = JSON.stringify(body) !== JSON.stringify(story.body);
  useEffect(() => {
    storeDraft(draftKey, { body, revision: base });
  }, [body, base, draftKey]);
  useEffect(() => {
    storeDraft(draftKey + ".message", request);
  }, [request, draftKey]);
  useEffect(() => {
    let live = true;
    const poll = async () => {
      try {
        const [c, v] = await Promise.all([
          api.GET("/api/v1/projects/{pid}/contents/{iid}/conversation", {
            params: { path: { pid, iid: story.id } },
          }),
          api.GET("/api/v1/projects/{pid}/contents/{iid}/versions", {
            params: { path: { pid, iid: story.id } },
          }),
        ]);
        if (live) {
          setConversation(unwrap(c));
          setVersions(unwrap(v));
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "读取失败");
      }
    };
    void poll();
    const timer = setInterval(poll, 2500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [pid, story.id]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(
        e instanceof TypeError
          ? "连接中断，草稿与提交记录已保留，请重试"
          : e instanceof Error
            ? e.message
            : "连接失败，草稿保留",
      );
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    const next = unwrap(
      await api.PUT("/api/v1/projects/{pid}/stories/{iid}", {
        params: { path: { pid, iid: story.id } },
        body: { body, revision: base },
      }),
    );
    setBase(next.revision);
    setBody(next.body as StoryBody);
    await refresh();
    setNotice("新版本已保存，旧版可在版本历史查看。");
  }
  return (
    <div className={`editor-with-director ${mode}`}>
      <section className="panel story-editor">
        <div className="row">
          <h2>{String(story.body.title)}</h2>
          <small>
            服务端 v{story.revision} / 草稿基准 v{base}
          </small>
        </div>
        {error && (
          <div role="alert" className="alert">
            {error}
          </div>
        )}
        {notice && (
          <div role="status" className="notice">
            {notice}
          </div>
        )}
        {story.stale && (
          <p className="muted">
            此候选来自旧创意，保留供比较；可明确选定此故事。
          </p>
        )}
        <label className="field">
          故事标题
          <input
            disabled={busy}
            value={body.title}
            maxLength={200}
            onChange={(e) => setBody({ ...body, title: e.target.value })}
          />
        </label>
        <label className="field">
          一句话故事
          <input
            disabled={busy}
            value={body.logline}
            maxLength={1000}
            onChange={(e) => setBody({ ...body, logline: e.target.value })}
          />
        </label>
        <label className="field">
          故事正文
          <textarea
            disabled={busy}
            aria-label="故事正文"
            className="story-text"
            value={body.text}
            maxLength={50000}
            onChange={(e) => setBody({ ...body, text: e.target.value })}
          />
        </label>
        <div className="actions">
          <button
            disabled={busy || !body.text.trim()}
            onClick={() => void run(save)}
          >
            保存修改
          </button>
          <button
            disabled={busy}
            onClick={() => {
              setBase(story.revision);
              setNotice("草稿保留，已更新保存基准；请核对版本历史后合并。");
            }}
          >
            读取最新基准
          </button>
          <button
            className="primary"
            disabled={
              busy ||
              dirty ||
              base !== story.revision ||
              page.selected_version_id === story.version_id
            }
            onClick={() =>
              void run(async () => {
                unwrap(
                  await api.POST(
                    "/api/v1/projects/{pid}/stories/{iid}/select",
                    {
                      params: { path: { pid, iid: story.id } },
                      body: {
                        version_id: story.version_id,
                        selection_revision: page.selection_revision,
                      },
                    },
                  ),
                );
                await refresh();
                setNotice("故事版本已选定");
              })
            }
          >
            {page.selected_version_id === story.version_id
              ? "此版本已选定"
              : "确定此故事"}
          </button>
        </div>
        <div className="method-actions">
          <MethodSelector pid={pid} stage="script" />
          <label className="field">
            本次剧本生成要求
            <textarea
              aria-label="本次剧本生成要求"
              rows={3}
              disabled={busy}
              value={generationInstruction}
              onChange={(e) => setGenerationInstruction(e.target.value)}
            />
          </label>
          <button
            className="primary"
            disabled={busy || dirty || base !== story.revision}
            onClick={() =>
              void run(async () => {
                await generateStage(
                  pid,
                  "script",
                  story.version_id,
                  generationInstruction,
                );
                await refresh();
                setStage("剧本");
              })
            }
          >
            确定故事并AI生成剧本
          </button>
        </div>
        <QualityPanel
          pid={pid}
          item={story}
          disabled={busy || dirty}
          onChanged={refresh}
        />
        <details className="version-history">
          <summary>版本历史（{versions.length}）</summary>
          {versions.map((v) => (
            <details key={v.id}>
              <summary>
                v{v.revision} · {v.origin} ·{" "}
                {new Date(v.created_at).toLocaleString("zh-CN")}
              </summary>
              <p className="preserve-text">{String(v.body.text)}</p>
              <button
                disabled={busy}
                onClick={() => {
                  setBody(v.body as StoryBody);
                  setBase(story.revision);
                  setNotice("历史版本已载入草稿，保存后新增版本。");
                }}
              >
                载入为草稿
              </button>
            </details>
          ))}
        </details>
      </section>
      {mode === "closed" ? (
        <button className="director-toggle" onClick={() => setMode("fixed")}>
          展开导演助手
        </button>
      ) : (
        <section className="panel director">
          <div className="row">
            <h2>AI导演助手</h2>
            <div>
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
          </div>
          <MethodSelector pid={pid} stage="story" />
          <div className="conversation">
            {conversation.messages.map((m) => (
              <p key={m.id} className={m.role}>
                <small>{m.role === "user" ? "我" : "导演"}</small>
                <br />
                {m.text}
              </p>
            ))}
          </div>
          <label className="field">
            修改要求
            <textarea
              disabled={busy}
              aria-label="修改要求"
              rows={4}
              value={request}
              maxLength={10000}
              onChange={(e) => setRequest(e.target.value)}
            />
          </label>
          <div className="suggestions">
            {["强化角色动机", "强化情感冲突", "优化结尾"].map((s) => (
              <button disabled={busy} key={s} onClick={() => setRequest(s)}>
                {s}
              </button>
            ))}
          </div>
          <button
            disabled={
              busy || dirty || base !== story.revision || !request.trim()
            }
            onClick={() =>
              void run(async () => {
                await awaitMethodSaves(pid, "story");
                const input = {
                  base_version_id: story.version_id,
                  text: request,
                };
                const cmd = durableCommand(pid + ":message:" + story.id, input);
                unwrap(
                  await api.POST(
                    "/api/v1/projects/{pid}/contents/{iid}/messages",
                    {
                      params: {
                        path: { pid, iid: story.id },
                        header: { "idempotency-key": cmd.key },
                      },
                      body: input,
                    },
                  ),
                );
                cmd.done();
                setRequest("");
                setNotice("修改要求已保存，建议生成后可选择采用。");
                await refresh();
              })
            }
          >
            发送修改要求
          </button>
          {dirty && <p className="muted">先保存正文，再生成或采用建议。</p>}
          {conversation.proposals.map((p) => (
            <details
              className="proposal"
              key={p.id}
              open={!p.applied_version_id}
            >
              <summary>
                {p.applied_version_id
                  ? "已采用"
                  : p.base_version_id !== story.version_id
                    ? "建议已过期"
                    : "AI建议版"}
              </summary>
              <p>{String(p.output.changeSummary)}</p>
              <p className="preserve-text">
                {String(
                  (p.output.body as Record<string, unknown> | undefined)
                    ?.text ||
                    p.output.text ||
                    "",
                )}
              </p>
              <button
                className="primary"
                disabled={
                  busy ||
                  dirty ||
                  !!p.applied_version_id ||
                  p.base_version_id !== story.version_id
                }
                onClick={() =>
                  void run(async () => {
                    const next = unwrap(
                      await api.POST(
                        "/api/v1/projects/{pid}/proposals/{proposal_id}/apply",
                        { params: { path: { pid, proposal_id: p.id } } },
                      ),
                    );
                    setBody(next.body as StoryBody);
                    setBase(next.revision);
                    await refresh();
                    setNotice("建议已采用并保存新版本");
                  })
                }
              >
                采用此版
              </button>
            </details>
          ))}
        </section>
      )}
    </div>
  );
}

export function TextJob({
  job,
  refresh,
}: {
  job: Job;
  refresh: () => Promise<void>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  return (
    <article className="text-job">
      <div className="row">
        <strong>
          {(
            {
              "story.generate": "生成三个故事",
              "story.revise": "故事导演建议",
              "idea.revise": "创意导演建议",
              "script.generate": "生成剧本",
              "board.generate": "生成分镜",
              "script.revise": "剧本导演建议",
              "board.revise": "分镜导演建议",
              "story.review": "故事质检",
              "script.review": "剧本质检",
              "board.review": "分镜质检",
              "story.repair": "故事修复建议",
              "script.repair": "剧本修复建议",
              "board.repair": "分镜修复建议",
            } as Record<string, string>
          )[job.kind] || job.kind}
        </strong>
        <span className="badge">{states[job.state] || job.state}</span>
      </div>
      <small>
        {new Date(job.created_at).toLocaleString("zh-CN")} · {job.id}
      </small>
      {job.error && <p>{job.error}</p>}
      <details>
        <summary>输入与配置快照</summary>
        <pre>{JSON.stringify(job.snapshot, null, 2)}</pre>
      </details>
      {job.state === "unknown" && (
        <label>
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => {
              setConfirmed(e.target.checked);
            }}
          />{" "}
          供应商可能已受理；我确认可能重复计费并重新提交
        </label>
      )}
      {["failed", "unknown"].includes(job.state) && (
        <button
          disabled={busy || (job.state === "unknown" && !confirmed)}
          onClick={() => {
            setBusy(true);
            setError("");
            let cmd: ReturnType<typeof durableCommand>;
            try {
              cmd = durableCommand("retry:" + job.id, {
                confirm_unknown: confirmed,
              });
            } catch {
              setError("无法保存重试标识，请启用浏览器存储后重试");
              setBusy(false);
              return;
            }
            void api
              .POST("/api/v1/jobs/{jid}/retry", {
                params: {
                  path: { jid: job.id },
                  header: { "idempotency-key": cmd.key },
                },
                body: { confirm_unknown: confirmed },
              })
              .then(unwrap)
              .then(async () => {
                cmd.done();
                await refresh();
              })
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          按原配置重试
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </article>
  );
}
