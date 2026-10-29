// ============================================================
// ReviewView — ② 計画レビュー
// ============================================================
// 人は計画を編集しない。ボードでカードを選び（= 指示の対象）、下の欄から AI に指示する。
// サイドは「解釈」（PlanSpec）・検証結果（V1〜V9）・改訂履歴。

import { createElement as h, useState, useMemo, useRef, useEffect } from "react";
import { PlanBoard, BoardFoot, RoleChip } from "./PlanBoard.js";
import { DetailFor } from "./StepDetail.js";
import { ActionBar } from "./ActionBar.js";
import {
  modelFromPlan, diffPlans, summarizeRevision, validationRows, isHuman, computeLevels, roleInfo,
} from "./plan-utils.js";

// --------------------------------------------------
// ヘッダー
// --------------------------------------------------

function ReviewHead({ plan, model, config }) {
  const works = plan.steps.filter((s) => s.kind === "work").length;
  const gates = plan.steps.filter((s) => s.kind === "gate").length;
  const { levels } = computeLevels(model);
  const widths = {};
  model.steps.filter((s) => s.kind === "work").forEach((s) => {
    const k = `${s.phaseId}:${levels[s.id]}`;
    widths[k] = (widths[k] || 0) + 1;
  });
  const par = Math.max(0, ...Object.values(widths));
  const mains = plan.phases.filter((p) => !p.final && !p.parentPhaseId);
  const deferred = mains.filter((p) => p.planning === "deferred").length;
  const orch = roleInfo(config, "orchestrator");
  return h("div", { className: "rhead" },
    h("h2", null, plan.title),
    h("span", { className: "rev" }, `rev ${plan.revision}`),
    plan.goal && plan.goal !== plan.title && h("span", { className: "goal" }, plan.goal),
    h("div", { className: "sum" },
      h("span", null, h("b", null, mains.length), " PHASES", h("span", { style: { color: "var(--accent-purple)" } }, ` (未決定 ${deferred})`)),
      h("span", null, "👤 ", h("b", null, plan.steps.filter(isHuman).length), " HUMAN"),
      h("span", null, h("b", null, works), " STEPS"),
      h("span", null, h("b", null, gates), " GATES"),
      h("span", null, "MAX ∥ ", h("b", null, par)),
      h("span", null, "ITER ≤ ", h("b", null, plan.maxIterations)),
      orch.known && h("span", null, "ORCH ", h("b", null, "orchestrator"), h("span", { style: { opacity: 0.7 } }, ` ${orch.model}`))));
}

// --------------------------------------------------
// サイド
// --------------------------------------------------

function SelectedSection({ model, id, config, workspace, targeted, onToggleTarget, onSelect, onClose }) {
  const exists = !!id && (model.steps.some((s) => s.id === id) || model.phases.some((p) => p.id === id));
  if (!exists) {
    return h("div", { className: "sel-empty" }, "○ フェーズの見出し・手順・ゲートをクリック → 指示の対象に追加・詳細を表示。対象なしの指示は計画全体へ。");
  }
  return h("div", { className: "sec sel-sec" },
    h(DetailFor, { model, id, config, workspace, onSelect, onClose }),
    h("div", { className: "act" },
      h("button", { className: `tbtn${targeted ? " on" : ""}`, onClick: () => onToggleTarget(id) }, targeted ? "◉ 指示の対象（外す）" : "○ 指示の対象にする"),
      h("span", { className: "hint" }, targeted ? "下の欄に定型指示が出ています。⌘/Ctrl+Enter で送信" : "対象にすると、下の欄に定型指示が出ます")));
}

function SpecSection({ spec, onAskAssumption }) {
  const li = (arr, cls) => h("ul", null, (arr || []).map((x, i) => h("li", { key: i, className: cls }, x)));
  return h("div", { className: "sec" },
    h("h4", null, "解釈", h("span", { className: "hint", style: { textTransform: "none", letterSpacing: 0, fontWeight: 400 } }, "AI が指示から導出 · 直すには追加指示")),
    h("dl", { className: "kv2" },
      h("dt", { className: "jp" }, "作業場所"), h("dd", { className: "mono" }, spec.workspace || "—"),
      h("dt", { className: "jp" }, "触ってよい範囲"), h("dd", { className: "mono" }, li(spec.scope)),
      h("dt", { className: "jp" }, "守ること"), h("dd", null, li(spec.constraints)),
      h("dt", { className: "jp" }, "完了の条件"), h("dd", null, li(spec.completion)),
      h("dt", { className: "jp" }, h("span", { className: "asmh" }, "AI の前提")),
      h("dd", null,
        spec.assumptions && spec.assumptions.length
          ? h("ul", null, spec.assumptions.map((a, i) => h("li", { key: i, className: "asm", title: "クリックで「この前提は違う」と指示する", onClick: () => onAskAssumption(a) }, a)))
          : "—",
        h("div", { className: "hint", style: { marginTop: 3 } }, "? = AI が置いた前提。確認してください"))));
}

function ValidationSection({ rows, loading }) {
  const errs = rows.filter((r) => r.level === "error").length;
  const warns = rows.filter((r) => r.level === "warning").length;
  const okN = rows.filter((r) => r.level === "ok").length;
  const st = errs ? "error" : warns ? "warn" : "ok";
  const icon = (lv) => (lv === "ok" ? "✔" : lv === "error" ? "✖" : "▲");
  const cls = (lv) => (lv === "warning" ? "warn" : lv);
  return h("details", { className: "sec val", open: errs + warns > 0 || undefined },
    h("summary", null,
      h("span", { className: `vi ${st}` }, errs ? "✖" : warns ? "▲" : "✔"),
      h("span", { className: `st ${st}` }, loading ? "検証を取得中…" : errs ? `検証 エラー ${errs}` : warns ? `検証 警告 ${warns}` : `検証 ${okN}/${rows.length} OK`),
      errs && warns ? h("span", { className: "hint" }, `· 警告 ${warns}`) : null,
      h("span", { className: "tw" }, "▸")),
    h("div", { className: "rows" }, rows.map((r, i) => h("div", { key: i, className: "vrow" },
      h("span", { className: `vi ${cls(r.level)}` }, icon(r.level)),
      h("span", { style: r.level === "ok" ? { color: "var(--text-secondary)" } : null },
        h("b", { className: "rule" }, r.rule), " ", r.text, r.autoFixed ? h("span", { className: "hint" }, "（自動修正済み）") : null)))),
    errs > 0 && h("div", { className: "hint", style: { marginTop: 4 } }, "エラーが 0 件になるまで承認できません。追加指示で直してください"));
}

/** 検証結果を取得できなかったときの表示（再取得ボタン付き） */
function ValidationFailed({ onRetry }) {
  return h("div", { className: "sec val-failed" },
    h("div", { className: "vrow" }, h("span", { className: "vi error" }, "✖"), h("span", null, "検証を取得できません。承認するには検証結果が必要です")),
    h("div", { className: "fixrow" }, h("button", { className: "q", onClick: onRetry }, "再取得")));
}

function HistorySection({ workspace, meta }) {
  const revs = workspace.revisions;
  const instrs = (meta && meta.instructions) || [];
  const items = revs.map((plan, i) => ({
    plan,
    lines: summarizeRevision(i > 0 ? revs[i - 1] : null, plan),
    // この revision を生んだ指示（このセッションで送ったものだけ分かる）
    instr: i === 0 ? { text: workspace.instruction, targets: [] } : instrs.find((x) => x.baseRevision === i) || null,
  }));
  const recent = items.slice(-2);
  const older = items.slice(0, -2);
  const render = (it) => [
    it.instr && h("div", { key: `y${it.plan.revision}`, className: "you" },
      h("span", { className: "caret" }, ">"),
      it.instr.targets && it.instr.targets.length ? h("span", { className: "tg" }, it.instr.targets.map((t) => `@${t.id}`).join(" ")) : null,
      h("span", null, it.instr.text)),
    h("div", { key: `p${it.plan.revision}`, className: "pl" },
      h("div", { className: "rv" }, `REV ${it.plan.revision} · PLANNER`),
      h("ul", null, it.lines.map((x, i) => h("li", { key: i }, x)))),
  ];
  return h("div", { className: "sec hist" },
    h("h4", null, "改訂履歴", h("span", null, `rev ${revs.length}`)),
    recent.map(render),
    older.length > 0 && h("details", null,
      h("summary", null, `▸ 以前の改訂（${older.length}）`),
      older.map(render)));
}

// --------------------------------------------------
// 画面
// --------------------------------------------------

/**
 * @param {{ workspace: object, meta: object, config: object, api: object, dispatch: function, onAborted?: function }} props
 */
export function ReviewView({ workspace, meta, config, api, dispatch, state }) {
  const serverStatus = state ? state.serverStatus : undefined;
  const revs = workspace.revisions;
  const plan = revs[revs.length - 1];
  const prev = revs.length > 1 ? revs[revs.length - 2] : null;

  const model = useMemo(() => modelFromPlan(plan, prev ? diffPlans(prev, plan) : null), [plan, prev]);
  const [selectedId, setSelectedId] = useState(null);
  const [targets, setTargets] = useState([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  // 再計画が失敗して review に戻ったら、送った指示を入力欄（と対象）に戻す
  const failedInstruction = meta && meta.failedInstruction;
  useEffect(() => {
    if (!failedInstruction) return;
    setText((cur) => (cur.trim() ? cur : failedInstruction.text));
    setTargets((failedInstruction.targets || []).map((x) => x.id).filter((id) => model.steps.some((s) => s.id === id) || model.phases.some((p) => p.id === id)));
    dispatch({ type: "workspace:clear_failed_instruction", data: { workspaceId: workspace.id } });
  }, [failedInstruction]);

  // 検証結果が無い（直接開いた / WS を取り逃した）ときは GET で取り込む。
  // 失敗したら「再取得」を出す。WebSocket の再接続時にも取り直す
  const validationFresh = meta && meta.validation && meta.validationRevision === revs.length;
  const [valError, setValError] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  useEffect(() => {
    if (validationFresh) { setValError(false); return undefined; }
    let cancelled = false;
    setValError(false);
    api.get(workspace.id)
      .then((ws) => { if (!cancelled) dispatch({ type: "workspace:loaded", data: ws }); })
      .catch(() => { if (!cancelled) setValError(true); });
    return () => { cancelled = true; };
  }, [workspace.id, revs.length, validationFresh, serverStatus, reloadTick, api, dispatch]);
  // 再接続（切断 → 接続）のときは、取得済みでも最新の検証結果を取り直す
  const prevStatus = useRef(serverStatus);
  useEffect(() => {
    const was = prevStatus.current;
    prevStatus.current = serverStatus;
    if (was === "disconnected" && serverStatus === "connected") {
      api.get(workspace.id).then((ws) => dispatch({ type: "workspace:loaded", data: ws })).catch(() => {});
    }
  }, [serverStatus, workspace.id, api, dispatch]);

  const rows = validationRows(validationFresh ? meta.validation : []);
  const errors = validationFresh ? rows.filter((r) => r.level === "error").length : null;

  const toggleTarget = (id) => {
    setTargets((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
    setSelectedId(id);
  };
  const askAssumption = (a) => {
    setTargets([]);
    setSelectedId(null);
    setText(`前提「${a}」は違う。正しくは: `);
    setTimeout(() => { if (inputRef.current) inputRef.current.focus(); }, 0);
  };

  const replan = async () => {
    const instruction = text.trim();
    if (!instruction || busy) return;
    const targetList = targets.map((id) => {
      const s = model.steps.find((x) => x.id === id);
      return { kind: s ? (s.kind === "gate" ? "gate" : "step") : "phase", id };
    });
    setBusy(true);
    setError(null);
    try {
      const ws = await api.replan(workspace.id, { instruction, targets: targetList });
      dispatch({ type: "workspace:local_instruction", data: { workspaceId: workspace.id, text: instruction, targets: targetList, at: new Date().toISOString(), baseRevision: revs.length } });
      if (ws && ws.id) dispatch({ type: "workspace:updated", data: ws });
      setText("");
      setTargets([]);
      setSelectedId(null);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const approve = async (maxIterations) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const ws = await api.approve(workspace.id, { maxIterations });
      if (ws && ws.id) dispatch({ type: "workspace:updated", data: ws });
    } catch (e) {
      const issues = e.issues && e.issues.length ? `（${e.issues.map((i) => i.message || String(i)).join(" / ")}）` : "";
      setError(`${e.message || String(e)}${issues}`);
    } finally {
      setBusy(false);
    }
  };

  const abort = async () => {
    if (busy || !window.confirm("この Workspace を中断しますか？")) return;
    setBusy(true);
    setError(null);
    try {
      const ws = await api.abort(workspace.id);
      if (ws && ws.id) dispatch({ type: "workspace:updated", data: ws });
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const detailProps = { model, id: selectedId, config, workspace, onSelect: setSelectedId, onClose: () => setSelectedId(null) };

  return h("div", { className: "review" },
    meta && meta.lastPlanError && h("div", { className: "ws-error" }, `直前の再計画に失敗したため、rev ${plan.revision} のままです: ${meta.lastPlanError}`),
    h(ReviewHead, { plan, model, config }),
    h("div", { className: "layout" },
      h("div", { className: "board-box" },
        h("div", { className: "board-wrap" },
          h(PlanBoard, { model, config, mode: "review", targets, selectedId, onToggleTarget: toggleTarget, onSelect: setSelectedId })),
        h(BoardFoot)),
      h("div", { className: "aside" },
        h(SelectedSection, { ...detailProps, targeted: selectedId ? targets.includes(selectedId) : false, onToggleTarget: toggleTarget }),
        h(SpecSection, { spec: plan.spec, onAskAssumption: askAssumption }),
        valError && !validationFresh
          ? h(ValidationFailed, { onRetry: () => setReloadTick((n) => n + 1) })
          : h(ValidationSection, { rows, loading: !validationFresh }),
        h(HistorySection, { workspace, meta }))),
    h(ActionBar, {
      model, plan, targets, text, setText, inputRef, errors, busy, error,
      onToggleTarget: toggleTarget, onClearTargets: () => setTargets([]),
      onReplan: replan, onApprove: approve, onAbort: abort,
    }));
}
