// ============================================================
// RunView — ③ 実行（running / waiting_human）
// ============================================================
// 同じボードに状態を重ねる。サイドに Orchestrator の現在・活動ログ・進捗台帳・ゲート結果を出す。
// waiting_human のときは、上部に人間レビュー / 再試行のパネルを出す。

import { createElement as h, useState, useMemo } from "react";
import { PlanBoard, BoardLegend, RoleChip } from "./PlanBoard.js";
import { DetailFor } from "./StepDetail.js";
import { HumanReviewPanel } from "./HumanReviewPanel.js";
import { RetryPanel } from "./RetryPanel.js";
import { IrregularBanner } from "./IrregularBanner.js";
import { modelFromLedger, modelFromPlan, fmtTime, truncate, isHuman, checkResultOf, STATUS_LABEL } from "./plan-utils.js";

// --------------------------------------------------
// 活動ログ: workspace:* イベント + このワークスペースに紐付く Agent
// --------------------------------------------------

/** この Workspace の Agent（グループの workspaceId、または Magentic 親グループ配下の子グループ） */
function agentsOfWorkspace(state, workspace) {
  const groupIds = new Set();
  for (const g of Object.values(state.groups || {})) {
    if (g.workspaceId === workspace.id) groupIds.add(g.id);
    if (workspace.groupId && (g.id === workspace.groupId || g.parentGroupId === workspace.groupId)) groupIds.add(g.id);
  }
  if (workspace.groupId) groupIds.add(workspace.groupId);
  return Object.values(state.agents || {}).filter((a) => groupIds.has(a.groupId));
}

const DONE_AGENT = new Set(["completed", "resultReported"]);

/**
 * Workspace に永続化されたデータ（ゲート結果・人間レビュー・イレギュラー）から作る活動。
 * 再読み込みしても経過が残るようにするため。
 */
function persistedActivity(workspace) {
  const items = [];
  for (const g of workspace.gateResults || []) {
    for (const a of g.attempts || []) {
      const at = a.closedAt || (a.checks.length ? a.checks[a.checks.length - 1].at : null);
      if (!at) continue;
      const passed = a.checks.filter((c) => c.passed).length;
      const ok = a.checks.length > 0 && passed === a.checks.length;
      items.push({
        key: `pg-${g.gateId}-${a.attempt}`, at, kind: ok ? "gate-pass" : "gate-fail", stepId: g.gateId, persisted: true,
        text: `${g.gateId} attempt ${a.attempt}: ${ok ? "自動チェック合格" : "不合格"}（${passed}/${a.checks.length}）`,
      });
    }
  }
  for (const r of workspace.humanReviews || []) {
    items.push({ key: `ph-${r.gateId}-${r.version}-r`, at: r.requestedAt, kind: "human", stepId: r.gateId, persisted: true, text: `人間レビュー待ち: ${r.gateId}（v${r.version}）` });
    if (r.resolvedAt) {
      const ok = r.status === "approved";
      items.push({ key: `ph-${r.gateId}-${r.version}-d`, at: r.resolvedAt, kind: ok ? "human-ok" : "human-ng", stepId: r.gateId, persisted: true, text: `人間レビュー ${r.gateId} v${r.version}: ${ok ? "承認" : "差し戻し"}` });
    }
  }
  for (const c of workspace.gateChanges || []) {
    items.push({ key: `pc-${c.id}`, at: c.at, kind: "irregular", stepId: c.gateId, persisted: true, text: `イレギュラー: ゲート ${c.gateId} が変更された（${truncate(c.reason, 80)}）` });
  }
  return items;
}

/** イベント由来のログと同じ種類・同じ対象が近い時刻にあれば、永続データ由来のほうを捨てる */
const DEDUPE_MS = 15000;
function dedupe(persisted, events) {
  const bucket = new Map();
  for (const e of events) {
    const k = `${e.kind}|${e.stepId || ""}`;
    (bucket.get(k) || bucket.set(k, []).get(k)).push(new Date(e.at).getTime());
  }
  return persisted.filter((p) => {
    const ts = bucket.get(`${p.kind}|${p.stepId || ""}`);
    if (!ts) return true;
    const t0 = new Date(p.at).getTime();
    return !ts.some((t) => Math.abs(t - t0) <= DEDUPE_MS);
  });
}

export function buildActivity(state, workspace) {
  const events = [];
  (state.workspaceLog[workspace.id] || []).forEach((l, i) => events.push({ key: `w${i}`, at: l.at, kind: l.kind, text: l.text, stepId: l.stepId }));
  const items = [...events, ...dedupe(persistedActivity(workspace), events)];
  for (const a of agentsOfWorkspace(state, workspace)) {
    items.push({ key: `a${a.agentId}s`, at: a.startedAt, kind: "dispatch", text: `${a.role} を起動（${a.agentId}）` });
    if (DONE_AGENT.has(a.status) || a.status === "failed" || a.status === "timeout" || a.status === "cancelled") {
      const end = new Date(new Date(a.startedAt).getTime() + (a.elapsed_ms || 0)).toISOString();
      const ok = DONE_AGENT.has(a.status);
      const summary = a.result && a.result.summary ? ` — ${truncate(a.result.summary, 100)}` : "";
      items.push({ key: `a${a.agentId}e`, at: end, kind: ok ? "report" : "gate-fail", text: `${a.role} ${ok ? "完了" : a.status}${summary}` });
    }
  }
  return items.sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime());
}

const KIND_CLASS = { "gate-pass": "gp", "gate-fail": "gf", "human-ok": "human-ok", "human-ng": "human-ng" };

function ActivityPane({ items, onSelect }) {
  if (items.length === 0) return h("div", { className: "empty" }, "まだ活動がありません");
  return h("div", { className: "rail-pane log" }, items.slice(0, 200).map((l) =>
    h("div", {
      key: l.key,
      className: l.kind === "irregular" ? "hl-irr" : l.kind === "replan" ? "hl-rep" : "",
      style: l.stepId ? { cursor: "pointer" } : null,
      onClick: l.stepId ? () => onSelect(l.stepId) : null,
    },
    h("span", { className: "t" }, fmtTime(l.at)),
    h("span", { className: `k ${KIND_CLASS[l.kind] || l.kind}` }, l.kind),
    h("span", null, l.text))));
}

// --------------------------------------------------
// 進捗台帳
// --------------------------------------------------

function LedgerEntry({ e }) {
  const rows = [
    ["充足", e.isRequestSatisfied, e.isRequestSatisfied.answer],
    ["ループ", e.isInLoop, e.isInLoop.answer ? "w" : false],
    ["進捗", e.isProgressBeingMade, e.isProgressBeingMade.answer],
  ];
  return h("div", { className: "led" },
    h("h5", null, h("span", null, `ITER #${e.iteration}`), h("span", null, fmtTime(e.updatedAt))),
    rows.map(([label, v, on]) => h("div", { key: label, className: "jd" },
      h("span", { className: "jl" }, label),
      h("span", { className: `a ${on === "w" ? "w" : on ? "t" : "f"}` }, v.answer ? "YES" : "NO"),
      h("span", null, v.reason))),
    h("div", { className: "jd" }, h("span", { className: "jl" }, "次"), h("span"), h("span", null, e.nextAction.answer)),
    h("div", { className: "jd" }, h("span", { className: "jl" }, "指示"), h("span"), h("span", { className: "muted" }, truncate(e.instruction.answer, 240))));
}

function ProgressPane({ ledger }) {
  const cur = ledger && ledger.progressLedger;
  const hist = (ledger && ledger.progressHistory) || [];
  const all = [...hist];
  if (cur && !all.some((x) => x.iteration === cur.iteration)) all.push(cur);
  all.sort((a, b) => b.iteration - a.iteration);
  if (all.length === 0) return h("div", { className: "empty" }, "まだ反復がありません");
  return h("div", { className: "rail-pane" }, all.map((e) => h(LedgerEntry, { key: e.iteration, e })));
}

// --------------------------------------------------
// ゲート結果
// --------------------------------------------------

function GatesPane({ model, onSelect }) {
  const gates = model.steps.filter((s) => s.kind === "gate");
  if (gates.length === 0) return h("div", { className: "empty" }, "ゲートがありません");
  const stateLabel = (g) => (g.status === "done" ? "PASS" : g.status === "waiting" ? "👤 WAITING" : g.status === "running" ? "CHECK…" : g.gateFailed ? "FAIL → 修正" : "—");
  return h("div", { className: "rail-pane" }, gates.map((g) => h("div", { key: g.id, className: `dodg${g.irregular ? " irr" : ""}`, onClick: () => onSelect(g.id) },
    h("div", { className: "gh" },
      h("span", null, `${g.id} ${g.title}`, g.irregular ? h("span", { className: "tag irregular", style: { marginLeft: 6 } }, "⚠ 変更済") : null),
      h("span", null, stateLabel(g))),
    g.checks.map((c, i) => {
      let st = "";
      if (c.method === "human") {
        st = g.status === "done" ? "pass" : g.status === "waiting" ? "run" : "";
      } else {
        const r = checkResultOf(g.gateResult, i);
        st = r ? (r.passed ? "pass" : "fail") : g.status === "running" ? "run" : "";
      }
      return h("div", { key: i, className: `ci ${st}` },
        h("span", { className: `vi ${st === "pass" ? "ok" : st === "fail" ? "error" : ""}` }, st === "pass" ? "✔" : st === "fail" ? "✖" : st === "run" ? "◔" : "○"),
        c.text);
    }))));
}

// --------------------------------------------------
// 画面
// --------------------------------------------------

/**
 * @param {{ workspace: object, meta: object, config: object, state: object, api: object, dispatch: function }} props
 */
export function RunView({ workspace, meta, config, state, api, dispatch }) {
  const ledger = workspace.groupId ? state.ledgers[workspace.groupId] : null;
  const model = useMemo(() => modelFromLedger(workspace, ledger, meta), [workspace, ledger, meta]);
  const [selectedId, setSelectedId] = useState(null);
  const [tab, setTab] = useState("log");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const approved = workspace.approvedRevision ? workspace.revisions[workspace.approvedRevision - 1] : null;
  const total = model.steps.length;
  const done = model.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  const running = model.steps.filter((s) => s.status === "running");
  const gates = model.steps.filter((s) => s.kind === "gate");
  const gatesDone = gates.filter((g) => g.status === "done").length;
  const prog = workspace.groupId ? state.magenticProgress[workspace.groupId] : null;
  const iteration = prog ? prog.iteration : ledger && ledger.progressLedger ? ledger.progressLedger.iteration : 0;
  const maxIter = prog ? prog.maxIterations : approved ? approved.maxIterations : null;
  const waiting = workspace.status === "waiting_human";
  const code = workspace.statusReason && workspace.statusReason.code;
  const now = ledger && ledger.progressLedger;

  const activity = useMemo(() => buildActivity(state, workspace), [state.workspaceLog, state.agents, state.groups, workspace]);

  const abort = async () => {
    if (busy || !window.confirm("実行を中断しますか？")) return;
    setBusy(true);
    setError(null);
    try {
      const ws = await api.abort(workspace.id);
      if (ws && ws.id && ws.revisions) dispatch({ type: "workspace:updated", data: ws });
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const tabs = [["log", "活動"], ["progress", "進捗台帳"], ["gates", `ゲート ${gatesDone}/${gates.length}`]];
  const pane = tab === "log" ? h(ActivityPane, { items: activity, onSelect: setSelectedId })
    : tab === "progress" ? h(ProgressPane, { ledger })
      : h(GatesPane, { model, onSelect: setSelectedId });

  const plan = approved;
  return h("div", null,
    waiting && code === "human_review" && h(HumanReviewPanel, { workspace, meta, model, api, dispatch, onShowGate: setSelectedId }),
    waiting && code === "gate_retry_exceeded" && h(RetryPanel, { workspace, model, api, dispatch, onShowGate: setSelectedId }),
    h(IrregularBanner, { workspace, api, dispatch, onShowGate: setSelectedId }),
    h("div", { className: "runbar" },
      h("span", { className: "rb-title" }, plan ? plan.title : workspace.instruction),
      plan && h("span", { className: "wbadge" }, `rev ${plan.revision}`),
      waiting ? h("span", { className: "wbadge waitb" }, "👤 WAITING HUMAN") : h("span", { className: "wbadge live" }, "● RUNNING"),
      h("div", { className: "meter" }, h("div", { style: { width: `${total ? (done / total) * 100 : 0}%` } })),
      h("span", { className: "rb-stat" },
        `${done}/${total}`, h("small", null, "DONE"),
        `${running.length}`, h("small", null, "RUN"),
        `${iteration}${maxIter ? `/${maxIter}` : ""}`, h("small", null, "ITER"),
        meta && meta.replanCount ? [String(meta.replanCount), h("small", { key: "rp", style: { color: "var(--accent-purple)" } }, "REPLAN")] : null,
        (workspace.gateChanges || []).length ? [String(workspace.gateChanges.length), h("small", { key: "ir", style: { color: "var(--accent-red)" } }, "IRREG")] : null),
      h("button", { className: "wbtn sm danger", disabled: busy, onClick: abort }, "■ 中断")),
    error && h("div", { className: "ws-error" }, error),
    h("div", { className: "runlayout" },
      h("div", { className: "board-box" },
        h("div", { className: "board-head" },
          h("span", { className: "muted", style: { fontSize: 12 } }, "計画表（Task Ledger）— 上から下へ実行"), h(BoardLegend)),
        h("div", { className: "board-wrap" },
          h(PlanBoard, { model, config, mode: "run", selectedId, onSelect: setSelectedId }))),
      h("div", { className: "rail" },
        h("div", { className: "orch" },
          h("div", { className: "orch-h" }, h(RoleChip, { config, role: "orchestrator" }),
            h("span", { className: "muted" }, waiting ? "人の判断待ち（停止中）" : running.length ? "委任・監視中" : "判定中")),
          h("div", { className: "orch-now" }, now ? now.nextAction.answer : "起動中…"),
          running.length > 0 && h("div", { className: "orch-run" }, running.map((s) => h("span", { key: s.id, className: "chip", onClick: () => setSelectedId(s.id) }, h(RoleChip, { config, role: s.role }), s.id)))),
        h("div", { className: "rail-box" },
          h("div", { className: "tabs" }, tabs.map(([k, l]) => h("div", { key: k, className: `tab${tab === k ? " active" : ""}`, onClick: () => setTab(k) }, l))),
          pane))),
    selectedId && h("div", { className: "drawer" },
      h("div", { className: "body sel-sec" },
        h(DetailFor, { model, id: selectedId, config, workspace, onSelect: setSelectedId, onClose: () => setSelectedId(null) }))));
}

// --------------------------------------------------
// 読み取り専用（failed / aborted など、最後の状態をボードで見る）
// --------------------------------------------------

export function ReadonlyBoard({ workspace, meta, config, state }) {
  const ledger = workspace.groupId ? state.ledgers[workspace.groupId] : null;
  const model = useMemo(() => {
    if (workspace.approvedRevision) return modelFromLedger(workspace, ledger, meta);
    const last = workspace.revisions[workspace.revisions.length - 1];
    return last ? modelFromPlan(last) : null;
  }, [workspace, ledger, meta]);
  const [selectedId, setSelectedId] = useState(null);
  if (!model || model.phases.length === 0) return null;
  const mode = workspace.approvedRevision ? "run" : "view";
  return h("div", null,
    h("div", { className: "board-box" },
      h("div", { className: "board-head" },
        h("span", { className: "muted", style: { fontSize: 12 } }, `最後の計画表（${STATUS_LABEL[workspace.status] || workspace.status}・読み取り専用）`),
        mode === "run" && h(BoardLegend)),
      h("div", { className: "board-wrap" }, h(PlanBoard, { model, config, mode, selectedId, onSelect: setSelectedId }))),
    selectedId && h("div", { className: "drawer" },
      h("div", { className: "body sel-sec" },
        h(DetailFor, { model, id: selectedId, config, workspace, onSelect: setSelectedId, onClose: () => setSelectedId(null) }))));
}
