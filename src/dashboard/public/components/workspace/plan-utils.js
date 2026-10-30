// ============================================================
// Workspace 計画ユーティリティ（純粋関数）
// ============================================================
// サーバーの src/workspace/plan.ts（実効依存・階層）と同じ規則をクライアントでも計算する。
// ボードは「ボードモデル」{ phases, steps } を描く。モデルは次の 2 通りで作る。
//   - modelFromPlan   : WorkPlan（計画レビュー）。依存は effectiveDeps で正規化する
//   - modelFromLedger : Task Ledger の scheduledSteps（実行中）。dependsOn は実効依存に正規化済みなのでそのまま使う

// --------------------------------------------------
// 職種・色・ラベル
// --------------------------------------------------

const KNOWN_ROLE_COLORS = {
  orchestrator: "#a371f7",
  planner: "#a371f7",
  design: "#58a6ff",
  "code-review": "#f778ba",
  "text-review": "#db61a2",
  "text-writer": "#56d4dd",
  "impl-code": "#3fb950",
  "impl-test": "#7ee787",
  research: "#d29922",
  "quick-task": "#ffa657",
};
const FALLBACK_COLORS = ["#58a6ff", "#3fb950", "#56d4dd", "#a371f7", "#f778ba", "#d29922", "#ffa657", "#7ee787"];

function hashString(str) {
  let x = 0;
  for (const c of String(str)) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return x;
}

/** 職種の表示情報。モデル名のみ小さく出す（Provider は出さない） */
export function roleInfo(config, roleId) {
  const roles = (config && config.roles) || [];
  const r = roles.find((x) => x.id === roleId);
  return {
    id: roleId,
    name: r ? r.name || roleId : roleId,
    model: r ? r.model || "" : "",
    known: !!r,
    color: KNOWN_ROLE_COLORS[roleId] || FALLBACK_COLORS[hashString(roleId) % FALLBACK_COLORS.length],
  };
}

export const PHASE_COLORS = ["#58a6ff", "#3fb950", "#7ee787", "#56d4dd", "#a371f7", "#f778ba"];

export const MARK_LABEL = {
  added: "NEW",
  modified: "変更",
  replanned: "AI追加",
  planned: "直前計画",
  fix: "修正",
  triage: "原因調査",
};

export const METHOD_LABEL = { "agent-review": "AI", command: "コマンド", human: "あなた" };
export const METHOD_ICON = { "agent-review": "🤖", command: "⚙", human: "👤" };

export const STATUS_LABEL = {
  planning: "計画生成中",
  review: "計画レビュー",
  running: "実行中",
  waiting_human: "人の判断待ち",
  done: "完了",
  failed: "失敗",
  aborted: "中断",
};

export const VALIDATION_RULES = [
  ["V1", "最終ゲート（完了確認）がある"],
  ["V2", "全フェーズが出口ゲートで終わる"],
  ["V3", "確定フェーズの全手順に完了定義（DoD）がある"],
  ["V4", "確定フェーズに手順があり、未決定フェーズに目的がある"],
  ["V5", "全ゲートにチェック項目がある"],
  ["V6", "職種が存在し、ヘルスチェックを通過している"],
  ["V7", "依存に循環がない"],
  ["V8", "並列の手順のスコープが衝突していない"],
  ["V9", "ゲートの command が禁止パターンに当たらない"],
];

/** 対象に応じた定型指示（spec §13.10.2） */
export function quickInstructions(kind, { human, deferred } = {}) {
  if (kind === "phase") {
    return [
      deferred ? "手順を今決めて" : "手順は直前に決めるようにして",
      "出口ゲートを人間レビューにして",
      "不要なので削除して",
    ];
  }
  if (kind === "gate") {
    return human ? ["人間レビューを外して（自動チェックのみ）", "チェック項目を追加して"] : ["人間レビューにして", "チェック項目を追加して"];
  }
  return ["2 つに分割して", "職種を impl-test に変えて", "完了定義を厳しくして", "不要なので削除して"];
}

export const GLOBAL_INSTRUCTIONS = [
  "実装の後にも人間レビューを入れて",
  "セキュリティ確認のフェーズを追加して",
  "手順を直前に決めるフェーズを増やして",
  "もっと並列化して",
];

// --------------------------------------------------
// 日時
// --------------------------------------------------

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 時間 ${m % 60} 分`;
}

export function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function fmtDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function truncate(text, n) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

// --------------------------------------------------
// WorkPlan 参照・実効依存（src/workspace/plan.ts と同じ規則）
// --------------------------------------------------

const getPhase = (plan, id) => plan.phases.find((p) => p.id === id);
const getStep = (plan, id) => plan.steps.find((s) => s.id === id);
const stepsOfPhase = (plan, pid) => plan.steps.filter((s) => s.phaseId === pid);
const workStepsOfPhase = (plan, pid) => stepsOfPhase(plan, pid).filter((s) => s.kind === "work");
const gateOfPhase = (plan, pid) => stepsOfPhase(plan, pid).find((s) => s.kind === "gate");
const fixPhasesOf = (plan, pid) => plan.phases.filter((p) => p.parentPhaseId === pid);

function prevGate(plan, pid) {
  const idx = plan.phases.findIndex((p) => p.id === pid);
  for (let i = idx - 1; i >= 0; i--) {
    const p = plan.phases[i];
    if (p.parentPhaseId) continue;
    const g = gateOfPhase(plan, p.id);
    if (g) return g;
  }
  return undefined;
}

function sinks(plan, pid) {
  const works = workStepsOfPhase(plan, pid);
  return works.filter((w) => !works.some((x) => (x.dependsOn || []).includes(w.id)));
}

export function effectiveDeps(plan, step) {
  const phase = getPhase(plan, step.phaseId);
  const origin = () => {
    if (phase && phase.fix) return [phase.fix.triageStepId];
    const g = prevGate(plan, step.phaseId);
    return g ? [g.id] : [];
  };
  if (step.kind === "gate") {
    const fixes = fixPhasesOf(plan, step.phaseId);
    const fromFix = fixes.flatMap((f) => {
      const fg = gateOfPhase(plan, f.id);
      return fg ? [fg.id] : sinks(plan, f.id).map((x) => x.id);
    });
    const via = new Set(fixes.flatMap((f) => (f.fix ? [f.fix.triageStepId] : [])));
    const all = sinks(plan, step.phaseId)
      .map((x) => x.id)
      .filter((id) => !via.has(id))
      .concat(fromFix);
    return all.length > 0 ? all : origin();
  }
  const inPhase = (step.dependsOn || []).filter((d) => {
    const x = getStep(plan, d);
    return x && x.phaseId === step.phaseId;
  });
  return inPhase.length > 0 ? inPhase : origin();
}

// --------------------------------------------------
// revision 間の差分（ID で突き合わせ）
// --------------------------------------------------

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function diffPlans(prev, next) {
  const diff = (a, b) => {
    const pm = new Map(a.map((x) => [x.id, x]));
    const nm = new Map(b.map((x) => [x.id, x]));
    return {
      added: b.filter((x) => !pm.has(x.id)).map((x) => x.id),
      changed: b.filter((x) => pm.has(x.id) && !same(pm.get(x.id), x)).map((x) => x.id),
      removed: a.filter((x) => !nm.has(x.id)).map((x) => x.id),
    };
  };
  const ph = diff(prev.phases, next.phases);
  const st = diff(prev.steps, next.steps);
  return {
    addedPhaseIds: ph.added,
    changedPhaseIds: ph.changed,
    removedPhaseIds: ph.removed,
    addedStepIds: st.added,
    changedStepIds: st.changed,
    removedStepIds: st.removed,
  };
}

/** 改訂履歴に出す 1 行ずつの要約 */
export function summarizeRevision(prev, cur) {
  if (!prev) {
    const fixedPhases = cur.phases.filter((p) => !p.final && !p.parentPhaseId);
    const deferred = fixedPhases.filter((p) => p.planning === "deferred").length;
    const works = cur.steps.filter((s) => s.kind === "work").length;
    const gates = cur.steps.filter((s) => s.kind === "gate");
    const humans = gates.filter(isHuman).length;
    return [
      `${fixedPhases.length} フェーズ（うち手順未決定 ${deferred}）/ ${works} 手順 / ${gates.length} ゲート（人間レビュー ${humans}）を生成`,
    ];
  }
  const d = diffPlans(prev, cur);
  const lines = [];
  const stepName = (plan, id) => {
    const s = getStep(plan, id);
    return s ? `${id}「${truncate(s.title, 24)}」` : id;
  };
  const phaseName = (plan, id) => {
    const p = getPhase(plan, id);
    return p ? `「${truncate(p.name, 20)}」` : id;
  };
  d.addedPhaseIds.forEach((id) => lines.push(`フェーズ ${phaseName(cur, id)} を追加`));
  d.removedPhaseIds.forEach((id) => lines.push(`フェーズ ${phaseName(prev, id)} を削除`));
  d.changedPhaseIds.forEach((id) => lines.push(`フェーズ ${phaseName(cur, id)} を変更`));
  d.addedStepIds.forEach((id) => lines.push(`${stepName(cur, id)} を追加`));
  d.removedStepIds.forEach((id) => lines.push(`${stepName(prev, id)} を削除`));
  d.changedStepIds.forEach((id) => lines.push(`${stepName(cur, id)} を変更`));
  if (lines.length === 0) lines.push("計画の構造に変更なし（解釈・前提のみの更新を含む）");
  return lines;
}

// --------------------------------------------------
// ボードモデル
// --------------------------------------------------

export const isHuman = (step) =>
  !!step && step.kind === "gate" && (step.checks || []).some((c) => c.method === "human");

function baseStep(s, deps) {
  return {
    id: s.id,
    phaseId: s.phaseId,
    kind: s.kind,
    title: s.title,
    role: s.role,
    description: s.description || "",
    deps,
    doneCriteria: s.doneCriteria || [],
    checks: s.checks || [],
    onFail: s.onFail,
    scope: s.scope || "",
    mark: null,
    status: null,
    retries: 0,
    irregular: false,
  };
}

/** WorkPlan から作る（計画レビュー / 読み取り専用）。diff があれば NEW / 変更の印を付ける */
export function modelFromPlan(plan, diff) {
  const addedS = new Set(diff ? diff.addedStepIds : []);
  const changedS = new Set(diff ? diff.changedStepIds : []);
  const addedP = new Set(diff ? diff.addedPhaseIds : []);
  const changedP = new Set(diff ? diff.changedPhaseIds : []);
  return {
    source: "plan",
    phases: plan.phases.map((p) => ({
      ...p,
      notes: p.notes || [],
      mark: p.fix ? "fix" : addedP.has(p.id) ? "added" : changedP.has(p.id) ? "modified" : null,
    })),
    steps: plan.steps.map((s) => ({
      ...baseStep(s, effectiveDeps(plan, s)),
      mark: addedS.has(s.id) ? "added" : changedS.has(s.id) ? "modified" : null,
    })),
  };
}

function stepTitleFromRevisions(workspace, id, description) {
  const order = [];
  if (workspace.approvedRevision) order.push(workspace.revisions[workspace.approvedRevision - 1]);
  for (let i = workspace.revisions.length - 1; i >= 0; i--) order.push(workspace.revisions[i]);
  for (const plan of order) {
    const s = plan && getStep(plan, id);
    if (s) return s.title;
  }
  return truncate((description || "").split(/[。\n]/)[0], 36) || id;
}

/** gateResults からゲートの表示状態（status / retries / gateFailed）を決める。サーバーが導出した status が正 */
function applyGateResult(s, gr) {
  s.gateResult = gr || null;
  if (!gr) return;
  s.retries = gr.attempts.filter((a) => a.closedAt && a.checks.some((c) => !c.passed)).length;
  if (gr.status === "passed") s.status = "done";
  else if (gr.status === "waiting_human") s.status = "waiting";
  else if (gr.status === "auto_passed" && s.status !== "done") s.status = "running";
  s.gateFailed = gr.status === "failed" && s.status !== "done";
  if (s.gateFailed) s.status = "pending";
}

const LEDGER_STATUS = { pending: "pending", in_progress: "running", completed: "done", skipped: "skipped" };

/**
 * Task Ledger から作る（実行中）。`dependsOn` は実効依存に正規化済みなのでそのまま使う。
 * ledger が無い（承認直後など）ときは承認済みの計画から作る（すべて待機）。
 */
export function modelFromLedger(workspace, ledger, meta) {
  const approved = workspace.approvedRevision ? workspace.revisions[workspace.approvedRevision - 1] : null;
  const tl = ledger && ledger.taskLedger;
  const gateResults = workspace.gateResults || [];
  const gateChanged = new Set((workspace.gateChanges || []).map((c) => c.gateId));
  const planned = (meta && meta.plannedSteps) || {};
  const replanned = (meta && meta.replannedSteps) || {};

  let phases;
  let steps;
  if (tl && tl.scheduledSteps) {
    phases = (tl.phases && tl.phases.length ? tl.phases : approved ? approved.phases : []).map((p) => ({ ...p, notes: p.notes || [] }));
    const triageIds = new Set(phases.filter((p) => p.fix).map((p) => p.fix.triageStepId));
    steps = tl.scheduledSteps.map((ls) => {
      const inPlan = approved ? getStep(approved, ls.stepId) : null;
      const phaseId = ls.phaseId || (inPlan ? inPlan.phaseId : (phases[0] && phases[0].id));
      const s = {
        id: ls.stepId,
        phaseId,
        kind: ls.kind || "work",
        title: stepTitleFromRevisions(workspace, ls.stepId, ls.description),
        role: ls.role,
        description: ls.description || "",
        deps: ls.dependsOn || [],
        doneCriteria: ls.doneCriteria || [],
        checks: ls.checks || [],
        onFail: ls.onFail,
        scope: inPlan ? inPlan.scope || "" : "",
        mark: null,
        status: LEDGER_STATUS[ls.status] || "pending",
        retries: 0,
        irregular: gateChanged.has(ls.stepId),
      };
      const phase = phases.find((p) => p.id === phaseId);
      if (!inPlan) {
        if (triageIds.has(s.id)) s.mark = "triage";
        else if (phase && phase.fix) s.mark = "fix";
        else if (planned[s.id] || (approved && getPhase(approved, phaseId) && getPhase(approved, phaseId).planning === "deferred")) s.mark = "planned";
        else s.mark = "replanned";
      } else if (replanned[s.id] === "changed") {
        s.mark = "modified";
      }
      if (s.kind === "gate") applyGateResult(s, gateResults.find((g) => g.gateId === s.id));
      return s;
    });
    for (const p of phases) if (p.fix) p.mark = "fix";
  } else if (approved) {
    const m = modelFromPlan(approved);
    phases = m.phases;
    // ledger が無い（承認直後・サーバー再起動後など）。状態は待機にし、ゲートだけ gateResults から決める
    steps = m.steps.map((s) => {
      const out = { ...s, status: "pending", mark: null, irregular: gateChanged.has(s.id) };
      if (out.kind === "gate") applyGateResult(out, gateResults.find((g) => g.gateId === out.id));
      return out;
    });
  } else {
    phases = [];
    steps = [];
  }
  return { source: "ledger", phases, steps };
}

// --------------------------------------------------
// モデル参照・階層
// --------------------------------------------------

export const stepById = (model, id) => model.steps.find((s) => s.id === id);
export const phaseById = (model, id) => model.phases.find((p) => p.id === id);
export const stepsOf = (model, pid) => model.steps.filter((s) => s.phaseId === pid);
export const workOf = (model, pid) => stepsOf(model, pid).filter((s) => s.kind === "work");
export const gateOf = (model, pid) => stepsOf(model, pid).find((s) => s.kind === "gate");
export const fixesOf = (model, pid) => model.phases.filter((p) => p.parentPhaseId === pid);

/** 各手順の階層（実効依存の最長経路）。循環があれば cyclic: true */
export function computeLevels(model) {
  const byId = new Map(model.steps.map((s) => [s.id, s]));
  const memo = {};
  const stack = new Set();
  let cyclic = false;
  const visit = (s) => {
    if (memo[s.id] != null) return memo[s.id];
    if (stack.has(s.id)) {
      cyclic = true;
      return 0;
    }
    stack.add(s.id);
    let lv = 0;
    for (const d of s.deps) {
      const dep = byId.get(d);
      if (dep) lv = Math.max(lv, visit(dep) + 1);
    }
    stack.delete(s.id);
    memo[s.id] = lv;
    return lv;
  };
  model.steps.forEach(visit);
  return { levels: memo, cyclic };
}

/** フェーズ内の work を依存段ごとに並べた行 */
export function phaseRows(model, pid, levels) {
  const ws = workOf(model, pid);
  const vs = [...new Set(ws.map((s) => levels[s.id] || 0))].sort((a, b) => a - b);
  return vs.map((v) => ws.filter((s) => (levels[s.id] || 0) === v));
}

/** 実行中のフェーズの状態 */
export function phaseState(model, p) {
  const g = gateOf(model, p.id);
  const ss = stepsOf(model, p.id);
  if (g && g.status === "done") return "done";
  if (g && g.status === "waiting") return "waiting";
  if (ss.some((s) => s.status === "running" || s.status === "done" || s.status === "skipped")) return "active";
  return "pending";
}

/**
 * 折りたたんだフェーズの見出しに出す要約。
 * gate: ゲートの状態（合格 / レビュー待ち / チェック中 / —）、running: 実行中の手順（work を優先。なければ null）
 */
export function phaseSummary(model, p) {
  const g = gateOf(model, p.id);
  const gate = !g ? "—" : g.gateFailed ? "不合格" : g.status === "done" ? "合格" : g.status === "waiting" ? "レビュー待ち" : g.status === "running" ? "チェック中" : "—";
  // 入れ子の修正フェーズの手順も含める
  const collect = (ph) => [...stepsOf(model, ph.id), ...fixesOf(model, ph.id).flatMap(collect)];
  const ss = collect(p).filter((s) => s.status === "running");
  const r = ss.find((s) => s.kind === "work") || ss[0] || null;
  return { gate, running: r ? { id: r.id, title: truncate(r.title, 24) } : null, runningCount: ss.length };
}

export const PHASE_STATE_LABEL = {
  done: "✓ 完了",
  active: "▶ 実行中",
  waiting: "👤 レビュー待ち",
  pending: "— 待機",
};

/** 指示の対象（kind を判定して { kind, id, title } にする） */
export function targetInfo(model, id) {
  const s = stepById(model, id);
  if (s) return { kind: s.kind === "gate" ? "gate" : "step", id, title: s.title };
  const p = phaseById(model, id);
  if (p) return { kind: "phase", id, title: p.name };
  return null;
}

/** 検証結果を V1〜V9 の一覧にする（issue があるルールは issue、なければ ok） */
export function validationRows(issues) {
  const list = issues || [];
  const rows = [];
  for (const [rule, okText] of VALIDATION_RULES) {
    const hits = list.filter((i) => i.rule === rule);
    if (hits.length === 0) {
      rows.push({ rule, level: "ok", text: okText });
    } else {
      for (const i of hits) rows.push({ rule, level: i.level, text: i.message, targetIds: i.targetIds, autoFixed: i.autoFixed });
    }
  }
  return rows;
}

/** ゲートの最新 attempt（なければ null） */
export function latestAttempt(gateResult) {
  if (!gateResult || !gateResult.attempts || gateResult.attempts.length === 0) return null;
  return gateResult.attempts[gateResult.attempts.length - 1];
}

/** チェック index ごとの最新結果 */
export function checkResultOf(gateResult, checkIndex) {
  const a = latestAttempt(gateResult);
  return a ? a.checks.find((c) => c.checkIndex === checkIndex) || null : null;
}
