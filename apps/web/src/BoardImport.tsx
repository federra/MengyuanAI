import { trapDialogFocus } from "./dialogFocus";
import { useEffect, useRef, useState } from "react";
import { api, unwrap } from "./api";
import { durableCommand, readDraft, removeDraft, storeDraft } from "./commands";
import type { components } from "./generated/api";
type Preview =
  components["schemas"]["shortfilm__creation__board_import__PreviewOut"];
type Result = components["schemas"]["CommitOut"];
type Content = components["schemas"]["ContentOut"];
type Draft = { text: string; filename: string; preview: Preview | null };
async function request<T>(
  url: string,
  body: unknown,
  key?: string,
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(
      Array.isArray(value.detail)
        ? value.detail
            .map(
              (e: { loc: unknown[]; msg: string }) =>
                `${e.loc.join(".")}: ${e.msg}`,
            )
            .join("\n")
        : value.detail || "导入请求未完成，请重试",
    );
  return value;
}
export function BoardImport({
  pid,
  baseVersion,
  disabled,
  preserve,
  onImported,
}: {
  pid: string;
  baseVersion: string | null;
  disabled: boolean;
  preserve: () => void;
  onImported: (item: Content) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    lock = useRef(false),
    generation = useRef(0);
  const key = `sf.${pid}.board-import`,
    endpoint = `/api/v1/projects/${pid}/storyboard/import`;
  const [draft, setDraft] = useState<Draft>(
      () => readDraft(key) || { text: "", filename: "", preview: null },
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  useEffect(() => storeDraft(key, draft), [key, draft]);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  async function file(file?: File) {
    if (!file || lock.current) return;
    lock.current = true;
    setBusy(true);
    setDraft((old) => ({ ...old, preview: null }));
    const revision = ++generation.current;
    setError("");
    try {
      if (file.size > 1048576) throw new Error("文件不能超过1MB");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        await file.arrayBuffer(),
      );
      if (revision === generation.current)
        setDraft({ text, filename: file.name, preview: null });
    } catch (e) {
      if (revision === generation.current)
        setError(
          e instanceof TypeError
            ? "文件必须是有效 UTF-8 编码"
            : e instanceof Error
              ? e.message
              : "无法读取文件",
        );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function preview() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const revision = generation.current;
    try {
      const script = unwrap(
        await api.GET("/api/v1/projects/{pid}/stages/{stage}", {
          params: { path: { pid, stage: "script" } },
        }),
      );
      if (
        !script.item ||
        script.confirmation?.version_id !== script.item.version_id
      )
        throw new Error("请先保存并确认当前剧本，再导入分镜。");
      const value = await request<Preview>(`${endpoint}/preview`, {
        sourceScriptVersionId: script.item.version_id,
        baseBoardVersionId: baseVersion,
        packageJson: draft.text,
      });
      if (revision === generation.current)
        setDraft((old) => ({ ...old, preview: value }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "预检失败，原分镜未变");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function commit() {
    if (lock.current || !draft.preview) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      preserve();
      const p = draft.preview,
        body = {
          previewId: p.previewId,
          contentHash: p.contentHash,
          sourceScriptVersionId: p.sourceScriptVersionId,
          baseBoardVersionId: p.baseBoardVersionId,
        };
      const command = durableCommand(`${pid}:board-import`, body);
      let result: Result;
      try {
        result = await request<Result>(`${endpoint}/commit`, body, command.key);
      } catch (error) {
        // A lost response may follow a successful transaction. Query the same command.
        const response = await fetch(`${endpoint}/commits/${command.key}`);
        if (!response.ok) throw error;
        result = await response.json();
      }
      onImported(result.item);
      command.done();
      removeDraft(key);
      setDraft({ text: "", filename: "", preview: null });
      setNotice(
        `已整体替换为新版本，共${result.shots.length}镜；旧版本及素材保留。`,
      );
      dialog.current?.close();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "提交结果尚未确认，请用原预检重试；草稿与原表保留。",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="board-import-entry">
      <button
        ref={trigger}
        disabled={disabled}
        onClick={() => dialog.current?.showModal()}
      >
        导入分镜 JSON
      </button>
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      <dialog
        onKeyDown={trapDialogFocus}
        ref={dialog}
        className="settings-dialog board-import-dialog"
        aria-label="导入分镜 JSON"
        onClose={() => trigger.current?.focus()}
        onCancel={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <header className="settings-dialog-header">
          <h2>导入分镜 JSON</h2>
          <button
            aria-label="关闭分镜导入"
            disabled={busy}
            onClick={() => dialog.current?.close()}
          >
            关闭
          </button>
        </header>
        <div className="settings-dialog-body">
          <p>
            校验后整表替换为新版本。旧版本、媒体及未保存编辑保留恢复副本；图片描述导入后仍需制作与确认。
          </p>
          <div className="actions">
            <a href={`${endpoint}/template`} download="分镜导入模板.json">
              下载模板
            </a>
            <a href={`${endpoint}/schema`} target="_blank" rel="noreferrer">
              查看格式要求
            </a>
          </div>
          <label className="field">
            分镜 JSON 文件
            <input
              type="file"
              accept=".json,application/json"
              disabled={busy}
              onChange={(e) => void file(e.target.files?.[0])}
            />
          </label>
          <label className="field">
            分镜 JSON 内容
            <textarea
              rows={8}
              disabled={busy}
              value={draft.text}
              onChange={(e) => {
                generation.current++;
                setDraft({
                  text: e.target.value,
                  filename: "手工编辑",
                  preview: null,
                });
              }}
            />
          </label>
          {draft.filename && (
            <p>
              {draft.filename} · {new TextEncoder().encode(draft.text).length}{" "}
              字节
            </p>
          )}
          {error && (
            <p role="alert" className="alert preserve-text">
              {error}
            </p>
          )}
          <button disabled={busy || !draft.text} onClick={() => void preview()}>
            校验并预览
          </button>
          {draft.preview && (
            <section className="import-preview">
              <h3>导入预检</h3>
              <p>
                {draft.preview.stats.shots} 镜 · {draft.preview.stats.dialogues}{" "}
                句台词 · {draft.preview.stats.assets} 项素材 ·{" "}
                {draft.preview.stats.totalSeconds} 秒
              </p>
              {draft.preview.warnings.map((w, i) => (
                <p key={i}>{w}</p>
              ))}
              <p>
                确认后需重新检查、确认分镜。系统将使用已配置文本模型进行建议质检，会消耗模型用量；质检失败不撤销导入，也不阻止继续。
              </p>
              <button
                className="primary"
                disabled={busy}
                onClick={() => void commit()}
              >
                确认整表替换
              </button>
            </section>
          )}
          {busy && (
            <p role="status">
              正在处理，为避免新编辑被覆盖，请等待结果后关闭。刷新或中断后可用原提交记录恢复。
            </p>
          )}
        </div>
      </dialog>
    </div>
  );
}
