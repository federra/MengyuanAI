import { useEffect, useState } from "react";
import { mediaRequest } from "./MediaWorkbench";
import { readDraft, storeDraft } from "./commands";
import { api, unwrap } from "./api";
import type { components } from "./generated/api";
type Reference = components["schemas"]["ReferenceOut"];

export function ReferenceImages({
  pid,
  entityId,
  entityRevision,
  disabled,
}: {
  pid: string;
  entityId: string;
  entityRevision: number;
  disabled: boolean;
}) {
  const [images, setImages] = useState<Reference[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [spec, setSpec] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [instruction, setInstruction] = useState(
    () => readDraft<string>(`sf.${pid}.image-instruction.${entityId}`) || "",
  );
  const [tasks, setTasks] = useState<components["schemas"]["MediaTaskOut"][]>(
    [],
  );
  const [notice, setNotice] = useState("");
  const [unknown, setUnknown] = useState<Record<string, boolean>>({});
  useEffect(
    () => storeDraft(`sf.${pid}.image-instruction.${entityId}`, instruction),
    [instruction, pid, entityId],
  );
  useEffect(() => {
    let live = true;
    async function poll() {
      const rows = await mediaRequest(
        `/api/v1/projects/${pid}/media/tasks`,
        undefined,
        "GET",
      );
      if (live) {
        setTasks(
          rows.filter(
            (t: components["schemas"]["MediaTaskOut"]) =>
              t.target_id === entityId,
          ),
        );
        await load();
        if (live) setLoaded(true);
      }
    }
    const timer = setInterval(
      () =>
        void poll().catch((e) => {
          if (live) setError(e.message);
        }),
      2500,
    );
    void poll().catch((e) => {
      if (live) setError(e.message);
    });
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [pid, entityId]);
  async function load() {
    const [refs, project] = await Promise.all([
      api.GET("/api/v1/projects/{pid}/reference-images", {
        params: { path: { pid } },
      }),
      api.GET("/api/v1/projects/{pid}", { params: { path: { pid } } }),
    ]);
    setImages(unwrap(refs).filter((i) => i.entity_id === entityId));
    const revision = unwrap(project).generation_settings?.revision;
    setSpec(typeof revision === "number" ? revision : null);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [pid, entityId, entityRevision]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败，请重试");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="entity-reference-panel"
      aria-label="元素参考图"
      aria-busy={!loaded}
    >
      <h3>参考图</h3>
      <label className="field">
        本次生成要求
        <textarea
          rows={2}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
        />
      </label>
      <button
        disabled={
          busy ||
          !loaded ||
          disabled ||
          tasks.some((t) =>
            ["queued", "running", "waiting_provider"].includes(t.state),
          )
        }
        onClick={() =>
          void run(async () => {
            await mediaRequest(
              `/api/v1/projects/${pid}/media/images`,
              {
                entity_id: entityId,
                entity_revision: entityRevision,
                instruction,
              },
              "POST",
              `image.${pid}.${entityId}`,
            );
            setNotice(
              "图像任务已提交；生成会消耗供应商用量，完成后须人工确认。",
            );
          })
        }
      >
        AI生成参考图
      </button>
      {notice && <p role="status">{notice}</p>}
      {tasks.map((t) => (
        <details key={t.id}>
          <summary>
            {(
              {
                queued: "排队中",
                running: "生成中",
                waiting_provider: "处理中",
                failed: "失败",
                unknown: "受理待核实",
                succeeded: "已保存",
                cancelled: "已取消",
              } as Record<string, string>
            )[t.state] || t.state}{" "}
            {t.stale ? " · 来源过期" : ""}
          </summary>
          <p>{t.error}</p>
          <pre className="preserve-text">
            {JSON.stringify(t.snapshot, null, 2)}
          </pre>
          {t.state === "unknown" && (
            <label>
              <input
                type="checkbox"
                checked={!!unknown[t.id]}
                onChange={(e) =>
                  setUnknown((old) => ({ ...old, [t.id]: e.target.checked }))
                }
              />
              已核实，接受可能重复计费
            </label>
          )}
          {["failed", "unknown"].includes(t.state) && (
            <button
              disabled={
                busy || t.stale || (t.state === "unknown" && !unknown[t.id])
              }
              onClick={() =>
                void run(async () => {
                  await mediaRequest(
                    `/api/v1/projects/${pid}/media/tasks/${t.id}/retry`,
                    { confirm_unknown: !!unknown[t.id] },
                    "POST",
                    `image-retry.${pid}.${t.id}`,
                  );
                  setUnknown((old) => ({ ...old, [t.id]: false }));
                })
              }
            >
              重试图像任务
            </button>
          )}
        </details>
      ))}
      {error && <p role="alert">{error}</p>}
      <label className="field">
        上传参考图
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          disabled={busy || disabled}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            void run(async () => {
              const form = new FormData();
              form.append("file", file);
              const response = await fetch(`/api/v1/projects/${pid}/files`, {
                method: "POST",
                body: form,
              });
              const result = await response.json();
              if (!response.ok)
                throw new Error(
                  typeof result.detail === "string"
                    ? result.detail
                    : "图片上传失败",
                );
              unwrap(
                await api.POST("/api/v1/projects/{pid}/reference-images", {
                  params: { path: { pid } },
                  body: {
                    entity_id: entityId,
                    entity_revision: entityRevision,
                    file_id: result.id,
                  },
                }),
              );
            });
          }}
        />
      </label>
      {disabled && (
        <p className="muted">请先保存元素草稿，再生成、上传或确认参考图。</p>
      )}
      {!loaded && <p role="status">读取参考图与任务状态…</p>}
      {loaded && !images.length && (
        <p className="muted">暂无已保存的参考图。</p>
      )}
      <div className="entity-reference-list">
        {images.map((image) => (
          <article key={image.id}>
            <a
              href={`/api/v1/projects/${pid}/files/${image.file_id}`}
              target="_blank"
              rel="noreferrer"
              aria-label={`预览${image.name}参考图`}
            >
              <img
                src={`/api/v1/projects/${pid}/files/${image.file_id}`}
                alt={image.name + "参考图"}
              />
            </a>
            <p>
              {image.stale
                ? "来源已更新，图片待更新"
                : image.confirmed
                  ? "已确认"
                  : "待人工确认"}
            </p>
            <button
              disabled={
                busy ||
                disabled ||
                image.stale ||
                image.confirmed ||
                spec === null
              }
              onClick={() =>
                void run(async () => {
                  if (spec === null) return;
                  unwrap(
                    await api.POST(
                      "/api/v1/projects/{pid}/reference-images/{image_id}/confirm",
                      {
                        params: { path: { pid, image_id: image.id } },
                        body: { specification_revision: spec },
                      },
                    ),
                  );
                })
              }
            >
              确认此参考图
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}
