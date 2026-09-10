import { useEffect, useRef, useState } from "react";
import { useMedia } from "./MediaWorkbench";
import { trapDialogFocus } from "./dialogFocus";
import { readDraft, storeDraft } from "./commands";
import type { components } from "./generated/api";
const emotions: Record<string, string> = {
  neutral: "平静",
  happy: "高兴",
  sad: "悲伤",
  angry: "愤怒",
  fearful: "恐惧",
  disgusted: "厌恶",
  surprised: "惊讶",
};
export function BatchMediaDialog({
  body,
  kind,
}: {
  body: components["schemas"]["BoardBody"];
  kind: "audio" | "position";
}) {
  const m = useMedia(),
    dialog = useRef<HTMLDialogElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    lock = useRef(false);
  const label = kind === "audio" ? "批量配音" : "批量站位图";
  const key = `sf.${m.pid}.batch.${m.version}.${kind}`;
  const [accepted, setAccepted] = useState<Record<string, string>>(
    () => readDraft(key + ".accepted") || {},
  );
  const [pending, setPending] = useState<
    Record<string, Record<string, unknown>>
  >(() => readDraft(key + ".pending") || {});
  function pendingEntry(id: string, value?: Record<string, unknown>) {
    setPending((old) => {
      const next = { ...old };
      if (value) next[id] = value;
      else delete next[id];
      storeDraft(key + ".pending", next);
      return next;
    });
  }
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [choices, setChoices] = useState<Record<string, string>>(
    () => readDraft(key) || {},
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  useEffect(() => storeDraft(key, choices), [key, choices]);
  const rows = body.shots.flatMap((shot, index) => {
    const units =
      kind === "audio"
        ? shot.dialogues.map((line) => ({ id: line.id, line }))
        : [{ id: shot.id, line: null }];
    return units.map(({ id, line }) => {
      const binding = m.bindings.find((b) => b.line_id === id);
      const voice = binding?.voice || line?.voice || "";
      const inputEmotion = line?.emotion || "";
      const emotion =
        choices[id] ||
        (Object.hasOwn(emotions, inputEmotion)
          ? inputEmotion
          : Object.keys(emotions).find((k) => emotions[k] === inputEmotion)) ||
        "neutral";
      const outputKind = kind === "audio" ? "media.audio" : "image.position";
      const task = m.tasks.find(
        (t) =>
          t.target_id === id &&
          t.kind === outputKind &&
          !t.stale &&
          [
            "queued",
            "running",
            "waiting_provider",
            "waiting_dependency",
            "unknown",
            "failed",
            "cancelled",
          ].includes(t.state),
      );
      const held =
        accepted[id] && !m.tasks.some((t) => t.id === accepted[id] && t.stale);
      const reason = held
        ? "任务已受理，请在原任务查看或恢复"
        : task
          ? "已有任务，请在原任务查看或恢复"
          : m.results.some(
                (r) => r.kind === outputKind && r.target_id === id && !r.stale,
              )
            ? "已有当前结果"
            : line && !line.text.trim()
              ? "台词为空"
              : line && !voice.trim()
                ? "请先设置音色"
                : "";
      return { id, shot, index, line, voice, emotion, reason };
    });
  });
  const chosen = rows.filter((row) => selected[row.id] && !row.reason);
  async function submit() {
    if (lock.current || !m.enabled || !chosen.length) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    let submitted = 0;
    try {
      // Capture exactly the reviewed selection and version; no new rows join a running batch.
      for (const row of chosen) {
        const request = pending[row.id] || {
          board_version_id: m.version,
          shot_id: row.shot.id,
          ...(kind === "audio"
            ? { line_id: row.id, emotion: row.emotion, speed: 1 }
            : {}),
        };
        pendingEntry(row.id, request);
        let result;
        try {
          result = await m.run(
            kind === "audio" ? "/audio" : "/images",
            request,
            "POST",
            true,
          );
        } catch (e) {
          const status = (e as { status?: number }).status;
          if (status && status >= 400 && status < 500) pendingEntry(row.id);
          throw e;
        }
        setAccepted((old) => {
          const next = {
            ...old,
            [row.id]: String((result as { id: string }).id),
          };
          storeDraft(key + ".accepted", next);
          return next;
        });
        pendingEntry(row.id);
        submitted++;
        setSelected((old) => ({ ...old, [row.id]: false }));
      }
      setNotice(
        `已提交 ${submitted} 项；任务完成后检查结果，站位图仍需人工确认。`,
      );
    } catch (e) {
      setError(
        `已提交 ${submitted} 项，未提交项与配置保留。${e instanceof Error ? e.message : "请检查后重试"}`,
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <button
        ref={trigger}
        disabled={!m.enabled || m.busy || busy}
        onClick={() => {
          setSelected(
            Object.fromEntries(rows.map((row) => [row.id, !row.reason])),
          );
          setError("");
          setNotice("");
          dialog.current?.showModal();
        }}
      >
        {label}
      </button>
      <dialog
        ref={dialog}
        className="settings-dialog batch-dialog"
        aria-label={label}
        onKeyDown={trapDialogFocus}
        onCancel={(e) => {
          if (busy) e.preventDefault();
        }}
        onClose={() => trigger.current?.focus()}
      >
        <header className="settings-dialog-header">
          <h2>{label}</h2>
          <button
            disabled={busy}
            aria-label={`关闭${label}`}
            onClick={() => dialog.current?.close()}
          >
            关闭
          </button>
        </header>
        <div className="settings-dialog-body">
          <p>
            {kind === "audio"
              ? "沿用每句已绑定角色与音色，可逐句选择配音表现；语速为1倍。"
              : "沿用项目模型、规格、风格及各镜头引用，提交后仍需人工确认图片。"}
          </p>
          <p className="muted">
            模型与配置在提交时冻结。共 {rows.length} 项，可提交 {chosen.length}{" "}
            项；提交会消耗供应商用量。
          </p>
          <fieldset disabled={busy} className="editor-fields batch-items">
            {rows.map((row) => (
              <div className="batch-item" key={row.id}>
                <label>
                  <input
                    type="checkbox"
                    disabled={!!row.reason}
                    checked={!!selected[row.id] && !row.reason}
                    onChange={(e) =>
                      setSelected((old) => ({
                        ...old,
                        [row.id]: e.target.checked,
                      }))
                    }
                  />
                  <span>
                    镜头 {row.index + 1}
                    {row.line
                      ? ` · ${row.line.speaker || "未命名角色"}：${row.line.text}`
                      : " · 站位图"}
                    {row.reason && `（${row.reason}）`}
                  </span>
                </label>
                {row.line && (
                  <div className="row">
                    <small>音色：{row.voice || "未设置"}</small>
                    <label>
                      配音表现
                      <select
                        disabled={!!pending[row.id]}
                        aria-label={`镜头${row.index + 1}台词${row.shot.dialogues.findIndex((d) => d.id === row.id) + 1}配音表现`}
                        value={String(pending[row.id]?.emotion || row.emotion)}
                        onChange={(e) =>
                          setChoices((old) => ({
                            ...old,
                            [row.id]: e.target.value,
                          }))
                        }
                      >
                        {Object.entries(emotions).map(([value, text]) => (
                          <option value={value} key={value}>
                            {text}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}
              </div>
            ))}
          </fieldset>
          {Object.keys(pending).length > 0 && (
            <p>部分提交结果待核实，重试将复用原配置与同一请求身份。</p>
          )}
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
        </div>
        <footer className="settings-dialog-header">
          <small>
            {busy
              ? "正在提交，请等待当前操作完成。"
              : "关闭保留配置，已提交任务继续运行。"}
          </small>
          <button
            className="primary"
            disabled={busy || m.busy || !m.enabled || !chosen.length}
            onClick={() => void submit()}
          >
            {busy ? "提交中…" : "提交所选任务"}
          </button>
        </footer>
      </dialog>
    </>
  );
}
