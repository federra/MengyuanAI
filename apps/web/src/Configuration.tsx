import { useEffect, useState } from "react";
import { api, unwrap, type Project } from "./api";
import type { components } from "./generated/api";
import { readDraft, storeDraft } from "./commands";
type Resource = components["schemas"]["ResourceOut"];
type Binding = components["schemas"]["BindingOut"];
const getBinding = async (scope: string, key: string) =>
  unwrap(
    await api.GET("/api/v1/settings/bindings/{scope}/{key}", {
      params: { path: { scope, key } },
    }),
  );
const putBinding = async (
  scope: string,
  key: string,
  base_version: number,
  value: Record<string, unknown> | null,
) =>
  unwrap(
    await api.PUT("/api/v1/settings/bindings/{scope}/{key}", {
      params: { path: { scope, key } },
      body: { base_version, value },
    }),
  );
// R4 P01–P29: configuration keys remain exact even for future generation steps.
const sceneCatalog = [
  {
    key: "novel",
    name: "故事生成",
    category: "text",
  },
  {
    key: "novelRevision",
    name: "故事修改",
    category: "text",
  },
  {
    key: "script",
    name: "剧本生成",
    category: "text",
  },
  {
    key: "scriptReview",
    name: "剧本质检",
    category: "text",
  },
  {
    key: "scriptRepair",
    name: "剧本修复",
    category: "text",
  },
  {
    key: "storyboard",
    name: "分镜生成",
    category: "text",
  },
  {
    key: "review",
    name: "分镜质检",
    category: "text",
  },
  {
    key: "boardRepair",
    name: "分镜修复",
    category: "text",
  },
  {
    key: "dialogue",
    name: "台词生成/优化",
    category: "text",
  },
  {
    key: "assetExtract",
    name: "提取资产",
    category: "text",
  },
  {
    key: "characterImage",
    name: "角色参考图",
    category: "image",
  },
  {
    key: "sceneImage",
    name: "场景参考图",
    category: "image",
  },
  {
    key: "propImage",
    name: "道具参考图",
    category: "image",
  },
  {
    key: "clothingImage",
    name: "服饰参考图",
    category: "image",
  },
  {
    key: "blockingImage",
    name: "站位图",
    category: "image",
  },
  {
    key: "shotPrompt",
    name: "镜头提示词生成/优化",
    category: "text",
  },
  {
    key: "video",
    name: "视频生成",
    category: "video",
  },
  {
    key: "voice",
    name: "TTS生成",
    category: "audio",
  },
  {
    key: "music",
    name: "配乐生成",
    category: "audio",
  },
  {
    key: "style",
    name: "风格推荐",
    category: "text",
  },
  {
    key: "template",
    name: "风格模板建立/完善",
    category: "text",
  },
  {
    key: "assetRecommend",
    name: "资产匹配推荐",
    category: "text",
  },
  {
    key: "voicePreset",
    name: "声音设定辅助",
    category: "text",
  },
  {
    key: "subtitle",
    name: "字幕语言润色（可选）",
    category: "text",
  },
  {
    key: "ideaRefine",
    name: "创意助手",
    category: "text",
  },
  {
    key: "storyExtract",
    name: "TXT选题提炼",
    category: "text",
  },
  {
    key: "scriptRefine",
    name: "剧本助手",
    category: "text",
  },
  {
    key: "boardRefine",
    name: "分镜助手",
    category: "text",
  },
  {
    key: "storyReview",
    name: "故事质检",
    category: "text",
  },
];
const scenes = sceneCatalog.map((s) => [s.key, s.name]);
const categories = [
  { id: "text", name: "生文" },
  { id: "image", name: "生图" },
  { id: "video", name: "生视频" },
  { id: "audio", name: "生音频" },
].map((c) => ({
  ...c,
  steps: sceneCatalog
    .filter((s) => s.category === c.id)
    .map((s) => [s.key, s.name]),
}));
const methodSaves = new Map<Promise<unknown>, string>();
const methodFailures = new Map<string, string>();
export async function awaitMethodSaves(pid: string, stage: string) {
  const scope = pid + ":" + stage;
  await Promise.all(
    [...methodSaves.entries()]
      .filter(([, key]) => key === scope)
      .map(([promise]) => promise),
  );
  const failure = methodFailures.get(scope);
  if (failure)
    throw new Error(
      "方法配置尚未保存，请在方法菜单读取最新基准并重试：" + failure,
    );
}
export function MethodSelector({ pid, stage }: { pid: string; stage: string }) {
  const [effectiveResource, setEffectiveResource] = useState<Resource | null>(
    null,
  );
  const [choice, setChoice] = useState<string | null>(null);
  const [resources, setResources] = useState<Resource[]>([]),
    [binding, setBinding] = useState<Binding>({ revision: 0, value: null }),
    [effective, setEffective] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [open, setOpen] = useState(false);
  async function load() {
    const [r, b, system] = await Promise.all([
      api.GET("/api/v1/settings/resources", { params: { query: { stage } } }),
      getBinding("project:" + pid, "method:" + stage),
      getBinding("system", "method:" + stage),
    ]);
    setResources(unwrap(r));
    setBinding(b);
    const resolved = b.value || system.value;
    const id = String(resolved?.resource_id || "");
    setEffective(id);
    if (id) {
      const r = unwrap(
        await api.GET("/api/v1/settings/resources/{rid}", {
          params: {
            path: { rid: id },
            query: {
              revision:
                typeof resolved?.revision === "number"
                  ? resolved.revision
                  : undefined,
            },
          },
        }),
      );
      setEffectiveResource({
        ...r,
        content:
          typeof resolved?.content === "string" ? resolved.content : r.content,
      });
    } else setEffectiveResource(null);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [pid, stage]);
  const selected =
    effectiveResource || resources.find((r) => r.id === effective);
  return (
    <div className="method-actions">
      <label className="field">
        {stage === "story"
          ? "故事方法"
          : stage === "script"
            ? "剧本方法"
            : "分镜方法"}
        <select
          aria-label={`${stage}方法`}
          disabled={busy}
          value={choice ?? effective}
          onFocus={() => void load().catch((e) => setError(e.message))}
          onChange={(e) => {
            const value = e.target.value;
            setChoice(value);
            setBusy(true);
            const save = putBinding(
              "project:" + pid,
              "method:" + stage,
              binding.revision,
              value ? { resource_id: value } : null,
            ).then(() => {
              setChoice(null);
              setError("");
              methodFailures.delete(pid + ":" + stage);
              return load();
            });
            methodSaves.set(save, pid + ":" + stage);
            void save
              .catch((e) => {
                setError(e.message);
                methodFailures.set(pid + ":" + stage, e.message);
              })
              .finally(() => {
                methodSaves.delete(save);
                setBusy(false);
              });
          }}
        >
          <option value="">沿用系统方法</option>
          {resources
            .filter((r) => r.kind === "skill" || r.kind === "prompt")
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
        </select>
      </label>
      <button onClick={() => setOpen(!open)}>查看 / 配置方法资源</button>
      {open && (
        <div>
          <p>
            {selected?.name || "沿用系统配置"}{" "}
            {selected && ` · v${selected.revision} · ${selected.kind}`}
          </p>
          <p className="preserve-text">
            {selected?.content ||
              "在资产资源库新增或编辑具名方法；修改后重新打开下拉菜单即可刷新。"}
          </p>
          <ResourceLibrary initialStage={stage} />
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {choice !== null && !busy && (
        <button
          onClick={() => {
            setBusy(true);
            const save = getBinding("project:" + pid, "method:" + stage)
              .then((b) =>
                putBinding(
                  "project:" + pid,
                  "method:" + stage,
                  b.revision,
                  choice ? { resource_id: choice } : null,
                ),
              )
              .then(() => {
                methodFailures.delete(pid + ":" + stage);
                setChoice(null);
                setError("");
                return load();
              });
            methodSaves.set(save, pid + ":" + stage);
            void save
              .catch((e) => setError(e.message))
              .finally(() => {
                methodSaves.delete(save);
                setBusy(false);
              });
          }}
        >
          读取最新方法基准并重试
        </button>
      )}
    </div>
  );
}
export function ResourceLibrary({
  initialKind,
  initialStage = "",
}: {
  initialKind?: Resource["kind"];
  initialStage?: string;
}) {
  const [kind, setKind] = useState<Resource["kind"]>(initialKind || "skill"),
    [stage, setStage] = useState(initialStage),
    [search, setSearch] = useState(""),
    [resources, setResources] = useState<Resource[]>([]),
    [current, setCurrent] = useState<Resource | null>(null),
    [name, setName] = useState(""),
    [content, setContent] = useState(""),
    [resourceStage, setResourceStage] = useState(initialStage || "story"),
    [variables, setVariables] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function load() {
    setResources(
      unwrap(
        await api.GET("/api/v1/settings/resources", {
          params: { query: { kind, stage: stage || undefined, search } },
        }),
      ),
    );
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [kind, stage, search]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "请求失败，草稿保留");
    } finally {
      setBusy(false);
    }
  }
  function select(r: Resource | null) {
    if (
      (content !== (current?.content || "") ||
        name !== (current?.name || "")) &&
      !window.confirm("当前资源有未保存草稿，是否放弃并切换？")
    )
      return;
    setCurrent(r);
    setName(r?.name || "");
    setContent(r?.content || "");
    setVariables(r?.required_variables?.join(",") || "");
    setResourceStage(r?.stage || stage || "story");
  }
  return (
    <section className="panel resource-library">
      <h2>共享资源库</h2>
      <p className="muted">与系统设置共用资源版本 · Skill 导入仅保存指令文本</p>
      <div className="row">
        <label>
          资源类型
          <select
            aria-label="资源类型"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as Resource["kind"]);
              setCurrent(null);
              setName("");
              setContent("");
            }}
          >
            <option value="skill">Skill库</option>
            <option value="prompt">提示词库</option>
            <option value="style">风格模板</option>
          </select>
        </label>
        <label>
          环节筛选
          <select value={stage} onChange={(e) => setStage(e.target.value)}>
            <option value="">全部</option>
            {["story", "script", "storyboard", "global"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <input
          aria-label="搜索资源"
          placeholder="搜索名称或正文"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="config-layout">
        <div className="resource-nav">
          <button onClick={() => select(null)}>＋ 新增资源</button>
          {resources.map((r) => (
            <button key={r.id} onClick={() => select(r)}>
              {r.name} · v{r.revision}
            </button>
          ))}
        </div>
        <div>
          <fieldset disabled={busy} className="editor-fields">
            <label className="field">
              资源名称
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              适用环节
              <input
                disabled={!!current}
                value={resourceStage}
                onChange={(e) => setResourceStage(e.target.value)}
              />
            </label>
            <label className="field">
              资源正文
              <textarea
                aria-label="资源正文"
                rows={10}
                value={content}
                onChange={(e) => setContent(e.target.value)}
              />
            </label>
            <label className="field">
              必填变量（逗号分隔）
              <input
                value={variables}
                onChange={(e) => setVariables(e.target.value)}
              />
            </label>
            <button
              disabled={!name.trim() || !content.trim()}
              onClick={() =>
                void run(async () => {
                  const body = {
                    name,
                    content,
                    required_variables: variables
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  };
                  const r = current
                    ? unwrap(
                        await api.PUT("/api/v1/settings/resources/{rid}", {
                          params: { path: { rid: current.id } },
                          body: { ...body, base_version: current.revision },
                        }),
                      )
                    : unwrap(
                        await api.POST("/api/v1/settings/resources", {
                          body: { ...body, kind, stage: resourceStage },
                        }),
                      );
                  setCurrent(r);
                  setNotice("资源已保存；设置与方法菜单使用同一版本。");
                })
              }
            >
              保存资源
            </button>
            <button
              onClick={() =>
                void run(async () => {
                  if (current) {
                    const r = unwrap(
                      await api.GET("/api/v1/settings/resources/{rid}", {
                        params: { path: { rid: current.id } },
                      }),
                    );
                    setCurrent(r);
                    setNotice("已读取最新保存基准，正文草稿保留，请合并。");
                  }
                })
              }
            >
              读取最新资源基准
            </button>
            {kind === "skill" && (
              <label className="field">
                导入 MD / TXT（128KB，UTF-8）
                <input
                  type="file"
                  accept=".md,.txt"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    void run(async () => {
                      const form = new FormData();
                      form.append("file", file);
                      form.append("name", name || file.name);
                      form.append("stage", resourceStage);
                      const response = await fetch(
                        "/api/v1/settings/resources/import",
                        { method: "POST", body: form },
                      );
                      const data = await response.json();
                      if (!response.ok) throw new Error(data.detail);
                      const r = data as Resource;
                      setCurrent(r);
                      setName(r.name);
                      setContent(r.content);
                      setNotice("已导入 Skill 文本。");
                    });
                    e.target.value = "";
                  }}
                />
              </label>
            )}
          </fieldset>
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
export function Configuration({ project }: { project?: Project }) {
  const [tab, setTab] = useState("模型");
  return (
    <>
      <div className="config-tabs" role="tablist">
        {["模型", "提示词", "风格模板"].map((t) => (
          <button
            role="tab"
            aria-selected={tab === t}
            key={t}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "模型" ? (
        <ModelSettings />
      ) : tab === "提示词" ? (
        <PromptSettings pid={project?.id} />
      ) : (
        <ResourceLibrary initialKind="style" />
      )}
      <OutputSettings />
      <p className="muted">
        凭据仅在服务端管理。保存配置不代表供应商连接或生成验收通过。
      </p>
    </>
  );
}
function ModelSettings() {
  const [expanded, setExpanded] = useState(["text"]),
    [node, setNode] = useState("model:category:text"),
    [category, setCategory] = useState("text"),
    [drafts, setDrafts] = useState<
      Record<
        string,
        { revision: number; value: Record<string, unknown>; inherit: boolean }
      >
    >(() => readDraft("sf.model-drafts") || {}),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [effective, setEffective] = useState<Record<string, unknown> | null>(null);
  const draft = drafts[node];
  useEffect(() => storeDraft("sf.model-drafts", drafts), [drafts]);
  useEffect(() => {
    let live = true;
    setNotice("");
    void Promise.all([
      getBinding("system", node),
      getBinding("system", "model:category:" + category),
    ])
      .then(([b, parent]) => {
        if (!live) return;
        setEffective(parent.value);
        setDrafts((d) =>
          d[node]
            ? d
            : {
                ...d,
                [node]: {
                  revision: b.revision,
                  value: b.value || {
                    provider: "",
                    model: "",
                    endpoint: "",
                    credential_ref: "",
                    timeout_seconds: 120,
                  },
                  inherit: !b.value,
                },
              },
        );
      })
      .catch((e) => setError(e.message));
    return () => {
      live = false;
    };
  }, [node, category]);
  function change(key: string, value: unknown) {
    setDrafts((d) => ({
      ...d,
      [node]: { ...d[node], value: { ...d[node].value, [key]: value } },
    }));
  }
  return (
    <section className="panel">
      <h2>模型配置</h2>
      <div className="config-layout">
        <div className="model-tree" aria-label="模型类别">
          {categories.map((c) => (
            <div key={c.id}>
              <button
                aria-label={c.name}
                aria-expanded={expanded.includes(c.id)}
                aria-controls={"model-" + c.id}
                className={node === "model:category:" + c.id ? "selected" : ""}
                onClick={() => {
                  setCategory(c.id);
                  setNode("model:category:" + c.id);
                  setExpanded((v) =>
                    v.includes(c.id)
                      ? v.filter((x) => x !== c.id)
                      : [...v, c.id],
                  );
                }}
              >
                <span aria-hidden>{expanded.includes(c.id) ? "⌄" : ">"}</span>{" "}
                {c.name}
              </button>
              <div id={"model-" + c.id} hidden={!expanded.includes(c.id)}>
                {c.steps.map(([id, name]) => (
                  <button
                    key={id}
                    className={
                      "child " + (node === "model:step:" + id ? "selected" : "")
                    }
                    onClick={() => {
                      setCategory(c.id);
                      setNode("model:step:" + id);
                    }}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div>
          {draft && (
            <fieldset disabled={busy} className="editor-fields">
              <h3>
                {node.startsWith("model:category") ? "类别默认" : "环节配置"} ·{" "}
                {category}
              </h3>
              <p className="muted">
                {draft.inherit
                  ? node.includes(":step:")
                    ? `沿用类别默认：${String(effective?.model || "未配置")}`
                    : "未配置"
                  : "已配置草稿 / 未验证"}{" "}
                · 保存基准 v{draft.revision}
              </p>
              {node.includes(":step:") && (
                <label>
                  <input
                    type="checkbox"
                    checked={draft.inherit}
                    onChange={(e) =>
                      setDrafts((d) => ({
                        ...d,
                        [node]: { ...draft, inherit: e.target.checked },
                      }))
                    }
                  />
                  沿用类别默认模型
                </label>
              )}
              {[
                "provider",
                "model",
                "endpoint",
                "credential_ref",
                "timeout_seconds",
              ].map((f) => (
                <label className="field" key={f}>
                  {
                    (
                      {
                        provider: "供应商",
                        model: "模型名称",
                        endpoint: "服务地址",
                        credential_ref: "凭据引用",
                        timeout_seconds: "超时秒数",
                      } as Record<string, string>
                    )[f]
                  }
                  <input
                    disabled={node.includes(":step:") && draft.inherit}
                    type={f === "timeout_seconds" ? "number" : "text"}
                    value={String(draft.value[f] ?? "")}
                    onChange={(e) => {
                      change(
                        f,
                        f === "timeout_seconds"
                          ? Number(e.target.value)
                          : e.target.value,
                      );
                      if (!node.includes(":step:"))
                        setDrafts((d) => ({
                          ...d,
                          [node]: { ...d[node], inherit: false },
                        }));
                    }}
                  />
                </label>
              ))}
              <p>能力类型：{category}（由类别固定）</p>
              <button
                onClick={() => {
                  setBusy(true);
                  setError("");
                  void putBinding(
                    "system",
                    node,
                    draft.revision,
                    draft.inherit
                      ? null
                      : { ...draft.value, capability: category },
                  )
                    .then((b) => {
                      setDrafts((d) => ({
                        ...d,
                        [node]: { ...draft, revision: b.revision },
                      }));
                      setNotice("模型配置已保存，连接尚未验证。");
                    })
                    .catch((e) => setError(e.message))
                    .finally(() => setBusy(false));
                }}
              >
                保存模型配置
              </button>
              <button
                onClick={() =>
                  void getBinding("system", node)
                    .then((b) => {
                      setDrafts((d) => ({
                        ...d,
                        [node]: { ...draft, revision: b.revision },
                      }));
                      setNotice("最新基准已读取，草稿保留，请核对后保存。");
                    })
                    .catch((e) => setError(e.message))
                }
              >
                读取最新配置基准
              </button>
            </fieldset>
          )}
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
        </div>
      </div>
    </section>
  );
}
function PromptSettings({ pid }: { pid?: string }) {
  const [loaded, setLoaded] = useState(false);
  const [scenario, setScenario] = useState("novel"),
    [scope, setScope] = useState("system"),
    [resources, setResources] = useState<Resource[]>([]),
    [binding, setBinding] = useState<Binding>({ revision: 0, value: null }),
    [rid, setRid] = useState(""),
    [content, setContent] = useState(""),
    [saved, setSaved] = useState(""),
    [variables, setVariables] = useState<Record<string, string>>({}),
    [preview, setPreview] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const resource = resources.find((r) => r.id === rid);
  const dirty = content !== saved;
  useEffect(() => {
    let live = true;
    setLoaded(false);
    void Promise.all([
      api.GET("/api/v1/settings/resources", {
        params: { query: { kind: "prompt" } },
      }),
      getBinding(scope, "scenario:" + scenario),
      getBinding("system", "scenario:" + scenario),
    ])
      .then(([result, b, system]) => {
        if (!live) return;
        const list = unwrap(result);
        setResources(list);
        setBinding(b);
        const value = b.value || system.value;
        const id = String(value?.resource_id || "");
        setRid(id);
        const text = String(
          value?.content ?? list.find((r) => r.id === id)?.content ?? "",
        );
        setContent(text);
        setSaved(text);
        setPreview("");
        setVariables({});
        setLoaded(true);
      })
      .catch((e) => setError(e.message));
    return () => {
      live = false;
    };
  }, [scope, scenario]);
  async function save() {
    setBusy(true);
    setError("");
    try {
      if (!resource) throw new Error("请选择具名模板");
      unwrap(
        await api.POST("/api/v1/settings/preview", {
          body: {
            content,
            variables: Object.fromEntries(
              (resource.required_variables || []).map((k) => [
                k,
                variables[k] || `示例 ${k}`,
              ]),
            ),
            required_variables: resource.required_variables,
          },
        }),
      );
      setBinding(
        await putBinding(scope, "scenario:" + scenario, binding.revision, {
          resource_id: rid,
          content,
        }),
      );
      setSaved(content);
      setNotice("场景绑定已保存；资源正文请在共享资源库编辑。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>提示词场景配置</h2>
      <label>
        配置范围
        <select
          value={scope}
          disabled={busy}
          onChange={(e) => {
            if (dirty) {
              setError("当前场景有未保存草稿，请先保存再切换。");
              return;
            }
            setScope(e.target.value);
          }}
        >
          <option value="system">系统默认</option>
          {pid && <option value={"project:" + pid}>当前项目覆盖</option>}
        </select>
      </label>
      <div className="config-layout">
        <div className="resource-nav">
          {scenes.map(([id, name]) => (
            <button
              key={id}
              onClick={() => {
                if (dirty) {
                  setError("当前场景有未保存草稿，请先保存再切换。");
                  return;
                }
                setScenario(id);
              }}
            >
              {name}
            </button>
          ))}
        </div>
        <fieldset disabled={busy || !loaded} className="editor-fields">
          <label className="field">
            场景模板
            <select
              value={rid}
              onChange={(e) => {
                const r = resources.find((r) => r.id === e.target.value);
                setRid(e.target.value);
                setContent(r?.content || "");
              }}
            >
              <option value="">请选择模板</option>
              {resources.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            场景提示词正文
            <textarea
              rows={12}
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </label>
          <p>必填变量：{resource?.required_variables?.join("、") || "无"}</p>
          {resource?.required_variables?.map((v) => (
            <label key={v} className="field">
              {v}
              <input
                value={variables[v] || ""}
                onChange={(e) =>
                  setVariables({ ...variables, [v]: e.target.value })
                }
              />
            </label>
          ))}
          <button
            onClick={() =>
              void api
                .POST("/api/v1/settings/preview", {
                  body: {
                    content,
                    variables,
                    required_variables: resource?.required_variables,
                  },
                })
                .then(unwrap)
                .then((v) => setPreview(v.content))
                .catch((e) => setError(e.message))
            }
          >
            预览变量展开
          </button>
          <button onClick={() => void save()}>保存并用于此场景</button>
          {scope !== "system" && (
            <button
              onClick={() =>
                void putBinding(
                  scope,
                  "scenario:" + scenario,
                  binding.revision,
                  null,
                )
                  .then((b) => {
                    setBinding(b);
                    setNotice("已重置为系统继承");
                    setScope("system");
                  })
                  .catch((e) => setError(e.message))
              }
            >
              重置项目继承
            </button>
          )}
          {preview && <p className="preserve-text">{preview}</p>}
        </fieldset>
      </div>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <ResourceLibrary initialKind="prompt" />
    </section>
  );
}
export function OutputSettings({
  project,
  onSaved,
}: {
  project?: Project;
  onSaved?: (p: Project) => void;
}) {
  const [video, setVideo] = useState<
    components["schemas"]["ModelRoute"] | null
  >(null);
  const [outputLoaded, setOutputLoaded] = useState(false);
  const [binding, setBinding] = useState<Binding>({ revision: 0, value: null }),
    [ratio, setRatio] = useState("9:16"),
    [resolution, setResolution] = useState("1080P"),
    [style, setStyle] = useState(""),
    [styles, setStyles] = useState<Resource[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  useEffect(() => {
    void api
      .GET("/api/v1/settings/resources", {
        params: { query: { kind: "style" } },
      })
      .then(unwrap)
      .then(setStyles)
      .catch((e) => setError(e.message));
    void getBinding("system", "output")
      .then((b) => {
        setBinding(b);
        const value = project?.generation_settings || b.value;
        setRatio(String(value?.aspect_ratio || "9:16"));
        setResolution(String(value?.resolution || "1080P"));
        setStyle(String(value?.style_resource_id || ""));
        setVideo(
          (value?.video_model || null) as
            components["schemas"]["ModelRoute"] | null,
        );
        setOutputLoaded(true);
      })
      .catch((e) => setError(e.message));
  }, [project?.id]);
  return (
    <section className="panel">
      <h2>{project ? "项目统一生成规格" : "视频输出默认设置"}</h2>
      <p className="muted">
        {project
          ? "影响后续生成与导出，已有媒体将标记待检查。"
          : "仅初始化新项目，已有项目保留各自规格。"}
      </p>
      <fieldset disabled={busy || !outputLoaded} className="editor-fields">
        <label className="field">
          画幅比例
          <select value={ratio} onChange={(e) => setRatio(e.target.value)}>
            {["9:16", "16:9", "1:1"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <label className="field">
          分辨率
          <select
            value={resolution}
            onChange={(e) => setResolution(e.target.value)}
          >
            {["720P", "1080P", "4K"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <label className="field">
          成片风格模板
          <select value={style} onChange={(e) => setStyle(e.target.value)}>
            <option value="">不指定</option>
            {styles.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <details>
          <summary>视频模型与像素尺寸</summary>
          <p>
            输出尺寸：
            {(() => {
              const n =
                resolution === "720P" ? 720 : resolution === "4K" ? 2160 : 1080;
              return ratio === "1:1"
                ? `${n} × ${n}`
                : ratio === "16:9"
                  ? `${Math.floor((n * 16) / 9)} × ${n}`
                  : `${n} × ${Math.floor((n * 16) / 9)}`;
            })()}
          </p>
          <label>
            <input
              type="checkbox"
              checked={!!video}
              onChange={(e) =>
                setVideo(
                  e.target.checked
                    ? {
                        provider: "",
                        model: "",
                        endpoint: "",
                        capability: "video",
                        credential_ref: "",
                        timeout_seconds: 120,
                      }
                    : null,
                )
              }
            />
            为输出指定独立视频模型（否则沿用模型配置）
          </label>
          {video &&
            (
              [
                "provider",
                "model",
                "endpoint",
                "credential_ref",
                "timeout_seconds",
              ] as const
            ).map((k) => (
              <label className="field" key={k}>
                {
                  {
                    provider: "视频供应商",
                    model: "视频模型名称",
                    endpoint: "视频服务地址",
                    credential_ref: "视频凭据引用",
                    timeout_seconds: "视频超时秒数",
                  }[k]
                }
                <input
                  type={k === "timeout_seconds" ? "number" : "text"}
                  value={video[k]}
                  onChange={(e) =>
                    setVideo({
                      ...video,
                      [k]:
                        k === "timeout_seconds"
                          ? Number(e.target.value)
                          : e.target.value,
                    })
                  }
                />
              </label>
            ))}
        </details>
        <button
          onClick={() => {
            setBusy(true);
            setError("");
            const value = {
              aspect_ratio: ratio as "9:16" | "16:9" | "1:1",
              resolution: resolution as "720P" | "1080P" | "4K",
              style_resource_id: style || null,
              video_model: video,
            };
            void (
              project
                ? api
                    .PUT("/api/v1/projects/{pid}/specification", {
                      params: { path: { pid: project.id } },
                      body: {
                        ...value,
                        base_version: Number(
                          project.generation_settings?.revision || 0,
                        ),
                      },
                    })
                    .then(unwrap)
                    .then((p) => onSaved?.(p))
                : putBinding("system", "output", binding.revision, value).then(
                    setBinding,
                  )
            )
              .then(() => setNotice("规格已保存"))
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          保存输出规格
        </button>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
