// ============================================================
// HumanReviewPanel — 人間レビュー待ち（statusReason.code === "human_review"）
// ============================================================
// レビュー資料（自己完結の HTML）を sandbox 付き iframe で表示する（spec §13.6.3）。
//   - sandbox="allow-scripts"（allow-same-origin なし）
//   - message は event.source が資料の iframe の contentWindow で、type が review:comment のものだけ受理する
// 上部のパネルに自動チェック結果・レビュー観点・履歴を出し、「レビュー資料を開く」で全面表示（資料 + 判断）にする。

import { createElement as h, useState, useEffect, useRef } from "react";
import { reviewFileOf } from "../../hooks/useWorkspaceApi.js";
import { stepById, phaseById, fmtTime } from "./plan-utils.js";
import { CheckList } from "./StepDetail.js";
import { notifyOnce, NotifyPermission } from "./notify.js";

const MAX_COMMENT_CHARS = 5000;
const MAX_COMMENTS = 100;

/**
 * @param {{ workspace: object, meta: object, model: object, api: object, dispatch: function, onShowGate: (id: string) => void }} props
 */
export function HumanReviewPanel({ workspace, meta, model, api, dispatch, onShowGate }) {
  const reason = workspace.statusReason || {};
  const gateId = reason.gateId;
  const gate = gateId ? stepById(model, gateId) : null;
  const phase = gate ? phaseById(model, gate.phaseId) : null;
  const gr = (workspace.gateResults || []).find((g) => g.gateId === gateId);
  const reviews = (workspace.humanReviews || []).filter((r) => r.gateId === gateId);
  const current = [...reviews].reverse().find((r) => r.status === "pending") || reviews[reviews.length - 1] || null;
  const past = reviews.filter((r) => r !== current && r.status !== "pending");
  const comments = (meta && meta.pendingComments) || [];

  const [open, setOpen] = useState(false);
  const [overall, setOverall] = useState("");
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const iframeRef = useRef(null);

  const reviewKey = current ? `${workspace.id}|${current.gateId}|v${current.version}` : null;

  // 新しい版が来たら自動で開く（モックと同じ。「あとで」で閉じられる）+ ブラウザ通知
  useEffect(() => {
    if (!reviewKey) return;
    setOpen(true);
    setOverall("");
    setError(null);
    notifyOnce(`hr|${reviewKey}`, "人間レビュー待ち", `${gate ? gate.title : gateId}: レビュー資料を確認してください`);
  }, [reviewKey]);

  const setComments = (list) => dispatch({ type: "workspace:set_pending_comments", data: { workspaceId: workspace.id, comments: list } });

  // iframe からの review:comment だけ受理する。reducer の関数型更新で積むので、
  // リスナーは Workspace ごとに 1 回だけ登録すればよい（毎 render で付け替えない）
  const wsId = workspace.id;
  useEffect(() => {
    const onMessage = (event) => {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const d = event.data;
      if (!d || typeof d !== "object" || d.type !== "review:comment") return;
      const sectionId = typeof d.sectionId === "string" && d.sectionId ? d.sectionId.slice(0, 200) : undefined;
      const text = typeof d.text === "string" ? d.text.slice(0, MAX_COMMENT_CHARS) : "";
      dispatch({ type: "workspace:add_pending_comment", data: { workspaceId: wsId, comment: { sectionId, text } } });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [wsId, dispatch]);

  const updateComment = (i, text) => setComments(comments.map((c, k) => (k === i ? { ...c, text: text.slice(0, MAX_COMMENT_CHARS) } : c)));
  const removeComment = (i) => setComments(comments.filter((_, k) => k !== i));

  const hasText = comments.some((c) => c.text.trim()) || overall.trim() !== "";

  const submit = async (decision) => {
    if (!current || busy) return;
    // コメントは差し戻し時だけ送る。書いたまま承認しようとしたら確認する
    if (decision === "approve" && hasText && !window.confirm("コメントは差し戻し時のみ送られます。承認しますか？")) return;
    setBusy(decision);
    setError(null);
    try {
      const body = { decision };
      if (decision === "request_changes" && overall.trim()) body.comment = overall.trim();
      const list = comments.filter((c) => c.text.trim()).map((c) => (c.sectionId ? { sectionId: c.sectionId, text: c.text.trim() } : { text: c.text.trim() }));
      if (decision === "request_changes" && list.length) body.comments = list;
      const ws = await api.review(workspace.id, current.gateId, body);
      if (ws && ws.id && ws.revisions) dispatch({ type: "workspace:updated", data: ws });
      setComments([]);
      setOverall("");
      setOpen(false);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(null);
    }
  };

  const humanChecks = gate ? gate.checks.filter((c) => c.method === "human") : [];
  const autoChecks = gate ? gate.checks.map((c, i) => ({ c, i })).filter((x) => x.c.method !== "human") : [];
  const autoPassed = gr && gr.attempts.length
    ? gr.attempts[gr.attempts.length - 1].checks.filter((c) => c.passed).length
    : 0;

  // ---- 全面表示（資料 + 判断） ----
  const overlay = open && current && h("div", { className: "rv-ov" },
    h("div", { className: "rv-top" },
      h("b", null, "👤 HUMAN REVIEW"),
      h("span", null, gate ? gate.title : gateId),
      h("span", { className: "muted" }, `${phase ? `「${phase.name}」の出口 · ` : ""}v${current.version} · 実行は停止中`),
      h("span", { className: "spacer" }),
      h("button", { className: "wbtn sm", onClick: () => setOpen(false) }, "あとで（閉じる）")),
    h("div", { className: "rv-body" },
      h("iframe", {
        ref: iframeRef,
        className: "rv-doc",
        sandbox: "allow-scripts",
        src: api.reviewUrl(workspace.id, reviewFileOf(current.docFile)),
        title: "レビュー資料",
      }),
      h("div", { className: "rv-side" },
        humanChecks.length > 0 && [
          h("div", { key: "ch", className: "rv-h" }, "判断してほしいこと"),
          humanChecks.map((c, i) => h("label", { key: i, className: "hr-chk" }, h("input", { type: "checkbox" }), c.text)),
        ],
        past.length > 0 && [
          h("div", { key: "ph", className: "rv-h" }, "これまでのやり取り"),
          past.map((r) => h("div", { key: r.version, className: "rv-past" },
            h("b", { className: r.status === "approved" ? "" : "ng" }, r.status === "approved" ? "承認" : "差し戻し"),
            ` v${r.version} `, r.comments.length ? r.comments.map((c) => `${c.sectionId ? `［${c.sectionId}］` : ""}${c.text}`).join(" / ") : "（コメントなし）")),
        ],
        h("div", { className: "rv-h" }, `節ごとのコメント（${comments.length}）`),
        comments.length === 0
          ? h("div", { className: "hint" }, "資料の各節の「コメント」ボタンで追加できます")
          : comments.map((c, i) => h("div", { key: i, className: "cm-row" },
            h("span", { className: "cm-sec" }, c.sectionId ? `［${c.sectionId}］` : "［全体］"),
            h("textarea", { value: c.text, rows: 2, spellCheck: false, placeholder: "コメントを書く", onChange: (e) => updateComment(i, e.target.value) }),
            h("button", { className: "wbtn sm", onClick: () => removeComment(i), title: "削除" }, "×"))),
        h("div", { className: "rv-h" }, "全体へのコメント"),
        h("textarea", { value: overall, spellCheck: false, placeholder: "差し戻すときは、指摘を書いてください", onChange: (e) => setOverall(e.target.value) }),
        h("div", { className: "rv-btns" },
          h("button", { className: "wbtn primary", disabled: !!busy, onClick: () => submit("approve") }, busy === "approve" ? "送信中…" : "✔ 承認して再開"),
          h("button", { className: "wbtn danger", disabled: !!busy || !hasText, onClick: () => submit("request_changes"), title: hasText ? "" : "指摘を書いてください" },
            busy === "request_changes" ? "送信中…" : "↩ 差し戻し（指摘を書く）")),
        error && h("div", { className: "ws-error" }, error),
        h("div", { className: "hint" }, "承認すると新しい Orchestrator が再開して次のフェーズへ進みます。差し戻すと AI が指摘を反映し、新しい版の資料で再レビューになります。"))));

  // ---- 上部のパネル ----
  return h("div", null,
    h("div", { className: "hr-panel" },
      h("div", { className: "hr-head" },
        h("b", null, "👤 HUMAN REVIEW"),
        h("span", null, gate ? gate.title : gateId),
        h("span", { className: "muted" }, `${phase ? `「${phase.name}」の出口 · ` : ""}AI 事前チェック ${autoPassed}/${autoChecks.length} 件 合格`),
        h("span", { className: "spacer" }),
        h("span", { className: "hr-stop" }, "実行は停止中"),
        h(NotifyPermission),
        gate && h("button", { className: "wbtn sm", onClick: () => onShowGate(gate.id) }, "ゲートを見る"),
        current
          ? h("button", { className: "wbtn sm primary", onClick: () => setOpen(true) }, `📄 レビュー資料を開く（v${current.version}）`)
          : h("span", { className: "hint" }, "レビュー資料を準備中…")),
      h("div", { className: "hr-grid" },
        h("div", null,
          h("div", { className: "hr-h" }, "自動チェックの結果"),
          gate ? h(CheckList, { checks: autoChecks.map((x) => x.c), gateResult: gr ? remapGateResult(gr, autoChecks.map((x) => x.i)) : null }) : null),
        h("div", null,
          h("div", { className: "hr-h" }, "レビューの観点"),
          humanChecks.length ? h("ul", { className: "hr-points" }, humanChecks.map((c, i) => h("li", { key: i }, c.text))) : h("div", { className: "hint" }, "—"),
          past.length > 0 && h("div", { className: "hint", style: { marginTop: 6 } },
            `過去の版: ${past.map((r) => `v${r.version} ${r.status === "approved" ? "承認" : "差し戻し"}（${fmtTime(r.resolvedAt || r.requestedAt)}）`).join(" / ")}`)))),
    overlay);
}

/** 自動チェックだけを並べるため、checkIndex を詰め直した GateResult を作る */
function remapGateResult(gr, originalIndexes) {
  const map = new Map(originalIndexes.map((orig, k) => [orig, k]));
  return {
    ...gr,
    attempts: gr.attempts.map((a) => ({
      ...a,
      checks: a.checks.filter((c) => map.has(c.checkIndex)).map((c) => ({ ...c, checkIndex: map.get(c.checkIndex) })),
    })),
  };
}
