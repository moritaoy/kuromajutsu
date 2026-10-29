import { describe, it, expect } from "vitest";
import {
  computeLevels,
  computeMaxIterations,
  diffPlans,
  effectiveDeps,
  finalGate,
  finalPhase,
  fixPhasesOf,
  gateOfPhase,
  generateWorkspaceId,
  getPhase,
  getStep,
  isHumanGate,
  prevGate,
  sinks,
  stepsOfPhase,
  toScheduledSteps,
  toTaskLedgerInput,
  workStepsOfPhase,
} from "../../src/workspace/plan.js";
import { computeNextRunnableSteps } from "../../src/mcp/tools/update-ledger.js";
import { gate, makeAuthPlan, makeFixPlan, work } from "./fixtures.js";

describe("参照ヘルパー", () => {
  const plan = makeAuthPlan();

  it("getPhase / getStep", () => {
    expect(getPhase(plan, "P1")?.name).toBe("アーキテクチャを決める");
    expect(getPhase(plan, "nope")).toBeUndefined();
    expect(getStep(plan, "s2")?.phaseId).toBe("P1");
    expect(getStep(plan, "nope")).toBeUndefined();
  });

  it("stepsOfPhase / workStepsOfPhase / gateOfPhase", () => {
    expect(stepsOfPhase(plan, "P1").map((s) => s.id)).toEqual(["s1", "s2", "gate-P1"]);
    expect(workStepsOfPhase(plan, "P1").map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(gateOfPhase(plan, "P1")?.id).toBe("gate-P1");
    expect(workStepsOfPhase(plan, "P2")).toEqual([]);
  });

  it("finalPhase / finalGate", () => {
    expect(finalPhase(plan)?.id).toBe("PF");
    expect(finalGate(plan)?.id).toBe("gate-final");
  });

  it("final フェーズがない計画では undefined", () => {
    const p = makeAuthPlan();
    p.phases = p.phases.filter((x) => !x.final);
    expect(finalPhase(p)).toBeUndefined();
    expect(finalGate(p)).toBeUndefined();
  });

  it("isHumanGate は human チェックを持つゲートだけ true", () => {
    expect(isHumanGate(getStep(plan, "gate-P1")!)).toBe(true);
    expect(isHumanGate(getStep(plan, "gate-P2")!)).toBe(false);
    expect(isHumanGate(getStep(plan, "s1")!)).toBe(false);
  });

  it("sinks はフェーズ内で他から依存されていない work Step", () => {
    expect(sinks(plan, "P1").map((s) => s.id)).toEqual(["s2"]);
    expect(sinks(plan, "P3").map((s) => s.id)).toEqual(["s3", "s4"]);
    expect(sinks(plan, "P2")).toEqual([]);
  });

  it("prevGate は入れ子でない直前フェーズの出口ゲート", () => {
    expect(prevGate(plan, "P1")).toBeUndefined();
    expect(prevGate(plan, "P2")?.id).toBe("gate-P1");
    expect(prevGate(plan, "PF")?.id).toBe("gate-P3");
  });

  it("fixPhasesOf は parentPhaseId が一致するフェーズ", () => {
    const fx = makeFixPlan();
    expect(fixPhasesOf(fx, "P2").map((p) => p.id)).toEqual(["FX1"]);
    expect(fixPhasesOf(fx, "P1")).toEqual([]);
    // 入れ子のフェーズは prevGate の対象外
    expect(prevGate(fx, "P3")?.id).toBe("gate-P2");
  });
});

describe("effectiveDeps", () => {
  const plan = makeAuthPlan();
  const deps = (id: string, p = plan) => effectiveDeps(p, getStep(p, id)!);

  it("フェーズ内に依存があればそれを返す", () => {
    expect(deps("s2")).toEqual(["s1"]);
  });

  it("第 1 フェーズの依存なし Step は依存なし", () => {
    expect(deps("s1")).toEqual([]);
  });

  it("フェーズ内依存のない Step は前フェーズのゲートに依存する", () => {
    expect(deps("s3")).toEqual(["gate-P2"]);
    expect(deps("s4")).toEqual(["gate-P2"]);
  });

  it("ゲートはフェーズの末端 Step すべてに依存する", () => {
    expect(deps("gate-P1")).toEqual(["s2"]);
    expect(deps("gate-P3")).toEqual(["s3", "s4"]);
  });

  it("Step のないフェーズのゲートは前フェーズのゲートに依存する", () => {
    expect(deps("gate-P2")).toEqual(["gate-P1"]);
  });

  it("最終ゲートは最後のフェーズの出口ゲートに依存する", () => {
    expect(deps("gate-final")).toEqual(["gate-P3"]);
  });

  it("別フェーズへの dependsOn は無視する", () => {
    const p = makeAuthPlan();
    getStep(p, "s3")!.dependsOn = ["s1"];
    expect(deps("s3", p)).toEqual(["gate-P2"]);
  });

  describe("修正フェーズの入れ子", () => {
    const fx = makeFixPlan();

    it("修正フェーズの起点は fix.triageStepId に依存する", () => {
      expect(deps("f1", fx)).toEqual(["t1"]);
    });

    it("修正フェーズのゲートは修正フェーズの末端に依存する", () => {
      expect(deps("gate-FX1", fx)).toEqual(["f1"]);
    });

    it("元のゲートは修正フェーズの出口ゲートの後に再チェックする", () => {
      // t1（切り分け）は修正フェーズ経由でつながるので直接は待たない
      expect(deps("gate-P2", fx)).toEqual(["gate-FX1"]);
    });

    it("修正フェーズの出口ゲートがなければその末端 Step に依存する", () => {
      const p = makeFixPlan();
      p.steps = p.steps.filter((s) => s.id !== "gate-FX1");
      expect(deps("gate-P2", p)).toEqual(["f1"]);
    });

    it("入れ子フェーズの後の Step は元フェーズのゲートを待つ", () => {
      expect(deps("s3", fx)).toEqual(["gate-P2"]);
    });
  });
});

describe("computeLevels", () => {
  it("フェーズ順に深くなる", () => {
    const { levels, cyclic } = computeLevels(makeAuthPlan());
    expect(cyclic).toBe(false);
    expect(levels["s1"]).toBe(0);
    expect(levels["s2"]).toBe(1);
    expect(levels["gate-P1"]).toBe(2);
    expect(levels["gate-P2"]).toBe(3);
    expect(levels["s3"]).toBe(4);
    expect(levels["s4"]).toBe(4);
    expect(levels["gate-P3"]).toBe(5);
    expect(levels["gate-final"]).toBe(6);
  });

  it("循環を検出する", () => {
    const p = makeAuthPlan();
    getStep(p, "s1")!.dependsOn = ["s2"]; // s1 -> s2 -> s1
    expect(computeLevels(p).cyclic).toBe(true);
  });

  it("自己依存も循環とみなす", () => {
    const p = makeAuthPlan();
    getStep(p, "s1")!.dependsOn = ["s1"];
    expect(computeLevels(p).cyclic).toBe(true);
  });

  it("修正フェーズを含む計画で循環しない", () => {
    expect(computeLevels(makeFixPlan()).cyclic).toBe(false);
  });
});

describe("toScheduledSteps", () => {
  const plan = makeAuthPlan();
  const steps = toScheduledSteps(plan);

  it("全 Step を pending で写像する", () => {
    expect(steps).toHaveLength(plan.steps.length);
    expect(steps.every((s) => s.status === "pending")).toBe(true);
  });

  it("work Step は phaseId / kind / doneCriteria を持つ", () => {
    const s2 = steps.find((s) => s.stepId === "s2")!;
    expect(s2).toMatchObject({
      stepId: "s2",
      role: "design",
      phaseId: "P1",
      kind: "work",
      dependsOn: ["s1"],
    });
    expect(s2.doneCriteria).toEqual(["s2 が完了している"]);
    expect(s2.checks).toBeUndefined();
  });

  it("ゲートは checks / onFail を保持し、dependsOn に実効依存が入る", () => {
    const g = steps.find((s) => s.stepId === "gate-P3")!;
    expect(g.kind).toBe("gate");
    expect(g.checks).toHaveLength(1);
    expect(g.onFail).toEqual({ action: "rework", maxRetries: 2 });
    expect(g.dependsOn).toEqual(["s3", "s4"]);
  });

  it("元の計画を変更しない（深いコピー）", () => {
    const g = steps.find((s) => s.stepId === "gate-P1")!;
    g.checks![0].text = "改変";
    expect(getStep(plan, "gate-P1")!.checks![0].text).not.toBe("改変");
  });

  it("computeNextRunnableSteps で最初に走るのは第 1 フェーズの依存なし Step だけ", () => {
    const runnable = computeNextRunnableSteps(steps).map((s) => s.stepId);
    expect(runnable).toEqual(["s1"]);
  });

  it("ゲート合格（completed）で次のフェーズが開始できる", () => {
    const progressed = toScheduledSteps(plan).map((s) =>
      ["s1", "s2", "gate-P1"].includes(s.stepId) ? { ...s, status: "completed" as const } : s,
    );
    // P2 は deferred で手順がなく、gate-P2 が次に走る
    expect(computeNextRunnableSteps(progressed).map((s) => s.stepId)).toEqual(["gate-P2"]);

    const progressed2 = progressed.map((s) =>
      s.stepId === "gate-P2" ? { ...s, status: "completed" as const } : s,
    );
    expect(computeNextRunnableSteps(progressed2).map((s) => s.stepId)).toEqual(["s3", "s4"]);
  });
});

describe("toTaskLedgerInput", () => {
  it("facts / plan / scheduledSteps / phases を返す", () => {
    const plan = makeAuthPlan();
    const input = toTaskLedgerInput(plan);
    expect(input.facts).toEqual(plan.facts);
    expect(input.plan[0]).toBe("P1 アーキテクチャを決める — 認証方式と API 仕様を決める");
    expect(input.plan).toHaveLength(plan.phases.length);
    expect(input.scheduledSteps).toHaveLength(plan.steps.length);
    expect(input.phases.map((p) => p.id)).toEqual(["P1", "P2", "P3", "PF"]);
  });
});

describe("computeMaxIterations", () => {
  it("固定フェーズの手順 + 未決定 × 3 + ゲート × 2 を数える", () => {
    // 固定の手順 4 + 未決定 1 × 3 + ゲート 4 + ゲート 4 = 15
    expect(computeMaxIterations(makeAuthPlan())).toBe(15);
  });

  it("未決定フェーズの手順は数えない", () => {
    const plan = makeAuthPlan();
    plan.phases[0].planning = "deferred";
    // 固定フェーズの work: s3, s4 = 2 / 未決定 2 × 3 = 6 / ゲート 4 × 2 = 8 → 16
    expect(computeMaxIterations(plan)).toBe(16);
  });

  it("小さな計画でも下限は 10", () => {
    const plan = makeAuthPlan();
    plan.steps = plan.steps.filter((s) => s.kind === "gate").slice(0, 1);
    plan.phases = plan.phases.slice(0, 1);
    // 式の値は 0 + 0 + 1 + 1 = 2
    expect(computeMaxIterations(plan)).toBe(10);
  });
});

describe("diffPlans", () => {
  it("追加・変更・削除を ID で突き合わせる", () => {
    const prev = makeAuthPlan();
    const next = makeAuthPlan();
    next.revision = 2;
    getStep(next, "s2")!.title = "変更後";
    next.steps = next.steps.filter((s) => s.id !== "s4");
    next.steps.push(work({ id: "s9", phaseId: "P3" }));
    next.phases[1].goal = "目的を変えた";
    next.phases.splice(3, 0, { id: "P4", name: "新", goal: "g", planning: "fixed", notes: [] });

    const d = diffPlans(prev, next);
    expect(d.addedStepIds).toEqual(["s9"]);
    expect(d.changedStepIds).toEqual(["s2"]);
    expect(d.removedStepIds).toEqual(["s4"]);
    expect(d.addedPhaseIds).toEqual(["P4"]);
    expect(d.changedPhaseIds).toEqual(["P2"]);
    expect(d.removedPhaseIds).toEqual([]);
  });

  it("同一の計画は差分なし", () => {
    const d = diffPlans(makeAuthPlan(), makeAuthPlan());
    expect(Object.values(d).every((v) => v.length === 0)).toBe(true);
  });

  it("ゲートのチェック変更を changed として検出する", () => {
    const prev = makeAuthPlan();
    const next = makeAuthPlan();
    getStep(next, "gate-P3")!.checks!.push({ text: "追加", method: "agent-review" });
    expect(diffPlans(prev, next).changedStepIds).toEqual(["gate-P3"]);
  });

  it("gate ヘルパーが使える（フィクスチャの健全性）", () => {
    expect(gate({ id: "g", phaseId: "P1" }).kind).toBe("gate");
  });
});

describe("generateWorkspaceId", () => {
  it("ws-{unixTimestamp}-{random4hex} 形式", () => {
    expect(generateWorkspaceId()).toMatch(/^ws-\d+-[0-9a-f]{4}$/);
  });

  it("random 部は常に 4 桁の 16 進", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateWorkspaceId()).toMatch(/^ws-\d+-[0-9a-f]{4}$/);
    }
  });
});
