import { useEffect, useState } from "react";
import { api, unwrap } from "./api";
import { mediaRequest } from "./MediaWorkbench";

export function ProjectHeadingInfo({ pid }: { pid: string }) {
  const [info, setInfo] = useState<{
    name: string;
    values: string[];
    idea: string;
  }>();
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const [p, settings, idea, config] = await Promise.all([
          api
            .GET("/api/v1/projects/{pid}", { params: { path: { pid } } })
            .then(unwrap),
          api.GET("/api/v1/settings").then(unwrap),
          api
            .GET("/api/v1/projects/{pid}/idea", { params: { path: { pid } } })
            .then(unwrap),
          mediaRequest(
            `/api/v1/settings/resolve/${pid}/video?stage=storyboard`,
            undefined,
            "GET",
          ),
        ]);
        if (live) {
          setInfo({
            name: p.name,
            values: [
              settings.project_types.find((t) => t.id === p.type_id)?.name ||
                "未分类",
              p.market === "zh" ? "中文市场" : "英文市场",
              config.style?.name || "未选择风格模板",
              String(p.generation_settings?.aspect_ratio || "未设置画幅"),
              String(p.generation_settings?.resolution || "未设置分辨率"),
            ],
            idea: String(idea?.body.text || "尚未填写创意"),
          });
          setError("");
        }
      } catch {
        if (live) setError("项目信息读取失败");
      }
    };
    void load();
    window.addEventListener("focus", load);
    const timer = window.setInterval(load, 10000);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [pid]);
  return (
    <div
      className="heading-project-info"
      aria-label="项目信息"
      title={info ? [info.name, ...info.values, info.idea].join(" · ") : error}
    >
      {info ? (
        <>
          <div>
            <strong>{info.name}</strong>
            {info.values.map((v, i) => (
              <span key={i}>{v}</span>
            ))}
          </div>
          <div className="heading-idea">{info.idea}</div>
        </>
      ) : (
        <span>{error || "读取项目信息…"}</span>
      )}
    </div>
  );
}
