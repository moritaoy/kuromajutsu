// ============================================================
// WorkPlan 計画ユーティリティ（純粋関数。docs/spec.md §13.4 / §13.8.7）
// ============================================================

import { isDeepStrictEqual } from "node:util";
import type {
  Phase,
  PlanStep,
  ScheduledStep,
  TaskLedger,
  WorkPlan,
} from "../types/index.js";

// --------------------------------------------------
// 参照ヘルパー
// --------------------------------------------------

export function getPhase(plan: WorkPlan, id: string): Phase | undefined {
  return plan.phases.find((p) => p.id === id);
}

export function getStep(plan: WorkPlan, id: string): PlanStep | undefined {
  return plan.steps.find((s) => s.id === id);
}

/** フェーズに属する Step（work + gate）。`plan.steps` の並び順 */
export function stepsOfPhase(plan: WorkPlan, phaseId: string): PlanStep[] {
  return plan.steps.filter((s) => s.phaseId === phaseId);
}

export function workStepsOfPhase(plan: WorkPlan, phaseId: string): PlanStep[] {
  return stepsOfPhase(plan, phaseId).filter((s) => s.kind === "work");
}

/** フェーズの出口ゲート（`kind: "gate"` の Step） */
export function gateOfPhase(plan: WorkPlan, phaseId: string): PlanStep | undefined {
  return stepsOfPhase(plan, phaseId).find((s) => s.kind === "gate");
}

export function finalPhase(plan: WorkPlan): Phase | undefined {
  return plan.phases.find((p) => p.final === true);
}

export function finalGate(plan: WorkPlan): PlanStep | undefined {
  const fp = finalPhase(plan);
  return fp ? gateOfPhase(plan, fp.id) : undefined;
}

/** `human` チェックを 1 つでも含むゲートか */
export function isHumanGate(step: PlanStep): boolean {
  return step.kind === "gate" && (step.checks ?? []).some((c) => c.method === "human");
}

/** ゲート不合格から追加された入れ子の修正フェーズ（`parentPhaseId === phaseId`） */
export function fixPhasesOf(plan: WorkPlan, parentPhaseId: string): Phase[] {
  return plan.phases.filter((p) => p.parentPhaseId === parentPhaseId);
}

/** 直前のフェーズの出口ゲート（入れ子の修正フェーズは数えない） */
export function prevGate(plan: WorkPlan, phaseId: string): PlanStep | undefined {
  const idx = plan.phases.findIndex((p) => p.id === phaseId);
  for (let i = idx - 1; i >= 0; i--) {
    const p = plan.phases[i];
    if (p.parentPhaseId) continue;
    const g = gateOfPhase(plan, p.id);
    if (g) return g;
  }
  return undefined;
}

/** フェーズ内で他の work Step から依存されていない work Step（出口ゲートの対象） */
export function sinks(plan: WorkPlan, phaseId: string): PlanStep[] {
  const works = workStepsOfPhase(plan, phaseId);
  return works.filter((w) => !works.some((x) => x.dependsOn.includes(w.id)));
}

// --------------------------------------------------
// 実効依存・階層
// --------------------------------------------------

/**
 * 実効依存（§13.4.1）。
 *
 * - work: フェーズ内の依存があればそれ。なければ前フェーズのゲート
 *   （修正フェーズの起点は `fix.triageStepId`）
 * - gate: フェーズの末端 Step すべて + 入れ子の修正フェーズの出口ゲート。
 *   末端がなければ前フェーズのゲート
 */
export function effectiveDeps(plan: WorkPlan, step: PlanStep): string[] {
  const phase = getPhase(plan, step.phaseId);
  const origin = (): string[] => {
    if (phase?.fix) return [phase.fix.triageStepId];
    const g = prevGate(plan, step.phaseId);
    return g ? [g.id] : [];
  };

  if (step.kind === "gate") {
    const fixes = fixPhasesOf(plan, step.phaseId);
    const fromFix = fixes.flatMap((f) => {
      const fg = gateOfPhase(plan, f.id);
      return fg ? [fg.id] : sinks(plan, f.id).map((x) => x.id);
    });
    // 修正フェーズの起点（原因の切り分け）は修正フェーズ経由でつながるので、直接は待たない
    const via = new Set(fixes.flatMap((f) => (f.fix ? [f.fix.triageStepId] : [])));
    const all = sinks(plan, step.phaseId)
      .map((x) => x.id)
      .filter((id) => !via.has(id))
      .concat(fromFix);
    return all.length > 0 ? all : origin();
  }

  const inPhase = step.dependsOn.filter((d) => getStep(plan, d)?.phaseId === step.phaseId);
  return inPhase.length > 0 ? inPhase : origin();
}

/** 各 Step の階層（実効依存の最長経路）。循環があれば `cyclic: true` */
export function computeLevels(plan: WorkPlan): {
  levels: Record<string, number>;
  cyclic: boolean;
} {
  const levels: Record<string, number> = {};
  const stack = new Set<string>();
  let cyclic = false;

  const visit = (step: PlanStep): number => {
    const known = levels[step.id];
    if (known !== undefined) return known;
    if (stack.has(step.id)) {
      cyclic = true;
      return 0;
    }
    stack.add(step.id);
    let level = 0;
    for (const depId of effectiveDeps(plan, step)) {
      const dep = getStep(plan, depId);
      if (dep) level = Math.max(level, visit(dep) + 1);
    }
    stack.delete(step.id);
    levels[step.id] = level;
    return level;
  };

  for (const s of plan.steps) visit(s);
  return { levels, cyclic };
}

// --------------------------------------------------
// Task Ledger への写像（§13.4.3）
// --------------------------------------------------

/** PlanStep を ScheduledStep に写像する（`dependsOn` は実効依存） */
export function toScheduledSteps(plan: WorkPlan): ScheduledStep[] {
  return plan.steps.map((s): ScheduledStep => {
    const out: ScheduledStep = {
      stepId: s.id,
      role: s.role,
      description: s.description || s.title,
      status: "pending",
      dependsOn: effectiveDeps(plan, s),
      phaseId: s.phaseId,
      kind: s.kind,
    };
    if (s.doneCriteria) out.doneCriteria = [...s.doneCriteria];
    if (s.checks) out.checks = s.checks.map((c) => ({ ...c }));
    if (s.onFail) out.onFail = { ...s.onFail };
    return out;
  });
}

/** 承認時に Task Ledger へ初期投入する内容 */
export function toTaskLedgerInput(plan: WorkPlan): {
  facts: TaskLedger["facts"];
  plan: string[];
  scheduledSteps: ScheduledStep[];
  phases: Phase[];
} {
  return {
    facts: structuredClone(plan.facts),
    plan: plan.phases.map((p) => `${p.id} ${p.name} — ${p.goal}`),
    scheduledSteps: toScheduledSteps(plan),
    phases: structuredClone(plan.phases),
  };
}

// --------------------------------------------------
// maxIterations（§13.8.7）
// --------------------------------------------------

/**
 * onFail.maxRetries の既定値。schema.ts の default / validator.ts の DEFAULT_ON_FAIL /
 * run.ts・ledger-guard.ts の DEFAULT_MAX_RETRIES と揃える（それらは export されていないため、
 * ここにも同じ値を置く）。
 */
const DEFAULT_GATE_MAX_RETRIES = 2;

/**
 * ```
 * max(12,
 *     固定フェーズの work Step 数 × 2
 *   + 未決定フェーズ数 × 4
 *   + Σ ゲート Step ごとに (2 + maxRetries)      // maxRetries は onFail.maxRetries（未指定は 2）
 *   + human チェックを含むゲート Step 数 × 2)
 * ```
 */
export function computeMaxIterations(plan: WorkPlan): number {
  const deferred = new Set(plan.phases.filter((p) => p.planning === "deferred").map((p) => p.id));
  const fixedSteps = plan.steps.filter((s) => s.kind === "work" && !deferred.has(s.phaseId)).length;
  const gates = plan.steps.filter((s) => s.kind === "gate");
  const gateCost = gates.reduce((sum, g) => sum + 2 + (g.onFail?.maxRetries ?? DEFAULT_GATE_MAX_RETRIES), 0);
  const humanGates = gates.filter(isHumanGate).length;
  return Math.max(12, fixedSteps * 2 + deferred.size * 4 + gateCost + humanGates * 2);
}

// --------------------------------------------------
// revision 間の差分（§13.7）
// --------------------------------------------------

export interface PlanDiff {
  addedPhaseIds: string[];
  changedPhaseIds: string[];
  removedPhaseIds: string[];
  addedStepIds: string[];
  changedStepIds: string[];
  removedStepIds: string[];
}

/** ID で突き合わせた差分。変更は JSON 表現の深い比較 */
export function diffPlans(prev: WorkPlan, next: WorkPlan): PlanDiff {
  const same = (a: unknown, b: unknown): boolean =>
    isDeepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));

  const diff = <T extends { id: string }>(a: T[], b: T[]) => {
    const prevMap = new Map(a.map((x) => [x.id, x]));
    const nextMap = new Map(b.map((x) => [x.id, x]));
    return {
      added: b.filter((x) => !prevMap.has(x.id)).map((x) => x.id),
      changed: b
        .filter((x) => prevMap.has(x.id) && !same(prevMap.get(x.id), x))
        .map((x) => x.id),
      removed: a.filter((x) => !nextMap.has(x.id)).map((x) => x.id),
    };
  };

  const phases = diff(prev.phases, next.phases);
  const steps = diff(prev.steps, next.steps);
  return {
    addedPhaseIds: phases.added,
    changedPhaseIds: phases.changed,
    removedPhaseIds: phases.removed,
    addedStepIds: steps.added,
    changedStepIds: steps.changed,
    removedStepIds: steps.removed,
  };
}

// --------------------------------------------------
// ID 採番
// --------------------------------------------------

/** `ws-{unixTimestamp}-{random4hex}`（generateGroupId と同じ方式） */
export function generateWorkspaceId(): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const random = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, "0");
  return `ws-${timestamp}-${random}`;
}
