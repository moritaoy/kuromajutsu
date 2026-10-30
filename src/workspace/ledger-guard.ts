// ============================================================
// update_ledger の検証と正規化（純粋関数。docs/spec.md §13.5.5 / §2.2.11）
//
// Workspace のグループで Orchestrator が `update_ledger` に渡した `scheduledSteps` / `phases` を、
// ゲートの不変性の規則に照らして検証し、実効依存に正規化して返す。
// ============================================================

import { isDeepStrictEqual } from "node:util";
import type {
  GateChange,
  GateResult,
  Phase,
  PlanStep,
  ScheduledStep,
  WorkPlan,
} from "../types/index.js";
import { checkCommand, type CommandPolicy } from "./gate-commands.js";
import { hasHumanCheck } from "./gates.js";
import { effectiveDeps, finalGate } from "./plan.js";
import { validatePhaseReferences } from "./validator.js";

export type LedgerGuardErrorCode =
  | "GATE_PROTECTED"
  | "GATE_CHANGE_NOT_ALLOWED"
  | "GATE_COMMAND_DENIED"
  | "INVALID_PHASES"
  | "DUPLICATE_STEP_ID";

/**
 * Orchestrator が再送するフェーズ。`id` 以外は省略でき、既存のフェーズなら現行値で補完する
 * （新規フェーズは `name` / `goal` が必須。`planning` は fixed、`notes` は空を既定とする）。
 */
export type IncomingPhase = Pick<Phase, "id"> & Partial<Omit<Phase, "id">>;

export interface LedgerGuardInput {
  /** 現在の Task Ledger */
  current: { phases: Phase[]; scheduledSteps: ScheduledStep[] };
  /** Orchestrator が渡した内容（`phases` を省略すると current を維持する） */
  incoming: { phases?: IncomingPhase[]; scheduledSteps: ScheduledStep[] };
  /** 承認済みの計画（最終ゲート・承認済みフェーズの判定に使う） */
  approvedPlan: WorkPlan;
  /** 現在のゲート結果（現状は判定に使わない。将来の拡張用に受け取る） */
  gateResults: GateResult[];
  irregular?: boolean;
  reason?: string;
  commandPolicy: CommandPolicy;
  /**
   * 初回の再登録の吸収（§13.5.5）。真のとき、追加・削除された Step が無く phases の構造（id・順序・
   * planning・final・fix・parentPhaseId）も変わらない更新では、既存 Step の `role` / `description` /
   * `doneCriteria` / `dependsOn`（work のみ）/ `phaseId` / `kind` と、フェーズの `name` / `goal` / `notes` を
   * current の値で上書きしてから差分を判定する（Orchestrator の言い換えを「変更」にしない）。
   * ゲートの `checks` / `onFail` と `status` には触れない。
   * 「Progress Ledger 未記録・全 Step が pending・ゲートの attempt 無し・irregular でない」といった
   * 呼び出し側の条件は、呼び出し側（`WorkspaceRunner.applyLedgerUpdate`）で判定してから指定する。
   */
  absorbRephrase?: boolean;
}

export type NewGateChange = Omit<GateChange, "id" | "at" | "acknowledgedAt">;

export type LedgerGuardResult =
  | {
      ok: true;
      /** 正規化済みのフェーズ */
      phases: Phase[];
      /** 正規化済みの Step（ゲートの status は current の値） */
      scheduledSteps: ScheduledStep[];
      gateChanges: NewGateChange[];
      /** `deferred` フェーズに work Step が追加されたもの（フェーズごと） */
      phasePlanned: { phaseId: string; addedSteps: ScheduledStep[] }[];
      replanned: { added: ScheduledStep[]; changed: ScheduledStep[]; removed: string[] };
      /** 初回の再登録の吸収で、言い換えを current の値に戻した（実際に何かを上書きした）とき true */
      absorbed: boolean;
    }
  | { ok: false; code: LedgerGuardErrorCode; message: string };

const DEFAULT_MAX_RETRIES = 2;

/** current から引き継ぐ optional フィールド（incoming が省略したとき） */
const INHERITED_KEYS = ["phaseId", "kind", "doneCriteria", "checks", "onFail"] as const;

// --------------------------------------------------
// 変換・比較
// --------------------------------------------------

function toPlanStep(s: ScheduledStep): PlanStep {
  const out: PlanStep = {
    id: s.stepId,
    phaseId: s.phaseId ?? "",
    kind: s.kind ?? "work",
    title: s.description,
    role: s.role,
    description: s.description,
    dependsOn: [...(s.dependsOn ?? [])],
  };
  if (s.doneCriteria) out.doneCriteria = [...s.doneCriteria];
  if (s.checks) out.checks = s.checks.map((c) => ({ ...c }));
  if (s.onFail) out.onFail = { ...s.onFail };
  return out;
}

const isGate = (s: ScheduledStep): boolean => s.kind === "gate";

/** JSON 表現に正規化して比較する（undefined と省略を同一視する） */
function same(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(JSON.parse(JSON.stringify(a ?? null)), JSON.parse(JSON.stringify(b ?? null)));
}

/** ゲートの「緩める可能性のある」内容（変更の検知に使う） */
function gateContent(s: ScheduledStep) {
  return {
    phaseId: s.phaseId ?? "",
    role: s.role,
    checks: s.checks ?? [],
    onFail: { action: s.onFail?.action ?? "rework", maxRetries: s.onFail?.maxRetries ?? DEFAULT_MAX_RETRIES },
  };
}

function humanCount(s: ScheduledStep): number {
  return (s.checks ?? []).filter((c) => c.method === "human").length;
}

/**
 * Step の内容（status を除く）。「変更」の判定に使う。
 * ゲートの dependsOn は実効依存から導出される値なので、比較に含めない。
 */
function stepContent(s: ScheduledStep) {
  return {
    role: s.role,
    description: s.description,
    dependsOn: isGate(s) ? undefined : [...(s.dependsOn ?? [])].sort(),
    phaseId: s.phaseId,
    kind: s.kind ?? "work",
    doneCriteria: s.doneCriteria,
    checks: s.checks,
    onFail: s.onFail,
  };
}

function commandViolation(step: ScheduledStep, policy: CommandPolicy): string | undefined {
  for (const [i, c] of (step.checks ?? []).entries()) {
    if (c.method !== "command") continue;
    const r = checkCommand(c.command ?? "", policy);
    if (!r.allowed) {
      return `ゲート ${step.stepId} の checks[${i}] の command は実行できません: ${r.reason}`;
    }
  }
  return undefined;
}

// --------------------------------------------------
// 本体
// --------------------------------------------------

const fail = (code: LedgerGuardErrorCode, message: string): LedgerGuardResult => ({ ok: false, code, message });

/**
 * `update_ledger` の内容を検証・正規化する（入力は変更しない）。
 *
 * - ゲートの `status` は Orchestrator が変えられない（`completed` / `skipped` は `GATE_PROTECTED`。
 *   それ以外は結果を current の値に戻す）
 * - ゲートの変更・削除は `irregular && reason` が必要（`GATE_CHANGE_NOT_ALLOWED`）。
 *   最終ゲートの削除と human チェックの削除は irregular でも `GATE_PROTECTED`
 * - 追加・変更されたゲートの `command` は `checkCommand` で検査（`GATE_COMMAND_DENIED`）
 * - `stepId` の重複は拒否する（`DUPLICATE_STEP_ID`。後ろ盾の弱いコピーで検証をすり抜けられないように）
 * - `phases` の整合性（`INVALID_PHASES`）。承認済みフェーズの `fix` / `parentPhaseId` / `planning` / `final` は
 *   変えられず、追加フェーズ（非 final）には出口ゲートが要る。final フェーズは最後に置く
 * - `dependsOn` を実効依存に正規化（完了済み Step は変更しない）
 *
 * incoming が `phaseId` / `kind` / `doneCriteria` / `checks` / `onFail` を省略した Step は、
 * current の同じ `stepId` の値を引き継ぐ（進捗更新で最低限のフィールドだけ渡しても
 * ゲートの定義が失われないようにする）。ゲートの `checks` を外すには `checks: []` を明示する。
 */
export function guardLedgerUpdate(input: LedgerGuardInput): LedgerGuardResult {
  const { current, approvedPlan, commandPolicy } = input;
  const reason = (input.reason ?? "").trim();
  const irregularOk = input.irregular === true && reason !== "";

  const curById = new Map(current.scheduledSteps.map((s) => [s.stepId, s]));

  // 0. stepId の重複
  const seen = new Set<string>();
  for (const s of input.incoming.scheduledSteps) {
    if (seen.has(s.stepId)) {
      return fail("DUPLICATE_STEP_ID", `stepId が重複しています: ${s.stepId}。同じ stepId の Step は 1 つにしてください`);
    }
    seen.add(s.stepId);
  }

  // 1. incoming を current で補完する
  const merged: ScheduledStep[] = input.incoming.scheduledSteps.map((inc) => {
    const out: ScheduledStep = structuredClone(inc);
    const cur = curById.get(inc.stepId);
    if (cur) {
      for (const key of INHERITED_KEYS) {
        if (out[key] === undefined && cur[key] !== undefined) {
          (out as unknown as Record<string, unknown>)[key] = structuredClone(cur[key]);
        }
      }
    }
    return out;
  });

  // 2. phases
  const completed = completePhases(input.incoming.phases, current.phases);
  if (typeof completed === "string") return fail("INVALID_PHASES", completed);
  const resultPhases = completed;
  let absorbed = false;
  if (input.absorbRephrase === true && isRephraseOnly(current, merged, resultPhases)) {
    const before = { steps: structuredClone(merged), phases: structuredClone(resultPhases) };
    absorbRephrase(merged, curById);
    absorbPhaseRephrase(resultPhases, current.phases);
    absorbed = !same(before.steps, merged) || !same(before.phases, resultPhases);
  }
  const phaseError = checkPhases(resultPhases, merged, approvedPlan, curById);
  if (phaseError) return fail("INVALID_PHASES", phaseError);

  // 3. ゲート
  const finalGateId = finalGate(approvedPlan)?.id;
  const gateChanges: NewGateChange[] = [];
  const mergedById = new Map(merged.map((s) => [s.stepId, s]));

  const needIrregular = (what: string): LedgerGuardResult | undefined =>
    irregularOk
      ? undefined
      : fail(
          "GATE_CHANGE_NOT_ALLOWED",
          `${what}には irregular: true と reason（理由）が必要です。ゲートは通常は変更できません`,
        );

  for (const cur of current.scheduledSteps) {
    if (!isGate(cur)) continue;
    const inc = mergedById.get(cur.stepId);

    if (!inc || !isGate(inc)) {
      // 削除（ゲートでなくすことを含む）
      if (cur.stepId === finalGateId) {
        return fail("GATE_PROTECTED", `最終ゲート ${cur.stepId} は削除できません（irregular でも不可）`);
      }
      if (hasHumanCheck(cur)) {
        return fail(
          "GATE_PROTECTED",
          `人間レビューのゲート ${cur.stepId} は削除できません（人間レビューの省略は irregular でも不可）`,
        );
      }
      const denied = needIrregular(`ゲート ${cur.stepId} の削除`);
      if (denied) return denied;
      gateChanges.push({ gateId: cur.stepId, before: toPlanStep(cur), after: null, reason });
      continue;
    }

    if ((inc.status === "completed" || inc.status === "skipped") && inc.status !== cur.status) {
      return fail(
        "GATE_PROTECTED",
        `ゲート ${cur.stepId} の status を ${inc.status} にはできません。ゲートの合否はサーバーが管理します`,
      );
    }
    inc.status = cur.status;

    if (!same(gateContent(cur), gateContent(inc))) {
      if (humanCount(inc) < humanCount(cur)) {
        return fail(
          "GATE_PROTECTED",
          `ゲート ${cur.stepId} の human チェックは減らせません（人間レビューの省略は irregular でも不可）`,
        );
      }
      const violation = commandViolation(inc, commandPolicy);
      if (violation) return fail("GATE_COMMAND_DENIED", violation);
      const denied = needIrregular(`ゲート ${cur.stepId} の変更`);
      if (denied) return denied;
      gateChanges.push({ gateId: cur.stepId, before: toPlanStep(cur), after: toPlanStep(inc), reason });
    }
  }

  // 追加されたゲート
  for (const inc of merged) {
    if (!isGate(inc)) continue;
    const cur = curById.get(inc.stepId);
    if (cur && isGate(cur)) continue;
    if (inc.status === "completed" || inc.status === "skipped") {
      return fail(
        "GATE_PROTECTED",
        `追加するゲート ${inc.stepId} の status を ${inc.status} にはできません。ゲートの合否はサーバーが管理します`,
      );
    }
    inc.status = "pending";
    const violation = commandViolation(inc, commandPolicy);
    if (violation) return fail("GATE_COMMAND_DENIED", violation);
  }

  // 4. dependsOn を実効依存に正規化する
  const scheduledSteps = normalizeDeps(merged, resultPhases, approvedPlan);

  // 5. 差分の分類
  const { phasePlanned, replanned } = classify(current, scheduledSteps, resultPhases);

  return { ok: true, phases: resultPhases, scheduledSteps, gateChanges, phasePlanned, replanned, absorbed };
}

// --------------------------------------------------
// 初回の再登録の吸収
// --------------------------------------------------

/** フェーズの構造（言い換えの対象の `name` / `goal` / `notes` を除いた部分） */
function phaseStructure(p: Phase) {
  return { id: p.id, planning: p.planning, final: p.final === true, fix: p.fix ?? null, parentPhaseId: p.parentPhaseId ?? null };
}

/** 追加・削除された Step が無く、phases の構造も current と同じ（= 既存の書き直しだけ）か */
function isRephraseOnly(
  current: { phases: Phase[]; scheduledSteps: ScheduledStep[] },
  merged: ScheduledStep[],
  resultPhases: Phase[],
): boolean {
  if (merged.length !== current.scheduledSteps.length) return false;
  const curIds = new Set(current.scheduledSteps.map((s) => s.stepId));
  if (!merged.every((s) => curIds.has(s.stepId))) return false;
  return same(resultPhases.map(phaseStructure), current.phases.map(phaseStructure));
}

/** 吸収の対象にする内容（ゲートの `checks` / `onFail` と `status` は含めない。`dependsOn` は work のみ別扱い） */
const ABSORBED_KEYS = ["role", "description", "doneCriteria", "phaseId", "kind"] as const;

/** 既存 Step の書き直しを current の値で上書きする（merged を直接書き換える） */
function absorbRephrase(merged: ScheduledStep[], curById: Map<string, ScheduledStep>): void {
  for (const out of merged) {
    const cur = curById.get(out.stepId);
    if (!cur) continue;
    const target = out as unknown as Record<string, unknown>;
    const keys: string[] = [...ABSORBED_KEYS];
    // ゲートの dependsOn は実効依存から導出されるので触らない
    if (!isGate(cur)) keys.push("dependsOn");
    for (const key of keys) {
      const value = (cur as unknown as Record<string, unknown>)[key];
      if (value === undefined) delete target[key];
      else target[key] = structuredClone(value);
    }
  }
}

/** フェーズの言い換え（`name` / `goal` / `notes`）を current の値で上書きする（resultPhases を直接書き換える） */
function absorbPhaseRephrase(resultPhases: Phase[], currentPhases: Phase[]): void {
  const curById = new Map(currentPhases.map((p) => [p.id, p]));
  for (const p of resultPhases) {
    const cur = curById.get(p.id);
    if (!cur) continue;
    p.name = cur.name;
    p.goal = cur.goal;
    p.notes = structuredClone(cur.notes);
  }
}

// --------------------------------------------------
// phases の検証
// --------------------------------------------------

/**
 * 再送されたフェーズを完全な Phase にする。既存のフェーズ（current に同じ ID）は省略された
 * `name` / `goal` / `planning` / `notes` を現行値で補完する。新規フェーズは `name` / `goal` が必須。
 * `phases` の省略は current の維持。問題があればメッセージ（string）を返す。
 */
function completePhases(incoming: IncomingPhase[] | undefined, current: Phase[]): Phase[] | string {
  if (incoming === undefined) return structuredClone(current);
  const curById = new Map(current.map((p) => [p.id, p]));
  const out: Phase[] = [];
  for (const inc of incoming) {
    const cur = curById.get(inc.id);
    const name = inc.name ?? cur?.name;
    const goal = inc.goal ?? cur?.goal;
    if (typeof name !== "string" || typeof goal !== "string") {
      return `追加するフェーズ ${inc.id} には name と goal が必要です`;
    }
    const phase: Phase = {
      id: inc.id,
      name,
      goal,
      planning: inc.planning ?? cur?.planning ?? "fixed",
      notes: structuredClone(inc.notes ?? cur?.notes ?? []),
    };
    if (cur) {
      // 既存のフェーズの構造（fix / parentPhaseId / final）は、省略されたら現行値で補完し、
      // 明示的に異なる値が来たら拒否する（承認済みかどうかによらない）
      for (const key of ["fix", "parentPhaseId", "final"] as const) {
        if (inc[key] !== undefined && !same(inc[key], cur[key])) {
          return `フェーズ ${inc.id} の ${key} は変更できません（修正が要るときは修正フェーズを追加します）`;
        }
      }
      if (cur.final !== undefined) phase.final = cur.final;
      if (cur.fix !== undefined) phase.fix = structuredClone(cur.fix);
      if (cur.parentPhaseId !== undefined) phase.parentPhaseId = cur.parentPhaseId;
    } else {
      if (inc.final !== undefined) phase.final = inc.final;
      if (inc.fix !== undefined) phase.fix = structuredClone(inc.fix);
      if (inc.parentPhaseId !== undefined) phase.parentPhaseId = inc.parentPhaseId;
    }
    out.push(phase);
  }
  return out;
}

function checkPhases(
  phases: Phase[],
  steps: ScheduledStep[],
  approved: WorkPlan,
  curById: Map<string, ScheduledStep>,
): string | undefined {
  const ids = new Set<string>();
  for (const p of phases) {
    if (ids.has(p.id)) return `フェーズ ID が重複しています: ${p.id}`;
    ids.add(p.id);
  }

  const approvedIds = new Set(approved.phases.map((p) => p.id));
  for (const ap of approved.phases) {
    const p = phases.find((x) => x.id === ap.id);
    if (!p) return `承認済みのフェーズ ${ap.id} は削除できません`;
    // 承認済みフェーズは構造（fix / parentPhaseId / planning / final）を変えられない
    // （省略された fix / parentPhaseId / final は completePhases が現行値で補っている）
    const changed = (["fix", "parentPhaseId", "planning", "final"] as const).filter((key) =>
      key === "final" ? (p.final === true) !== (ap.final === true) : !same(p[key], ap[key]),
    );
    if (changed.length > 0) {
      return `承認済みのフェーズ ${ap.id} の ${changed.join(" / ")} は変更できません（修正が要るときは修正フェーズを追加します）`;
    }
  }
  for (const p of phases) {
    if (!approvedIds.has(p.id) && p.final === true) {
      return `追加するフェーズ ${p.id} を final にはできません（最終ゲートは承認済みの 1 つだけです）`;
    }
  }
  if (phases.some((p) => p.final === true) && phases[phases.length - 1]?.final !== true) {
    return "final フェーズは phases の最後に置いてください（追加するフェーズは final フェーズより前に入れます）";
  }

  for (const s of steps) {
    if (s.phaseId === undefined) {
      if (!curById.has(s.stepId)) {
        return `新しい Step ${s.stepId} には phaseId が必要です（Workspace ではすべての Step がフェーズに属します）`;
      }
    } else if (!ids.has(s.phaseId)) {
      return `Step ${s.stepId} が存在しないフェーズを指しています: ${s.phaseId}`;
    }
  }

  // 追加した非 final フェーズには出口ゲートが要る（§13.5.1）
  for (const p of phases) {
    if (approvedIds.has(p.id) || p.final === true) continue;
    if (!steps.some((s) => s.phaseId === p.id && s.kind === "gate")) {
      return `追加するフェーズ ${p.id} には出口ゲート（kind: "gate" の Step）が必要です`;
    }
  }

  const problems = validatePhaseReferences({ ...approved, phases, steps: steps.map(toPlanStep) });
  if (problems.length > 0) return problems.join(" / ");
  return undefined;
}

// --------------------------------------------------
// 依存の正規化
// --------------------------------------------------

function normalizeDeps(steps: ScheduledStep[], phases: Phase[], approved: WorkPlan): ScheduledStep[] {
  // phaseId のある Step だけを計画に載せる（無い Step は dependsOn をそのまま残す）
  const planSteps = steps.filter((s) => s.phaseId !== undefined).map(toPlanStep);
  const phaseOf = new Map(planSteps.map((s) => [s.id, s.phaseId]));
  for (const ps of planSteps) {
    ps.dependsOn = ps.dependsOn.filter((d) => phaseOf.get(d) === ps.phaseId);
  }
  const plan: WorkPlan = { ...approved, phases, steps: planSteps };
  const planById = new Map(planSteps.map((s) => [s.id, s]));

  return steps.map((s) => {
    const ps = planById.get(s.stepId);
    if (!ps || s.status === "completed") return s;
    return { ...s, dependsOn: effectiveDeps(plan, ps) };
  });
}

// --------------------------------------------------
// 差分の分類
// --------------------------------------------------

function classify(
  current: { phases: Phase[]; scheduledSteps: ScheduledStep[] },
  next: ScheduledStep[],
  nextPhases: Phase[],
) {
  const curById = new Map(current.scheduledSteps.map((s) => [s.stepId, s]));
  const nextIds = new Set(next.map((s) => s.stepId));

  const planningOf = (phaseId: string | undefined): Phase["planning"] | undefined => {
    if (phaseId === undefined) return undefined;
    return (
      current.phases.find((p) => p.id === phaseId)?.planning ??
      nextPhases.find((p) => p.id === phaseId)?.planning
    );
  };

  const phasePlannedMap = new Map<string, ScheduledStep[]>();
  const replanned = {
    added: [] as ScheduledStep[],
    changed: [] as ScheduledStep[],
    removed: [] as string[],
  };

  for (const s of next) {
    const cur = curById.get(s.stepId);
    if (!cur) {
      if (!isGate(s) && s.phaseId !== undefined && planningOf(s.phaseId) === "deferred") {
        const list = phasePlannedMap.get(s.phaseId) ?? [];
        list.push(s);
        phasePlannedMap.set(s.phaseId, list);
      } else {
        replanned.added.push(s);
      }
    } else if (!same(stepContent(cur), stepContent(s))) {
      replanned.changed.push(s);
    }
  }
  for (const cur of current.scheduledSteps) {
    if (!nextIds.has(cur.stepId)) replanned.removed.push(cur.stepId);
  }

  const phasePlanned = [...phasePlannedMap.entries()].map(([phaseId, addedSteps]) => ({ phaseId, addedSteps }));
  return { phasePlanned, replanned };
}
