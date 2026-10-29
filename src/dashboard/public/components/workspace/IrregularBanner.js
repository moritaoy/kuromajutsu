// ============================================================
// IrregularBanner — ゲート変更（イレギュラー）の警告表示（spec §13.5.5）
// ============================================================
// 未確認のものは画面上部に警告表示し、確認済みは折りたたみで残す。

import { createElement as h, useState } from "react";
import { fmtTime, truncate } from "./plan-utils.js";

/** 変更前後の差分（チェックの文言で突き合わせる） */
export function GateChangeDiff({ change }) {
  const before = change.before || {};
  const after = change.after;
  if (!after) {
    return h("div", { className: "diff" }, h("div", { className: "del" }, `- ゲート「${before.title || change.gateId}」が削除された`));
  }
  const bc = before.checks || [];
  const ac = after.checks || [];
  const key = (c) => `${c.method}\u0000${c.text}\u0000${c.command || ""}`;
  const afterKeys = new Set(ac.map(key));
  const beforeKeys = new Set(bc.map(key));
  const rows = [];
  bc.forEach((c) => rows.push([afterKeys.has(key(c)) ? "keep" : "del", c]));
  ac.forEach((c) => { if (!beforeKeys.has(key(c))) rows.push(["add", c]); });
  const meta = [];
  if (before.title !== after.title) meta.push(`タイトル: ${before.title} → ${after.title}`);
  if (before.role !== after.role) meta.push(`職種: ${before.role} → ${after.role}`);
  return h("div", { className: "diff" },
    meta.map((m, i) => h("div", { key: `m${i}`, className: "keep" }, `  ${m}`)),
    rows.map(([k, c], i) => h("div", { key: i, className: k },
      `${k === "del" ? "- " : k === "add" ? "+ " : "  "}${c.text}  [${c.method}]${c.command ? `  $ ${c.command}` : ""}`)));
}

function Item({ change, titleOf, busy, onAck, onShow }) {
  return h("div", { className: "irr-item" },
    h("div", { className: "irr-head" },
      h("b", null, "⚠ IRREGULAR"),
      h("span", null, `AI がゲート ${change.gateId}「${titleOf(change)}」を変更しました`),
      h("span", { className: "tt" }, fmtTime(change.at)),
      h("span", { className: "spacer" }),
      onShow && h("button", { className: "wbtn sm", onClick: () => onShow(change.gateId) }, "ゲートを見る"),
      h("button", { className: "wbtn sm primary", disabled: busy === change.id, onClick: () => onAck(change) }, "確認した")),
    h("div", { className: "irr-reason" }, `理由: ${change.reason}`),
    h(GateChangeDiff, { change }));
}

/**
 * @param {{ workspace: object, api: object, dispatch: function, onShowGate: (id: string) => void }} props
 */
export function IrregularBanner({ workspace, api, dispatch, onShowGate }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const changes = workspace.gateChanges || [];
  const open = changes.filter((c) => !c.acknowledgedAt);
  const acked = changes.filter((c) => c.acknowledgedAt);
  if (changes.length === 0) return null;

  const titleOf = (c) => (c.after && c.after.title) || (c.before && c.before.title) || c.gateId;
  const ack = async (change) => {
    setBusy(change.id);
    setError(null);
    try {
      const ws = await api.ack(workspace.id, change.id);
      if (ws && ws.id && ws.revisions) dispatch({ type: "workspace:updated", data: ws });
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(null);
    }
  };

  return h("div", { className: "irr-wrap" },
    open.length > 0 && h("div", { className: "irr-banner" },
      open.map((c) => h(Item, { key: c.id, change: c, titleOf, busy, onAck: ack, onShow: onShowGate })),
      error && h("div", { className: "ws-error" }, error)),
    acked.length > 0 && h("details", { className: "irr-acked" },
      h("summary", null, `確認済みのイレギュラー（${acked.length}）`),
      acked.map((c) => h("div", { key: c.id, className: "irr-item2" },
        h("div", null, h("b", null, `${titleOf(c)}（${c.gateId}）`), " のゲートを AI が変更 — 確認済み ", h("span", { className: "tt" }, fmtTime(c.acknowledgedAt))),
        h("div", { className: "hint" }, `理由: ${truncate(c.reason, 200)}`),
        h(GateChangeDiff, { change: c })))));
}
