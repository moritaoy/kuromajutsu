// ============================================================
// ReportView — ④ 完了レポート（spec §13.11）
// ============================================================
// 結果のサマリを最上部に置き、途中の経過は折りたたみに入れる。

import { createElement as h, useState } from "react";
import { Markdown } from "./Markdown.js";
import { GateChangeDiff } from "./IrregularBanner.js";
import { fmtDuration, fmtTime, fmtDateTime, truncate, METHOD_LABEL } from "./plan-utils.js";

const STEP_STATUS = { completed: "完了", done: "完了", skipped: "スキップ", in_progress: "実行中", pending: "未着手" };
const TL_COLOR = {
  "gate-pass": "var(--accent-green)", "gate-fail": "var(--accent-red)", replan: "var(--accent-purple)", plan: "var(--accent-purple)",
  irregular: "var(--accent-red)", human: "var(--accent-blue)", "human-ok": "var(--accent-blue)", "human-ng": "var(--accent-red)", rework: "#ffa657",
};

function Section({ label, children, hint }) {
  return h("div", { className: "res-sec" }, h("div", { className: "res-h" }, label, hint), children);
}

function FileList({ files, mark, cls }) {
  return files.map((f) => h("div", { key: `${mark}${f}` }, h("code", null, f), h("span", { className: cls }, mark)));
}

function IrregularBlock({ change, busy, onAck }) {
  const title = (change.after && change.after.title) || (change.before && change.before.title) || change.gateId;
  const acked = !!change.acknowledgedAt;
  return h("div", { className: "irr-item2" },
    h("div", null, h("b", null, `${title}（${change.gateId}）`), " のゲートを AI が変更"),
    h("div", { className: "hint" }, `理由: ${change.reason}`),
    h(GateChangeDiff, { change }),
    h("button", { className: "wbtn sm", disabled: acked || busy === change.id, onClick: () => onAck(change) }, acked ? "確認済み" : "確認した"));
}

/** 経過（折りたたみ） */
function Progress({ report, plan }) {
  const p = report.progress || { phases: [], timeline: [], gateResults: [], stats: {} };
  const stats = p.stats || {};
  const stepOf = (id) => (plan ? plan.steps.find((s) => s.id === id) : null);
  return h("details", { className: "proc" },
    h("summary", null, "作業の経過",
      h("span", { className: "hint" }, ` — ${(p.phases || []).length} フェーズ · ${stats.steps ?? "—"} 手順 · ゲート ${stats.gates ?? "—"} · 反復 ${stats.iterations ?? "—"} · ${fmtDuration(stats.duration_ms)}`)),
    h("div", { className: "kpis" },
      [["手順", stats.steps], ["ゲート", stats.gates], ["反復", stats.iterations], ["所要時間", fmtDuration(stats.duration_ms)]].map(([k, v]) =>
        h("div", { key: k, className: "kpi" }, h("b", null, v ?? "—"), h("span", null, k)))),
    h("h3", null, "フェーズ別の手順"),
    (p.phases || []).map((ph) => h("div", { key: ph.phaseId, className: "lane-sum" },
      h("h4", null, ph.name, h("span", { className: "wbadge" }, `${ph.steps.length} 手順`)),
      ph.steps.map((s) => h("div", { key: s.stepId, className: "res" },
        h("div", { className: "rt" }, h("span", { className: "sid" }, s.stepId), s.title, h("span", { className: "role" }, h("i"), s.role), h("span", { className: "hint" }, STEP_STATUS[s.status] || s.status)))))),
    h("h3", null, "出来事の時系列"),
    (p.timeline || []).length === 0
      ? h("div", { className: "hint" }, "記録なし")
      : h("div", { className: "timeline" }, p.timeline.map((l, i) =>
        h("div", { key: i, className: "tl", style: { "--tc": TL_COLOR[l.kind] || "var(--border-hover)" } },
          h("span", { className: "tt" }, fmtDateTime(l.at)), l.text))),
    h("h3", null, "ゲート結果"),
    h("div", { className: "gres" }, (p.gateResults || []).map((g) => {
      const step = stepOf(g.gateId);
      const failedN = g.attempts.filter((a) => a.checks.some((c) => !c.passed)).length;
      const last = g.attempts[g.attempts.length - 1];
      return h("div", { key: g.gateId, className: "g" },
        h("h4", null, h("span", null, step ? step.title : g.gateId), h("span", { className: `vi ${g.status === "passed" ? "ok" : "error"}` }, (failedN ? `${failedN} 回不合格 → ` : "") + (g.status === "passed" ? "合格" : g.status))),
        step && step.checks.some((c) => c.method === "human") && h("div", { className: "hint", style: { color: "var(--accent-blue)" } }, "👤 人間レビュー"),
        step ? step.checks.map((c, i) => {
          const r = last ? last.checks.find((x) => x.checkIndex === i) : null;
          const ok = c.method === "human" ? g.status === "passed" : r ? r.passed : false;
          return h("div", { key: i, className: `ci ${ok ? "pass" : ""}` }, h("span", { className: `vi ${ok ? "ok" : "error"}` }, ok ? "✔" : "✖"), c.text, h("span", { className: "hint" }, ` [${METHOD_LABEL[c.method] || c.method}]`));
        }) : (last ? last.checks.map((r, i) => h("div", { key: i, className: `ci ${r.passed ? "pass" : ""}` }, h("span", { className: `vi ${r.passed ? "ok" : "error"}` }, r.passed ? "✔" : "✖"), `${r.method} #${r.checkIndex}`)) : null));
    })));
}

/**
 * @param {{ workspace: object, config: object, api: object, dispatch: function }} props
 */
export function ReportView({ workspace, api, dispatch }) {
  const report = workspace.report;
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const plan = workspace.approvedRevision ? workspace.revisions[workspace.approvedRevision - 1] : workspace.revisions[workspace.revisions.length - 1];

  if (!report) {
    return h("div", { className: "report" },
      h("div", { className: "res-hero" }, h("div", { className: "ok" }, "✓"),
        h("div", null, h("div", { className: "res-k" }, "完了"), h("h2", null, plan ? plan.title : workspace.instruction))),
      h("div", { className: "empty-box" }, "レポートなし"));
  }

  // 確認状況は実行中のデータ（gateChanges）が最新。レポート生成時点のものと突き合わせる
  const liveChanges = workspace.gateChanges || [];
  const irregulars = (report.irregulars || []).map((c) => liveChanges.find((x) => x.id === c.id) || c);
  const unack = irregulars.filter((c) => !c.acknowledgedAt);
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

  const created = (report.changedFiles && report.changedFiles.createdFiles) || [];
  const edited = (report.changedFiles && report.changedFiles.editedFiles) || [];
  const stats = (report.progress && report.progress.stats) || {};
  const assumptions = (plan && plan.spec && plan.spec.assumptions) || [];
  const completion = report.completion || [];
  const unmet = completion.filter((c) => !c.achieved).length;

  return h("div", { className: "report" },
    h("div", { className: "res-hero" },
      h("div", { className: "ok" }, "✓"),
      h("div", null,
        h("div", { className: "res-k" }, `完了 · ${fmtDateTime(report.generatedAt)}${stats.duration_ms ? ` · 所要 ${fmtDuration(stats.duration_ms)}` : ""}`),
        h("h2", null, plan ? plan.title : truncate(workspace.instruction, 60)))),

    // ---- 結果のサマリ（最上部） ----
    h("div", { className: "res-card" },
      h(Section, { label: "何が実装されたか" }, report.summary ? h(Markdown, { text: report.summary }) : h("div", { className: "hint" }, "記載なし")),
      report.howToTry && h(Section, { label: "試し方" }, h(Markdown, { text: report.howToTry })),
      h(Section, {
        label: "変更したファイル",
        hint: h("span", { className: "hint" }, ` ${created.length + edited.length} ファイル · `, h("span", { className: "a" }, `新規 ${created.length}`), " / ", h("span", { className: "m" }, `編集 ${edited.length}`)),
      }, created.length + edited.length === 0
        ? h("div", { className: "hint" }, "変更したファイルはありません")
        : h("div", { className: "flist" },
          h(FileList, { files: created, mark: "新規", cls: "a" }),
          h(FileList, { files: edited, mark: "編集", cls: "m" }))),
      h(Section, { label: "あなたが判断したこと" },
        (report.humanDecisions || []).length
          ? h("ul", { className: "decl" }, report.humanDecisions.map((t, i) => h("li", { key: i }, t)))
          : h("div", { className: "hint" }, "人間レビューはありませんでした")),
      h(Section, { label: "完了条件の達成", hint: unmet ? h("span", { className: "hint", style: { color: "var(--accent-red)" } }, ` 未達 ${unmet} 件`) : null },
        completion.length
          ? completion.map((c, i) => h("div", { key: i, className: `ci ${c.achieved ? "pass" : ""}` },
            h("span", { className: `vi ${c.achieved ? "ok" : "error"}` }, c.achieved ? "✔" : "✖"),
            h("span", null, c.criterion, c.note ? h("span", { className: "hint" }, ` — ${c.note}`) : null)))
          : h("div", { className: "hint" }, "完了条件の記載なし"))),

    // ---- 確認しておくと良いこと ----
    (unack.length > 0 || irregulars.length > 0 || report.notes || assumptions.length > 0) && h("div", { className: `res-warn${unack.length ? " hot" : ""}` },
      h("div", { className: "res-h" }, unack.length ? `⚠ 確認が必要なこと（未確認のイレギュラー ${unack.length} 件）` : "確認しておくと良いこと"),
      irregulars.map((c) => h(IrregularBlock, { key: c.id, change: c, busy, onAck: ack })),
      error && h("div", { className: "ws-error" }, error),
      report.notes && h(Markdown, { text: report.notes }),
      assumptions.length > 0 && h("div", { className: "note-row" }, h("b", null, "AI が置いた前提: "), assumptions.join(" / "))),

    h("div", { className: "res-actions" },
      h("button", { className: "wbtn primary", onClick: () => { window.location.hash = "#/workspace"; } }, "新しい指示を書く")),

    // ---- 経過（折りたたみ） ----
    h(Progress, { report, plan }));
}
