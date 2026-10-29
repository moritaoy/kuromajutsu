// ============================================================
// WorkPlan の検証器 V1〜V9（docs/spec.md §13.5.7）
// ============================================================

import type { Phase, PlanStep, ValidationIssue, WorkPlan } from "../types/index.js";
import { checkCommand, type CommandPolicy } from "./gate-commands.js";
import {
  computeLevels,
  effectiveDeps,
  finalGate,
  finalPhase,
  gateOfPhase,
  getStep,
} from "./plan.js";

export interface ValidationContext {
  /** ヘルスチェックを通過した職種 ID */
  availableRoles: Set<string>;
  commandPolicy: CommandPolicy;
}

/**
 * error が 1 件でもあるか。
 * `autoFixed: true` の issue（`autoFixWorkPlan` が修正済みの記録）は
 * 「修正した」という情報であって未解決のエラーではないので無視する。
 */
export function hasErrors(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.level === "error" && i.autoFixed !== true);
}

const DEFAULT_ON_FAIL = { action: "rework", maxRetries: 2 } as const;

/**
 * 修正フェーズ（`Phase.fix` / `parentPhaseId`）の参照整合性を検証し、問題のメッセージを返す。
 * - `fix` と `parentPhaseId` は両方あるか両方ない
 * - `parentPhaseId` / `causePhaseId` は存在するフェーズ
 * - `failedGateId` は親フェーズのゲート、`triageStepId` は親フェーズの work Step
 */
export function validatePhaseReferences(plan: WorkPlan): string[] {
  return phaseReferenceIssues(plan).map((i) => i.message);
}

function phaseReferenceIssues(plan: WorkPlan): { message: string; targetIds: string[] }[] {
  const out: { message: string; targetIds: string[] }[] = [];
  for (const p of plan.phases) {
    if (p.fix === undefined && p.parentPhaseId === undefined) continue;
    const label = `修正フェーズ ${p.id}`;
    const add = (message: string) => out.push({ message: `${label}: ${message}`, targetIds: [p.id] });

    if (p.fix === undefined) {
      add("parentPhaseId があるのに fix がありません");
      continue;
    }
    if (p.parentPhaseId === undefined) {
      add("fix があるのに parentPhaseId がありません");
      continue;
    }
    const parent = plan.phases.find((x) => x.id === p.parentPhaseId);
    if (!parent) add(`parentPhaseId が存在しません: ${p.parentPhaseId}`);
    if (!plan.phases.some((x) => x.id === p.fix?.causePhaseId)) {
      add(`causePhaseId が存在しません: ${p.fix.causePhaseId}`);
    }
    const gate = plan.steps.find((s) => s.id === p.fix?.failedGateId);
    if (!gate || gate.kind !== "gate") {
      add(`failedGateId がゲートではありません: ${p.fix.failedGateId}`);
    } else if (gate.phaseId !== p.parentPhaseId) {
      add(`failedGateId ${gate.id} は親フェーズ ${p.parentPhaseId} のゲートではありません`);
    }
    const triage = plan.steps.find((s) => s.id === p.fix?.triageStepId);
    if (!triage || triage.kind !== "work") {
      add(`triageStepId が work Step ではありません: ${p.fix.triageStepId}`);
    } else if (triage.phaseId !== p.parentPhaseId) {
      add(`triageStepId ${triage.id} は親フェーズ ${p.parentPhaseId} の Step ではありません`);
    }
  }
  return out;
}

/** 読み取りのみ・未指定の scope は並列衝突の対象にしない */
function isWriteScope(scope: string | undefined): scope is string {
  const s = (scope ?? "").trim();
  return s !== "" && !s.startsWith("（") && !s.startsWith("(");
}

/** 出口ゲートが必要なフェーズ（final 以外。入れ子の修正フェーズも含む。§13.5.1） */
const needsExitGate = (p: Phase): boolean => !p.final;

// --------------------------------------------------
// 検証
// --------------------------------------------------

export function validateWorkPlan(plan: WorkPlan, ctx: ValidationContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const names = (ids: string[]) => ids.join("、");

  // V1 最終ゲート
  if (!finalGate(plan)) {
    issues.push({
      rule: "V1",
      level: "error",
      message: "最終ゲート（完了確認）がありません",
    });
  }

  // V2 全フェーズに出口ゲート
  const noGate = plan.phases.filter((p) => needsExitGate(p) && !gateOfPhase(plan, p.id));
  if (noGate.length > 0) {
    issues.push({
      rule: "V2",
      level: "error",
      message: `出口ゲートがないフェーズ: ${names(noGate.map((p) => p.name || p.id))}`,
      targetIds: noGate.map((p) => p.id),
    });
  }

  // V3 確定フェーズの全手順に DoD
  const fixedPhaseIds = new Set(
    plan.phases.filter((p) => p.planning === "fixed" && !p.final).map((p) => p.id),
  );
  const noDod = plan.steps.filter(
    (s) =>
      s.kind === "work" &&
      fixedPhaseIds.has(s.phaseId) &&
      !(s.doneCriteria ?? []).some((c) => c.trim() !== ""),
  );
  if (noDod.length > 0) {
    issues.push({
      rule: "V3",
      level: "error",
      message: `完了定義（DoD）が未設定の手順: ${names(noDod.map((s) => `${s.id} ${s.title}`))}`,
      targetIds: noDod.map((s) => s.id),
    });
  }

  // V4 確定フェーズに手順 / 未決定フェーズに目的
  const emptyFixed = plan.phases.filter(
    (p) =>
      !p.final &&
      p.planning === "fixed" &&
      !plan.steps.some((s) => s.phaseId === p.id && s.kind === "work"),
  );
  if (emptyFixed.length > 0) {
    issues.push({
      rule: "V4",
      level: "error",
      message: `手順のない確定フェーズ: ${names(emptyFixed.map((p) => p.name || p.id))}`,
      targetIds: emptyFixed.map((p) => p.id),
    });
  }
  const noGoal = plan.phases.filter(
    (p) => !p.final && p.planning === "deferred" && p.goal.trim() === "",
  );
  if (noGoal.length > 0) {
    issues.push({
      rule: "V4",
      level: "error",
      message: `目的のない未決定フェーズ: ${names(noGoal.map((p) => p.name || p.id))}`,
      targetIds: noGoal.map((p) => p.id),
    });
  }

  // V5 すべてのゲートにチェック
  const gates = plan.steps.filter((s) => s.kind === "gate");
  const noChecks = gates.filter((g) => !(g.checks ?? []).some((c) => c.text.trim() !== ""));
  if (noChecks.length > 0) {
    issues.push({
      rule: "V5",
      level: "error",
      message: `チェック項目が未設定のゲート: ${names(noChecks.map((g) => g.id))}`,
      targetIds: noChecks.map((g) => g.id),
    });
  }
  const noCommand = gates.filter((g) =>
    (g.checks ?? []).some((c) => c.method === "command" && (c.command ?? "").trim() === ""),
  );
  if (noCommand.length > 0) {
    issues.push({
      rule: "V5",
      level: "error",
      message: `command が未設定の command チェックがあるゲート: ${names(noCommand.map((g) => g.id))}`,
      targetIds: noCommand.map((g) => g.id),
    });
  }

  // V6 職種の存在とヘルスチェック通過
  const badRole = plan.steps.filter((s) => !ctx.availableRoles.has(s.role));
  if (badRole.length > 0) {
    issues.push({
      rule: "V6",
      level: "error",
      message: `利用できない職種があります（未定義またはヘルスチェック未通過）: ${names(
        badRole.map((s) => `${s.id}=${s.role}`),
      )}`,
      targetIds: badRole.map((s) => s.id),
    });
  }

  // V7 循環 + 修正フェーズの参照整合性
  const { cyclic } = computeLevels(plan);
  if (cyclic) {
    issues.push({ rule: "V7", level: "error", message: "依存に循環があります" });
  }
  for (const r of phaseReferenceIssues(plan)) {
    issues.push({ rule: "V7", level: "error", message: r.message, targetIds: r.targetIds });
  }

  // V8 並列 Step のスコープ衝突（warning）
  issues.push(...scopeConflicts(plan, cyclic));

  // V9 ゲートの command の禁止パターン / 許可リスト
  for (const g of gates) {
    for (const c of g.checks ?? []) {
      if (c.method !== "command" || (c.command ?? "").trim() === "") continue;
      const r = checkCommand(c.command ?? "", ctx.commandPolicy);
      if (!r.allowed) {
        issues.push({
          rule: "V9",
          level: "error",
          message: `ゲート ${g.id} の command は実行できません: ${c.command ?? ""}（${r.reason}）`,
          targetIds: [g.id],
        });
      }
    }
  }

  return issues;
}

/** 同じフェーズで並列に動く（互いに依存しない）work Step が同じ scope を編集していないか */
function scopeConflicts(plan: WorkPlan, cyclic: boolean): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const works = plan.steps.filter((s) => s.kind === "work" && isWriteScope(s.scope));
  if (works.length < 2) return out;

  // 推移的な依存先（循環があっても止まるよう訪問済みで打ち切る）
  const ancestors = new Map<string, Set<string>>();
  const ancestorsOf = (step: PlanStep): Set<string> => {
    const known = ancestors.get(step.id);
    if (known) return known;
    const acc = new Set<string>();
    ancestors.set(step.id, acc); // 再入防止
    for (const depId of effectiveDeps(plan, step)) {
      acc.add(depId);
      const dep = getStep(plan, depId);
      if (dep) for (const a of ancestorsOf(dep)) acc.add(a);
    }
    return acc;
  };
  const parallel = (a: PlanStep, b: PlanStep) =>
    cyclic ? false : !ancestorsOf(a).has(b.id) && !ancestorsOf(b).has(a.id);

  for (let i = 0; i < works.length; i++) {
    for (let j = i + 1; j < works.length; j++) {
      const a = works[i];
      const b = works[j];
      if (a.phaseId !== b.phaseId) continue;
      if ((a.scope ?? "").trim() !== (b.scope ?? "").trim()) continue;
      if (!parallel(a, b)) continue;
      out.push({
        rule: "V8",
        level: "warning",
        message: `並列に動く手順が同じスコープを編集します: ${a.id} / ${b.id}（${(a.scope ?? "").trim()}）`,
        targetIds: [a.id, b.id],
      });
    }
  }
  return out;
}

// --------------------------------------------------
// 自動修正
// --------------------------------------------------

/** 既存 ID と衝突しない ID を返す */
function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** 自動挿入するゲートの職種: code-review があればそれ、なければ利用可能な最初の職種 */
function reviewRole(ctx: ValidationContext): string {
  if (ctx.availableRoles.has("code-review")) return "code-review";
  const [first] = ctx.availableRoles;
  return first ?? "code-review";
}

/**
 * V1 / V2 / V4 を自動修正する（§13.5.7）。入力は変更せず新しい計画を返す。
 * `fixed` の issue は `autoFixed: true` の記録で、`hasErrors` は無視する。
 * 修正できなかった項目は返り値に含まれないため、`validateWorkPlan` を再実行して確認する。
 */
export function autoFixWorkPlan(
  plan: WorkPlan,
  ctx: ValidationContext,
): { plan: WorkPlan; fixed: ValidationIssue[] } {
  const role = reviewRole(ctx);
  const next: WorkPlan = structuredClone(plan);
  const fixed: ValidationIssue[] = [];

  // V4: 手順のない確定フェーズを未決定に変更
  const emptyFixed = next.phases.filter(
    (p) =>
      !p.final &&
      p.planning === "fixed" &&
      !next.steps.some((s) => s.phaseId === p.id && s.kind === "work"),
  );
  if (emptyFixed.length > 0) {
    for (const p of emptyFixed) p.planning = "deferred";
    fixed.push({
      rule: "V4",
      level: "error",
      message: `手順のない確定フェーズを未決定に変更しました: ${emptyFixed.map((p) => p.name || p.id).join("、")}`,
      targetIds: emptyFixed.map((p) => p.id),
      autoFixed: true,
    });
  }

  // V2: 出口ゲートを自動挿入
  const noGate = next.phases.filter((p) => needsExitGate(p) && !gateOfPhase(next, p.id));
  if (noGate.length > 0) {
    const usedIds = new Set(next.steps.map((s) => s.id));
    const order = new Map(next.phases.map((p, i) => [p.id, i]));
    for (const p of noGate) {
      const id = uniqueId(`gate-${p.id}`, usedIds);
      usedIds.add(id);
      const g: PlanStep = {
        id,
        phaseId: p.id,
        kind: "gate",
        title: "出口ゲート（自動挿入）",
        role,
        description: `フェーズ「${p.name || p.id}」の完了を確認する`,
        dependsOn: [],
        checks: [{ text: "フェーズの完了定義がすべて満たされている", method: "agent-review" }],
        onFail: { ...DEFAULT_ON_FAIL },
      };
      // フェーズ順で自分以前の最後の Step の直後に入れる
      const myOrder = order.get(p.id) ?? Number.MAX_SAFE_INTEGER;
      let at = 0;
      next.steps.forEach((s, i) => {
        if ((order.get(s.phaseId) ?? Number.MAX_SAFE_INTEGER) <= myOrder) at = i + 1;
      });
      next.steps.splice(at, 0, g);
    }
    fixed.push({
      rule: "V2",
      level: "error",
      message: `出口ゲートを自動挿入しました: ${noGate.map((p) => p.name || p.id).join("、")}`,
      targetIds: noGate.map((p) => p.id),
      autoFixed: true,
    });
  }

  // V1: 最終フェーズ + 最終ゲートを生成
  if (!finalGate(next)) {
    const usedPhaseIds = new Set(next.phases.map((p) => p.id));
    const usedStepIds = new Set(next.steps.map((s) => s.id));
    let fp = finalPhase(next);
    if (!fp) {
      fp = {
        id: uniqueId("PF", usedPhaseIds),
        name: "完了確認",
        goal: "完了条件を全体で確認する",
        planning: "fixed",
        notes: [],
        final: true,
      };
      next.phases.push(fp);
    }
    const completion = next.spec.completion.filter((c) => c.trim() !== "");
    const gateId = uniqueId("gate-final", usedStepIds);
    next.steps.push({
      id: gateId,
      phaseId: fp.id,
      kind: "gate",
      title: "最終ゲート",
      role,
      description: "完了条件を全体で確認する",
      dependsOn: [],
      checks:
        completion.length > 0
          ? completion.map((text) => ({ text, method: "agent-review" as const }))
          : [{ text: "完了条件を満たしている", method: "agent-review" as const }],
      onFail: { ...DEFAULT_ON_FAIL },
    });
    fixed.push({
      rule: "V1",
      level: "error",
      message: "最終ゲート（完了確認）を生成しました",
      targetIds: [gateId],
      autoFixed: true,
    });
  }

  return { plan: next, fixed };
}
