import { trapDialogFocus } from "./dialogFocus";
import React, { useEffect, useRef, useState } from "react";
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
import "./v12-v13.css";
import "./compact-workspace.css";
import { NavigationIcon } from "./NavigationIcon";
import {
  Configuration,
  ResourceLibrary,
  OutputSettings,
} from "./Configuration";
import { StoryWorkbench, jobTitle } from "./StoryWorkbench";

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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem("shortfilm.sidebar-collapsed") === "true";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(
        "shortfilm.sidebar-collapsed",
        String(sidebarCollapsed),
      );
    } catch {}
  }, [sidebarCollapsed]);
  const projectOutputDialog = useRef<HTMLDialogElement>(null);
  const projectOutputTrigger = useRef<HTMLElement | null>(null);
  const [projectOutputMounted, setProjectOutputMounted] = useState(false);
  const [projectOutputOpen, setProjectOutputOpen] = useState(false);
  function openProjectOutput(trigger?: HTMLElement) {
    projectOutputTrigger.current =
      trigger || (document.activeElement as HTMLElement);
    setProjectOutputMounted(true);
    setProjectOutputOpen(true);
  }
  useEffect(() => {
    if (projectOutputOpen) projectOutputDialog.current?.showModal();
  }, [projectOutputOpen]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
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
  const projectNameInput = useRef<HTMLInputElement>(null);
  const projectDefaultsInitialized = useRef(false);
  const settingsDialog = useRef<HTMLDialogElement>(null);
  const settingsTrigger = useRef<HTMLElement | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsMounted, setSettingsMounted] = useState(false);
  const [settingsTab, setSettingsTab] = useState("模型");
  const [outputOpen, setOutputOpen] = useState(false);
  const [outputMounted, setOutputMounted] = useState(false);
  function openSettings(tab = settingsTab) {
    settingsTrigger.current = document.activeElement as HTMLElement;
    setSettingsMounted(true);
    setSettingsTab(tab);
    setOutputOpen(tab === "输出");
    if (tab === "输出") setOutputMounted(true);
    setSettingsOpen(true);
  }
  useEffect(() => {
    if (settingsOpen && !settingsDialog.current?.open)
      settingsDialog.current?.showModal();
  }, [settingsOpen]);
  function closeSettings() {
    settingsDialog.current?.close();
    setSettingsOpen(false);
    settingsTrigger.current?.focus();
  }
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
      const stored = localStorage.getItem("shortfilm.theme");
      return stored && ["light", "dark", "sky", "noir"].includes(stored)
        ? stored
        : "light";
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
  useEffect(() => {
    const syncTheme = (event: StorageEvent) => {
      if (
        event.key === "shortfilm.theme" &&
        event.newValue &&
        ["light", "dark", "sky", "noir"].includes(event.newValue)
      )
        setTheme(event.newValue);
    };
    window.addEventListener("storage", syncTheme);
    return () => window.removeEventListener("storage", syncTheme);
  }, []);
  useEffect(() => {
    void api
      .GET("/api/v1/settings/resources", {
        params: { query: { kind: "style" } },
      })
      .then(unwrap)
      .then(setStyleOptions)
      .catch(() => {});
  }, []);
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
    setProjectsLoaded(true);
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
      if (!projectDefaultsInitialized.current) {
        setRatio((output.value?.aspect_ratio || "9:16") as typeof ratio);
        setResolution(
          (output.value?.resolution || "1080P") as typeof resolution,
        );
        setProjectStyle(String(output.value?.style_resource_id || ""));
        projectDefaultsInitialized.current = true;
      }
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
      projectNameInput.current?.focus();
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
    <div className="app" data-sidebar-collapsed={sidebarCollapsed}>
      <header className="app-topbar">
        <div className="brand">
          <svg className="workshop-mark" viewBox="0 0 32 32" aria-hidden="true">
            <path
              d="M5 5a3 3 0 0 1 4.5-2.6l20 11a3 3 0 0 1 0 5.2l-20 11A3 3 0 0 1 5 27Z"
              fill="currentColor"
              opacity=".22"
            />
            <path
              d="M9 8a2 2 0 0 1 3-1.7l14 8a2 2 0 0 1 0 3.4l-14 8A2 2 0 0 1 9 24Z"
              fill="currentColor"
            />
            <path d="m13 12 8 4-8 4Z" fill="white" />
          </svg>
          <strong className="workshop-name">AI短片工坊</strong>
        </div>
        <div className="topbar-actions">
          <span className="muted">本地工作空间</span>
          <button onClick={() => openSettings()}>设置</button>
          <label className="theme-picker">
            <span className="theme-dot" aria-hidden="true" />
            UI主题
            <select
              aria-label="UI主题"
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
            >
              <option value="light">浅色</option>
              <option value="dark">深色</option>
              <option value="sky">晴空蓝</option>
              <option value="noir">曜夜鎏金</option>
            </select>
          </label>
        </div>
      </header>
      <aside className="app-sidebar" id="app-sidebar">
        <button
          className="sidebar-toggle"
          aria-controls="app-sidebar"
          aria-expanded={!sidebarCollapsed}
          aria-label={sidebarCollapsed ? "展开页面栏" : "收起页面栏"}
          title={sidebarCollapsed ? "展开页面栏" : "收起页面栏"}
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
        >
          {sidebarCollapsed ? "›" : "‹"}
        </button>
        <nav className="primary-navigation" aria-label="主导航">
          {modules.map((m, i) => (
            <button
              key={m}
              aria-label={m}
              title={m}
              className={module === m ? "active" : ""}
              onClick={() => {
                setModule(m);
                setError("");
              }}
            >
              <NavigationIcon index={i} />
              <span className="navigation-label">{m}</span>
            </button>
          ))}
        </nav>
        <div className="local">
          让每一个故事
          <br />
          成为可见的作品。<small>项目独立保存 · 本地工作空间</small>
        </div>
      </aside>
      <div className="workspace">
        <main>
          {module !== "创作" && (
            <div className="page-heading">
              <div>
                <h1>
                  {module === "项目"
                    ? "项目工作台"
                    : module === "资产"
                      ? "资产库"
                      : module}
                </h1>
                <p className="muted">
                  {
                    (
                      {
                        项目: "管理项目，延续灵感。每一次创作都有自己的工作空间。",
                        资产: "统一管理创作素材、Skill 与提示词，让好内容可以复用。",
                        任务记录: "追溯每次生成的输入、配置与结果。",
                        系统设置:
                          "管理模型路由、提示词与风格模板。配置变更只影响后续任务。",
                      } as Record<string, string>
                    )[module]
                  }
                </p>
              </div>
            </div>
          )}
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
              <div className="project-stats">
                {[
                  [
                    "项目总数",
                    projectsLoaded ? (statistics.total ?? total) : "—",
                  ],
                  ["创作中", statistics.in_progress ?? "—"],
                  ["已完成", statistics.completed ?? "—"],
                  ["失败任务", statistics.failed_jobs ?? "—"],
                ].map(([label, value]) => (
                  <div key={label}>
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>
              <div className="project-layout">
                <section className="panel project-create">
                  <div className="row">
                    <h2>创建项目</h2>
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => void beginProject()}
                    >
                      载入默认
                    </button>
                  </div>
                  <p className="muted">先确定作品方向，内容随后展开。</p>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run(async () => {
                        const created = await api
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
                        setSelected(created);
                        setEditName(created.name);
                        setFiles([]);
                        setJobs([]);
                        setModule("创作");
                        setOffset(0);
                        setName("");
                        await refreshProjects(0);
                      });
                    }}
                  >
                    <label>
                      项目名称
                      <input
                        ref={projectNameInput}
                        required
                        maxLength={50}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="给这部短片起个名字"
                      />
                    </label>
                    <div className="project-type-field">
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
                      <details>
                        <summary>添加项目类型</summary>
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
                              setSettings(
                                unwrap(await api.GET("/api/v1/settings")),
                              );
                              setTypeId(t.id);
                              setNewType("");
                            })
                          }
                        >
                          添加类型
                        </button>
                      </details>
                    </div>
                    <label>
                      市场
                      <select
                        value={market}
                        onChange={(e) =>
                          setMarket(e.target.value as "zh" | "en")
                        }
                      >
                        <option value="zh">中文</option>
                        <option value="en">英文</option>
                      </select>
                    </label>
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
                    <div className="project-spec-fields">
                      <label>
                        画幅比例
                        <select
                          value={ratio}
                          onChange={(e) =>
                            setRatio(e.target.value as typeof ratio)
                          }
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
                    </div>
                    {error && (
                      <p role="alert" className="alert">
                        {error}
                      </p>
                    )}
                    <div className="actions">
                      <button
                        className="primary"
                        disabled={busy || !name.trim()}
                      >
                        创建项目
                      </button>
                    </div>
                  </form>
                  <p className="muted">
                    立项规格将用于视频生成与导出，可在生成设置中统一修改。
                  </p>
                </section>
                <section className="panel project-library">
                  <div className="row">
                    <h2>项目记录</h2>
                    <span className="project-filters">
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
                  {!projectsLoaded ? (
                    <section className="empty" role="status">
                      <p>正在读取项目…</p>
                    </section>
                  ) : !projects.length ? (
                    <section className="empty">
                      <span>▦</span>
                      <h2>创建你的第一部短片</h2>
                      <p>先为项目命名，再逐步丰富故事与画面。</p>
                      <button onClick={() => void beginProject()}>
                        新建项目
                      </button>
                    </section>
                  ) : (
                    <div className="cards">
                      {projects.map((p) => (
                        <article key={p.id}>
                          <div className="cover">
                            <span>尚无短片封面</span>
                            <small>项目画面将在生成后留存</small>
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
                                  finishing: "导出",
                                } as Record<string, string>
                              )[p.stage] || p.stage}
                              阶段
                            </p>
                            <div className="row">
                              <small>
                                更新于{" "}
                                {new Date(p.updated_at).toLocaleString(
                                  "zh-CN",
                                  {
                                    hour12: false,
                                  },
                                )}
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
                </section>
              </div>
            </>
          )}
          {module === "创作" &&
            (selected ? (
              <>
                <StoryWorkbench
                  key={selected.id}
                  pid={selected.id}
                  projectName={selected.name}
                  projectMarket={selected.market}
                  onSwitchProject={() => setModule("项目")}
                  onGenerationSettings={openProjectOutput}
                />
                <div className="project-auxiliary">
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
                </div>
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
                            <td>{jobTitle(j.kind)}</td>
                            <td>
                              <span className="badge" data-state={j.state}>
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
          {module === "系统设置" && (
            <section className="settings-home">
              <div className="settings-cards">
                {[
                  [
                    "模型",
                    "大模型配置",
                    "生文、生图、生视频、生音频；类别默认与环节覆盖",
                  ],
                  [
                    "提示词",
                    "提示词中心",
                    "系统默认与项目覆盖，变量校验与预览",
                  ],
                  ["风格模板", "风格模板", "新增、编辑风格与模板生成指令"],
                  ["输出", "视频输出设置", "配置画幅、分辨率和视频默认值"],
                ].map(([tab, title, description]) => (
                  <button
                    key={tab}
                    className="panel settings-entry-card"
                    onClick={() => openSettings(tab)}
                  >
                    <h2>{title}</h2>
                    <p>{description}</p>
                    <span>配置 →</span>
                  </button>
                ))}
              </div>
              <section className="panel">
                <h2>创作配置说明</h2>
                <p>
                  模型、提示词和风格配置用于后续任务，历史任务保留原配置快照。
                </p>
                <p className="muted">
                  API
                  密钥通过模型配置加密保存在服务端；连接测试使用已保存的配置。
                </p>
              </section>
            </section>
          )}
        </main>
      </div>
      <dialog
        ref={projectOutputDialog}
        className="settings-dialog project-generation-dialog"
        aria-label="生成设置"
        onKeyDown={trapDialogFocus}
        onClose={() => {
          setProjectOutputOpen(false);
          projectOutputTrigger.current?.focus();
        }}
      >
        <header className="settings-dialog-header">
          <h2>生成设置</h2>
          <button
            aria-label="关闭生成设置"
            onClick={() => projectOutputDialog.current?.close()}
          >
            关闭
          </button>
        </header>
        <div className="settings-dialog-body">
          {projectOutputMounted && selected && (
            <OutputSettings
              key={selected.id}
              project={selected}
              onSaved={(p) =>
                setSelected((current) => (current?.id === p.id ? p : current))
              }
            />
          )}
        </div>
      </dialog>
      <dialog
        onKeyDown={trapDialogFocus}
        ref={settingsDialog}
        className="settings-dialog"
        aria-labelledby="settings-dialog-title"
        onCancel={(event) => {
          event.preventDefault();
          closeSettings();
        }}
        onClose={() => {
          setSettingsOpen(false);
          settingsTrigger.current?.focus();
        }}
      >
        <div className="settings-dialog-header">
          <div>
            <p className="muted">AI短片工坊 · 创作配置</p>
            <h2 id="settings-dialog-title">设置</h2>
          </div>
          <button onClick={closeSettings}>关闭</button>
        </div>
        <div className="settings-dialog-body">
          <div hidden={outputOpen}>
            {settingsMounted && (
              <Configuration
                project={selected}
                initialTab={settingsTab}
                onTabChange={setSettingsTab}
              />
            )}
          </div>
          <div hidden={!outputOpen}>{outputMounted && <OutputSettings />}</div>
        </div>
      </dialog>
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
