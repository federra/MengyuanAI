import {
  AI_TEXT,
  TEXT_JOB_EVENT,
  TextGenerationProvider,
  findTextJob,
  useTextGeneration,
  GenerationOutput,
  notifyTextJob,
} from "./TextGeneration";
import { useEffect, useRef, useState } from "react";
import { FinishingWorkbench } from "./FinishingWorkbench";
import { api, unwrap, type Job } from "./api";
import { readDraft, storeDraft, removeDraft, durableCommand } from "./commands";
import { StageWorkbench, QualityPanel, generateStage } from "./StageWorkbench";
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
export function StoryWorkbench({
  pid,
  projectName,
  projectMarket,
  onSwitchProject,
  onGenerationSettings,
}: {
  pid: string;
  projectName: string;
  projectMarket: string;
  onSwitchProject: () => void;
  onGenerationSettings: (trigger?: HTMLElement) => void;
}) {
  const [stage, updateStage] = useState(
    () => readDraft<string>(`sf.${pid}.stage`) || "创意",
  );
  function setStage(next: string) {
    storeDraft(`sf.${pid}.stage`, next);
    updateStage(next);
  }
  const [idea, setIdea] = useState<Content | null>(null);
  const txtInput = useRef<HTMLInputElement>(null);
  const pollEpoch = useRef(0);
  const [text, setText] = useState("");
  const [storyCount, setStoryCount] = useState("3");
  const [draftDirty, setDraftDirty] = useState(false);
  const validCount = /^[1-3]$/.test(storyCount);
  const running = useRef(false);
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState(false);

  const [page, setPage] = useState<Page>({
    source_mode: "idea",
    items: [],
    total: 0,
    selection_revision: 0,
    selected_version_id: null,
  });
  const [offset, setOffset] = useState(0);
  const [activeId, setActiveId] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  useEffect(() => {
    const accepted = (event: Event) => {
      const job = (event as CustomEvent<Job>).detail;
      if (!job || job.project_id !== pid) return;
      pollEpoch.current++;
      setJobs((current) => [
        job,
        ...current.filter((item) => item.id !== job.id),
      ]);
    };
    window.addEventListener(TEXT_JOB_EVENT, accepted);
    return () => window.removeEventListener(TEXT_JOB_EVENT, accepted);
  }, [pid]);
  const storyGeneration = findTextJob(jobs, pid, {
    kind: "story.generate",
    sourceVersionId: idea?.version_id,
  });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  function commandKey(action: string, body: unknown) {
    return durableCommand(pid + ":" + action, body);
  }
  async function run(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
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
      running.current = false;
      setBusy(false);
    }
  }
  async function refresh() {
    const epoch = ++pollEpoch.current;
    const [p, j] = await Promise.all([
      api.GET("/api/v1/projects/{pid}/stories", {
        params: { path: { pid }, query: { offset } },
      }),
      api.GET("/api/v1/projects/{pid}/jobs", { params: { path: { pid } } }),
    ]);
    if (epoch !== pollEpoch.current) return;
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
        const draft = readDraft<{
          text: string;
          revision: number;
          storyCount?: string;
        }>(`sf.${pid}.idea`);
        setText(draft?.text ?? String(saved?.body.text || ""));
        setStoryCount(
          draft?.storyCount ?? String(saved?.body.story_count ?? 3),
        );
        setRevision(draft?.revision ?? saved?.revision ?? 0);
        setDraftDirty(
          !!draft &&
            (draft.text !== String(saved?.body.text || "") ||
              (draft.storyCount !== undefined &&
                draft.storyCount !== String(saved?.body.story_count ?? 3))),
        );
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
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      const epoch = ++pollEpoch.current;
      try {
        const [p, j] = await Promise.all([
          api.GET("/api/v1/projects/{pid}/stories", {
            params: { path: { pid }, query: { offset } },
          }),
          api.GET("/api/v1/projects/{pid}/jobs", { params: { path: { pid } } }),
        ]);
        if (live && epoch === pollEpoch.current) {
          const current = unwrap(p);
          setPage(current);
          if (
            current.source_mode === "txt" &&
            !readDraft<string>(`sf.${pid}.stage`)
          )
            setStage("故事");
          setJobs(
            unwrap(j).filter((j) =>
              /^(idea|story|script|board)\./.test(j.kind),
            ),
          );
        }
      } catch (e) {
        if (live && epoch === pollEpoch.current)
          setError(e instanceof Error ? e.message : "无法读取状态");
      } finally {
        inFlight = false;
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
    if (!loaded) return;
    if (draftDirty)
      storeDraft(`sf.${pid}.idea`, { text, revision, storyCount });
    else removeDraft(`sf.${pid}.idea`);
  }, [text, revision, storyCount, loaded, pid, draftDirty]);
  const active = page.items.find((i) => i.id === activeId) || page.items[0];
  useEffect(() => {
    if (
      stage !== "创意" ||
      !loaded ||
      !draftDirty ||
      busy ||
      error ||
      !text.trim() ||
      !validCount
    )
      return;
    const timer = setTimeout(() => void run(saveIdeaOnly), 700);
    return () => clearTimeout(timer);
  }, [text, storyCount, draftDirty, loaded, busy, error, stage]);
  async function saveIdeaOnly() {
    await saveIdea();
  }
  async function saveIdea() {
    if (!validCount) throw new Error("故事数量须为1～3的整数");
    if (!draftDirty && idea) return idea;
    const response = await api.PUT("/api/v1/projects/{pid}/idea", {
      params: { path: { pid } },
      body: { text, revision, story_count: Number(storyCount) },
    });
    let saved: Content;
    if (response.response.status === 409) {
      const latest = unwrap(
        await api.GET("/api/v1/projects/{pid}/idea", {
          params: { path: { pid } },
        }),
      );
      if (
        !latest ||
        latest.body.text !== text ||
        (latest.body.story_count ?? 3) !== Number(storyCount)
      ) {
        setIdea(latest);
        throw new Error(
          "创意版本冲突，草稿已保留，请核对下方服务端版本后再继续。",
        );
      }
      saved = latest;
    } else saved = unwrap(response);
    setIdea(saved);
    setRevision(saved.revision);
    setDraftDirty(false);
    removeDraft(`sf.${pid}.idea`);
    return saved;
  }
  async function importTxt(file: File) {
    if (!/\.txt$/i.test(file.name) || file.size > 1024 * 1024 || !file.size)
      throw new Error("请选择非空且不超过1MB的TXT文件");
    let source: string;
    try {
      source = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(await file.arrayBuffer());
    } catch {
      throw new Error("TXT须使用UTF-8编码，请转换后重试；原故事保持不变。");
    }
    if (!source.trim()) throw new Error("TXT内容不能为空");
    const pendingKey = `sf.${pid}.txt-input`;
    const previous = readDraft<{
      filename: string;
      text: string;
      expected_story_version_id: string | null;
    }>(pendingKey);
    const input =
      previous?.filename === file.name && previous.text === source
        ? previous
        : {
            filename: file.name,
            text: source,
            expected_story_version_id: page.selected_version_id,
          };
    localStorage.setItem(pendingKey, JSON.stringify(input));
    const command = commandKey("import-txt", input);
    pollEpoch.current++;
    const response = await api.POST(
      "/api/v1/projects/{pid}/stories/import-txt",
      {
        params: { path: { pid }, header: { "idempotency-key": command.key } },
        body: input,
      },
    );
    if (response.response.status === 409 || response.response.status === 422) {
      try {
        command.done();
      } catch {}
      removeDraft(pendingKey);
    }
    unwrap(response);
    // A receipt may describe an earlier successful attempt; render the current table.
    const result = unwrap(
      await api.GET("/api/v1/projects/{pid}/stories", {
        params: { path: { pid }, query: { offset: 0 } },
      }),
    );
    try {
      command.done();
    } catch {
      /* The committed story remains authoritative. */
    }
    removeDraft(pendingKey);
    pollEpoch.current++;
    setPage(result);
    setOffset(0);
    setActiveId(result.items[0]?.id || "");
    setStage("故事");
    setNotice(
      "TXT全文已保存。卡片标题取自文件名，摘要为原文摘录，可在故事资料中修改。",
    );
  }
  async function generate() {
    await awaitMethodSaves(pid, "story");
    const saved = await saveIdea();
    const body = {
      idea_version_id: saved.version_id,
      story_count: Number(storyCount),
      instruction: "",
      style: "",
      writing_mode: "prompt" as const,
    };
    const cmd = commandKey("generate", body);
    const job = unwrap(
      await api.POST("/api/v1/projects/{pid}/story-batches", {
        params: { path: { pid }, header: { "idempotency-key": cmd.key } },
        body,
      }),
    );
    notifyTextJob(job);
    setActiveId("");
    cmd.done();
    setOffset(0);
    setStage("故事");
    setNotice("生成任务已保存，可以离开页面，稍后回来继续。");
    await refresh();
  }
  return (
    <TextGenerationProvider pid={pid} jobs={jobs}>
      <div className="stages">
        {["创意", "故事", "剧本", "分镜", "导出"].map((s, i) => (
          <button
            aria-label={`${i + 1}　${s}`}
            className={stage === s ? "current" : ""}
            key={s}
            onClick={() => setStage(s)}
          >
            <span className="step-number">{i + 1}</span>
            {s}
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
        <div className="page-heading">
          <div>
            <h1>创意工作台</h1>
            <p>从一句话开始，让灵感成为一个值得讲述的故事。</p>
          </div>
        </div>
      )}
      {stage === "创意" && (
        <div className="idea-workspace">
          <div>
            <section className="panel project-context">
              <strong>{projectName}</strong>
              <small>{projectMarket === "zh" ? "中文市场" : "英文市场"}</small>
              <button onClick={onSwitchProject}>切换项目</button>
            </section>
            <section className="panel idea-editor">
              <div className="idea-title">
                <h2>一句话创意</h2>
                <span className="muted">可输入对故事篇幅字数的要求</span>
              </div>
              <label className="field">
                <textarea
                  disabled={busy || !loaded}
                  aria-label="一句话创意"
                  rows={5}
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    setDraftDirty(true);
                  }}
                  maxLength={10000}
                />
              </label>
              <div className="txt-upload">
                <button
                  disabled={busy || !loaded}
                  onClick={() => txtInput.current?.click()}
                >
                  若已有小说故事，可点击上传
                </button>
                <input
                  ref={txtInput}
                  type="file"
                  accept=".txt,text/plain"
                  hidden
                  aria-label="上传TXT故事"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) void run(() => importTxt(file));
                  }}
                />
                <small className="muted">
                  TXT · UTF-8 · 不超过1MB，保留全文
                </small>
              </div>
              <p className="muted" role="status">
                {busy
                  ? "正在保存或提交…"
                  : draftDirty
                    ? "草稿已保留，停止输入后自动保存"
                    : idea
                      ? "内容已保存"
                      : "输入后自动保存"}
              </p>
              {error && draftDirty && text.trim() && validCount && (
                <button disabled={busy} onClick={() => void run(saveIdeaOnly)}>
                  重试自动保存
                </button>
              )}
              {error && idea && idea.revision !== revision && (
                <details className="alert" open>
                  <summary>核对创意版本冲突</summary>
                  <p className="preserve-text">{String(idea.body.text)}</p>
                  <button
                    onClick={() => {
                      setRevision(idea.revision);
                      setError("");
                      setDraftDirty(true);
                    }}
                  >
                    已核对，以我的草稿保存新版
                  </button>
                </details>
              )}
              <div className="idea-generation-row">
                <MethodSelector pid={pid} stage="story" />
                <div className="idea-generate-actions">
                  <label className="story-count">
                    故事数量
                    <input
                      aria-label="故事数量"
                      type="number"
                      min="1"
                      max="3"
                      step="1"
                      value={storyCount}
                      disabled={busy || !loaded}
                      onChange={(e) => {
                        setStoryCount(e.target.value);
                        setDraftDirty(true);
                      }}
                      aria-invalid={!validCount}
                      aria-describedby={
                        !validCount ? "story-count-error" : undefined
                      }
                    />
                  </label>
                  <button
                    className="primary"
                    disabled={
                      busy ||
                      !!storyGeneration ||
                      !loaded ||
                      !text.trim() ||
                      !validCount
                    }
                    onClick={() => void run(generate)}
                  >
                    AI生成故事方案
                  </button>
                </div>
              </div>
              {!validCount && (
                <p id="story-count-error" role="alert" className="alert">
                  故事数量须为1～3的整数
                </p>
              )}
            </section>
          </div>
        </div>
      )}
      {stage === "故事" && (
        <>
          <div className="page-heading">
            <div>
              <h1>故事工作台</h1>
              <p>比较故事方案，打磨细节，确定你想讲述的故事。</p>
            </div>
          </div>

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
                {page.source_mode !== "txt" && (
                  <button
                    disabled={
                      busy ||
                      !!storyGeneration ||
                      !loaded ||
                      !text.trim() ||
                      !validCount
                    }
                    onClick={() => void run(generate)}
                  >
                    再生成{validCount ? storyCount : ""}个方案
                  </button>
                )}
                <GenerationOutput label="新故事方案" job={storyGeneration} />
              </section>
              <StoryEditor
                key={active.id}
                {...{ pid, story: active, refresh, setStage }}
                generating={false}
              />
            </div>
          ) : storyGeneration ? (
            <section className="panel story-editor">
              <label className="field">
                故事正文
                <textarea
                  aria-label="故事正文"
                  className="story-text"
                  aria-busy="true"
                  readOnly
                  value={AI_TEXT}
                />
              </label>
            </section>
          ) : (
            <section className="empty">
              <h2>等待你的第一个故事</h2>
              <p>
                在创意工作台输入一句话；任务完成后这里会出现所选数量的故事方案。
              </p>
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
          onGenerationSettings={onGenerationSettings}
        />
      )}
      {stage === "导出" && <FinishingWorkbench key={pid} pid={pid} />}
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
    </TextGenerationProvider>
  );
}

function StoryEditor({
  pid,
  story,
  refresh,
  setStage,
  generating,
}: {
  setStage: (stage: string) => void;
  pid: string;
  story: Content;
  generating: boolean;
  refresh: () => Promise<void>;
}) {
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

  const running = useRef(false);
  const suggestionJob = useTextGeneration({
    kind: ["story.revise", "story.repair"],
    itemId: story.id,
    versionId: story.version_id,
  });
  const persisted = useRef(story);
  const dirty = JSON.stringify(body) !== JSON.stringify(persisted.current.body);
  useEffect(() => {
    if (story.revision <= persisted.current.revision) return;
    if (!dirty && base === persisted.current.revision) {
      setBody(story.body as StoryBody);
      setBase(story.revision);
      persisted.current = story;
    }
  }, [story.version_id]);
  useEffect(() => {
    if (
      !dirty ||
      generating ||
      busy ||
      error ||
      !body.text.trim() ||
      !body.title.trim() ||
      !body.logline.trim()
    )
      return;
    const timer = setTimeout(
      () =>
        void run(async () => {
          await save();
        }),
      700,
    );
    return () => clearTimeout(timer);
  }, [body, base, dirty, busy, error, generating]);
  useEffect(() => {
    storeDraft(draftKey, { body, revision: base });
  }, [body, base, draftKey]);
  useEffect(() => {
    storeDraft(draftKey + ".message", request);
  }, [request, draftKey]);
  useEffect(() => {
    let live = true;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
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
      } finally {
        inFlight = false;
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
    if (running.current) return;
    running.current = true;
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
      running.current = false;
      setBusy(false);
    }
  }
  async function save(): Promise<Content> {
    if (!dirty) {
      if (base !== story.revision)
        throw new Error("故事版本已变化，请核对当前版本。");
      return persisted.current;
    }
    const response = await api.PUT("/api/v1/projects/{pid}/stories/{iid}", {
      params: { path: { pid, iid: story.id } },
      body: { body, revision: base },
    });
    let next: Content;
    if (response.response.status === 409) {
      const history = unwrap(
        await api.GET("/api/v1/projects/{pid}/contents/{iid}/versions", {
          params: { path: { pid, iid: story.id } },
        }),
      );
      const latest = history[0];
      if (!latest || JSON.stringify(latest.body) !== JSON.stringify(body)) {
        await refresh();
        throw new Error("故事版本冲突，草稿已保留，请核对服务端正文后再继续。");
      }
      next = {
        ...story,
        body: latest.body,
        revision: latest.revision,
        version_id: latest.id,
      };
    } else next = unwrap(response);
    persisted.current = next;
    setBase(next.revision);
    setBody(next.body as StoryBody);
    storeDraft(draftKey, { body: next.body, revision: next.revision });
    await refresh();
    return next;
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
            此候选来自旧创意，正文与历史已保留；更新来源后再生成剧本。
          </p>
        )}
        <details className="story-metadata">
          <summary>故事资料 · 标题与一句话故事</summary>
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
        </details>
        <label className="field">
          故事正文
          <textarea
            disabled={busy}
            aria-label="故事正文"
            className="story-text"
            value={generating ? AI_TEXT : body.text}
            readOnly={generating}
            aria-busy={generating}
            maxLength={1048576}
            onChange={(e) => setBody({ ...body, text: e.target.value })}
          />
        </label>
        <p className="muted" role="status">
          {busy
            ? "正在保存或提交…"
            : dirty
              ? "草稿已保留，停止输入后自动保存"
              : "内容已保存"}
        </p>
        {error && dirty && (
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await save();
              })
            }
          >
            重试自动保存
          </button>
        )}
        {error && base !== story.revision && (
          <details className="alert" open>
            <summary>核对故事版本冲突</summary>
            <p className="preserve-text">{String(story.body.text)}</p>
            <button
              onClick={() => {
                setBase(story.revision);
                persisted.current = story;
                setError("");
              }}
            >
              已核对，以我的草稿保存新版
            </button>
          </details>
        )}
        <div className="method-actions">
          <MethodSelector pid={pid} stage="script" />
          <button
            className="primary"
            disabled={
              busy || generating || !body.text.trim() || base !== story.revision
            }
            onClick={() =>
              void run(async () => {
                const source = await save();
                await generateStage(pid, "script", source.version_id);
                await refresh();
                setStage("剧本");
              })
            }
          >
            确定故事并AI生成剧本
          </button>
        </div>

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
          <QualityPanel
            pid={pid}
            item={story}
            disabled={busy || dirty}
            onChanged={refresh}
          />
          <div className="suggestions">
            <strong>故事建议</strong>
            {["强化角色动机", "强化情感冲突", "优化结尾"].map((s) => (
              <button disabled={busy} key={s} onClick={() => setRequest(s)}>
                {s}
              </button>
            ))}
          </div>
          <GenerationOutput label="建议正文" job={suggestionJob} />
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

          <MethodSelector pid={pid} stage="story" />
          <button
            className="primary"
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
                const job = unwrap(
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
                notifyTextJob(job);
                cmd.done();
                setRequest("");
                setNotice("修改要求已保存，建议生成后可选择采用。");
                await refresh();
              })
            }
          >
            发送修改要求
          </button>
          {dirty && <p className="muted">正文自动保存后可生成或采用建议。</p>}
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
                    persisted.current = next;
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

export function jobTitle(kind: string) {
  return (
    (
      {
        "story.generate": "生成故事方案",
        "story.revise": "故事导演建议",
        "idea.revise": "创意导演建议",
        "script.generate": "生成剧本",
        "board.generate": "生成分镜",
        "script.revise": "剧本导演建议",
        "board.revise": "分镜导演建议",
        "export.render": "成片合成",
        "story.review": "故事质检",
        "script.review": "剧本质检",
        "board.review": "分镜质检",
        "story.repair": "故事修复建议",
        "script.repair": "剧本修复建议",
        "board.repair": "分镜修复建议",
      } as Record<string, string>
    )[kind] || (kind === "file.verify" ? "文件校验" : kind)
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
        <strong>{jobTitle(job.kind)}</strong>
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
