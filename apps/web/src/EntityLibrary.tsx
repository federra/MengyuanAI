import { useEffect, useRef, useState } from "react";
import { mediaRequest } from "./MediaWorkbench";
import { readDraft, removeDraft } from "./commands";
type Image = {
  id: string;
  filename: string;
  mime: string;
  sha256: string;
  url: string;
  size: number;
};
type LibraryAsset = {
  id: string;
  version: number;
  kind: "character" | "scene" | "prop";
  name: string;
  description: string;
  voice: string;
  three_view: boolean;
  input_image: Image | null;
  output_image: Image | null;
  created_at: string;
};
const labels = { character: "角色", scene: "场景", prop: "道具" };
export function EntityLibrary({
  pid,
  kind,
  onAdopted,
}: {
  pid?: string;
  kind?: LibraryAsset["kind"];
  onAdopted?: () => Promise<void>;
}) {
  const [rows, setRows] = useState<LibraryAsset[]>([]),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const alive = useRef(true),
    lock = useRef(false);
  useEffect(() => {
    alive.current = true;
    void mediaRequest("/api/v1/library/assets", undefined, "GET")
      .then((items) => {
        if (alive.current) {
          setRows(items);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (alive.current) setError(e.message);
      });
    return () => {
      alive.current = false;
    };
  }, []);
  async function adopt(a: LibraryAsset) {
    if (!pid || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const key = `sf.${pid}.library-adopt.${a.id}.${a.version}`;
    try {
      const body = readDraft<{ id: string; library_version: number }>(key) || {
        id: crypto.randomUUID(),
        library_version: a.version,
      };
      localStorage.setItem(key, JSON.stringify(body));
      await mediaRequest(
        `/api/v1/projects/${pid}/library-assets/${a.id}/adoptions`,
        body,
        "POST",
        `library-adopt.${pid}.${a.id}.${a.version}`,
      );
      removeDraft(key);
      if (alive.current) {
        setNotice(
          `已将“${a.name}”复制到当前项目；图片待确认，源资产后续变化不影响此副本。`,
        );
        try {
          await onAdopted?.();
        } catch {
          setNotice("已加入项目；列表刷新失败，请重新打开，勿重复加入。");
        }
      }
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : "加入项目失败");
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="entity-library" aria-label="元素资产库">
      <h3>元素资产库</h3>
      <p className="muted">
        显式存入的角色、场景与道具副本。加入项目会复制指定版本，保留各项目独立的数据与图片。
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!loaded && !error && <p>读取资产库…</p>}
      {loaded && !rows.filter((a) => !kind || a.kind === kind).length && (
        <p>暂无可复用元素，可在元素管理中存入资产库。</p>
      )}
      <div className="entity-library-grid">
        {rows
          .filter((a) => !kind || a.kind === kind)
          .map((a) => (
            <article key={a.id}>
              <h4>
                {a.name}{" "}
                <small>
                  {labels[a.kind]} · v{a.version}
                </small>
              </h4>
              {(a.output_image || a.input_image) && (
                <a
                  href={(a.output_image || a.input_image)!.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <img
                    className="entity-preview"
                    src={(a.output_image || a.input_image)!.url}
                    alt={a.name}
                  />
                </a>
              )}
              <p>{a.description}</p>
              {a.kind === "character" && (
                <p>
                  音色：{a.voice || "未设置"}；三视图：
                  {a.three_view ? "是" : "否"}
                </p>
              )}
              <button disabled={busy || !pid} onClick={() => void adopt(a)}>
                加入当前项目
              </button>
            </article>
          ))}
      </div>
      {!pid && <p>请先选择项目，再加入元素。</p>}
    </section>
  );
}
