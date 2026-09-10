import { useEffect, useRef, useState } from "react";
import { mediaRequest } from "./MediaWorkbench";
export function VoiceLibrary() {
  const [rows, setRows] = useState<
      { id: string; name: string; content: string; revision: number }[]
    >([]),
    [name, setName] = useState(""),
    [voice, setVoice] = useState(""),
    [error, setError] = useState("");
  const lock = useRef(false);
  async function load() {
    setRows(
      await mediaRequest(
        "/api/v1/settings/resources?kind=voice",
        undefined,
        "GET",
      ),
    );
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  return (
    <section className="panel">
      <h2>音色资产库</h2>
      <p>
        保存已有供应商音色
        ID；此操作不会合成音频。角色选择后保留音色值，库中修改不覆盖项目。
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="actions">
        <label>
          音色名称
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          供应商音色 ID
          <input value={voice} onChange={(e) => setVoice(e.target.value)} />
        </label>
        <button
          disabled={!name.trim() || !voice.trim()}
          onClick={() => {
            if (lock.current) return;
            lock.current = true;
            void mediaRequest("/api/v1/settings/resources", {
              name: name.trim(),
              kind: "voice",
              stage: "voice",
              content: voice.trim(),
              required_variables: [],
            })
              .then(async () => {
                setName("");
                setVoice("");
                await load();
              })
              .catch((e) => setError(e.message))
              .finally(() => {
                lock.current = false;
              });
          }}
        >
          添加音色
        </button>
      </div>
      <ul>
        {rows.map((r) => (
          <li key={r.id}>
            {r.name} · {r.content}
          </li>
        ))}
      </ul>
    </section>
  );
}
