// ============================================================
// RetryPanel — 「ゲート不合格が続いています」（statusReason.code === "gate_retry_exceeded"）
// ============================================================
// 不合格のゲートと各 attempt の結果を見せ、「指示を付けて再試行」か「中断」を選ばせる（spec §13.5.6）。

import { createElement as h, useState, useEffect } from "react";
import { stepById, phaseById, fmtTime } from "./plan-utils.js";
import { notifyOnce, NotifyPermission } from "./notify.js";

function CheckResultRow({ check, result }) {
  const ok = result.passed;
  const isCmd = result.method === "command";
  const hasOut = isCmd && (result.stdoutTail || result.stderrTail);
  return h("div", { className: `rt-check ${ok ? "pass" : "fail"}` },
    h("div", { className: "rt-line" },
      h("span", { className: `vi ${ok ? "ok" : "error"}` }, ok ? "✔" : "✖"),
      h("span", { className: "rt-text" }, check ? check.text : `チェック ${result.checkIndex}`),
      h("span", { className: "rt-m" }, result.method),
      isCmd && h("span", { className: "rt-exit" },
        result.timedOut ? "タイムアウト" : `exit ${result.exitCode == null ? "—" : result.exitCode}`,
        result.duration_ms != null ? ` · ${(result.duration_ms / 1000).toFixed(1)}s` : "")),
    result.note && h("div", { className: "rt-note" }, result.note),
    isCmd && check && check.command && h("div", { className: "rt-cmd" }, `$ ${check.command}`),
    hasOut && h("details", { className: "rt-out" },
      h("summary", null, "出力（末尾）"),
      result.stdoutTail && h("pre", null, h("b", null, "stdout\n"), result.stdoutTail),
      result.stderrTail && h("pre", null, h("b", null, "stderr\n"), result.stderrTail)));
}

/**
 * @param {{ workspace: object, model: object, api: object, dispatch: function, onShowGate: (id: string) => void }} props
 */
export function RetryPanel({ workspace, model, api, dispatch, onShowGate }) {
  const reason = workspace.statusReason || {};
  const gateId = reason.gateId;
  const gate = gateId ? stepById(model, gateId) : null;
  const phase = gate ? phaseById(model, gate.phaseId) : null;
  const gr = (workspace.gateResults || []).find((g) => g.gateId === gateId);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const key = `${workspace.id}|retry|${gateId}|${gr ? gr.attempts.length : 0}`;
  useEffect(() => {
    notifyOnce(key, "ゲート不合格が続いています", `${gate ? gate.title : gateId}: 指示を付けて再試行するか中断を選んでください`);
  }, [key]);

  const run = async (kind) => {
    setBusy(kind);
    setError(null);
    try {
      const ws = kind === "retry" ? await api.retry(workspace.id, { instruction: text }) : await api.abort(workspace.id);
      if (ws && ws.id && ws.revisions) dispatch({ type: "workspace:updated", data: ws });
      if (kind === "retry") setText("");
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(null);
    }
  };

  const attempts = gr ? [...gr.attempts].reverse() : [];
  const retries = gr ? gr.retryInstructions || [] : [];

  return h("div", { className: "hr-panel retry-panel" },
    h("div", { className: "hr-head" },
      h("b", { style: { color: "var(--accent-red)" } }, "✖ GATE FAILED"),
      h("span", null, "ゲート不合格が続いています"),
      h("span", { className: "muted" }, `${gate ? gate.title : gateId}${phase ? `（「${phase.name}」の出口）` : ""}`),
      h("span", { className: "spacer" }),
      h("span", { className: "hr-stop" }, "実行は停止中"),
      h(NotifyPermission),
      gate && h("button", { className: "wbtn sm", onClick: () => onShowGate(gate.id) }, "ゲートを見る")),
    reason.message && h("div", { className: "hint", style: { marginTop: 4 } }, reason.message),
    h("div", { className: "hr-grid" },
      h("div", null,
        h("div", { className: "hr-h" }, "各 attempt の結果（新しい順）"),
        attempts.length === 0 && h("div", { className: "hint" }, "結果がありません"),
        attempts.map((a) => h("div", { key: a.attempt, className: "rt-attempt" },
          h("div", { className: "rt-ah" }, `attempt ${a.attempt}`, a.closedAt ? h("span", { className: "tt" }, ` ${fmtTime(a.closedAt)}`) : null,
            h("span", { className: a.checks.every((c) => c.passed) ? "ok" : "ng" }, a.checks.every((c) => c.passed) ? " 合格" : ` 不合格 ${a.checks.filter((c) => !c.passed).length} 件`)),
          a.checks.map((c, i) => h(CheckResultRow, { key: i, check: gate ? gate.checks[c.checkIndex] : null, result: c }))))),
      h("div", null,
        retries.length > 0 && [
          h("div", { key: "rh", className: "hr-h" }, "これまでの再試行の指示"),
          retries.map((r, i) => h("div", { key: i, className: "rv-past" }, h("b", null, fmtTime(r.at)), ` ${r.text}`)),
        ],
        h("div", { className: "hr-h" }, "指示（任意）"),
        h("div", { className: "hr-act" },
          h("textarea", {
            value: text, spellCheck: false, disabled: !!busy,
            placeholder: "原因の見立てや直し方のヒントを書く（空でも再試行できます）",
            onChange: (e) => setText(e.target.value),
          }),
          h("div", { className: "hr-btns" },
            h("button", { className: "wbtn primary", disabled: !!busy, onClick: () => run("retry") }, busy === "retry" ? "送信中…" : "指示を付けて再試行"),
            h("button", { className: "wbtn danger", disabled: !!busy, onClick: () => { if (window.confirm("この Workspace を中断しますか？")) run("abort"); } }, "中断")),
          h("div", { className: "hint" }, "再試行すると、この指示を添えた新しい Orchestrator が再開し、同じゲートを同じ条件で再チェックします。"),
          error && h("div", { className: "ws-error" }, error)))));
}
