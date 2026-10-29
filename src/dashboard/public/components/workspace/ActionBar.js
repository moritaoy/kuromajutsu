// ============================================================
// ActionBar — 下部バー: 対象チップ + 定型指示 + 指示欄 + 「AI に指示」「承認して実行」「中断」
// ============================================================
// 人は計画を編集しない。ここで AI に指示するだけ（spec §13.1.1 / §13.10.2）。

import { createElement as h, useState, useEffect } from "react";
import { quickInstructions, GLOBAL_INSTRUCTIONS, targetInfo, isHuman, phaseById, stepById } from "./plan-utils.js";

/**
 * @param {{
 *   model: object, plan: object, targets: string[], text: string, setText: (t: string) => void,
 *   inputRef: object, errors: number|null, busy: boolean, error: string|null,
 *   onToggleTarget: (id: string) => void, onClearTargets: () => void,
 *   onReplan: () => void, onApprove: (maxIterations: number|undefined) => void, onAbort: () => void,
 * }} props
 */
export function ActionBar({ model, plan, targets, text, setText, inputRef, errors, busy, error, onToggleTarget, onClearTargets, onReplan, onApprove, onAbort }) {
  const [maxIter, setMaxIter] = useState(String(plan.maxIterations));
  // 計画が更新されたら、サーバーが算出した値に戻す
  useEffect(() => { setMaxIter(String(plan.maxIterations)); }, [plan.revision, plan.maxIterations]);

  const infos = targets.map((id) => targetInfo(model, id)).filter(Boolean);
  const sugg = infos.length
    ? [...new Set(infos.flatMap((t) => {
      const p = t.kind === "phase" ? phaseById(model, t.id) : null;
      const s = t.kind !== "phase" ? stepById(model, t.id) : null;
      return quickInstructions(t.kind, { human: isHuman(s), deferred: p && p.planning === "deferred" });
    }))]
    : GLOBAL_INSTRUCTIONS;

  const mi = Number(maxIter);
  const miValid = Number.isInteger(mi) && mi >= 1 && mi <= 1000;
  const approveBlocked = errors == null || errors > 0 || busy || !miValid;
  const canReplan = text.trim() !== "" && !busy;

  const focusInput = () => {
    const ta = inputRef.current;
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  };

  return h("div", { className: "actionbar" }, h("div", { className: "in" },
    h("div", { className: "tgt" },
      h("span", { className: "caret" }, "@"),
      infos.length
        ? [
          infos.map((t) => h("span", { key: t.id, className: "tchip" }, t.id, h("span", { className: "nm" }, t.title),
            h("b", { onClick: () => onToggleTarget(t.id), title: "対象から外す" }, "×"))),
          h("a", { key: "clr", className: "clr", onClick: onClearTargets }, "clear"),
        ]
        : h("span", null, "計画全体", h("span", { style: { marginLeft: 8, opacity: 0.7 } }, "— カードをクリックすると対象を絞れる"))),
    h("div", { className: "prompt" },
      h("span", { className: "caret" }, ">"),
      h("textarea", {
        ref: inputRef,
        value: text,
        spellCheck: false,
        disabled: busy,
        placeholder: infos.length ? `${infos.map((t) => `@${t.id}`).join(" ")} への指示を書く` : "計画全体への指示を書く（例: セキュリティレビューのフェーズを追加して）",
        onChange: (e) => setText(e.target.value),
        onKeyDown: (e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); if (canReplan) onReplan(); }
        },
      })),
    h("div", { className: "qs" }, sugg.map((q) => h("button", { key: q, className: "q", disabled: busy, onClick: () => { setText(q); setTimeout(focusInput, 0); } }, q))),
    h("div", { className: "btns" },
      h("button", { className: "send", disabled: !canReplan, onClick: onReplan, title: "⌘/Ctrl + Enter" }, busy ? "送信中…" : "AI に指示 ⏎"),
      h("div", { className: "iterrow", title: "Orchestrator の最大反復回数（サーバーが算出した値。変更可）" },
        h("span", null, "最大反復"),
        h("input", { type: "number", min: 1, max: 1000, value: maxIter, disabled: busy, onChange: (e) => setMaxIter(e.target.value) })),
      h("button", {
        className: `approve${errors ? " err" : ""}`,
        disabled: approveBlocked,
        title: errors ? "検証エラーを解消してください" : "承認して Orchestrator を起動",
        onClick: () => onApprove(miValid ? mi : undefined),
      }, errors ? `✖ エラー ${errors}` : "承認して実行 ▶"),
      h("span", { className: `vst ${errors == null ? "" : errors ? "error" : "ok"}` },
        errors == null ? "検証を取得中…" : errors ? "承認不可" : `検証 OK · rev ${plan.revision}`),
      h("button", { className: "abort", disabled: busy, onClick: onAbort }, "中断")),
    error && h("div", { className: "ws-error bar" }, error)));
}
