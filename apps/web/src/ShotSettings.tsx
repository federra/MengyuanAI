import { trapDialogFocus } from "./dialogFocus";
import { useEffect, useRef, useState } from "react";
import { mediaRequest, useMedia } from "./MediaWorkbench";
import { readDraft, storeDraft, removeDraft } from "./commands";
import type { components } from "./generated/api";
type Model = components["schemas"]["ModelRoute"];
type Overrides = {
  model?: Model;
  aspect_ratio?: "9:16" | "16:9" | "1:1";
  resolution?: "720P" | "1080P" | "4K";
};
type Settings = {
  revision: number;
  overrides: Overrides;
  effective: {
    model: { value: Model | null };
    specification: { aspect_ratio: string; resolution: string };
  };
  sources: Record<string, string>;
};
export function ShotSettings({
  shotId,
  duration,
  onDuration,
}: {
  shotId: string;
  duration: number;
  onDuration: (duration: number) => void;
}) {
  const m = useMedia(),
    dialog = useRef<HTMLDialogElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    lock = useRef(false);
  const key = `sf.${m.pid}.shot-settings.${shotId}`;
  const [saved, setSaved] = useState<Settings | null>(null),
    [draft, setDraft] = useState<{
      revision: number;
      overrides: Overrides;
    } | null>(() => readDraft(key));
  const [models, setModels] = useState<Model[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const endpoint = `/api/v1/projects/${m.pid}/media/shots/${shotId}/settings`;
  useEffect(() => {
    let live = true;
    mediaRequest(`${endpoint}?board_version_id=${m.version}`, undefined, "GET")
      .then((s) => {
        if (live && s.effective) setSaved(s);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [endpoint, m.version]);
  useEffect(() => {
    if (draft) storeDraft(key, draft);
  }, [key, draft]);
  async function open() {
    dialog.current?.showModal();
    setError("");
    setNotice("");
    try {
      const s: Settings = await mediaRequest(
        `${endpoint}?board_version_id=${m.version}`,
        undefined,
        "GET",
      );
      setSaved(s);
      setDraft(
        (old) => old || { revision: s.revision, overrides: s.overrides },
      );
      const rows = await Promise.all(
        ["model:category:video", "model:step:video"].map((k) =>
          mediaRequest(
            `/api/v1/settings/bindings/system/${encodeURIComponent(k)}`,
            undefined,
            "GET",
          ),
        ),
      );
      const values = [
        s.effective.model.value,
        ...rows.map((r) => r.value),
      ].filter((r): r is Model => !!r && r.capability === "video");
      setModels(
        values.filter(
          (r, i) =>
            values.findIndex((x) => JSON.stringify(x) === JSON.stringify(r)) ===
            i,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法读取本镜设置");
    }
  }
  function change(next: Overrides) {
    setDraft((old) => ({
      revision: old?.revision ?? saved?.revision ?? 0,
      overrides: next,
    }));
  }
  async function save() {
    if (lock.current || !draft) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const s: Settings = await mediaRequest(
        endpoint,
        { board_version_id: m.version, ...draft },
        "PUT",
      );
      setSaved(s);
      setDraft({ revision: s.revision, overrides: s.overrides });
      removeDraft(key);
      await m.reload();
      setNotice("本镜设置已保存；受影响的视频与成片将标记待更新。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败，草稿保留");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const overrides = draft?.overrides || {},
    spec = saved?.effective.specification;
  return (
    <>
      <div className="shot-specification spec-chips">
        <button ref={trigger} aria-label="本镜模型" onClick={() => void open()}>
          {saved?.effective.model.value?.model || "未配置模型"}
        </button>
        <button aria-label="本镜画幅" onClick={() => void open()}>
          {spec?.aspect_ratio || "读取中…"}
        </button>
        <button aria-label="本镜分辨率" onClick={() => void open()}>
          {spec?.resolution || "读取中…"}
        </button>
        <label title="镜头时长">
          <input
            aria-label="镜头时长"
            type="number"
            min="0.1"
            max="600"
            step="0.1"
            value={duration}
            onChange={(e) => onDuration(Number(e.target.value))}
          />
          秒
        </label>
      </div>
      <dialog
        onKeyDown={trapDialogFocus}
        ref={dialog}
        className="settings-dialog shot-settings-dialog"
        aria-label="本镜生成设置"
        onClose={() => trigger.current?.focus()}
      >
        <header className="settings-dialog-header">
          <h2>本镜生成设置</h2>
          <button
            aria-label="关闭单镜设置"
            onClick={() => dialog.current?.close()}
          >
            关闭
          </button>
        </header>
        <div className="settings-dialog-body">
          <p>
            仅影响本镜。选择“继承”可恢复项目或系统设置，已提交任务保留原配置快照。
          </p>
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
          {!draft ? (
            <p role="status">读取中…</p>
          ) : (
            <>
              <label className="field">
                本镜模型
                <select
                  disabled={busy}
                  value={overrides.model ? JSON.stringify(overrides.model) : ""}
                  onChange={(e) =>
                    change({
                      ...overrides,
                      model: e.target.value
                        ? JSON.parse(e.target.value)
                        : undefined,
                    })
                  }
                >
                  <option value="">继承模型</option>
                  {[
                    ...models,
                    ...(overrides.model &&
                    !models.some(
                      (r) =>
                        JSON.stringify(r) === JSON.stringify(overrides.model),
                    )
                      ? [overrides.model]
                      : []),
                  ].map((r) => (
                    <option key={JSON.stringify(r)} value={JSON.stringify(r)}>
                      {r.provider} · {r.model}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                本镜画幅
                <select
                  disabled={busy}
                  value={overrides.aspect_ratio || ""}
                  onChange={(e) =>
                    change({
                      ...overrides,
                      aspect_ratio:
                        (e.target.value as Overrides["aspect_ratio"]) ||
                        undefined,
                    })
                  }
                >
                  <option value="">继承画幅</option>
                  {["9:16", "16:9", "1:1"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                本镜分辨率
                <select
                  disabled={busy}
                  value={overrides.resolution || ""}
                  onChange={(e) =>
                    change({
                      ...overrides,
                      resolution:
                        (e.target.value as Overrides["resolution"]) ||
                        undefined,
                    })
                  }
                >
                  <option value="">继承分辨率</option>
                  {["720P", "1080P", "4K"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <div className="actions">
                <button
                  className="primary"
                  disabled={busy || m.busy}
                  onClick={() => void save()}
                >
                  保存本镜设置
                </button>
                <button disabled={busy} onClick={() => change({})}>
                  全部恢复继承
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void mediaRequest(
                      `${endpoint}?board_version_id=${m.version}`,
                      undefined,
                      "GET",
                    )
                      .then((s) => {
                        setSaved(s);
                        setDraft((old) =>
                          old
                            ? { ...old, revision: s.revision }
                            : { revision: s.revision, overrides: s.overrides },
                        );
                        setNotice("最新基准已读取，输入保留，请核对后保存。");
                      })
                      .catch((e) => setError(e.message))
                  }
                >
                  读取最新基准
                </button>
              </div>
            </>
          )}
        </div>
      </dialog>
    </>
  );
}
