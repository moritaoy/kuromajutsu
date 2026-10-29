// ============================================================
// InstructView — ① 指示（指示欄 1 つ + 任意の作業ディレクトリ）
// ============================================================
// ラベルや説明文は置かない（placeholder のみ）。

import { createElement as h, useState, useRef, useEffect } from "react";

/**
 * @param {{ onSubmit: (input: { instruction: string, workspacePath: string }) => Promise<void> }} props
 */
export function InstructView({ onSubmit }) {
  const [instruction, setInstruction] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const taRef = useRef(null);

  useEffect(() => {
    if (taRef.current) taRef.current.focus();
  }, []);

  const canSend = instruction.trim() !== "" && !busy;
  const send = async () => {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ instruction, workspacePath });
    } catch (e) {
      setError(e && e.message ? e.message : String(e));
      setBusy(false);
    }
  };

  return h("div", { className: "instruct" },
    h("div", { className: "prompt" },
      h("span", { className: "caret" }, ">"),
      h("textarea", {
        ref: taRef,
        value: instruction,
        spellCheck: false,
        placeholder: "指示を書く",
        onChange: (e) => setInstruction(e.target.value),
        onKeyDown: (e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); send(); }
        },
      })),
    h("div", { className: "ibar" },
      h("input", {
        value: workspacePath,
        spellCheck: false,
        placeholder: "作業ディレクトリ（任意）",
        "aria-label": "作業ディレクトリ",
        onChange: (e) => setWorkspacePath(e.target.value),
      }),
      h("span", { className: "spacer" }),
      h("button", { className: "send", disabled: !canSend, onClick: send, title: "⌘/Ctrl + Enter" }, busy ? "送信中…" : "送信 ⏎")),
    error && h("div", { className: "ws-error" }, error));
}
