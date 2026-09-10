import { ImagePreview } from "./ImagePreview";
import { useRef, useState } from "react";
import { useMedia } from "./MediaWorkbench";
import {
  projectMentions,
  editMentions,
  inlineCharacterMentions,
} from "./promptMentions";
import { trapDialogFocus } from "./dialogFocus";
import type { components } from "./generated/api";
type Shot = components["schemas"]["Shot"];
export function PromptEditor({
  shot,
  files,
  onChange,
}: {
  shot: Shot;
  files: components["schemas"]["FileOut"][];
  onChange: (shot: Shot) => void;
}) {
  const m = useMedia(),
    input = useRef<HTMLTextAreaElement>(null),
    dialog = useRef<HTMLDialogElement>(null);
  const [insertion, setInsertion] = useState<{
    raw: string;
    offset: number;
  } | null>(null);
  const [editing, setEditing] = useState(false);
  const [preview, setPreview] = useState<{ src: string; title: string } | null>(
    null,
  );
  const [previewError, setPreviewError] = useState("");
  const names = new Map<string, string>();
  const group = (kind: string): keyof Shot["refs"] =>
    (({ character: "characters", scene: "scenes", prop: "props" })[
      kind
    ] as keyof Shot["refs"]) || "positions";
  const choices = m.referenceImages.map((r) => {
    const e = m.entities.find((e) => e.id === r.entity_id);
    const binding = m.references.find(
      (b) =>
        b.shot_id === shot.id &&
        b.file_id === r.file_id &&
        b.entity_id === r.entity_id,
    );
    return {
      id: binding?.ref_id || r.file_id,
      file: r.file_id,
      name: e?.name || r.name,
      kind: group(e?.kind || r.kind),
      state: r.stale ? "已过期" : r.confirmed ? "已确认" : "待确认",
    };
  });
  for (const r of m.results.filter((r) => r.kind === "image.position"))
    choices.push({
      id: r.file_id,
      file: r.file_id,
      name:
        "站位图 " +
        (m.results.filter((r) => r.kind === "image.position").indexOf(r) + 1),
      kind: "positions",
      state: r.stale ? "已过期" : r.confirmed ? "已确认" : "待确认",
    });
  for (const file of files) names.set(file.id, file.filename);
  for (const c of choices) {
    names.set(c.id, c.name);
    names.set(c.file, c.name);
  }
  for (const r of m.references.filter((r) => r.shot_id === shot.id)) {
    const e = m.entities.find((e) => e.id === r.entity_id);
    if (e) names.set(r.ref_id, e.name);
  }
  const available = choices
    .filter((c) => files.some((f) => f.id === c.file))
    .filter((c, i, a) => {
      const preferred =
        a.find((x) => x.file === c.file && x.id !== x.file) ||
        a.find((x) => x.file === c.file);
      return preferred === c && a.indexOf(c) === i;
    });
  const characters = new Map<string, string>();
  for (const id of shot.refs.characters || [])
    if (names.has(id)) characters.set(id, names.get(id)!);
  const raw = inlineCharacterMentions(shot.prompt, characters);
  const visible = projectMentions(raw, names).text;
  function openReference(id: string) {
    const binding = m.references.find(
      (r) => r.shot_id === shot.id && r.ref_id === id,
    );
    const fileId = binding ? binding.file_id : id;
    if (
      !fileId ||
      !files.some((f) => f.id === fileId && f.mime.startsWith("image/"))
    ) {
      setPreviewError("该引用尚无图片，请先生成或绑定图片。");
      return;
    }
    setPreviewError("");
    setPreview({
      src: `/api/v1/projects/${m.pid}/files/${fileId}`,
      title: names.get(id) || "引用图片",
    });
  }
  function startEditing() {
    setEditing(true);
    requestAnimationFrame(() => input.current?.focus());
  }
  const pieces = raw.split(/(@\[[^\]]+\])/g);

  function choose(c: (typeof choices)[number]) {
    if (!insertion) return;
    const display = projectMentions(insertion.raw, names).text;
    const next =
      display.slice(0, insertion.offset - 1) +
      "\uFFF0" +
      display.slice(insertion.offset);
    const raw = editMentions(insertion.raw, next, names).replace(
      "\uFFF0",
      `@[${c.id}]`,
    );
    onChange({
      ...shot,
      prompt: raw,
      refs: {
        ...shot.refs,
        [c.kind]: [...new Set([...(shot.refs[c.kind] || []), c.id])],
      },
    });
    dialog.current?.close();
    requestAnimationFrame(() => input.current?.focus());
  }
  return (
    <div className="field prompt-editor">
      {!editing && (
        <div
          className="linked-prompt"
          aria-label="提示词预览"
          onClick={startEditing}
        >
          {pieces.map((part, index) =>
            part.startsWith("@[") ? (
              <button
                type="button"
                role="link"
                className="prompt-image-link"
                key={index}
                onClick={(e) => {
                  e.stopPropagation();
                  openReference(part.slice(2, -1));
                }}
              >
                @{names.get(part.slice(2, -1)) || "待绑定图片"}
              </button>
            ) : (
              part
            ),
          )}
        </div>
      )}
      <button
        type="button"
        className="prompt-edit-toggle"
        onClick={() => (editing ? setEditing(false) : startEditing())}
      >
        {editing ? "返回图片链接预览" : "编辑提示词"}
      </button>
      {previewError && <p role="status">{previewError}</p>}
      {preview && (
        <ImagePreview {...preview} onClose={() => setPreview(null)} />
      )}
      <textarea
        hidden={!editing}
        ref={input}
        aria-label="提示词"
        rows={7}
        value={visible}
        onChange={(e) => {
          const text = e.target.value,
            offset = e.target.selectionStart,
            raw = editMentions(
              inlineCharacterMentions(shot.prompt, characters),
              text,
              names,
            );
          onChange({ ...shot, prompt: raw });
          if (
            text[offset - 1] === "@" &&
            (e.nativeEvent as InputEvent).inputType !== "deleteContentBackward"
          ) {
            setInsertion({ raw, offset });
            dialog.current?.showModal();
          }
        }}
      />
      <dialog
        ref={dialog}
        className="settings-dialog image-mention-dialog"
        aria-label="选择引用图片"
        onKeyDown={trapDialogFocus}
        onClose={() => setInsertion(null)}
      >
        <header className="settings-dialog-header">
          <h2>选择引用图片</h2>
          <button onClick={() => dialog.current?.close()}>关闭</button>
        </header>
        <div className="settings-dialog-body">
          <p>选择已生成图片；待确认或过期图片仍须检查后才能生成视频。</p>
          <div className="mention-image-grid">
            {available.map((c) => (
              <button key={c.id} type="button" onClick={() => choose(c)}>
                <img
                  src={`/api/v1/projects/${m.pid}/files/${c.file}`}
                  alt={c.name}
                />
                <span>{c.name}</span>
                <small>
                  {
                    {
                      characters: "角色",
                      scenes: "场景",
                      props: "道具",
                      positions: "站位",
                    }[c.kind]
                  }{" "}
                  · {c.state}
                </small>
              </button>
            ))}
          </div>
          {!available.length && (
            <p>暂无已生成图片，请先在角色、场景、道具管理或站位图中制作。</p>
          )}
        </div>
      </dialog>
    </div>
  );
}
