// ============================================================
// RecoverPanel — 「Orchestrator の異常終了からの再開」（failed / statusReason.code === "orchestrator_failed"）
// ============================================================
// ネット切れなどで Orchestrator が異常終了した Workspace を、同じ Magentic グループの新しい Orchestrator で
// 続きから再開させる（spec §13.8.9）。サーバー再起動などで実行時の状態が失われていると再開できない
// （GET の `resumable: false`）。

import { createElement as h, useState, useEffect } from "react";

/**
 * @param {{ workspace: object, api: object, dispatch: function }} props
 */
export function RecoverPanel({ workspace, api, dispatch }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // 再開できるかは単体 GET の `resumable` だけが持つ（WebSocket の Workspace には無い）。取得前は null
  const [resumable, setResumable] = useState(typeof workspace.resumable === "boolean" ? workspace.resumable : null);

  useEffect(() => {
    let cancelled = false;
    api.get(workspace.id)
      .then((ws) => { if (!cancelled && ws && typeof ws.resumable === "boolean") setResumable(ws.resumable); })
      .catch(() => { /* 取得できなければ判定せず、押したときのサーバーの応答（409 など）に任せる */ });
    return () => { cancelled = true; };
  }, [workspace.id, workspace.updatedAt]);

  const disabled = resumable === false;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const ws = await api.resume(workspace.id, { instruction: text });
      if (ws && ws.id && ws.revisions) dispatch({ type: "workspace:updated", data: ws });
      setText("");
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  return h("div", { className: "hr-panel recover-panel" },
    h("div", { className: "hr-head" },
      h("b", { style: { color: "var(--accent-yellow)" } }, "↻ RECOVER"),
      h("span", null, "Orchestrator が異常終了しました"),
      h("span", { className: "spacer" }),
      h("span", { className: "hr-stop" }, "実行は停止中")),
    h("div", { className: "hint", style: { marginTop: 4 } },
      "同じグループ・同じ台帳の新しい Orchestrator で、完了していない手順から続きを実行できます。途中で動いていたサブ Agent は停止します。"),
    h("div", { className: "hr-h", style: { marginTop: 10 } }, "指示（任意）"),
    h("div", { className: "hr-act" },
      h("textarea", {
        value: text, spellCheck: false, disabled: busy || disabled,
        placeholder: "続きから再開するときのヒントを書く（空でも再開できます）",
        onChange: (e) => setText(e.target.value),
      }),
      h("div", { className: "hr-btns" },
        h("button", { className: "wbtn primary", disabled: busy || disabled, onClick: run }, busy ? "送信中…" : "再開")),
      disabled && h("div", { className: "ws-error" }, "サーバー再起動などで実行時の状態が失われているため再開できません"),
      error && h("div", { className: "ws-error" }, error)));
}
