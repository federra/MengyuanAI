import { useEffect, useRef, useState } from "react";
import { trapDialogFocus } from "./dialogFocus";
import { readDraft, storeDraft } from "./commands";
const fields = ["序号", "台词", "角色/场景/道具", "提示词", "视频", "操作"];
export function BoardViewSettings({ pid }: { pid: string }) {
  const key = `sf.${pid}.board-visible-fields`;
  const [hidden, setHidden] = useState<number[]>(() => readDraft(key) || []);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    storeDraft(key, hidden);
  }, [key, hidden]);
  return (
    <>
      <button onClick={() => dialog.current?.showModal()}>界面设置</button>
      <style>
        {hidden
          .map((i) => `.board-table tr>:nth-child(${i + 1}){display:none}`)
          .join("\n")}
      </style>
      <dialog
        ref={dialog}
        onKeyDown={trapDialogFocus}
        className="settings-dialog"
        aria-label="界面设置"
      >
        <header className="settings-dialog-header">
          <h2>界面设置</h2>
          <button onClick={() => dialog.current?.close()}>关闭</button>
        </header>
        <div className="settings-dialog-body">
          <p>仅调整本项目在当前浏览器的显示，不删除内容。</p>
          {fields.map((f, i) => (
            <label className="view-field" key={f}>
              <input
                type="checkbox"
                checked={!hidden.includes(i)}
                onChange={(e) =>
                  setHidden(
                    e.target.checked
                      ? hidden.filter((x) => x !== i)
                      : [...hidden, i],
                  )
                }
              />
              {f}
            </label>
          ))}
          <button onClick={() => setHidden([])}>显示全部字段</button>
        </div>
      </dialog>
    </>
  );
}
