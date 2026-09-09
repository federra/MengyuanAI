import { useEffect, useRef, useState } from "react";
import { api, unwrap, type Project } from "./api";
import { durableCommand, readDraft, storeDraft, removeDraft } from "./commands";
import { OutputSettings } from "./Configuration";
import type { components } from "./generated/api";

type Draft = Required<Omit<components["schemas"]["EditDraft"], "clips">> & {
  clips: Required<components["schemas"]["Clip"]>[];
};
type State = Omit<components["schemas"]["EditState"], "draft"> & {
  draft: Draft;
};
type Outcome = components["schemas"]["OutcomeOut"];
type ExportRow = {
  id: string;
  state: string;
  error: string | null;
  revision: number;
  stale: boolean;
  output: {
    file_id: string;
    metadata: { duration: number; width: number; height: number; fps: number };
  } | null;
};
const statuses: Record<string, string> = {
  queued: "排队等待合成",
  running: "正在合成与校验",
  succeeded: "真实成片已生成",
  failed: "合成失败，可重试",
};
const errors: Record<string, string> = {
  export_source_stale: "素材或剪辑已更新，请重新载入并检查。",
  export_source_checksum_mismatch: "源文件校验不一致，请从备份恢复素材。",
  export_encoding_failed: "编码失败，剪辑已保留，可重试并检查本机编码环境。",
  export_dialogue_overflow: "配音超出镜头，请调整时长或重新配音。",
  export_subtitle_font_missing: "缺少中文字幕字体，请配置本机字体。",
  export_subtitle_too_long_split_dialogue: "单句字幕超过四行，请拆分台词。",
  export_media_invalid_or_missing: "素材无效或缺失，请检查文件或从备份恢复。",
};

export function FinishingWorkbench({ pid }: { pid: string }) {
  const key = `sf.${pid}.finishing`;
  const [state, setState] = useState<State | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [base, setBase] = useState(0);
  const [project, setProject] = useState<Project>();
  const [media, setMedia] = useState<Outcome[]>([]);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const live = useRef(true);
  const locked = useRef(false);
  const requestSequence = useRef(0);
  const initialized = useRef(false);
  const mediaSequence = useRef(0);
  const params = { path: { pid } };
  const files = (fid: string) => `/api/v1/projects/${pid}/files/${fid}`;
  async function refresh() {
    const request = ++requestSequence.current;
    const next = unwrap(
      await api.GET("/api/v1/projects/{pid}/finishing", { params }),
    ) as State;
    if (live.current && request === requestSequence.current)
      setState((prior) =>
        !prior || next.revision >= prior.revision ? next : prior,
      );
    return next;
  }
  async function refreshMedia() {
    const request = ++mediaSequence.current;
    const [rows, data] = await Promise.all([
      api.GET("/api/v1/projects/{pid}/media/results", { params }).then(unwrap),
      api
        .GET("/api/v1/projects/{pid}/stages/{stage}", {
          params: { path: { pid, stage: "board" } },
        })
        .then(unwrap),
    ]);
    if (!live.current || request !== mediaSequence.current) return;
    setMedia(rows);
    const body = data.item?.body as
      { shots?: { dialogues: { id: string; text: string }[] }[] } | undefined;
    setTexts(
      Object.fromEntries(
        (body?.shots || []).flatMap((s) =>
          s.dialogues.map((l) => [l.id, l.text]),
        ),
      ),
    );
  }
  useEffect(() => {
    live.current = true;
    const firstRequest = requestSequence.current + 1;
    void refresh()
      .then((next) => {
        if (!live.current || firstRequest !== requestSequence.current) return;
        const saved = readDraft<{ revision: number; draft: Draft }>(key);
        initialized.current = true;
        setDraft(saved?.draft || next.draft);
        setBase(saved?.revision ?? next.revision);
        if (saved) setNotice("已恢复本机未保存剪辑；正式版本以服务端为准。");
      })
      .catch((e) => setError(e.message));
    void api
      .GET("/api/v1/projects/{pid}", { params })
      .then(unwrap)
      .then((p) => {
        if (live.current) setProject(p);
      })
      .catch((e) => {
        if (live.current) setError(e.message);
      });
    void refreshMedia().catch(() => {});
    const timer = window.setInterval(() => {
      if (!initialized.current || locked.current) return;
      void refresh().catch((e) => {
        if (live.current) setError(e.message);
      });
    }, 3000);
    return () => {
      live.current = false;
      ++requestSequence.current;
      ++mediaSequence.current;
      window.clearInterval(timer);
    };
  }, [pid]);
  function change(next: Draft) {
    if (!live.current) return;
    setDraft(next);
    storeDraft(key, { revision: base, draft: next });
    setNotice("");
  }
  async function action(fn: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (live.current) setError((e as Error).message);
    } finally {
      locked.current = false;
      if (live.current) setBusy(false);
    }
  }
  if (!state || !draft)
    return (
      <section className="panel">
        <h2>导出工作台</h2>
        <p>{error || "正在读取剪辑与素材…"}</p>
      </section>
    );
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(state.draft) ||
    base !== state.revision;
  const exports = state.exports as unknown as ExportRow[];
  const preview =
    exports.find((e) => e.id === selected && e.output) ||
    exports.find((e) => e.output);
  const total = draft.clips.reduce((n, c) => n + c.duration, 0);
  function move(index: number, direction: number) {
    const clips = [...draft!.clips];
    [clips[index], clips[index + direction]] = [
      clips[index + direction],
      clips[index],
    ];
    change({ ...draft!, clips, continuity_ack: false });
  }
  return (
    <section className="finishing-workbench">
      <div className="page-heading">
        <div>
          <h2>作品导出</h2>
          <p>检查镜头、声音与字幕，生成可下载 MP4。</p>
        </div>
        <button onClick={() => setSettingsOpen(!settingsOpen)}>生成设置</button>
      </div>
      {settingsOpen && project && (
        <section className="panel">
          <OutputSettings
            project={project}
            onSaved={(p) => {
              setProject(p);
              void refresh();
            }}
          />
          <button onClick={() => setSettingsOpen(false)}>收起生成设置</button>
        </section>
      )}
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <div className="finishing-grid">
        <section className="panel finishing-preview">
          <h3>作品预览</h3>
          {preview?.output ? (
            <>
              <video
                key={preview.output.file_id}
                controls
                preload="metadata"
                src={files(preview.output.file_id)}
              />
              <p>
                {preview.stale
                  ? "历史成片 · 当前剪辑或素材已变化，需重新导出"
                  : "已生成的真实成片"}{" "}
                · {preview.output.metadata.duration.toFixed(3)} 秒 ·{" "}
                {preview.output.metadata.width} ×{" "}
                {preview.output.metadata.height}
              </p>
              <a
                className="button"
                href={`/api/v1/projects/${pid}/exports/${preview.id}/download`}
              >
                下载 MP4
              </a>
            </>
          ) : (
            <div className="empty">
              <p>保存剪辑并生成后，在此检查真实成片。</p>
              <p>
                当前剪辑 {draft.clips.length} 镜 · {total.toFixed(3)} 秒
              </p>
            </div>
          )}
        </section>
        <section className="panel finishing-settings">
          <h3>导出配置</h3>
          <fieldset disabled={busy}>
            <label className="field">
              成片文件名
              <input
                value={draft.filename}
                onChange={(e) => change({ ...draft, filename: e.target.value })}
              />
            </label>
            <p>
              MP4 · {String(state.specification.resolution)} ·{" "}
              {String(state.specification.aspect_ratio)} ·{" "}
              {String(state.specification.width)} ×{" "}
              {String(state.specification.height)}
              <br />
              <small>规格继承项目，修改请使用“生成设置”。</small>
            </p>
            <label className="field">
              帧率
              <select
                value={draft.fps}
                onChange={(e) =>
                  change({
                    ...draft,
                    fps: Number(e.target.value) as 24 | 25 | 30,
                  })
                }
              >
                {[24, 25, 30].map((f) => (
                  <option key={f} value={f}>
                    {f} fps
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              画幅适配
              <select
                value={draft.fit}
                onChange={(e) =>
                  change({ ...draft, fit: e.target.value as "pad" | "crop" })
                }
              >
                <option value="pad">完整画面，必要时留边</option>
                <option value="crop">居中裁切填满</option>
              </select>
            </label>
            {(
              [
                ["narration", "使用逐句配音"],
                ["subtitles", "烧录字幕"],
                ["original_audio", "保留原视频声音"],
              ] as const
            ).map(([k, label]) => (
              <label className="check-row" key={k}>
                <input
                  type="checkbox"
                  checked={draft[k]}
                  onChange={(e) => change({ ...draft, [k]: e.target.checked })}
                />
                {label}
              </label>
            ))}
            <small>
              原视频声音默认关闭，避免重复人声。关闭配音是明确的静音选择；字幕仍按真实配音时长对齐。
            </small>
            {(
              [
                ["voice_volume", "配音音量", 0.1, 2],
                ["original_volume", "原声音量", 0, 1],
                ["music_volume", "配乐音量", 0, 1],
              ] as const
            ).map(([k, label, min, max]) => (
              <label className="field" key={k}>
                {label}
                <input
                  type="number"
                  min={min}
                  max={max}
                  step="0.05"
                  value={draft[k]}
                  onChange={(e) =>
                    change({ ...draft, [k]: Number(e.target.value) })
                  }
                />
              </label>
            ))}
            <label className="field">
              上传背景音乐
              <input
                type="file"
                accept=".mp3,.wav,.flac,.ogg"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  void action(async () => {
                    const data = new FormData();
                    data.append("file", file);
                    const response = await fetch(
                      `/api/v1/projects/${pid}/finishing/music`,
                      { method: "POST", body: data },
                    );
                    const body = await response.json();
                    if (!live.current) return;
                    if (!response.ok)
                      throw new Error(body.detail || "音乐上传失败");
                    change({ ...draft, music_file_id: body.id });
                  });
                }}
              />
            </label>
            {draft.music_file_id && (
              <>
                <audio controls src={files(draft.music_file_id)} />
                <button
                  onClick={() => change({ ...draft, music_file_id: null })}
                >
                  移除配乐
                </button>
              </>
            )}
            <small>
              背景音乐循环覆盖全片，在片尾结束；各音轨按设定音量混合并限幅。配音超长会阻止导出，不截断台词。
            </small>
          </fieldset>
        </section>
      </div>
      <section className="panel">
        <div className="row">
          <h3>镜头顺序与时长 · {total.toFixed(3)} 秒</h3>
          <button
            disabled={busy}
            onClick={() =>
              void action(async () => {
                const next = unwrap(
                  await api.GET("/api/v1/projects/{pid}/finishing/defaults", {
                    params,
                  }),
                ) as State;
                if (!live.current) return;
                await refreshMedia();
                if (!live.current) return;
                storeDraft(`${key}.previous`, { revision: base, draft });
                change(next.draft);
                setNotice(
                  "已载入当前分镜与最新素材；原剪辑草稿保留在本机，请检查后保存。",
                );
              })
            }
          >
            载入当前分镜与最新素材
          </button>
        </div>
        <p>
          调整顺序会影响前镜尾帧连续性和音画同步；仅改变本次剪辑，保留原分镜与素材历史。
        </p>
        <label className="check-row">
          <input
            type="checkbox"
            checked={draft.continuity_ack}
            disabled={busy}
            onChange={(e) =>
              change({ ...draft, continuity_ack: e.target.checked })
            }
          />
          我已检查调整后的镜头连续性与音画同步
        </label>
        {draft.clips.map((clip, index) => {
          const videos = media.filter(
            (m) => m.kind === "media.video" && m.target_id === clip.shot_id,
          );
          const video = videos.find((m) => m.id === clip.video_id);
          function update(values: Partial<typeof clip>) {
            change({
              ...draft!,
              clips: draft!.clips.map((c, i) =>
                i === index ? { ...c, ...values } : c,
              ),
            });
          }
          return (
            <article className="finishing-clip" key={clip.shot_id}>
              <div className="row">
                <strong>镜头 {index + 1}</strong>
                <button
                  aria-label={`上移镜头${index + 1}`}
                  disabled={busy || index === 0}
                  onClick={() => move(index, -1)}
                >
                  上移
                </button>
                <button
                  aria-label={`下移镜头${index + 1}`}
                  disabled={busy || index === draft.clips.length - 1}
                  onClick={() => move(index, 1)}
                >
                  下移
                </button>
                <small>{clip.shot_id}</small>
              </div>
              <div className="finishing-clip-grid">
                {video ? (
                  <video
                    controls
                    preload="metadata"
                    src={files(video.file_id)}
                  />
                ) : (
                  <p>缺少视频，请回分镜工作台补齐。</p>
                )}
                <fieldset disabled={busy}>
                  <label className="field">
                    视频版本
                    <select
                      value={clip.video_id || ""}
                      onChange={(e) =>
                        update({ video_id: e.target.value || null })
                      }
                    >
                      <option value="">请选择视频</option>
                      {videos.map((v) => (
                        <option key={v.id} value={v.id}>
                          {new Date(v.created_at).toLocaleString()} ·{" "}
                          {Number(v.metadata.duration).toFixed(3)}秒
                          {v.stale ? " · 已过期" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="row">
                    <label>
                      裁剪起点（秒）
                      <input
                        type="number"
                        min="0"
                        step="0.001"
                        value={clip.trim_start}
                        onChange={(e) =>
                          update({ trim_start: Number(e.target.value) })
                        }
                      />
                    </label>
                    <label>
                      镜头时长（秒）
                      <input
                        type="number"
                        min={1 / draft.fps}
                        step={1 / draft.fps}
                        value={clip.duration}
                        onChange={(e) =>
                          update({ duration: Number(e.target.value) })
                        }
                      />
                    </label>
                  </div>
                  <small>
                    时长以1/{draft.fps}
                    秒为单位，不能超出真实视频长度；字幕/配音起点相对于裁剪后的镜头。
                  </small>
                  {clip.lines.map((line, li) => {
                    const audio = media.find(
                      (m) =>
                        m.kind === "media.audio" &&
                        m.target_id === line.line_id,
                    );
                    return (
                      <div className="finishing-line" key={line.line_id}>
                        <span>{texts[line.line_id] || `台词 ${li + 1}`}</span>
                        <label>
                          台词 {li + 1} 开始时间（秒）
                          <input
                            type="number"
                            min="0"
                            step="0.001"
                            value={line.start}
                            onChange={(e) =>
                              update({
                                lines: clip.lines.map((l, i) =>
                                  i === li
                                    ? { ...l, start: Number(e.target.value) }
                                    : l,
                                ),
                              })
                            }
                          />
                        </label>
                        {audio && (
                          <>
                            <small>
                              音频 {Number(audio.metadata.duration).toFixed(3)}{" "}
                              秒{audio.stale ? " · 已过期" : ""}
                            </small>
                            <audio
                              controls
                              preload="metadata"
                              src={files(audio.file_id)}
                            />
                          </>
                        )}
                      </div>
                    );
                  })}
                </fieldset>
              </div>
            </article>
          );
        })}
      </section>
      <section className="panel finishing-submit">
        <p>
          {dirty
            ? "有未保存的剪辑；保存后重新检查素材。"
            : `已保存剪辑 v${state.revision}`}
        </p>
        {state.blockers.map((b) => (
          <p className="alert" key={b}>
            {b}
          </p>
        ))}
        {base !== state.revision && (
          <button
            disabled={busy}
            onClick={() => {
              setBase(state.revision);
              storeDraft(key, { revision: state.revision, draft });
              setNotice(
                "保留当前草稿，已更新保存基准；请与服务端版本核对后保存。",
              );
            }}
          >
            保留草稿，使用最新保存基准
          </button>
        )}
        <div className="row">
          <button
            disabled={busy}
            onClick={() =>
              void action(async () => {
                const result = unwrap(
                  await api.PUT("/api/v1/projects/{pid}/finishing", {
                    params,
                    body: { revision: base, draft },
                  }),
                ) as State;
                if (!live.current) return;
                ++requestSequence.current;
                setState(result);
                setDraft(result.draft);
                setBase(result.revision);
                removeDraft(key);
                setNotice("剪辑已保存，素材检查已更新。");
              })
            }
          >
            保存剪辑
          </button>
          <button
            className="primary"
            disabled={
              busy || dirty || state.revision === 0 || state.blockers.length > 0
            }
            onClick={() =>
              void action(async () => {
                const body = { revision: state.revision };
                const command = durableCommand(`export:${pid}`, body);
                const job = unwrap(
                  await api.POST("/api/v1/projects/{pid}/exports", {
                    params: {
                      path: { pid },
                      header: { "idempotency-key": command.key },
                    },
                    body,
                  }),
                );
                command.done();
                setSelected(job.id);
                await refresh();
              })
            }
          >
            生成真实 MP4
          </button>
        </div>
      </section>
      <section className="panel">
        <h3>导出历史</h3>
        {exports.length === 0 && <p>尚无真实合成记录。</p>}
        {exports.map((e) => (
          <article className="text-job" key={e.id}>
            <div className="row">
              <strong>剪辑 v{e.revision}</strong>
              <span className="badge">{statuses[e.state] || e.state}</span>
              {e.stale && <span>已过期 · 仅供历史查看</span>}
            </div>
            <small>{e.id}</small>
            {e.error && <p role="alert">{errors[e.error] || e.error}</p>}
            {e.output && (
              <div className="row">
                <button onClick={() => setSelected(e.id)}>预览此版</button>
                <a href={`/api/v1/projects/${pid}/exports/${e.id}/download`}>
                  下载此版 MP4
                </a>
              </div>
            )}
            {e.state === "failed" && (
              <button
                disabled={busy || e.stale}
                onClick={() =>
                  void action(async () => {
                    const command = durableCommand(
                      `export-retry:${pid}:${e.id}`,
                      {},
                    );
                    unwrap(
                      await api.POST(
                        "/api/v1/projects/{pid}/exports/{jid}/retry",
                        {
                          params: {
                            path: { pid, jid: e.id },
                            header: { "idempotency-key": command.key },
                          },
                        },
                      ),
                    );
                    command.done();
                    await refresh();
                  })
                }
              >
                重试合成（不重新生成素材）
              </button>
            )}
          </article>
        ))}
      </section>
    </section>
  );
}
