import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { durableCommand, readDraft, storeDraft } from "./commands";
import type { components } from "./generated/api";
type Board = components["schemas"]["BoardBody"];
type Shot = components["schemas"]["Shot"];
type Outcome = components["schemas"]["OutcomeOut"];
type Task = components["schemas"]["MediaTaskOut"];
type Entity = components["schemas"]["EntityOut"];
type Binding = components["schemas"]["LineBindingOut"];
const states: Record<string, string> = {
  queued: "排队中",
  running: "处理中",
  waiting_provider: "供应商处理中",
  waiting_dependency: "等待前镜或已暂停",
  unknown: "受理待核实，未自动重发",
  failed: "失败",
  succeeded: "成功",
  cancelled: "已取消",
};
export async function mediaRequest(
  path: string,
  body?: unknown,
  method = "POST",
  commandScope?: string,
) {
  const command = commandScope ? durableCommand(commandScope, body) : null;
  const response = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(command ? { "Idempotency-Key": command.key } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (!response.ok) {
    if (response.status >= 400 && response.status < 500) command?.done();
    throw new Error(
      typeof value.detail === "string"
        ? value.detail
        : "操作未成功，请检查输入与任务记录",
    );
  }
  command?.done();
  return value;
}
type State = {
  pid: string;
  version: string;
  enabled: boolean;
  busy: boolean;
  results: Outcome[];
  tasks: Task[];
  entities: Entity[];
  bindings: Binding[];
  references: components["schemas"]["ShotReferenceOut"][];
  run: (
    path: string,
    body?: unknown,
    method?: string,
    paid?: boolean,
  ) => Promise<unknown>;
  reload: () => Promise<void>;
  notice: (text: string) => void;
};
const Context = createContext<State | null>(null);
export function useMedia() {
  const state = useContext(Context);
  if (!state) throw new Error("Media context missing");
  return state;
}
export function BoardMedia({
  pid,
  version,
  enabled,
  children,
  onFiles,
}: {
  pid: string;
  version: string;
  enabled: boolean;
  children: ReactNode;
  onFiles: (files: components["schemas"]["FileOut"][]) => void;
}) {
  const [results, setResults] = useState<Outcome[]>([]),
    [tasks, setTasks] = useState<Task[]>([]),
    [entities, setEntities] = useState<Entity[]>([]),
    [bindings, setBindings] = useState<Binding[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [references, setReferences] = useState<
    components["schemas"]["ShotReferenceOut"][]
  >([]);
  const lock = useRef(false),
    live = useRef(true);
  const root = `/api/v1/projects/${pid}`;
  async function reload() {
    const responses = await Promise.all(
      [
        "/media/results",
        "/media/tasks",
        "/entities",
        "/media/line-bindings",
        "/files",
        "/media/reference-bindings",
      ].map((path) => mediaRequest(root + path, undefined, "GET")),
    );
    if (!live.current) return;
    setResults(responses[0]);
    setTasks(responses[1]);
    setEntities(responses[2]);
    setBindings(responses[3]);
    onFiles(responses[4]);
    setReferences(responses[5]);
  }
  useEffect(() => {
    live.current = true;
    const load = () =>
      void reload().catch((e) => {
        if (live.current) setError(e.message);
      });
    load();
    const timer = setInterval(load, 2500);
    return () => {
      live.current = false;
      clearInterval(timer);
    };
  }, [pid]);
  async function run(
    path: string,
    body?: unknown,
    method = "POST",
    paid = false,
  ) {
    if (lock.current) throw new Error("请等待当前操作完成");
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await mediaRequest(
        root + "/media" + path,
        body,
        method,
        paid ? `media.${pid}.${path}` : undefined,
      );
      await reload();
      setNotice(
        paid
          ? "已提交，离开页面后任务继续；结果保存后可预览。"
          : "操作已保存。",
      );
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
      throw e;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <Context.Provider
      value={{
        pid,
        version,
        enabled,
        busy,
        results,
        tasks,
        entities,
        bindings,
        references,
        run,
        reload,
        notice: setNotice,
      }}
    >
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!enabled && (
        <p className="muted">
          请先保存并确认当前分镜，再生成媒体。质检建议不影响继续。
        </p>
      )}
      {children}
    </Context.Provider>
  );
}
const ignore = () => {};
const active = (task: Task) =>
  ["queued", "running", "waiting_provider", "waiting_dependency"].includes(
    task.state,
  );
export function MediaToolbar({ body }: { body: Board }) {
  const m = useMedia();
  async function batch(kind: "audio" | "position") {
    let submitted = 0,
      skipped = 0;
    for (const shot of body.shots) {
      if (kind === "position") {
        if (
          m.tasks.some(
            (t) =>
              t.kind === "image.position" && t.shot_id === shot.id && active(t),
          )
        ) {
          skipped++;
          continue;
        }
        await m.run(
          "/images",
          { board_version_id: m.version, shot_id: shot.id },
          "POST",
          true,
        );
        submitted++;
      } else
        for (const line of shot.dialogues) {
          const bound = m.bindings.find((b) => b.line_id === line.id);
          if (
            !line.text.trim() ||
            !(bound?.voice || line.voice).trim() ||
            m.results.some(
              (r) =>
                r.kind === "media.audio" && r.target_id === line.id && !r.stale,
            ) ||
            m.tasks.some((t) => t.target_id === line.id && active(t))
          ) {
            skipped++;
            continue;
          }
          const emotion = [
            "happy",
            "sad",
            "angry",
            "fearful",
            "disgusted",
            "surprised",
            "neutral",
          ].includes(line.emotion)
            ? line.emotion
            : undefined;
          if (!emotion) {
            skipped++;
            continue;
          }
          await m.run(
            "/audio",
            {
              board_version_id: m.version,
              shot_id: shot.id,
              line_id: line.id,
              emotion,
            },
            "POST",
            true,
          );
          submitted++;
        }
    }
    m.notice(
      `批量提交 ${submitted} 项，跳过 ${skipped} 项（缺少音色/情绪、已有结果或任务）。`,
    );
  }
  return (
    <div className="actions media-toolbar">
      <button
        disabled={!m.enabled || m.busy}
        onClick={() => void batch("audio").catch(ignore)}
      >
        批量配音
      </button>
      <button
        disabled={!m.enabled || m.busy}
        onClick={() => void batch("position").catch(ignore)}
      >
        批量站位图
      </button>
      <button
        disabled={
          !m.enabled ||
          m.busy ||
          m.tasks.some((t) => t.sequence_id && active(t))
        }
        onClick={() =>
          void m
            .run(
              "/videos",
              {
                board_version_id: m.version,
                shot_ids: body.shots.map((s) => s.id),
                sequential: true,
              },
              "POST",
              true,
            )
            .catch(ignore)
        }
      >
        按顺序生成全部镜头
      </button>
      <small>
        媒体生成会消耗供应商用量；连续性采用多图参考，前镜尾帧不保证严格首帧一致。
      </small>
      {[
        ...new Set(
          m.tasks.flatMap((t) => (t.sequence_id ? [t.sequence_id] : [])),
        ),
      ].map((id) => {
        const task = m.tasks.find((t) => t.sequence_id === id)!;
        return (
          <button
            key={id}
            disabled={m.busy}
            onClick={() =>
              void m
                .run(`/sequences/${id}`, { paused: !task.paused }, "PUT")
                .catch(ignore)
            }
          >
            {task.paused ? "继续顺序任务" : "暂停顺序任务"}
          </button>
        );
      })}
    </div>
  );
}
export function MediaHistory({
  target,
  kind,
}: {
  target: string;
  kind: string;
}) {
  const m = useMedia();
  const [confirmUnknown, setConfirmUnknown] = useState<Record<string, boolean>>(
    {},
  );
  const jobs = m.tasks.filter((t) => t.target_id === target && t.kind === kind);
  return (
    <div className="media-history">
      {jobs.slice(0, 1).map((t) => (
        <p key={t.id}>
          {t.error === "cancel_requested"
            ? "已请求取消，供应商可能仍计费，晚到结果归档"
            : states[t.state] || t.state}
          {t.error === "provider_audio_status_1008" &&
            " · MiniMax 账户余额不足，请补充语音API额度后再处理此任务。"}
          {t.error === "provider_reference_image_privacy" &&
            " · 参考图被方舟隐私审核拒绝（InputImageSensitiveContentDetected.PrivacyInformation）。请核对官方人像素材接入要求，勿原样重复提交。"}
          {t.error === "provider_output_video_sensitive" &&
            " · 输出视频未通过供应商审核（OutputVideoSensitiveContentDetected），请检查内容后再处理。"}
          {t.stale ? " · 输入已过期" : ""}
        </p>
      ))}
      {!!jobs.length && (
        <details>
          <summary>任务与输入快照（{jobs.length}）</summary>
          {jobs.map((t) => (
            <article key={t.id}>
              <p>
                {states[t.state] || t.state} · {t.error || ""}{" "}
                {t.stale ? " · 已过期" : ""}
              </p>
              <small>{t.id}</small>
              <details>
                <summary>模型、来源与前镜版本</summary>
                <pre className="preserve-text">
                  {JSON.stringify(
                    {
                      snapshot: t.snapshot,
                      previous: t.previous,
                      external_id: t.external_id,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
              {t.state === "unknown" && !t.external_id && (
                <label>
                  <input
                    type="checkbox"
                    checked={!!confirmUnknown[t.id]}
                    onChange={(e) =>
                      setConfirmUnknown((old) => ({
                        ...old,
                        [t.id]: e.target.checked,
                      }))
                    }
                  />
                  已向供应商核实，接受可能重复计费
                </label>
              )}
              {["failed", "unknown", "cancelled"].includes(t.state) && (
                <button
                  disabled={
                    m.busy ||
                    t.stale ||
                    (t.state === "unknown" &&
                      !t.external_id &&
                      !confirmUnknown[t.id])
                  }
                  onClick={() =>
                    void m
                      .run(
                        `/tasks/${t.id}/retry`,
                        { confirm_unknown: !!confirmUnknown[t.id] },
                        "POST",
                        true,
                      )
                      .then(() =>
                        setConfirmUnknown((old) => ({ ...old, [t.id]: false })),
                      )
                      .catch(ignore)
                  }
                >
                  重试此任务
                </button>
              )}
              {active(t) && (
                <button
                  disabled={m.busy}
                  onClick={() =>
                    void m.run(`/tasks/${t.id}/cancel`).catch(ignore)
                  }
                >
                  取消此任务
                </button>
              )}
            </article>
          ))}
        </details>
      )}
    </div>
  );
}
function fileUrl(pid: string, fid: string) {
  return `/api/v1/projects/${pid}/files/${fid}`;
}
export function ShotVideo({
  shot,
  previousShotId,
}: {
  shot: Shot;
  previousShotId?: string;
}) {
  const m = useMedia();
  const outputs = m.results.filter(
    (r) => r.kind === "media.video" && r.target_id === shot.id,
  );
  const previous = m.results.find(
    (r) =>
      r.kind === "media.video" && r.target_id === previousShotId && !r.stale,
  );
  const bound = m.tasks.find(
    (t) => t.target_id === shot.id && t.previous,
  )?.previous;
  return (
    <section aria-label="镜头视频">
      <button
        disabled={
          !m.enabled ||
          m.busy ||
          m.tasks.some(
            (t) =>
              t.target_id === shot.id && t.kind === "media.video" && active(t),
          )
        }
        onClick={() =>
          void m
            .run(
              "/videos",
              {
                board_version_id: m.version,
                shot_ids: [shot.id],
                sequential: false,
              },
              "POST",
              true,
            )
            .catch(ignore)
        }
      >
        生成本镜视频
      </button>
      {previousShotId && (
        <button
          disabled={!m.enabled || m.busy || !previous || previous.stale}
          onClick={() =>
            void m
              .run(`/shots/${shot.id}/previous-frame`, {
                board_version_id: m.version,
                previous_video_version_id: previous!.id,
              })
              .then(
                () =>
                  m.notice(
                    "尾帧引用已保存为新分镜版本；请载入最新版本并确认后生成。原草稿保留。",
                  ),
                ignore,
              )
          }
        >
          参考上一视频尾帧
        </button>
      )}
      {bound && (
        <a
          href={fileUrl(m.pid, String(bound.refId))}
          target="_blank"
          rel="noreferrer"
        >
          <img
            className="tail-preview"
            src={fileUrl(m.pid, String(bound.refId))}
            alt="已绑定前镜真实尾帧"
          />
        </a>
      )}
      {outputs.map((r, i) => (
        <details key={r.id} open={i === 0}>
          <summary>
            {i === 0 ? "最近结果" : "历史结果"}
            {r.stale ? " · 待更新" : ""}
          </summary>
          <video controls preload="metadata" src={fileUrl(m.pid, r.file_id)} />
          <a href={fileUrl(m.pid, r.file_id)} target="_blank" rel="noreferrer">
            打开视频
          </a>
          {r.tail_file_id && (
            <a
              href={fileUrl(m.pid, r.tail_file_id)}
              target="_blank"
              rel="noreferrer"
            >
              <img
                className="tail-preview"
                src={fileUrl(m.pid, r.tail_file_id)}
                alt="本镜真实尾帧"
              />
            </a>
          )}
        </details>
      ))}
      <MediaHistory target={shot.id} kind="media.video" />
    </section>
  );
}
export function ShotAudio({ shot }: { shot: Shot }) {
  const m = useMedia();
  const [choices, setChoices] = useState<
    Record<string, { emotion: string; speed: number }>
  >(() => readDraft(`sf.${m.pid}.audio-options.${shot.id}`) || {});
  useEffect(
    () => storeDraft(`sf.${m.pid}.audio-options.${shot.id}`, choices),
    [choices, m.pid, shot.id],
  );
  return (
    <section aria-label="逐段配音">
      {shot.dialogues.map((line, i) => {
        const binding = m.bindings.find((b) => b.line_id === line.id),
          choice = choices[line.id] || { emotion: "neutral", speed: 1 };
        const outputs = m.results.filter(
          (r) => r.kind === "media.audio" && r.target_id === line.id,
        );
        return (
          <div className="dialogue-line audio-line" key={line.id}>
            <strong>
              第{i + 1}段 · {binding?.name || line.speaker || "未指定角色"}
            </strong>
            <label className="field">
              绑定全片角色
              <select
                disabled={!m.enabled || m.busy}
                value={binding?.entity_id || ""}
                onChange={(e) =>
                  void m
                    .run(
                      `/line-bindings/${line.id}`,
                      {
                        board_version_id: m.version,
                        entity_id: e.target.value || null,
                        revision: binding?.revision || 0,
                      },
                      "PUT",
                    )
                    .catch(ignore)
                }
              >
                <option value="">使用逐段音色</option>
                {m.entities
                  .filter((e) => e.kind === "character")
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name} · {e.voice || "未设音色"}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field">
              配音表现
              <select
                value={choice.emotion}
                onChange={(e) =>
                  setChoices({
                    ...choices,
                    [line.id]: { ...choice, emotion: e.target.value },
                  })
                }
              >
                {Object.entries({
                  neutral: "平静",
                  happy: "高兴",
                  sad: "悲伤",
                  angry: "愤怒",
                  fearful: "恐惧",
                  disgusted: "厌恶",
                  surprised: "惊讶",
                }).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              配音语速
              <input
                type="number"
                min="0.5"
                max="2"
                step="0.1"
                value={choice.speed}
                onChange={(e) =>
                  setChoices({
                    ...choices,
                    [line.id]: { ...choice, speed: Number(e.target.value) },
                  })
                }
              />
            </label>
            <button
              disabled={
                !m.enabled ||
                m.busy ||
                !line.text.trim() ||
                !(binding?.voice || line.voice).trim() ||
                m.tasks.some((t) => t.target_id === line.id && active(t))
              }
              onClick={() =>
                void m
                  .run(
                    "/audio",
                    {
                      board_version_id: m.version,
                      shot_id: shot.id,
                      line_id: line.id,
                      ...choice,
                    },
                    "POST",
                    true,
                  )
                  .catch(ignore)
              }
            >
              生成第{i + 1}段配音
            </button>
            {outputs.map((r, index) => (
              <details key={r.id} open={index === 0}>
                <summary>
                  {index === 0 ? "最近配音" : "历史配音"}
                  {r.stale ? " · 待更新" : ""}
                  {Number(r.metadata.duration) > shot.duration
                    ? " · 长于镜头，请调整时长或语速"
                    : ""}
                </summary>
                <audio
                  controls
                  preload="metadata"
                  src={fileUrl(m.pid, r.file_id)}
                />
              </details>
            ))}
            <MediaHistory target={line.id} kind="media.audio" />
          </div>
        );
      })}
    </section>
  );
}
export function ShotPosition({
  shot,
  onBind,
}: {
  shot: Shot;
  onBind: (id: string) => void;
}) {
  const m = useMedia();
  const outputs = m.results.filter(
    (r) => r.kind === "image.position" && r.target_id === shot.id,
  );
  return (
    <section aria-label="站位图生成">
      <button
        disabled={
          !m.enabled ||
          m.busy ||
          m.tasks.some(
            (t) =>
              t.kind === "image.position" &&
              t.target_id === shot.id &&
              active(t),
          )
        }
        onClick={() =>
          void m
            .run(
              "/images",
              { board_version_id: m.version, shot_id: shot.id },
              "POST",
              true,
            )
            .catch(ignore)
        }
      >
        生成站位图
      </button>
      {outputs.map((r) => (
        <article key={r.id}>
          <a href={fileUrl(m.pid, r.file_id)} target="_blank" rel="noreferrer">
            <img
              className="tail-preview"
              src={fileUrl(m.pid, r.file_id)}
              alt="生成站位图"
            />
          </a>
          <p>{r.stale ? "来源过期" : r.confirmed ? "已确认" : "待确认"}</p>
          <button
            disabled={m.busy || r.stale || r.confirmed}
            onClick={() => void m.run(`/results/${r.id}/confirm`).catch(ignore)}
          >
            确认站位图
          </button>
          <button
            disabled={
              m.busy ||
              r.stale ||
              !r.confirmed ||
              (shot.refs.positions || []).includes(r.file_id)
            }
            onClick={() => onBind(r.file_id)}
          >
            加入本镜站位引用
          </button>
        </article>
      ))}
      <MediaHistory target={shot.id} kind="image.position" />
    </section>
  );
}
