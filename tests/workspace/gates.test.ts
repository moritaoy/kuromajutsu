// ============================================================
// gates テスト（ゲートの attempt 管理と状態導出。docs/spec.md §13.3.3〜13.3.4 / §13.5.6）
// ============================================================

import { describe, it, expect } from "vitest";
import {
  autoChecksOf,
  deriveGateStatus,
  failedAttemptsSinceRetry,
  hasHumanCheck,
  isRetryLimitExceeded,
  newGateResult,
  recordCheckResult,
  remapGateChecks,
} from "../../src/workspace/gates.js";
import type { GateCheckResult, GateResult, PlanStep } from "../../src/types/index.js";
import { gate, human } from "./fixtures.js";

/** agent-review(0) + command(1) + human(2) */
const FULL_GATE: PlanStep = gate({
  id: "g",
  phaseId: "P1",
  checks: [
    { text: "レビュー", method: "agent-review" },
    { text: "テスト", method: "command", command: "npm test" },
    human("人が見る"),
  ],
});

/** agent-review(0) + command(1) のみ */
const AUTO_GATE: PlanStep = gate({
  id: "g",
  phaseId: "P1",
  checks: [
    { text: "レビュー", method: "agent-review" },
    { text: "テスト", method: "command", command: "npm test" },
  ],
});

const HUMAN_ONLY_GATE: PlanStep = gate({ id: "g", phaseId: "P1", checks: [human("人が見る")] });

let tick = 0;
function res(
  checkIndex: number,
  method: "agent-review" | "command",
  passed: boolean,
  extra: Partial<GateCheckResult> = {},
): GateCheckResult {
  tick += 1;
  return {
    checkIndex,
    method,
    passed,
    at: new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString(),
    ...extra,
  };
}

describe("autoChecksOf / hasHumanCheck", () => {
  it("agent-review と command の添字と方式を配列順に返す", () => {
    expect(autoChecksOf(FULL_GATE)).toEqual([
      { checkIndex: 0, method: "agent-review" },
      { checkIndex: 1, method: "command" },
    ]);
  });

  it("human のみなら空", () => {
    expect(autoChecksOf(HUMAN_ONLY_GATE)).toEqual([]);
  });

  it("checks が無い Step は空", () => {
    expect(autoChecksOf({ ...FULL_GATE, checks: undefined })).toEqual([]);
  });

  it("ScheduledStep 形（checks を持つオブジェクト）も受け付ける", () => {
    expect(autoChecksOf({ checks: [{ text: "x", method: "command", command: "ls" }] })).toEqual([
      { checkIndex: 0, method: "command" },
    ]);
  });

  it("hasHumanCheck は human チェックの有無", () => {
    expect(hasHumanCheck(FULL_GATE)).toBe(true);
    expect(hasHumanCheck(AUTO_GATE)).toBe(false);
    expect(hasHumanCheck({ checks: undefined })).toBe(false);
  });
});

describe("newGateResult", () => {
  it("pending・attempts 空・retryInstructions 空で作る", () => {
    expect(newGateResult("g", "P1")).toEqual({
      gateId: "g",
      phaseId: "P1",
      status: "pending",
      attempts: [],
      retryInstructions: [],
    });
  });
});

describe("recordCheckResult", () => {
  it("最初の結果で attempt 1 を開き、全自動チェックが揃うまで閉じない", () => {
    const g0 = newGateResult("g", "P1");
    const g1 = recordCheckResult(g0, AUTO_GATE, res(1, "command", true));
    expect(g1.attempts).toHaveLength(1);
    expect(g1.attempts[0].attempt).toBe(1);
    expect(g1.attempts[0].checks).toHaveLength(1);
    expect(g1.attempts[0].closedAt).toBeUndefined();
    expect(g1.status).toBe("pending");
  });

  it("入力を変更しない", () => {
    const g0 = newGateResult("g", "P1");
    const snapshot = structuredClone(g0);
    recordCheckResult(g0, AUTO_GATE, res(1, "command", true));
    expect(g0).toEqual(snapshot);
  });

  it("全自動チェックに結果が揃ったら closedAt を付ける（最後の結果の時刻）", () => {
    let g = newGateResult("g", "P1");
    g = recordCheckResult(g, AUTO_GATE, res(1, "command", true));
    const last = res(0, "agent-review", true);
    g = recordCheckResult(g, AUTO_GATE, last);
    expect(g.attempts[0].closedAt).toBe(last.at);
    expect(g.status).toBe("passed");
  });

  it("human のみのゲートでは自動チェックがないので結果を記録できても閉じる対象がない", () => {
    // 想定外の呼び出しでも壊れない（checkIndex 0 は human なので自動チェックの集合に入らない）
    const g = recordCheckResult(newGateResult("g", "P1"), HUMAN_ONLY_GATE, res(0, "command", true));
    expect(g.attempts).toHaveLength(1);
  });

  it("閉じた attempt の後の結果は新しい attempt を開く（通し番号）", () => {
    let g = newGateResult("g", "P1");
    g = recordCheckResult(g, AUTO_GATE, res(1, "command", false));
    g = recordCheckResult(g, AUTO_GATE, res(0, "agent-review", true));
    expect(g.attempts[0].closedAt).toBeDefined();

    g = recordCheckResult(g, AUTO_GATE, res(1, "command", true));
    expect(g.attempts).toHaveLength(2);
    expect(g.attempts[1].attempt).toBe(2);
    expect(g.attempts[1].closedAt).toBeUndefined();
    expect(g.status).toBe("pending");
  });

  it("同じ attempt 内で、合格済みの checkIndex の結果は上書きする", () => {
    let g = newGateResult("g", "P1");
    g = recordCheckResult(g, AUTO_GATE, res(1, "command", true, { stdoutTail: "old" }));
    g = recordCheckResult(g, AUTO_GATE, res(1, "command", true, { stdoutTail: "new" }));
    expect(g.attempts).toHaveLength(1);
    expect(g.attempts[0].checks).toHaveLength(1);
    expect(g.attempts[0].checks[0].stdoutTail).toBe("new");
  });

  it("開いた attempt の不合格を同じ checkIndex で再記録したら、その attempt を閉じて次の attempt に記録する", () => {
    // agent-review が未報告のまま command の再チェックが来た（= 差し戻しサイクルが 1 周した）
    let g = newGateResult("g", "P1");
    g = recordCheckResult(g, AUTO_GATE, res(1, "command", false));
    expect(g.attempts[0].closedAt).toBeUndefined();

    const second = res(1, "command", false);
    g = recordCheckResult(g, AUTO_GATE, second);
    expect(g.attempts).toHaveLength(2);
    expect(g.attempts[0].closedAt).toBeDefined();
    expect(g.attempts[0].checks[0].passed).toBe(false);
    expect(g.attempts[1].attempt).toBe(2);
    expect(g.attempts[1].checks).toEqual([second]);
  });

  it("結果の順序は checkIndex の昇順で保持する", () => {
    let g = newGateResult("g", "P1");
    g = recordCheckResult(g, FULL_GATE, res(1, "command", true));
    g = recordCheckResult(g, FULL_GATE, res(0, "agent-review", true));
    expect(g.attempts[0].checks.map((c) => c.checkIndex)).toEqual([0, 1]);
  });

  it("status は導出した値になる（human ありなら auto_passed）", () => {
    let g = newGateResult("g", "P1");
    g = recordCheckResult(g, FULL_GATE, res(0, "agent-review", true));
    g = recordCheckResult(g, FULL_GATE, res(1, "command", true));
    expect(g.status).toBe("auto_passed");
  });

  it("retryInstructions は引き継ぐ", () => {
    const g0: GateResult = {
      ...newGateResult("g", "P1"),
      retryInstructions: [{ text: "やり直して", at: "2026-01-01T00:00:00.000Z" }],
    };
    const g1 = recordCheckResult(g0, AUTO_GATE, res(1, "command", true));
    expect(g1.retryInstructions).toEqual(g0.retryInstructions);
  });
});

describe("deriveGateStatus（§13.3.4）", () => {
  const make = (checks: GateCheckResult[], closed: boolean): GateResult => ({
    ...newGateResult("g", "P1"),
    attempts: [
      { attempt: 1, checks, ...(closed ? { closedAt: "2026-01-01T00:00:10.000Z" } : {}) },
    ],
  });

  it("attempt が無ければ pending", () => {
    expect(deriveGateStatus(newGateResult("g", "P1"), AUTO_GATE)).toBe("pending");
  });

  it("結果の揃っていない自動チェックがあれば pending", () => {
    expect(deriveGateStatus(make([res(1, "command", true)], false), AUTO_GATE)).toBe("pending");
  });

  it("1 つでも不合格なら failed（他が未実施でも）", () => {
    expect(deriveGateStatus(make([res(1, "command", false)], false), AUTO_GATE)).toBe("failed");
  });

  it("全自動合格 + human なし → passed", () => {
    const g = make([res(0, "agent-review", true), res(1, "command", true)], true);
    expect(deriveGateStatus(g, AUTO_GATE)).toBe("passed");
  });

  it("全自動合格 + human あり → auto_passed", () => {
    const g = make([res(0, "agent-review", true), res(1, "command", true)], true);
    expect(deriveGateStatus(g, FULL_GATE)).toBe("auto_passed");
  });

  it("現在（最後）の attempt だけを見る", () => {
    const g: GateResult = {
      ...newGateResult("g", "P1"),
      attempts: [
        { attempt: 1, checks: [res(0, "agent-review", false), res(1, "command", false)], closedAt: "x" },
        { attempt: 2, checks: [res(0, "agent-review", true), res(1, "command", true)], closedAt: "y" },
      ],
    };
    expect(deriveGateStatus(g, AUTO_GATE)).toBe("passed");
  });

  it("自動チェックが無い（human のみ）ゲートは auto_passed、human もなければ passed", () => {
    expect(deriveGateStatus(newGateResult("g", "P1"), HUMAN_ONLY_GATE)).toBe("auto_passed");
    expect(
      deriveGateStatus(newGateResult("g", "P1"), { ...AUTO_GATE, checks: [] }),
    ).toBe("passed");
  });

  it("ゲートの checks にない checkIndex の結果は無視する", () => {
    const g = make([res(5, "command", false), res(0, "agent-review", true), res(1, "command", true)], true);
    expect(deriveGateStatus(g, AUTO_GATE)).toBe("passed");
  });
});

describe("failedAttemptsSinceRetry / isRetryLimitExceeded", () => {
  const failed = (n: number, closed = true) => ({
    attempt: n,
    checks: [res(1, "command", false)],
    ...(closed ? { closedAt: "x" } : {}),
  });
  const passedAttempt = (n: number) => ({
    attempt: n,
    checks: [res(1, "command", true)],
    closedAt: "x",
  });

  it("連続する不合格の attempt の数を数える（不合格 → 不合格 → 不合格 は 3）", () => {
    const g: GateResult = { ...newGateResult("g", "P1"), attempts: [failed(1), failed(2), failed(3)] };
    expect(failedAttemptsSinceRetry(g)).toBe(3);
  });

  it("合格した attempt を挟むと 0 に戻る（不合格 → 不合格 → 合格 → 不合格 は 1）", () => {
    const g: GateResult = {
      ...newGateResult("g", "P1"),
      attempts: [failed(1), failed(2), passedAttempt(3), failed(4)],
    };
    expect(failedAttemptsSinceRetry(g)).toBe(1);
    expect(failedAttemptsSinceRetry({ ...g, attempts: [failed(1), failed(2), passedAttempt(3)] })).toBe(0);
  });

  it("結果が揃っていない（不合格もない）attempt は読み飛ばして数える", () => {
    const open = { attempt: 3, checks: [res(0, "agent-review", true)] };
    const g: GateResult = { ...newGateResult("g", "P1"), attempts: [failed(1), failed(2), open] };
    expect(failedAttemptsSinceRetry(g)).toBe(2);
  });

  it("まだ閉じていない attempt でも不合格のチェックがあれば数える", () => {
    const g: GateResult = { ...newGateResult("g", "P1"), attempts: [failed(1, false)] };
    expect(failedAttemptsSinceRetry(g)).toBe(1);
  });

  it("不合格のないまだ閉じていない attempt は数えない", () => {
    const g: GateResult = {
      ...newGateResult("g", "P1"),
      attempts: [{ attempt: 1, checks: [res(1, "command", true)] }],
    };
    expect(failedAttemptsSinceRetry(g)).toBe(0);
  });

  it("retryInstructions の afterAttempt より後の attempt だけを数える", () => {
    const g: GateResult = {
      ...newGateResult("g", "P1"),
      attempts: [failed(1), failed(2), failed(3), failed(4)],
      retryInstructions: [{ text: "x", at: "2026-01-01T00:00:00.000Z", afterAttempt: 3 }],
    };
    expect(failedAttemptsSinceRetry(g)).toBe(1);
  });

  it("afterAttempt が無い retryInstructions は時刻で比較する（attempt の最初のチェックが後のもの）", () => {
    const early = { attempt: 1, checks: [{ ...res(1, "command", false), at: "2026-01-01T00:00:01.000Z" }], closedAt: "x" };
    const late = { attempt: 2, checks: [{ ...res(1, "command", false), at: "2026-01-01T00:00:09.000Z" }], closedAt: "x" };
    const g: GateResult = {
      ...newGateResult("g", "P1"),
      attempts: [early, late],
      retryInstructions: [{ text: "x", at: "2026-01-01T00:00:05.000Z" }],
    };
    expect(failedAttemptsSinceRetry(g)).toBe(1);
  });

  it("isRetryLimitExceeded: maxRetries + 1 回の不合格で超過", () => {
    const base = newGateResult("g", "P1");
    const g2: GateResult = { ...base, attempts: [failed(1), failed(2)] };
    const g3: GateResult = { ...base, attempts: [failed(1), failed(2), failed(3)] };
    expect(isRetryLimitExceeded(g2, 2)).toBe(false);
    expect(isRetryLimitExceeded(g3, 2)).toBe(true);
    expect(isRetryLimitExceeded(g2, 1)).toBe(true);
    expect(isRetryLimitExceeded(base, 0)).toBe(false);
  });

  it("retry 後は 0 から数え直す", () => {
    const g: GateResult = {
      ...newGateResult("g", "P1"),
      attempts: [failed(1), failed(2), failed(3)],
      retryInstructions: [{ text: "x", at: "2026-01-01T00:00:00.000Z", afterAttempt: 3 }],
    };
    expect(isRetryLimitExceeded(g, 2)).toBe(false);
    expect(failedAttemptsSinceRetry(g)).toBe(0);
  });
});

describe("remapGateChecks（checks が変わったゲート）", () => {
  const review = { text: "レビュー", method: "agent-review" as const };
  const cmd = { text: "テスト", method: "command" as const, command: "npm test" };

  it("方式・項目・コマンドが同じチェックの結果を、新しい checkIndex に付け替える", () => {
    let g = newGateResult("g", "P1");
    g = recordCheckResult(g, { checks: [review, cmd] }, res(0, "agent-review", true));
    g = recordCheckResult(g, { checks: [review, cmd] }, res(1, "command", true));
    const out = remapGateChecks(g, [review, cmd], [cmd]);
    expect(out.attempts[0].checks.map((c) => [c.checkIndex, c.method])).toEqual([[0, "command"]]);
    expect(deriveGateStatus(out, { checks: [cmd] })).toBe("passed");
  });

  it("添字が同じでも別のチェックなら引き継がない（別のチェックの合格を流用しない）", () => {
    let g = newGateResult("g", "P1");
    g = recordCheckResult(g, { checks: [review, cmd] }, res(0, "agent-review", true));
    // review を外すと cmd が添字 0 になる。review の結果を cmd の結果と取り違えてはならない
    const out = remapGateChecks(g, [review, cmd], [cmd]);
    expect(out.attempts[0].checks).toEqual([]);
    expect(deriveGateStatus(out, { checks: [cmd] })).toBe("pending");
  });

  it("コマンドが変わったチェックの結果は捨て、入力を変更しない", () => {
    let g = newGateResult("g", "P1");
    g = recordCheckResult(g, { checks: [cmd] }, res(0, "command", true));
    const snapshot = structuredClone(g);
    const out = remapGateChecks(g, [cmd], [{ ...cmd, command: "npm run lint" }]);
    expect(out.attempts[0].checks).toEqual([]);
    expect(out.attempts).toHaveLength(1);
    expect(g).toEqual(snapshot);
  });

  it("チェックが増えた場合は既存の結果をそのまま引き継ぐ（新しいチェックは未実施の pending）", () => {
    let g = newGateResult("g", "P1");
    g = recordCheckResult(g, { checks: [cmd] }, res(0, "command", true));
    const lint = { text: "lint", method: "command" as const, command: "npm run lint" };
    const out = remapGateChecks(g, [cmd], [cmd, lint]);
    expect(out.attempts[0].checks.map((c) => c.checkIndex)).toEqual([0]);
    expect(deriveGateStatus(out, { checks: [cmd, lint] })).toBe("pending");
  });
});
