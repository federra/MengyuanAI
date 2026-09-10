import { ImagePreview } from "./ImagePreview";
import "./entity-compact.css";
import { EntityLibrary } from "./EntityLibrary";
import { trapDialogFocus } from "./dialogFocus";
import { useEffect, useRef, useState } from "react";
import { ReferenceImages } from "./ReferenceImages";
import { mediaRequest } from "./MediaWorkbench";
import { readDraft, storeDraft, removeDraft } from "./commands";
import type { components } from "./generated/api";
type Kind = "character" | "scene" | "prop";
type Draft = {
  clear_output?: boolean;
  id: string;
  revision: number;
  kind: Kind;
  name: string;
  description: string;
  voice: string;
  three_view: boolean;
  input_file_id: string | null;
  output_file_id: string | null;
};
type Entity = Draft & {
  version_id: string;
  library_asset_id?: string | null;
  library_version?: number | null;
};
type Batch = {
  items: { entity_id: string; entity_revision: number; instruction: string }[];
};
type SaveResult = {
  entities: Entity[];
  board_version_id: string | null;
  affected_shot_ids: string[];
};
const names: Record<Kind, string> = {
  character: "角色",
  scene: "场景",
  prop: "道具",
};
const fields = [
  "name",
  "description",
  "voice",
  "three_view",
  "input_file_id",
  "output_file_id",
] as const;
const toDraft = (e: Entity): Draft => ({
  id: e.id,
  revision: e.revision,
  kind: e.kind,
  name: e.name,
  description: e.description,
  voice: e.voice,
  three_view: e.three_view,
  input_file_id: e.input_file_id || null,
  output_file_id: e.output_file_id || null,
});
const blank = (kind: Kind): Draft => ({
  id: crypto.randomUUID(),
  revision: 0,
  kind,
  name: "",
  description: "",
  voice: "",
  three_view: kind === "character",
  input_file_id: null,
  output_file_id: null,
});

export function EntityManager({
  pid,
  onChanged,
}: {
  pid: string;
  onChanged?: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    trigger = useRef<HTMLButtonElement | null>(null),
    lock = useRef(false),
    alive = useRef(true);
  const cacheKey = `sf.${pid}.entity-drafts-v2`,
    pendingKey = `sf.${pid}.entity-image-batch`;
  const [kind, setKind] = useState<Kind>("character"),
    [entities, setEntities] = useState<Entity[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(
    () => readDraft(cacheKey) || {},
  );
  const [selected, setSelected] = useState<Partial<Record<Kind, string>>>({});
  const [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [board, setBoard] = useState<
    components["schemas"]["ContentOut"] | null
  >(null);
  const [pending, setPending] = useState<Batch | null>(() =>
    readDraft(pendingKey),
  );
  const [bind, setBind] = useState<{
    shot_id: string;
    mode: "add" | "replace";
  } | null>(null);
  const [remove, setRemove] = useState(false),
    [history, setHistory] = useState<Entity[] | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [catalogImages, setCatalogImages] = useState<
    components["schemas"]["ReferenceOut"][]
  >([]);
  const [catalogTasks, setCatalogTasks] = useState<
    components["schemas"]["MediaTaskOut"][]
  >([]);
  useEffect(() => {
    let live = true;
    async function poll() {
      if (!dialog.current?.open) return;
      const [images, tasks] = await Promise.all([
        mediaRequest(
          `/api/v1/projects/${pid}/reference-images`,
          undefined,
          "GET",
        ),
        mediaRequest(`/api/v1/projects/${pid}/media/tasks`, undefined, "GET"),
      ]);
      if (live) {
        setCatalogImages(images);
        setCatalogTasks(tasks);
      }
    }
    const timer = setInterval(
      () =>
        void poll().catch((e) => {
          if (live) setError(e.message);
        }),
      2500,
    );
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [pid]);

  const [voiceAssets, setVoiceAssets] = useState<
    { id: string; name: string; content: string }[]
  >([]);
  useEffect(() => {
    let live = true;
    mediaRequest("/api/v1/settings/resources?kind=voice", undefined, "GET")
      .then((rows) => {
        if (live) setVoiceAssets(rows);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [pid]);
  const [preview, setPreview] = useState<{file:string;title:string}|null>(null);
  const [voiceEditor, setVoiceEditor] = useState(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => storeDraft(cacheKey, drafts), [cacheKey, drafts]);
  // A displayed current generation must be part of the save payload, not preview-only.
  useEffect(() => {
    if (busy || pending || !loaded) return;
    setDrafts(old => {
      let next = old;
      for (const entity of entities) {
        const current = old[entity.id] || toDraft(entity);
        if (current.output_file_id || current.clear_output || current.revision !== entity.revision) continue;
        if (current.description !== entity.description || current.three_view !== entity.three_view || current.input_file_id !== entity.input_file_id) continue;
        const result = catalogImages.find(image => image.entity_id === entity.id && image.entity_version_id === entity.version_id && !image.stale);
        if (!result) continue;
        if (next === old) next = { ...old };
        next[entity.id] = { ...current, output_file_id: result.file_id };
      }
      return next;
    });
  }, [catalogImages, entities, busy, pending, loaded]);

  const merged = [
    ...entities.map((e) => drafts[e.id] || toDraft(e)),
    ...Object.values(drafts).filter(
      (d) => !entities.some((e) => e.id === d.id),
    ),
  ];
  const rows = merged.filter((e) => e.kind === kind);
  const draft = rows.find((e) => e.id === selected[kind]) || rows[0];
  const changes = Object.values(drafts).filter((d) => {
    const e = entities.find((e) => e.id === d.id);
    return (
      d.clear_output ||
      !e ||
      fields.some((f) => (e[f] ?? null) !== (d[f] ?? null))
    );
  });
  function edit(value: Draft) {
    setDrafts((old) => ({ ...old, [value.id]: value }));
  }
  async function load() {
    const [list, stage] = await Promise.all([
      mediaRequest(`/api/v1/projects/${pid}/entities`, undefined, "GET"),
      mediaRequest(`/api/v1/projects/${pid}/stages/board`, undefined, "GET"),
    ]);
    if (!alive.current) return;
    setEntities(list);
    setBoard(stage.item);
    setLoaded(true);
    // Keep earlier per-kind drafts recoverable when upgrading the editor.
    const legacy =
      readDraft<Record<string, Partial<Draft>>>(`sf.${pid}.entities`) || {};
    const backups =
      readDraft<Partial<Draft>[]>(`sf.${pid}.entity-backups`) || [];
    if (!readDraft<boolean>(cacheKey + ".migrated")) {
      setDrafts((old) => {
        const next = { ...old };
        for (const value of [...Object.values(legacy), ...backups]) {
          if (!value.kind || !(value.name || value.description || value.voice))
            continue;
          const existing = list.find((e: Entity) => e.id === value.id);
          const id = value.id || crypto.randomUUID();
          if (!next[id])
            next[id] = {
              ...blank(value.kind),
              ...value,
              id,
              revision: value.revision ?? existing?.revision ?? 0,
            };
        }
        return next;
      });
      storeDraft(cacheKey + ".migrated", true);
    }
  }
  function open(next: Kind, button: HTMLButtonElement) {
    trigger.current = button;
    setKind(next);
    setEditorOpen(false);
    setError("");
    setNotice("");
    setBind(null);
    setRemove(false);
    setHistory(null);
    mediaRequest("/api/v1/settings/resources?kind=voice", undefined, "GET")
      .then(setVoiceAssets)
      .catch((e) => setError(e.message));
    dialog.current?.showModal();
    void load().catch((e) => setError(e.message));
  }
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : "操作失败，草稿保留");
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function refreshParent() {
    try {
      await onChanged?.();
    } catch {
      if (alive.current)
        setNotice("已保存；工作台刷新失败，请重新读取页面，勿重复提交。");
    }
  }
  async function saveAll(): Promise<Entity[]> {
    if (!changes.length) return entities;
    if (changes.some((d) => !d.name.trim()))
      throw new Error("请填写所有新增或修改元素的名称，再保存。");
    const result: SaveResult = await mediaRequest(
      `/api/v1/projects/${pid}/entities/batch`,
      { base_board_version_id: board?.version_id || null, items: changes },
      "PUT",
      `entity-save.${pid}`,
    );
    if (!alive.current) return result.entities;
    setEntities(result.entities);
    setDrafts((old) => {
      const next = { ...old };
      for (const d of changes) delete next[d.id];
      return next;
    });
    setNotice(
      `已统一保存 ${changes.length} 个元素；${result.affected_shot_ids.length ? `${result.affected_shot_ids.length} 个镜头待更新；` : ""}历史版本保留。`,
    );
    await load();
    await refreshParent();
    return result.entities;
  }
  async function uploadInput(file: File, source = draft) {
    if (!source) return;
    const target = { ...source };
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > 20 * 1024 * 1024
    )
      throw new Error("请选择20MB以内PNG、JPG或WebP图片。");
    const form = new FormData();
    form.append("file", file);
    const response = await fetch(`/api/v1/projects/${pid}/files`, {
      method: "POST",
      body: form,
    });
    const value = await response.json();
    if (!response.ok)
      throw new Error(
        typeof value.detail === "string" ? value.detail : "图片上传失败",
      );
    if (alive.current) {
      edit({ ...target, input_file_id: value.id });
      setNotice("参考输入图已上传；保存后用于生成图片，不会当作生成结果。");
    }
  }
  async function uploadOutput(file: File, source = draft) {
    if (!source) return;
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > 20 * 1024 * 1024
    )
      throw new Error("请选择20MB以内PNG、JPG或WebP图片。");
    const saved = await saveAll();
    const entity = saved.find((e) => e.id === source.id);
    if (!entity) throw new Error("请先填写元素名称并保存。");
    const form = new FormData();
    form.append("file", file);
    const response = await fetch(`/api/v1/projects/${pid}/files`, {
      method: "POST",
      body: form,
    });
    const uploaded = await response.json();
    if (!response.ok)
      throw new Error(
        typeof uploaded.detail === "string" ? uploaded.detail : "图片上传失败",
      );
    await mediaRequest(`/api/v1/projects/${pid}/reference-images`, {
      entity_id: entity.id,
      entity_revision: entity.revision,
      file_id: uploaded.id,
    });
    if (alive.current) {
      edit({ ...toDraft(entity), output_file_id: uploaded.id });
      setNotice(
        "生成图片已上传并选中；保存修改后同步镜头，在图片管理中人工确认。",
      );
    }
  }

  async function submitImages(targets: string[] = []) {
    let request = pending;
    if (!request) {
      const saved = await saveAll();
      request = {
        items: targets.map((id) => {
          const e = saved.find((e) => e.id === id);
          if (!e) throw new Error("待生成元素已变化，请重新选择。");
          return {
            entity_id: e.id,
            entity_revision: e.revision,
            instruction: "",
          };
        }),
      };
      localStorage.setItem(pendingKey, JSON.stringify(request));
      setPending(request);
    }
    try {
      await mediaRequest(
        `/api/v1/projects/${pid}/entities/image-batches`,
        request,
        "POST",
        `entity-image-batch.${pid}`,
      );
    } catch (e) {
      if (
        (e as { status?: number }).status &&
        (e as { status: number }).status < 500
      ) {
        removeDraft(pendingKey);
        setPending(null);
      }
      throw e;
    }
    removeDraft(pendingKey);
    if (!alive.current) return;
    setPending(null);
    setNotice(
      `已提交 ${request.items.length} 个图片任务；结果须人工检查确认。`,
    );
    await refreshParent();
  }
  const selectedId = useRef(draft?.id);
  selectedId.current = draft?.id;
  const frozen = busy || !!pending;
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
        ref={dialog}
        onKeyDown={trapDialogFocus}
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
          <p className="muted">
            管理整部短片的{names[kind]}
            。按稳定ID关联镜头；修改后相关素材需重新确认。角色名称与音色同步已绑定该角色的台词；可在逐句配音设置中绑定。
          </p>
          {error && (
            <p role="alert" className="alert">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          <div className="entity-toolbar">
            <button
              disabled={frozen || !loaded}
              onClick={() => {
                const d = blank(kind);
                edit(d);
                setSelected((old) => ({ ...old, [kind]: d.id }));
                setBind(null);
                setHistory(null);
              }}
            >
              新增{names[kind]}
            </button>
            <button
              disabled={frozen || !rows.length || !loaded}
              onClick={() =>
                void run(() => submitImages(rows.map((e) => e.id)))
              }
            >
              批量生成{names[kind]}图片
            </button>
            <span>
              {rows.length} 个{names[kind]}
            </span>
            <button disabled={frozen} onClick={() => void run(load)}>
              读取最新数据（保留草稿）
            </button>
          </div>
          {pending && (
            <section className="entity-action-panel" aria-label="图片提交恢复">
              <p>提交结果待核实；恢复沿用原请求，不新增第二批任务。</p>
              <button
                disabled={busy}
                onClick={() => void run(() => submitImages())}
              >
                核实并重试原提交
              </button>
            </section>
          )}
          <details
            open={showLibrary}
            onToggle={(e) => setShowLibrary(e.currentTarget.open)}
          >
            <summary>从资产库加入</summary>
            {showLibrary && (
              <EntityLibrary
                key={pid + kind}
                pid={pid}
                kind={kind}
                onAdopted={async () => {
                  await load();
                  await refreshParent();
                }}
              />
            )}
          </details>
          <div className="entity-workspace">
            <div className="entity-table-scroll">
              <table className="entity-catalog-table">
                <thead>
                  <tr>
                    {[
                      "序号",
                      names[kind] + "名",
                      "描述",
                      "音色",
                      "参考图",
                      "图片",
                      "操作",
                    ].map((t) => (
                      <th key={t}>{t}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => {
                    const e = row;
                    const displayFile =
                      e.output_file_id ||
                      (!e.clear_output
                        ? catalogImages.find(
                            (r) =>
                              r.entity_id === row.id &&
                              r.entity_version_id ===
                                entities.find((x) => x.id === e.id)
                                  ?.version_id &&
                              !r.stale,
                          )?.file_id
                        : null) ||
                      null;
                    const generating = catalogTasks.some(
                      (t) =>
                        t.target_id === e.id &&
                        [
                          "queued",
                          "running",
                          "waiting_provider",
                          "waiting_dependency",
                        ].includes(t.state),
                    );
                    return (
                      <tr key={e.id} data-entity-id={e.id}>
                        <td>
                          {index + 1}
                          {changes.some((d) => d.id === e.id) && (
                            <small>未保存</small>
                          )}
                        </td>
                        <td>
                          {entities.some(
                            (saved) =>
                              saved.id === e.id &&
                              saved.revision !== e.revision,
                          ) && (
                            <button
                              className="danger"
                              onClick={() => {
                                setSelected((old) => ({
                                  ...old,
                                  [kind]: e.id,
                                }));
                                setEditorOpen(true);
                              }}
                            >
                              版本冲突：比较版本
                            </button>
                          )}
                          <input
                            aria-label="元素名称"
                            value={e.name}
                            disabled={frozen}
                            maxLength={100}
                            onChange={(ev) =>
                              edit({ ...e, name: ev.target.value })
                            }
                          />
                        </td>
                        <td>
                          <textarea
                            aria-label="元素描述"
                            value={e.description}
                            disabled={frozen}
                            maxLength={10000}
                            onChange={(ev) =>
                              edit({ ...e, description: ev.target.value })
                            }
                          />
                        </td>
                        <td>
                          {kind === "character" ? (
                            <select
                              aria-label="角色音色"
                              value={e.voice}
                              disabled={frozen}
                              onChange={(ev) =>
                                edit({ ...e, voice: ev.target.value })
                              }
                            >
                              <option value="">选择音色</option>
                              {e.voice &&
                                !voiceAssets.some(
                                  (a) => a.content === e.voice,
                                ) && <option value={e.voice}>{e.voice}</option>}
                              {voiceAssets.map((a) => (
                                <option key={a.id} value={a.content}>
                                  {a.name}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span className="muted">不适用</span>
                          )}
                        </td>
                        <td>
                          {e.input_file_id ? (
                            <button className="catalog-image-button" aria-label={e.name + "参考图预览"} onClick={()=>setPreview({file:e.input_file_id!,title:e.name+"参考图"})}><img className="catalog-image" src={`/api/v1/projects/${pid}/files/${e.input_file_id}`} alt={e.name+"参考图"}/></button>
                          ) : (
                            <div className="catalog-empty">暂无图片</div>
                          )}
                          <div className="catalog-image-actions">
                            <label className="catalog-upload">
                              上传
                              <input
                                aria-label="上传参考图"
                                type="file"
                                accept="image/png,image/jpeg,image/webp"
                                disabled={frozen}
                                onChange={(ev) => {
                                  const f = ev.target.files?.[0];
                                  ev.target.value = "";
                                  if (f) void run(() => uploadInput(f, e));
                                }}
                              />
                            </label>
                            <button
                              disabled={frozen || !e.input_file_id}
                              onClick={() =>
                                edit({ ...e, input_file_id: null })
                              }
                            >
                              清除
                            </button>
                          </div>
                        </td>
                        <td>
                          <button
                            className="catalog-image-button"
                            aria-label={e.name + "图片预览"}
                            disabled={!displayFile}
                            onClick={() => displayFile && setPreview({file:displayFile,title:e.name+"图片"})}
                          >
                            {generating ? (
                              <span className="catalog-empty" role="status">
                                AI生成中...
                              </span>
                            ) : displayFile ? (
                              <img
                                className="catalog-image"
                                src={`/api/v1/projects/${pid}/files/${displayFile}`}
                                alt={e.name + "图片"}
                              />
                            ) : (
                              <span className="catalog-empty">暂无图片</span>
                            )}
                          </button>
                          <div className="catalog-image-actions">
                            <label className="catalog-upload">
                              上传
                              <input
                                aria-label="上传图片"
                                type="file"
                                accept="image/png,image/jpeg,image/webp"
                                disabled={frozen}
                                onChange={(ev) => {
                                  const f = ev.target.files?.[0];
                                  ev.target.value = "";
                                  if (f) void run(() => uploadOutput(f, e));
                                }}
                              />
                            </label>
                            <button
                              disabled={frozen || !displayFile}
                              onClick={() =>
                                edit({
                                  ...e,
                                  output_file_id: null,
                                  clear_output: true,
                                })
                              }
                            >
                              清除
                            </button>
                          </div>
                          {kind === "character" && (
                            <label className="catalog-check">
                              <input
                                type="checkbox"
                                checked={e.three_view}
                                disabled={frozen}
                                onChange={(ev) =>
                                  edit({ ...e, three_view: ev.target.checked })
                                }
                              />
                              三视图
                            </label>
                          )}
                        </td>
                        <td>
                          <div className="catalog-actions"><button aria-label={e.name+"图片详情"} onClick={()=>{setSelected(old=>({...old,[kind]:e.id}));setEditorOpen(true)}}>图片详情</button>
                            <button
                              disabled={frozen}
                              onClick={() =>
                                void run(() => submitImages([e.id]))
                              }
                            >
                              生图
                            </button>
                            <button
                              disabled={frozen}
                              className="danger"
                              onClick={() => {
                                setSelected((old) => ({
                                  ...old,
                                  [kind]: e.id,
                                }));
                                setRemove(true);
                                setEditorOpen(true);
                              }}
                            >
                              删除
                            </button>
                            <button
                              disabled={frozen || !e.revision}
                              onClick={() =>
                                void run(async () => {
                                  const saved = await saveAll();
                                  const current = saved.find(
                                    (x) => x.id === e.id,
                                  );
                                  await mediaRequest(
                                    `/api/v1/projects/${pid}/entities/${e.id}/library-snapshots`,
                                    {
                                      entity_revision:
                                        current?.revision || e.revision,
                                    },
                                    "POST",
                                    `entity-library.${pid}.${e.id}`,
                                  );
                                  setNotice("已添加到资产库，副本独立保存。");
                                })
                              }
                            >
                              添加到资产库
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {loaded && !rows.length && (
                <p>暂无{names[kind]}，生成分镜后自动解析，或手动新增。</p>
              )}
            </div>
            {editorOpen && (
              <button onClick={() => setEditorOpen(false)}>收起图片详情</button>
            )}
            {draft && editorOpen && (
              <div className="entity-selected-editor">
                {entities.some(
                  (e) => e.id === draft.id && e.revision !== draft.revision,
                ) && (
                  <section
                    className="entity-action-panel"
                    aria-label="版本冲突合并"
                  >
                    <h3>
                      已保存版本 v
                      {entities.find((e) => e.id === draft.id)?.revision}
                    </h3>
                    <p>
                      当前已保存名称：
                      {entities.find((e) => e.id === draft.id)?.name}
                    </p>
                    <p>
                      当前已保存描述：
                      {entities.find((e) => e.id === draft.id)?.description}
                    </p>
                    <p>草稿保留在下方，请核对后明确采用草稿内容。</p>
                    <button
                      disabled={frozen}
                      onClick={() => {
                        edit({
                          ...draft,
                          revision: entities.find((e) => e.id === draft.id)!
                            .revision,
                        });
                        setError("");
                        setNotice(
                          "已将当前草稿放到最新基准，保存修改后才正式生效。",
                        );
                      }}
                    >
                      将此草稿合并到最新版本
                    </button>
                  </section>
                )}
                <fieldset className="editor-fields" disabled={frozen}>
                  <label className="field">
                    名称
                    <input
                      aria-label="元素名称"
                      maxLength={100}
                      value={draft.name}
                      onChange={(e) => edit({ ...draft, name: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    {names[kind]}描述
                    <textarea
                      aria-label="元素描述"
                      maxLength={10000}
                      value={draft.description}
                      onChange={(e) =>
                        edit({ ...draft, description: e.target.value })
                      }
                    />
                  </label>
                  {kind === "character" && (
                    <div className="entity-voice-row">
                      <label className="field">
                        音色
                        <select
                          aria-label="角色音色"
                          value={draft.voice}
                          onChange={(e) => {
                            if (e.target.value !== "__custom")
                              edit({ ...draft, voice: e.target.value });
                            else {
                              setVoiceEditor(true);
                              setNotice(
                                "可在下方输入供应商音色ID；不会以演示音色代替真实音色。",
                              );
                            }
                          }}
                        >
                          <option value="">未设置</option>
                          {[
                            ...new Set(
                              merged
                                .filter((e) => e.kind === "character")
                                .map((e) => e.voice)
                                .filter(Boolean),
                            ),
                          ].map((v) => (
                            <option key={v} value={v}>
                              {merged.find(
                                (e) => e.kind === "character" && e.voice === v,
                              )?.name || "自定义"}{" "}
                              · {v}
                            </option>
                          ))}
                          <option value="__custom">自定义供应商音色</option>
                        </select>
                      </label>
                      {voiceEditor && (
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
                      )}
                      <label>
                        <input
                          type="checkbox"
                          checked={draft.three_view}
                          onChange={(e) =>
                            edit({ ...draft, three_view: e.target.checked })
                          }
                        />
                        三视图
                      </label>
                    </div>
                  )}
                </fieldset>
                <div className="entity-images-grid">
                  <section aria-label="参考输入图">
                    <h3>参考图</h3>
                    {draft.input_file_id ? (
                      <a
                        href={`/api/v1/projects/${pid}/files/${draft.input_file_id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <img
                          className="entity-preview"
                          src={`/api/v1/projects/${pid}/files/${draft.input_file_id}`}
                          alt={draft.name + "输入参考图"}
                        />
                      </a>
                    ) : (
                      <div className="entity-image-empty">未上传参考图</div>
                    )}
                    <label className="field">
                      上传参考图
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        disabled={frozen}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          e.target.value = "";
                          if (f) void run(() => uploadInput(f));
                        }}
                      />
                    </label>
                    {draft.input_file_id && (
                      <button
                        disabled={frozen}
                        onClick={() => edit({ ...draft, input_file_id: null })}
                      >
                        移除输入参考
                      </button>
                    )}
                  </section>
                  <section aria-label="当前生成图片">
                    <h3>生成图片</h3>
                    {draft.output_file_id ? (
                      <a
                        href={`/api/v1/projects/${pid}/files/${draft.output_file_id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <img
                          className="entity-preview"
                          src={`/api/v1/projects/${pid}/files/${draft.output_file_id}`}
                          alt={draft.name + "当前生成图"}
                        />
                      </a>
                    ) : (
                      <div className="entity-image-empty">尚未选择生成图片</div>
                    )}
                    <label className="field">
                      上传已有图片
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        disabled={frozen}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = "";
                          if (file) void run(() => uploadOutput(file));
                        }}
                      />
                    </label>
                  </section>
                </div>
                <div className="actions entity-operations">
                  <button
                    disabled={frozen || !loaded}
                    onClick={() => void run(() => submitImages([draft.id]))}
                  >
                    生成图片
                  </button>
                  <button
                    disabled={frozen || !draft.revision}
                    onClick={() =>
                      void run(async () => {
                        const saved = await saveAll();
                        const e = saved.find((e) => e.id === draft.id);
                        await mediaRequest(
                          `/api/v1/projects/${pid}/entities/${draft.id}/library-snapshots`,
                          { entity_revision: e?.revision || draft.revision },
                          "POST",
                          `entity-library.${pid}.${draft.id}`,
                        );
                        setNotice(
                          "已存入资产库，复用副本不会随项目修改而变化。",
                        );
                      })
                    }
                  >
                    存入资产库
                  </button>
                  <button
                    disabled={frozen || !draft.revision || !board}
                    onClick={() =>
                      setBind({
                        shot_id:
                          (board?.body as components["schemas"]["BoardBody"])
                            ?.shots[0]?.id || "",
                        mode: "add",
                      })
                    }
                  >
                    绑定镜头
                  </button>
                  <button
                    disabled={frozen}
                    className="danger"
                    onClick={() => setRemove(true)}
                  >
                    删除
                  </button>
                </div>
                {bind && (
                  <section
                    className="entity-action-panel"
                    aria-label="绑定镜头"
                  >
                    <h3>绑定镜头</h3>
                    <label className="field">
                      选择镜头
                      <select
                        value={bind.shot_id}
                        disabled={busy}
                        onChange={(e) =>
                          setBind({ ...bind, shot_id: e.target.value })
                        }
                      >
                        {(
                          board?.body as components["schemas"]["BoardBody"]
                        )?.shots.map((s, i) => (
                          <option key={s.id} value={s.id}>
                            镜头 {i + 1}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      绑定方式
                      <select
                        value={bind.mode}
                        disabled={busy}
                        onChange={(e) =>
                          setBind({
                            ...bind,
                            mode: e.target.value as "add" | "replace",
                          })
                        }
                      >
                        <option value="add">添加为参考元素</option>
                        <option value="replace">替换首个同类元素</option>
                      </select>
                    </label>
                    <p>
                      添加保留已有同类元素；替换保留首个同类引用ID，其他引用不变。
                    </p>
                    <button disabled={busy} onClick={() => setBind(null)}>
                      取消绑定
                    </button>
                    <button
                      disabled={busy || !bind.shot_id}
                      onClick={() =>
                        void run(async () => {
                          const saved = await saveAll();
                          const stage = await mediaRequest(
                            `/api/v1/projects/${pid}/stages/board`,
                            undefined,
                            "GET",
                          );
                          await mediaRequest(
                            `/api/v1/projects/${pid}/entities/${draft.id}/shot-bindings`,
                            {
                              entity_revision: saved.find(
                                (e) => e.id === draft.id,
                              )!.revision,
                              board_version_id: stage.item.version_id,
                              ...bind,
                            },
                            "POST",
                            `entity-bind.${pid}.${draft.id}`,
                          );
                          setBind(null);
                          await load();
                          await refreshParent();
                          setNotice(
                            "已绑定镜头；受影响素材待更新，原引用与历史版本保留。",
                          );
                        })
                      }
                    >
                      确认绑定
                    </button>
                  </section>
                )}
                {remove && (
                  <section
                    className="entity-action-panel"
                    aria-label="删除元素确认"
                  >
                    <p>
                      删除“{draft.name || "未命名元素"}
                      ”？已有引用会阻止删除，历史版本和文件保留。
                    </p>
                    <button disabled={busy} onClick={() => setRemove(false)}>
                      取消删除
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          if (draft.revision)
                            await mediaRequest(
                              `/api/v1/projects/${pid}/entities/${draft.id}?revision=${draft.revision}`,
                              undefined,
                              "DELETE",
                            );
                          setDrafts((old) => {
                            const next = { ...old };
                            delete next[draft.id];
                            return next;
                          });
                          setRemove(false);
                          await load();
                          await refreshParent();
                          setNotice("元素已移出管理列表；已有历史和文件保留。");
                        })
                      }
                    >
                      确认删除
                    </button>
                  </section>
                )}
                {draft.revision > 0 && (
                  <ReferenceImages
                    key={draft.id}
                    pid={pid}
                    entityId={draft.id}
                    entityRevision={draft.revision}
                    disabled={frozen || changes.some((d) => d.id === draft.id)}
                    managedGeneration
                    selectedOutput={draft.output_file_id}
                    onSelectOutput={(id) =>
                      edit({ ...draft, output_file_id: id, clear_output: false })
                    }
                  />
                )}
                {draft.revision > 0 && (
                  <details
                    onToggle={(e) => {
                      if (e.currentTarget.open)
                        void mediaRequest(
                          `/api/v1/projects/${pid}/entities/${draft.id}/versions`,
                          undefined,
                          "GET",
                        )
                          .then((rows) => {
                            if (
                              alive.current &&
                              selectedId.current === draft.id
                            )
                              setHistory(rows);
                          })
                          .catch((e) => setError(e.message));
                    }}
                  >
                    <summary>历史版本</summary>
                    {history?.map((e) => (
                      <p key={e.version_id}>
                        v{e.revision} · {e.name} · {e.description}
                      </p>
                    ))}
                  </details>
                )}
              </div>
            )}
          </div>
        </div>
        <footer className="settings-dialog-header">
          <small>关闭保留全部草稿；{changes.length} 个元素待保存。</small>
          <button
            className="primary"
            disabled={frozen || !loaded || !changes.length}
            onClick={() =>
              void run(async () => {
                await saveAll();
              })
            }
          >
            {busy ? "保存中…" : "保存修改"}
          </button>
        </footer>
        {preview && <ImagePreview src={`/api/v1/projects/${pid}/files/${preview.file}`} title={preview.title} onClose={()=>setPreview(null)} />}
      </dialog>
    </>
  );
}
