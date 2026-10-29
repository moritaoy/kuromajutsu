// ============================================================
// ゲートの attempt 管理と状態導出（純粋関数。docs/spec.md §13.3.3〜13.3.4 / §13.5.6）
//
// すべて入力を変更せず、新しい値を返す。
// ============================================================

import type {
  GateAttempt,
  GateCheck,
  GateCheckResult,
  GateResult,
} from "../types/index.js";

/** ゲートの checks だけを見る関数の引数（PlanStep / ScheduledStep のどちらも渡せる） */
export interface HasChecks {
  checks?: GateCheck[];
}

/** 自動チェック（agent-review / command）の添字と方式。配列順 */
export function autoChecksOf(step: HasChecks): { checkIndex: number; method: "agent-review" | "command" }[] {
  const out: { checkIndex: number; method: "agent-review" | "command" }[] = [];
  (step.checks ?? []).forEach((c, checkIndex) => {
    if (c.method === "agent-review" || c.method === "command") {
      out.push({ checkIndex, method: c.method });
    }
  });
  return out;
}

/** `human` チェックを 1 つでも持つか */
export function hasHumanCheck(step: HasChecks): boolean {
  return (step.checks ?? []).some((c) => c.method === "human");
}

/** 空の GateResult（pending・attempt なし） */
export function newGateResult(gateId: string, phaseId: string): GateResult {
  return { gateId, phaseId, status: "pending", attempts: [], retryInstructions: [] };
}

// --------------------------------------------------
// 状態の導出（§13.3.4）
// --------------------------------------------------

/** 現在の attempt（最後の attempt） */
function currentAttempt(gate: GateResult): GateAttempt | undefined {
  return gate.attempts[gate.attempts.length - 1];
}

/**
 * `GateResult.status` を現在の attempt から導出する。
 *
 * - `failed`: 現在の attempt の自動チェックに不合格が 1 つ以上（他が未実施でも）
 * - `pending`: 結果の揃っていない自動チェックがある
 * - `auto_passed`: 自動チェックがすべて合格し、human チェックがある
 * - `passed`: 自動チェックがすべて合格し、human チェックがない
 *
 * 自動チェックがないゲート（human のみ）は、attempt がなくても `auto_passed`（human なしなら `passed`）。
 * `waiting_human` と「人が承認した `passed`」は service が明示的に設定する。
 */
export function deriveGateStatus(gate: GateResult, step: HasChecks): GateResult["status"] {
  const autos = autoChecksOf(step);
  const human = hasHumanCheck(step);
  if (autos.length === 0) return human ? "auto_passed" : "passed";

  const attempt = currentAttempt(gate);
  if (!attempt) return "pending";

  const byIndex = new Map(attempt.checks.map((c) => [c.checkIndex, c]));
  const results = autos.map((a) => byIndex.get(a.checkIndex));
  if (results.some((r) => r !== undefined && !r.passed)) return "failed";
  if (results.some((r) => r === undefined)) return "pending";
  return human ? "auto_passed" : "passed";
}

// --------------------------------------------------
// 結果の記録
// --------------------------------------------------

/** attempt に結果を入れる（同じ checkIndex は置き換え、checkIndex の昇順を保つ） */
function withResult(attempt: GateAttempt, result: GateCheckResult): GateAttempt {
  const checks = attempt.checks.filter((c) => c.checkIndex !== result.checkIndex);
  checks.push(result);
  checks.sort((a, b) => a.checkIndex - b.checkIndex);
  return { ...attempt, checks };
}

/**
 * チェック結果を記録した新しい GateResult を返す（§13.5.6 の attempt の数え方）。
 *
 * - 最後の attempt が閉じている（または無い）→ 新しい attempt（通し番号）を開く
 * - 同じ `checkIndex` の結果は同じ attempt 内で上書きする。ただし、開いている attempt の
 *   **不合格** の結果を同じ `checkIndex` で記録し直すときは、差し戻しのサイクルが 1 周したとみなし、
 *   その attempt を閉じて次の attempt に記録する（agent-review が未報告のまま再チェックされても
 *   不合格が数えられず、差し戻し上限に達しなくなるのを防ぐ）
 * - 全ての自動チェックに結果が揃ったら `closedAt` を付ける
 * - `status` は `deriveGateStatus` で導出する
 */
export function recordCheckResult(
  gate: GateResult,
  step: HasChecks,
  result: GateCheckResult,
): GateResult {
  const attempts = gate.attempts.map((a) => ({ ...a, checks: [...a.checks] }));
  let last: GateAttempt | undefined = attempts[attempts.length - 1];

  if (last && last.closedAt === undefined) {
    const same = last.checks.find((c) => c.checkIndex === result.checkIndex);
    if (same && !same.passed) {
      last.closedAt = result.at;
      last = undefined;
    }
  } else {
    last = undefined;
  }

  if (last) {
    attempts[attempts.length - 1] = withResult(last, result);
  } else {
    const number = (attempts[attempts.length - 1]?.attempt ?? 0) + 1;
    attempts.push({ attempt: number, checks: [result] });
  }

  // 全ての自動チェックに結果が揃ったら閉じる
  const current = attempts[attempts.length - 1];
  if (current.closedAt === undefined) {
    const have = new Set(current.checks.map((c) => c.checkIndex));
    if (autoChecksOf(step).every((a) => have.has(a.checkIndex))) {
      current.closedAt = result.at;
    }
  }

  const next: GateResult = { ...gate, attempts, retryInstructions: [...gate.retryInstructions] };
  next.status = deriveGateStatus(next, step);
  return next;
}

// --------------------------------------------------
// 差し戻し上限（§13.5.6）
// --------------------------------------------------

/** attempt の最初のチェックの時刻（チェックがなければ undefined） */
function attemptStartedAt(attempt: GateAttempt): string | undefined {
  let min: string | undefined;
  for (const c of attempt.checks) if (min === undefined || c.at < min) min = c.at;
  return min;
}

/**
 * 最後の「指示を付けて再試行」より後の、**連続する** 不合格の attempt の数（末尾から数える）。
 * 不合格の attempt は、不合格のチェックを 1 つ以上含む attempt（閉じていなくても数える）。
 * 合格した attempt（閉じていて不合格がない）が挟まれば 0 に戻る（人間の承認でゲートが合格するのも同じ）。
 * まだ結果が揃っておらず不合格もない attempt は、どちらにも数えず読み飛ばす。
 * 再試行の位置は `afterAttempt`（無ければ時刻の比較）で判定する。
 */
export function failedAttemptsSinceRetry(gate: GateResult): number {
  const lastRetry = gate.retryInstructions[gate.retryInstructions.length - 1];
  const afterRetry = (a: GateAttempt): boolean => {
    if (!lastRetry) return true;
    if (lastRetry.afterAttempt !== undefined) return a.attempt > lastRetry.afterAttempt;
    const started = attemptStartedAt(a);
    return started !== undefined && started > lastRetry.at;
  };

  let count = 0;
  for (let i = gate.attempts.length - 1; i >= 0; i--) {
    const a = gate.attempts[i];
    if (!afterRetry(a)) break;
    if (a.checks.some((c) => !c.passed)) count += 1;
    else if (a.closedAt !== undefined) break; // 合格した attempt
  }
  return count;
}

/** 不合格の attempt が `maxRetries + 1` 回に達したか */
export function isRetryLimitExceeded(gate: GateResult, maxRetries: number): boolean {
  return failedAttemptsSinceRetry(gate) >= maxRetries + 1;
}

// --------------------------------------------------
// checks が変わったゲート（§13.5.5 のイレギュラー）
// --------------------------------------------------

/** チェックの同一性（方式・項目・コマンドが同じなら同じチェック） */
function sameCheck(a: GateCheck, b: GateCheck): boolean {
  return a.method === b.method && a.text === b.text && (a.command ?? "") === (b.command ?? "");
}

/**
 * ゲートの `checks` が変わったときに、記録済みの結果を新しい `checkIndex` に付け替える。
 * 方式・項目・コマンドが同じチェックの結果だけを引き継ぎ（添字が動いても正しく対応する）、
 * 対応するチェックが無くなった結果は捨てる。attempt の履歴は残す。`status` は呼び出し側が導出する。
 */
export function remapGateChecks(gate: GateResult, oldChecks: GateCheck[], newChecks: GateCheck[]): GateResult {
  const attempts = gate.attempts.map((attempt) => {
    const taken = new Set<number>();
    const checks: GateCheckResult[] = [];
    for (const r of attempt.checks) {
      const old = oldChecks[r.checkIndex];
      if (!old) continue;
      const j = newChecks.findIndex((c, i) => !taken.has(i) && sameCheck(c, old));
      if (j < 0) continue;
      taken.add(j);
      checks.push({ ...r, checkIndex: j });
    }
    checks.sort((a, b) => a.checkIndex - b.checkIndex);
    return { ...attempt, checks };
  });
  return { ...gate, attempts, retryInstructions: [...gate.retryInstructions] };
}
