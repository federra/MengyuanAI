import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  api,
  unwrap,
  type Project,
  type MediaFile,
  type Job,
  type Settings,
} from "./api";
import "./style.css";
import {
  Configuration,
  ResourceLibrary,
  OutputSettings,
} from "./Configuration";
import { StoryWorkbench } from "./StoryWorkbench";

const modules = ["项目", "创作", "资产", "任务记录", "系统设置"];
const states: Record<string, string> = {
  queued: "排队中",
  running: "处理中",
  succeeded: "已完成",
  failed: "失败",
  unknown: "待核实",
};
function App() {
  const [module, setModule] = useState("项目");
  const [projects, setProjects] = useState<Project[]>([]);
  const [sort, setSort] = useState<"updated_desc" | "updated_asc" | "name">(
    "updated_desc",
  );
  const [filter, setFilter] = useState<"" | "in_progress" | "completed">("");
  const [statistics, setStatistics] = useState<Record<string, number>>({});
  const [newType, setNewType] = useState("");
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Project>();
  const [files, setFiles] = useState<MediaFile[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [settings, setSettings] = useState<Settings>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [ratio, setRatio] = useState<"9:16" | "16:9" | "1:1">("9:16");
  const [resolution, setResolution] = useState<"720P" | "1080P" | "4K">(
    "1080P",
  );
  const [projectStyle, setProjectStyle] = useState("");
  const [styleOptions, setStyleOptions] = useState<
    { id: string; name: string }[]
  >([]);
  const [name, setName] = useState("");
  const [editName, setEditName] = useState("");

  const [market, setMarket] = useState<"zh" | "en">("zh");
  const [typeId, setTypeId] = useState("");
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem("shortfilm.theme") || "light";
    } catch {
      return "light";
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("shortfilm.theme", theme);
    } catch {}
  }, [theme]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "服务连接失败，请重试");
    } finally {
      setBusy(false);
    }
  }
  async function refreshProjects(page = offset) {
    const data = unwrap(
      await api.GET("/api/v1/projects", {
        params: {
          query: { offset: page, limit: 20, sort, status: filter || undefined },
        },
      }),
    );
    setProjects(data.items);
    setTotal(data.total);
    setStatistics(
      unwrap(await api.GET("/api/v1/projects/statistics")) as Record<
        string,
        number
      >,
    );
  }
  useEffect(() => {
    void run(async () => {
      await refreshProjects(offset);
      setSettings(unwrap(await api.GET("/api/v1/settings")));
      const output = unwrap(
        await api.GET("/api/v1/settings/bindings/{scope}/{key}", {
          params: { path: { scope: "system", key: "output" } },
        }),
      );
      setRatio((output.value?.aspect_ratio || "9:16") as typeof ratio);
      setResolution((output.value?.resolution || "1080P") as typeof resolution);
    });
  }, [offset, sort, filter]);
  useEffect(() => {
    if (!selected) {
      setFiles([]);
      setJobs([]);
      return;
    }
    const pid = selected.id;
    let active = true;
    const refresh = async () => {
      try {
        const [f, j] = await Promise.all([
          api.GET("/api/v1/projects/{pid}/files", {
            params: { path: { pid } },
          }),
          api.GET("/api/v1/projects/{pid}/jobs", { params: { path: { pid } } }),
        ]);
        if (active) {
          setFiles(unwrap(f));
          setJobs(unwrap(j));
        }
      } catch (e) {
        if (active)
          setError(e instanceof Error ? e.message : "无法载入项目数据");
      }
    };
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [selected?.id]);
  async function beginProject() {
    await run(async () => {
      const output = unwrap(
        await api.GET("/api/v1/settings/bindings/{scope}/{key}", {
          params: { path: { scope: "system", key: "output" } },
        }),
      );
      setRatio((output.value?.aspect_ratio || "9:16") as typeof ratio);
      setResolution((output.value?.resolution || "1080P") as typeof resolution);
      setProjectStyle(String(output.value?.style_resource_id || ""));
      setStyleOptions(
        unwrap(
          await api.GET("/api/v1/settings/resources", {
            params: { query: { kind: "style" } },
          }),
        ),
      );
      setCreating(true);
    });
  }
  async function openProject(p: Project) {
    await run(async () => {
      const fresh = unwrap(
        await api.GET("/api/v1/projects/{pid}", {
          params: { path: { pid: p.id } },
        }),
      );
      setSelected(fresh);
      setEditName(fresh.name);
      setFiles([]);
      setJobs([]);
      setModule("创作");
    });
  }
  return (
    <div className="app">
      <aside>
        <div className="brand">
          <span>▶</span> AI短片工坊
        </div>
        <nav aria-label="主导航">
          {modules.map((m, i) => (
            <button
              key={m}
              className={module === m ? "active" : ""}
              onClick={() => {
                setModule(m);
                setError("");
              }}
            >
              <span aria-hidden>{["▦", "✎", "▧", "◷", "⚙"][i]}</span>
              {m}
            </button>
          ))}
        </nav>
        <div className="local">
          <i /> 本地工作空间<small>故事创作 · M1</small>
        </div>
      </aside>
      <div className="workspace">
        <header>
          <span>
            {module}
            {selected && module !== "项目" ? ` / ${selected.name}` : ""}
          </span>
          <button onClick={() => setModule("系统设置")}>设置</button>
          <label>
            UI主题{" "}
            <select value={theme} onChange={(e) => setTheme(e.target.value)}>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
              <option value="sky">晴空蓝</option>
            </select>
          </label>
        </header>
        <main>
          <div className="heading">
            <div>
              <p className="eyebrow">AI SHORT FILM STUDIO</p>
              <h1>{module === "项目" ? "我的项目" : module}</h1>
              <p className="muted">
                {module === "项目"
                  ? "从一个想法开始，留存每一次创作。"
                  : "项目与文件已持久保存，可在下次打开时继续。"}
              </p>
            </div>
            {module === "项目" && (
              <button className="primary" onClick={() => void beginProject()}>
                ＋ 新建项目
              </button>
            )}
          </div>
          {error && (
            <div role="alert" className="alert">
              {error}{" "}
              <button onClick={() => void run(() => refreshProjects())}>
                重新连接
              </button>
            </div>
          )}
          {notice && (
            <div role="status" className="notice">
              {notice}
            </div>
          )}
          {module === "项目" && (
            <>
              <div className="summary">
                <span>
                  全部项目 <b>{statistics.total ?? total}</b> · 创作中{" "}
                  {statistics.in_progress ?? "—"} · 已完成{" "}
                  {statistics.completed ?? "—"} · 失败任务{" "}
                  {statistics.failed_jobs ?? "—"}
                </span>
                <span className="muted">
                  <select
                    aria-label="项目状态筛选"
                    value={filter}
                    onChange={(e) => {
                      setFilter(e.target.value as typeof filter);
                      setOffset(0);
                    }}
                  >
                    <option value="">全部状态</option>
                    <option value="in_progress">创作中</option>
                    <option value="completed">已完成</option>
                  </select>
                  <select
                    aria-label="项目排序"
                    value={sort}
                    onChange={(e) => {
                      setSort(e.target.value as typeof sort);
                      setOffset(0);
                    }}
                  >
                    <option value="updated_desc">最近编辑优先</option>
                    <option value="updated_asc">最早编辑优先</option>
                    <option value="name">项目名称</option>
                  </select>
                </span>
              </div>
              {!projects.length ? (
                <section className="empty">
                  <span>▦</span>
                  <h2>创建你的第一部短片</h2>
                  <p>先为项目命名，再逐步丰富故事与画面。</p>
                  <button onClick={() => void beginProject()}>新建项目</button>
                </section>
              ) : (
                <div className="cards">
                  {projects.map((p) => (
                    <article key={p.id}>
                      <div className="cover">
                        <span>▶</span>
                        <small>尚未设置封面</small>
                      </div>
                      <div className="card-body">
                        <div className="row">
                          <h2>{p.name}</h2>
                          <span className="badge">
                            {p.status === "completed" ? "已完成" : "创作中"}
                          </span>
                        </div>
                        <p className="muted">
                          {settings?.project_types.find(
                            (t) => t.id === p.type_id,
                          )?.name || "未分类"}{" "}
                          · {p.market === "zh" ? "中文市场" : "英文市场"} ·{" "}
                          {(
                            {
                              idea: "创意",
                              story: "故事",
                              script: "剧本",
                              board: "分镜",
                            } as Record<string, string>
                          )[p.stage] || p.stage}
                          阶段
                        </p>
                        <div className="row">
                          <small>
                            更新于{" "}
                            {new Date(p.updated_at).toLocaleString("zh-CN", {
                              hour12: false,
                            })}
                          </small>
                          <button
                            disabled={busy}
                            onClick={() => void openProject(p)}
                          >
                            继续创作 →
                          </button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
              {total > 20 && (
                <div className="pagination">
                  <button
                    disabled={!offset}
                    onClick={() => setOffset(offset - 20)}
                  >
                    上一页
                  </button>
                  <span>
                    {offset + 1}–{Math.min(offset + 20, total)} / {total}
                  </span>
                  <button
                    disabled={offset + 20 >= total}
                    onClick={() => setOffset(offset + 20)}
                  >
                    下一页
                  </button>
                </div>
              )}
            </>
          )}
          {module === "创作" &&
            (selected ? (
              <>
                <details>
                  <summary>项目资料</summary>
                  <section className="panel">
                    <h2>项目资料</h2>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void run(async () => {
                          const p = unwrap(
                            await api.PATCH("/api/v1/projects/{pid}", {
                              params: { path: { pid: selected.id } },
                              body: {
                                name: editName,
                                revision: selected.revision,
                              },
                            }),
                          );
                          setSelected(p);
                          await refreshProjects();
                          setNotice("项目已保存");
                        });
                      }}
                    >
                      <label>
                        项目名称
                        <input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          required
                          maxLength={50}
                        />
                      </label>
                      <button className="primary" disabled={busy}>
                        保存修改
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const p = unwrap(
                              await api.GET("/api/v1/projects/{pid}", {
                                params: { path: { pid: selected.id } },
                              }),
                            );
                            setSelected(p);
                            setNotice(
                              `已读取版本 ${p.revision}，保留输入框中的草稿，可检查后再保存`,
                            );
                          })
                        }
                      >
                        读取最新版本
                      </button>
                    </form>
                  </section>
                </details>
                <details>
                  <summary>统一生成规格</summary>
                  <OutputSettings project={selected} onSaved={setSelected} />
                </details>
                <StoryWorkbench key={selected.id} pid={selected.id} />
              </>
            ) : (
              <EmptyProject />
            ))}
          {module === "资产" && <ResourceLibrary />}
          {module === "资产" &&
            (selected ? (
              <section className="panel">
                <div className="row">
                  <div>
                    <h2>项目图片</h2>
                    <p className="muted">PNG / JPEG / WebP · 最大 20 MB</p>
                  </div>
                  <label className="upload">
                    上传图片
                    <input
                      aria-label="上传图片"
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      disabled={busy}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        void run(async () => {
                          const form = new FormData();
                          form.append("file", file);
                          const response = await fetch(
                            `/api/v1/projects/${selected.id}/files`,
                            { method: "POST", body: form },
                          );
                          if (!response.ok) {
                            const b = await response.json();
                            throw new Error(b.detail);
                          }
                          const saved: MediaFile = await response.json();
                          setFiles((old) => [saved, ...old]);
                          setNotice("图片已保存");
                        });
                        e.target.value = "";
                      }}
                    />
                  </label>
                </div>
                {!files.length ? (
                  <p className="muted">还没有图片，上传后可进行完整性校验。</p>
                ) : (
                  <div className="media-grid">
                    {files.map((f) => (
                      <article key={f.id}>
                        <img
                          src={`/api/v1/projects/${selected.id}/files/${f.id}`}
                          alt={f.filename}
                        />
                        <div className="card-body">
                          <h3>{f.filename}</h3>
                          <p className="muted">
                            {(f.size / 1024).toFixed(1)} KB
                          </p>
                          <button
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                const j = unwrap(
                                  await api.POST(
                                    "/api/v1/projects/{pid}/jobs",
                                    {
                                      params: {
                                        path: { pid: selected.id },
                                        header: {
                                          "idempotency-key":
                                            crypto.randomUUID(),
                                        },
                                      },
                                      body: {
                                        kind: "file.verify",
                                        file_id: f.id,
                                      },
                                    },
                                  ),
                                );
                                setJobs((old) => [j, ...old]);
                                setNotice("校验任务已加入队列");
                              })
                            }
                          >
                            校验文件
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            ) : (
              <EmptyProject />
            ))}
          {module === "任务记录" &&
            (selected ? (
              <section className="panel">
                <h2>项目任务</h2>
                <p className="muted">文件与文本任务 · 自动刷新</p>
                {jobs.length ? (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>任务</th>
                          <th>状态</th>
                          <th>创建时间</th>
                          <th>追踪 ID</th>
                        </tr>
                      </thead>
                      <tbody>
                        {jobs.map((j) => (
                          <tr key={j.id}>
                            <td>
                              {j.kind === "file.verify"
                                ? "文件校验"
                                : j.kind === "story.generate"
                                  ? "生成故事"
                                  : "导演修改"}
                            </td>
                            <td>
                              <span className="badge">
                                {states[j.state] || j.state}
                              </span>
                              {j.error && <small>{j.error}</small>}
                            </td>
                            <td>
                              {new Date(j.created_at).toLocaleString("zh-CN")}
                            </td>
                            <td>
                              <code>{j.id}</code>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p>还没有任务，可在资产中校验已上传图片。</p>
                )}
              </section>
            ) : (
              <EmptyProject />
            ))}
          {module === "系统设置" && <Configuration project={selected} />}
        </main>
      </div>
      {creating && (
        <div className="overlay">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="dialog-title"
            className="dialog"
          >
            <h2 id="dialog-title">新建项目</h2>
            <p className="muted">画幅与分辨率将保存到项目，后续可统一修改。</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await api
                    .POST("/api/v1/projects", {
                      body: {
                        name,
                        market,
                        type_id: typeId || null,
                        aspect_ratio: ratio,
                        resolution,
                        style_resource_id: projectStyle || null,
                      },
                    })
                    .then(unwrap);
                  await refreshProjects(0);
                  setOffset(0);
                  setName("");
                  setCreating(false);
                });
              }}
            >
              <label>
                项目名称
                <input
                  autoFocus
                  required
                  maxLength={50}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="给这部短片起个名字"
                />
              </label>
              <label>
                类型
                <select
                  value={typeId}
                  onChange={(e) => setTypeId(e.target.value)}
                >
                  <option value="">未分类</option>
                  {settings?.project_types.map((t) => (
                    <option value={t.id} key={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                新增项目类型
                <input
                  value={newType}
                  onChange={(e) => setNewType(e.target.value)}
                />
              </label>
              <button
                type="button"
                disabled={busy || !newType.trim()}
                onClick={() =>
                  void run(async () => {
                    const t = unwrap(
                      await api.POST("/api/v1/projects/types", {
                        body: { name: newType },
                      }),
                    );
                    setSettings(unwrap(await api.GET("/api/v1/settings")));
                    setTypeId(t.id);
                    setNewType("");
                  })
                }
              >
                添加类型
              </button>
              <label>
                风格模板
                <select
                  value={projectStyle}
                  onChange={(e) => setProjectStyle(e.target.value)}
                >
                  <option value="">系统默认 / 不指定</option>
                  {styleOptions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                市场
                <select
                  value={market}
                  onChange={(e) => setMarket(e.target.value as "zh" | "en")}
                >
                  <option value="zh">中文</option>
                  <option value="en">英文</option>
                </select>
              </label>
              <label>
                画幅比例
                <select
                  value={ratio}
                  onChange={(e) => setRatio(e.target.value as typeof ratio)}
                >
                  {["9:16", "16:9", "1:1"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label>
                分辨率
                <select
                  value={resolution}
                  onChange={(e) =>
                    setResolution(e.target.value as typeof resolution)
                  }
                >
                  {["720P", "1080P", "4K"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              {error && (
                <p role="alert" className="alert">
                  {error}
                </p>
              )}
              <div className="actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setCreating(false)}
                >
                  取消
                </button>
                <button className="primary" disabled={busy || !name.trim()}>
                  创建项目
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
function EmptyProject() {
  return (
    <section className="empty">
      <h2>请先选择一个项目</h2>
      <p>在项目页点击“继续创作”后，可查看该项目的数据。</p>
    </section>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
