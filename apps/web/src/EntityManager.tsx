import "./entity-compact.css";
import { trapDialogFocus } from "./dialogFocus";
import { useEffect, useRef, useState } from "react";
import { ReferenceImages } from "./ReferenceImages";
import { api, unwrap } from "./api";
import { readDraft, storeDraft } from "./commands";
import type { components } from "./generated/api";
type Entity = components["schemas"]["EntityOut"];
type Kind = Entity["kind"];
type Draft = components["schemas"]["EntityCreate"] & {
  id?: string;
  revision?: number;
};
const names: Record<Kind, string> = {
  character: "角色",
  scene: "场景",
  prop: "道具",
};
const blank = (kind: Kind): Draft => ({
  kind,
  name: "",
  description: "",
  voice: "",
  three_view: false,
});

export function EntityManager({ pid }: { pid: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [kind, setKind] = useState<Kind>("character");
  const [entities, setEntities] = useState<Entity[]>([]);
  const [drafts, setDrafts] = useState<Partial<Record<Kind, Draft>>>(
    () => readDraft(`sf.${pid}.entities`) || {},
  );
  const [preserved, setPreserved] = useState<(Draft & { backupId: string })[]>(
    () => readDraft(`sf.${pid}.entity-backups`) || [],
  );
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const draft = drafts[kind] || blank(kind);
  useEffect(() => storeDraft(`sf.${pid}.entities`, drafts), [pid, drafts]);
  useEffect(
    () => storeDraft(`sf.${pid}.entity-backups`, preserved),
    [pid, preserved],
  );
  function preserve() {
    const saved = entities.find((entity) => entity.id === draft.id);
    if (
      saved &&
      saved.revision === draft.revision &&
      saved.name === draft.name &&
      saved.description === draft.description &&
      saved.voice === draft.voice &&
      saved.three_view === draft.three_view
    )
      return;
    if (draft.name || draft.description || draft.voice || draft.three_view)
      setPreserved((old) =>
        old.some((item) =>
          [
            "id",
            "revision",
            "kind",
            "name",
            "description",
            "voice",
            "three_view",
          ].every(
            (key) =>
              (item as unknown as Record<string, unknown>)[key] ===
              (draft as unknown as Record<string, unknown>)[key],
          ),
        )
          ? old
          : [...old, { ...draft, backupId: crypto.randomUUID() }],
      );
  }
  function edit(value: Draft) {
    setDrafts((old) => ({ ...old, [kind]: value }));
  }
  function selectEntity(entity: Entity) {
    if (draft.id === entity.id && draft.revision === entity.revision) return;
    preserve();
    const { id, revision, kind, name, description, voice, three_view } = entity;
    edit({ id, revision, kind, name, description, voice, three_view });
    setError("");
  }
  async function load() {
    const rows = unwrap(
      await api.GET("/api/v1/projects/{pid}/entities", {
        params: { path: { pid } },
      }),
    );
    setEntities(rows);
    setLoaded(true);
  }
  function open(next: Kind, button: HTMLButtonElement) {
    trigger.current = button;
    setKind(next);
    setError("");
    setNotice("");
    dialog.current?.showModal();
    void load().catch((e) => setError(e.message));
  }
  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { id, revision, ...body } = draft;
      const saved = id
        ? unwrap(
            await api.PUT("/api/v1/projects/{pid}/entities/{eid}", {
              params: { path: { pid, eid: id } },
              body: { ...body, revision: revision! },
            }),
          )
        : unwrap(
            await api.POST("/api/v1/projects/{pid}/entities", {
              params: { path: { pid } },
              body,
            }),
          );
      edit({
        id: saved.id,
        revision: saved.revision,
        kind: saved.kind,
        name: saved.name,
        description: saved.description,
        voice: saved.voice,
        three_view: saved.three_view,
      });
      await load();
      setNotice("元素已保存；历史版本保留。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败，草稿保留");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="actions" aria-label="全片元素管理">
        {(Object.keys(names) as Kind[]).map((k) => (
          <button key={k} onClick={(e) => open(k, e.currentTarget)}>
            {names[k]}管理
          </button>
        ))}
      </div>
      <dialog
        onKeyDown={trapDialogFocus}
        ref={dialog}
        className="settings-dialog entity-dialog"
        aria-labelledby="entity-title"
        onClose={() => trigger.current?.focus()}
      >
        <header className="settings-dialog-header">
          <h2 id="entity-title">{names[kind]}管理</h2>
          <button
            aria-label="关闭元素管理"
            onClick={() => dialog.current?.close()}
          >
            关闭
          </button>
        </header>
        <div className="settings-dialog-body">
          {error && (
            <p role="alert" className="alert">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          <div className="entity-workspace">
            <aside className="entity-picker" aria-label={names[kind] + "列表"}>
              {!loaded && <p>读取项目元素…</p>}
              {entities
                .filter((entity) => entity.kind === kind)
                .map((entity) => (
                  <article
                    key={entity.id}
                    className={draft.id === entity.id ? "selected" : ""}
                  >
                    <button
                      disabled={busy}
                      aria-label={"编辑" + entity.name}
                      aria-pressed={draft.id === entity.id}
                      onClick={() => selectEntity(entity)}
                    >
                      <strong>{entity.name}</strong>
                      <small>v{entity.revision}</small>
                    </button>
                    <button
                      disabled={busy}
                      aria-label={"管理" + entity.name + "图片"}
                      onClick={() => {
                        selectEntity(entity);
                        requestAnimationFrame(() =>
                          dialog.current
                            ?.querySelector(".entity-reference-panel")
                            ?.scrollIntoView({ block: "nearest" }),
                        );
                      }}
                    >
                      管理图片
                    </button>
                  </article>
                ))}
              {loaded && !entities.some((entity) => entity.kind === kind) && (
                <p>暂无{names[kind]}，可在右侧新增。</p>
              )}
            </aside>
            <div className="entity-selected-editor">
              <fieldset className="editor-fields" disabled={busy}>
                <div className="row">
                  <h3>{draft.id ? "编辑元素" : "新增元素"}</h3>
                  <button
                    onClick={() => {
                      preserve();
                      edit(blank(kind));
                    }}
                  >
                    新增{names[kind]}
                  </button>
                </div>
                <label className="field">
                  元素名称
                  <input
                    value={draft.name}
                    maxLength={100}
                    onChange={(e) => edit({ ...draft, name: e.target.value })}
                  />
                </label>
                <label className="field">
                  元素描述
                  <textarea
                    rows={4}
                    value={draft.description}
                    maxLength={10000}
                    onChange={(e) =>
                      edit({ ...draft, description: e.target.value })
                    }
                  />
                </label>
                {kind === "character" && (
                  <>
                    <label className="field">
                      音色 ID
                      <input
                        value={draft.voice}
                        maxLength={200}
                        onChange={(e) =>
                          edit({ ...draft, voice: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={draft.three_view}
                        onChange={(e) =>
                          edit({ ...draft, three_view: e.target.checked })
                        }
                      />
                      角色三视图
                    </label>
                  </>
                )}
              </fieldset>
              {draft.id && (
                <ReferenceImages
                  key={draft.id}
                  pid={pid}
                  entityId={draft.id}
                  entityRevision={draft.revision!}
                  disabled={
                    busy ||
                    (() => {
                      const saved = entities.find((e) => e.id === draft.id);
                      return (
                        !saved ||
                        ["name", "description", "voice", "three_view"].some(
                          (k) =>
                            (saved as unknown as Record<string, unknown>)[k] !==
                            (draft as unknown as Record<string, unknown>)[k],
                        )
                      );
                    })()
                  }
                />
              )}
              {draft.id && (
                <details>
                  <summary>
                    当前已保存版本 v
                    {entities.find((e) => e.id === draft.id)?.revision}
                    ，请核对后保存草稿
                  </summary>
                  <p>
                    当前已保存名称：
                    {entities.find((e) => e.id === draft.id)?.name}
                  </p>
                  <p>
                    当前已保存描述：
                    {entities.find((e) => e.id === draft.id)?.description}
                  </p>
                  {kind === "character" && (
                    <p>
                      当前音色：
                      {entities.find((e) => e.id === draft.id)?.voice ||
                        "未设置"}
                      ；三视图：
                      {entities.find((e) => e.id === draft.id)?.three_view
                        ? "是"
                        : "否"}
                    </p>
                  )}
                </details>
              )}
              {preserved
                .filter((item) => item.kind === kind)
                .map((item) => (
                  <button
                    key={item.backupId}
                    disabled={busy}
                    onClick={() => {
                      preserve();
                      const { backupId, ...recovered } = item;
                      const latest = entities.find(
                        (e) => e.id === recovered.id,
                      );
                      edit({
                        ...recovered,
                        revision: latest?.revision ?? recovered.revision,
                      });
                      setPreserved((old) =>
                        old.filter((value) => value.backupId !== backupId),
                      );
                      setError("");
                      setNotice(
                        "已载入草稿；请与当前已保存内容核对、合并后再保存。",
                      );
                    }}
                  >
                    恢复草稿：
                    {item.name ||
                      item.description?.slice(0, 30) ||
                      "未命名元素"}
                  </button>
                ))}
            </div>
          </div>
        </div>
        <footer className="settings-dialog-header">
          <small>关闭窗口保留草稿；保存后供当前项目使用。</small>
          <button
            className="primary"
            disabled={busy || !loaded || !draft.name.trim()}
            onClick={() => void save()}
          >
            {busy ? "保存中…" : "保存元素"}
          </button>
        </footer>
      </dialog>
    </>
  );
}
