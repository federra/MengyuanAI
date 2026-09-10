import "./entity-compact.css";
import { useEffect, useState } from "react";
import { mediaRequest, useMedia } from "./MediaWorkbench";
import type { components } from "./generated/api";
type Shot = components["schemas"]["Shot"];
type Asset = components["schemas"]["AssetOut"];
export function ShotReferences({
  shot,
  files,
  onChange,
}: {
  shot: Shot;
  files: components["schemas"]["FileOut"][];
  onChange: (refs: Shot["refs"]) => void;
}) {
  const m = useMedia(),
    [descriptions, setDescriptions] = useState<Asset[]>([]),
    [error, setError] = useState("");
  const confirmed = m.referenceImages;
  useEffect(() => {
    let live = true;
    mediaRequest(
      `/api/v1/projects/${m.pid}/storyboard/import/assets`,
      undefined,
      "GET",
    )
      .then((rows) => {
        if (live) setDescriptions(rows);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [m.pid, m.version]);
  const validFiles = new Set([
    ...confirmed.filter((r) => r.confirmed && !r.stale).map((r) => r.file_id),
    ...m.results
      .filter(
        (r) =>
          r.kind === "image.position" &&
          r.confirmed &&
          !r.stale &&
          !confirmed.some((ref) => ref.file_id === r.file_id),
      )
      .map((r) => r.file_id),
  ]);
  const images = files.filter((f) => f.mime.startsWith("image/"));
  return (
    <div className="shot-reference-grid">
      {error && <p role="alert">{error}</p>}
      {(["characters", "scenes", "props", "positions"] as const).map((kind) => {
        const ids = shot.refs[kind] || [],
          label = {
            characters: "角色",
            scenes: "场景",
            props: "道具",
            positions: "站位",
          }[kind];
        return (
          <section className="reference-window" key={kind}>
            <strong>
              {label} · {ids.length}
            </strong>
            <div className="reference-thumbnails">
              {ids.map((id) => {
                const fid =
                  m.references.find(
                    (r) => r.shot_id === shot.id && r.ref_id === id,
                  )?.file_id || id;
                const file = images.find((f) => f.id === fid);
                return file ? (
                  <a
                    key={id}
                    href={`/api/v1/projects/${m.pid}/files/${fid}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <img
                      src={`/api/v1/projects/${m.pid}/files/${fid}`}
                      alt={
                        descriptions.find((d) => d.id === id)?.name ||
                        file.filename
                      }
                    />
                  </a>
                ) : (
                  <span key={id} className="reference-missing">
                    待制图
                  </span>
                );
              })}
            </div>
            <details>
              <summary>管理图片</summary>
              <label className="field">
                {label}图片引用
                <select
                  multiple
                  value={ids}
                  onChange={(e) =>
                    onChange({
                      ...shot.refs,
                      [kind]: Array.from(
                        e.target.selectedOptions,
                        (o) => o.value,
                      ),
                    })
                  }
                >
                  {ids
                    .filter(
                      (id) =>
                        !images.some(
                          (f) => f.id === id && validFiles.has(f.id),
                        ),
                    )
                    .map((id) => (
                      <option key={id} value={id}>
                        {descriptions.find((d) => d.id === id)?.name ||
                          `保留引用 ${id.slice(0, 8)}`}
                      </option>
                    ))}
                  {images
                    .filter((f) => validFiles.has(f.id))
                    .map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.filename}
                      </option>
                    ))}
                </select>
              </label>
              {!ids.length && <p>暂无图片</p>}
              {ids.map((id) => {
                const binding = m.references.find(
                    (r) => r.shot_id === shot.id && r.ref_id === id,
                  ),
                  descriptor = descriptions.find((d) => d.id === id),
                  fid = binding?.file_id || id,
                  file = images.find((f) => f.id === fid),
                  url = `/api/v1/projects/${m.pid}/files/${fid}`;
                return (
                  <div className="reference-preview" key={id}>
                    <strong>
                      {descriptor?.name || file?.filename || "图片引用"}
                    </strong>
                    {descriptor && (
                      <p className="preserve-text">{descriptor.description}</p>
                    )}
                    <details>
                      <summary>引用 ID</summary>
                      <code>{id}</code>
                    </details>
                    {file ? (
                      <a href={url} target="_blank" rel="noreferrer">
                        <img
                          src={url}
                          alt={descriptor?.name || file.filename}
                        />
                      </a>
                    ) : (
                      <p className="muted">待制作 / 绑定已确认图片</p>
                    )}
                    <label className="field">
                      {file ? "替换图片（保留ID）" : "绑定已确认图片"}
                      <select
                        disabled={m.busy || !images.length}
                        value={file?.id || ""}
                        onChange={(e) => {
                          if (e.target.value)
                            void m
                              .run(
                                `/shots/${shot.id}/references/${id}`,
                                {
                                  board_version_id: m.version,
                                  revision: binding?.revision || 0,
                                  file_id: e.target.value,
                                },
                                "PUT",
                              )
                              .catch(() => {});
                        }}
                      >
                        <option value="">选择图片</option>
                        {file && !validFiles.has(file.id) && (
                          <option value={file.id} disabled>
                            {file.filename}（当前引用待更新）
                          </option>
                        )}
                        {images
                          .filter((f) => validFiles.has(f.id))
                          .map((f) => (
                            <option key={f.id} value={f.id}>
                              {f.filename}
                            </option>
                          ))}
                      </select>
                    </label>
                  </div>
                );
              })}
            </details>
          </section>
        );
      })}
    </div>
  );
}
