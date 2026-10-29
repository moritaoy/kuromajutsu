// ============================================================
// ledger-guard テスト（update_ledger の検証と正規化。docs/spec.md §13.5.5 / §2.2.11）
// ============================================================

import { describe, it, expect } from "vitest";
import { guardLedgerUpdate, type LedgerGuardInput } from "../../src/workspace/ledger-guard.js";
import { buildCommandPolicy } from "../../src/workspace/gate-commands.js";
import { toScheduledSteps } from "../../src/workspace/plan.js";
import type { Phase, ScheduledStep, WorkPlan } from "../../src/types/index.js";
import { DEFAULT_WORKSPACE_CONFIG, gate, human, makeAuthPlan, makeFixPlan, phase, work } from "./fixtures.js";

const plan: WorkPlan = makeAuthPlan();
const policy = buildCommandPolicy(DEFAULT_WORKSPACE_CONFIG);

function baseInput(over: Partial<LedgerGuardInput> = {}): LedgerGuardInput {
  const steps = toScheduledSteps(plan);
  return {
    current: { phases: structuredClone(plan.phases), scheduledSteps: structuredClone(steps) },
    incoming: { scheduledSteps: structuredClone(steps) },
    approvedPlan: plan,
    gateResults: [],
    commandPolicy: policy,
    ...over,
  };
}

/** current の Step を複製し、incoming として編集する */
function edit(fn: (steps: ScheduledStep[]) => ScheduledStep[] | void): ScheduledStep[] {
  const steps = structuredClone(toScheduledSteps(plan));
  return fn(steps) ?? steps;
}

function ok(input: LedgerGuardInput) {
  const r = guardLedgerUpdate(input);
  if (!r.ok) throw new Error(`拒否された: ${r.code} ${r.message}`);
  return r;
}

function ng(input: LedgerGuardInput) {
  const r = guardLedgerUpdate(input);
  if (r.ok) throw new Error("受理されてしまった");
  return r;
}

const byId = (steps: ScheduledStep[], id: string): ScheduledStep => {
  const s = steps.find((x) => x.stepId === id);
  if (!s) throw new Error(`Step が無い: ${id}`);
  return s;
};

describe("変更なし", () => {
  it("そのまま受理し、通知対象は空", () => {
    const r = ok(baseInput());
    expect(r.scheduledSteps).toEqual(toScheduledSteps(plan));
    expect(r.phases).toEqual(plan.phases);
    expect(r.gateChanges).toEqual([]);
    expect(r.phasePlanned).toEqual([]);
    expect(r.replanned).toEqual({ added: [], changed: [], removed: [] });
  });

  it("入力を変更しない", () => {
    const input = baseInput();
    const snapshot = structuredClone(input);
    ok(input);
    expect(input).toEqual(snapshot);
  });
});

describe("ゲートの status（GATE_PROTECTED）", () => {
  it("incoming でゲートを completed にすると GATE_PROTECTED", () => {
    const steps = edit((s) => {
      byId(s, "gate-P3").status = "completed";
    });
    expect(ng(baseInput({ incoming: { scheduledSteps: steps } })).code).toBe("GATE_PROTECTED");
  });

  it("skipped も GATE_PROTECTED", () => {
    const steps = edit((s) => {
      byId(s, "gate-P3").status = "skipped";
    });
    expect(ng(baseInput({ incoming: { scheduledSteps: steps } })).code).toBe("GATE_PROTECTED");
  });

  it("現在 completed のゲートを incoming でも completed なら問題ない", () => {
    const input = baseInput();
    byId(input.current.scheduledSteps, "gate-P3").status = "completed";
    byId(input.incoming.scheduledSteps, "gate-P3").status = "completed";
    const r = ok(input);
    expect(byId(r.scheduledSteps, "gate-P3").status).toBe("completed");
  });

  it("completed 以外の status の変更は受理するが、サーバー管理の値（current）に戻す", () => {
    const input = baseInput();
    byId(input.current.scheduledSteps, "gate-P3").status = "completed";
    byId(input.incoming.scheduledSteps, "gate-P3").status = "in_progress";
    byId(input.incoming.scheduledSteps, "gate-P2").status = "in_progress";
    const r = ok(input);
    expect(byId(r.scheduledSteps, "gate-P3").status).toBe("completed");
    expect(byId(r.scheduledSteps, "gate-P2").status).toBe("pending");
    expect(r.gateChanges).toEqual([]);
  });

  it("work Step の status は incoming のとおり", () => {
    const steps = edit((s) => {
      byId(s, "s1").status = "completed";
      byId(s, "s2").status = "in_progress";
    });
    const r = ok(baseInput({ incoming: { scheduledSteps: steps } }));
    expect(byId(r.scheduledSteps, "s1").status).toBe("completed");
    expect(byId(r.scheduledSteps, "s2").status).toBe("in_progress");
    // status だけの変更は「変更」に含めない
    expect(r.replanned).toEqual({ added: [], changed: [], removed: [] });
  });

  it("新しく追加するゲートを completed にしても GATE_PROTECTED", () => {
    const steps = edit((s) => {
      s.push({
        stepId: "gate-extra",
        role: "code-review",
        description: "追加のゲート",
        status: "completed",
        phaseId: "P3",
        kind: "gate",
        checks: [{ text: "x", method: "agent-review" }],
      });
    });
    expect(ng(baseInput({ incoming: { scheduledSteps: steps } })).code).toBe("GATE_PROTECTED");
  });
});

describe("ゲートの変更（GATE_CHANGE_NOT_ALLOWED / irregular）", () => {
  const changeChecks = (): ScheduledStep[] =>
    edit((s) => {
      byId(s, "gate-P3").checks = [{ text: "ビルドだけ", method: "command", command: "npm run build" }];
    });

  it("checks の変更は irregular なしだと GATE_CHANGE_NOT_ALLOWED", () => {
    const r = ng(baseInput({ incoming: { scheduledSteps: changeChecks() } }));
    expect(r.code).toBe("GATE_CHANGE_NOT_ALLOWED");
  });

  it("irregular: true でも reason が無ければ GATE_CHANGE_NOT_ALLOWED", () => {
    const r = ng(baseInput({ incoming: { scheduledSteps: changeChecks() }, irregular: true }));
    expect(r.code).toBe("GATE_CHANGE_NOT_ALLOWED");
    const r2 = ng(
      baseInput({ incoming: { scheduledSteps: changeChecks() }, irregular: true, reason: "  " }),
    );
    expect(r2.code).toBe("GATE_CHANGE_NOT_ALLOWED");
  });

  it("irregular + reason があれば受理し、before / after / reason を gateChanges に積む", () => {
    const r = ok(
      baseInput({
        incoming: { scheduledSteps: changeChecks() },
        irregular: true,
        reason: "全テストは重すぎるためビルドのみにする",
      }),
    );
    expect(r.gateChanges).toHaveLength(1);
    const c = r.gateChanges[0];
    expect(c.gateId).toBe("gate-P3");
    expect(c.reason).toBe("全テストは重すぎるためビルドのみにする");
    expect(c.before.checks?.[0].command).toBe("npm test && npx tsc --noEmit");
    expect(c.after?.checks?.[0].command).toBe("npm run build");
    expect(c.before.kind).toBe("gate");
    expect(byId(r.scheduledSteps, "gate-P3").checks?.[0].command).toBe("npm run build");
    // 変更されたゲートは「リプランの変更」にも出る
    expect(r.replanned.changed.map((s) => s.stepId)).toContain("gate-P3");
  });

  it("role / onFail の変更も対象", () => {
    const roleChange = edit((s) => {
      byId(s, "gate-P3").role = "text-review";
    });
    expect(ng(baseInput({ incoming: { scheduledSteps: roleChange } })).code).toBe("GATE_CHANGE_NOT_ALLOWED");
    const onFailChange = edit((s) => {
      byId(s, "gate-P3").onFail = { action: "rework", maxRetries: 9 };
    });
    expect(ng(baseInput({ incoming: { scheduledSteps: onFailChange } })).code).toBe("GATE_CHANGE_NOT_ALLOWED");
  });

  it("onFail の省略と既定値（maxRetries: 2）は同じとみなす", () => {
    const input = baseInput();
    byId(input.current.scheduledSteps, "gate-P3").onFail = undefined;
    byId(input.incoming.scheduledSteps, "gate-P3").onFail = { action: "rework", maxRetries: 2 };
    expect(ok(input).gateChanges).toEqual([]);
  });

  it("ゲートの削除は irregular なしだと GATE_CHANGE_NOT_ALLOWED、ありなら after: null", () => {
    const steps = edit((s) => s.filter((x) => x.stepId !== "gate-P3"));
    expect(ng(baseInput({ incoming: { scheduledSteps: steps } })).code).toBe("GATE_CHANGE_NOT_ALLOWED");

    const r = ok(baseInput({ incoming: { scheduledSteps: steps }, irregular: true, reason: "不要になった" }));
    expect(r.gateChanges).toHaveLength(1);
    expect(r.gateChanges[0].gateId).toBe("gate-P3");
    expect(r.gateChanges[0].after).toBeNull();
    expect(r.replanned.removed).toContain("gate-P3");
  });

  it("irregular が付いていても、ゲートの変更が無ければ gateChanges は空", () => {
    const r = ok(baseInput({ irregular: true, reason: "念のため" }));
    expect(r.gateChanges).toEqual([]);
  });

  it("optional フィールド（kind / checks / phaseId / onFail）を省略した incoming は current を引き継ぐ", () => {
    const steps = edit((s) => {
      for (const st of s) {
        delete st.kind;
        delete st.checks;
        delete st.phaseId;
        delete st.onFail;
        delete st.doneCriteria;
      }
    });
    const r = ok(baseInput({ incoming: { scheduledSteps: steps } }));
    expect(r.gateChanges).toEqual([]);
    expect(byId(r.scheduledSteps, "gate-P1").kind).toBe("gate");
    expect(byId(r.scheduledSteps, "gate-P1").checks).toHaveLength(2);
    expect(byId(r.scheduledSteps, "s1").phaseId).toBe("P1");
  });

  it("checks: [] を明示すると削除（緩和）とみなす", () => {
    const steps = edit((s) => {
      byId(s, "gate-P3").checks = [];
    });
    expect(ng(baseInput({ incoming: { scheduledSteps: steps } })).code).toBe("GATE_CHANGE_NOT_ALLOWED");
  });
});

describe("GATE_PROTECTED（irregular でも不可）", () => {
  it("最終ゲートの削除", () => {
    const steps = edit((s) => s.filter((x) => x.stepId !== "gate-final"));
    const r = ng(baseInput({ incoming: { scheduledSteps: steps }, irregular: true, reason: "不要" }));
    expect(r.code).toBe("GATE_PROTECTED");
  });

  it("human チェックを持つゲートの削除", () => {
    const steps = edit((s) => s.filter((x) => x.stepId !== "gate-P1"));
    const r = ng(baseInput({ incoming: { scheduledSteps: steps }, irregular: true, reason: "不要" }));
    expect(r.code).toBe("GATE_PROTECTED");
  });

  it("human チェックの削除（ゲートは残す）", () => {
    const steps = edit((s) => {
      byId(s, "gate-P1").checks = [{ text: "仕様書が矛盾していない", method: "agent-review" }];
    });
    const r = ng(baseInput({ incoming: { scheduledSteps: steps }, irregular: true, reason: "人は不要" }));
    expect(r.code).toBe("GATE_PROTECTED");
  });

  it("kind を work に変えてゲートでなくする（= ゲートの削除）も、最終ゲートなら不可", () => {
    const steps = edit((s) => {
      byId(s, "gate-final").kind = "work";
    });
    const r = ng(baseInput({ incoming: { scheduledSteps: steps }, irregular: true, reason: "不要" }));
    expect(r.code).toBe("GATE_PROTECTED");
  });

  it("human チェックの追加・human の数が減らない変更は irregular で可", () => {
    const steps = edit((s) => {
      byId(s, "gate-P1").checks = [
        { text: "仕様書が矛盾していない", method: "agent-review" },
        { text: "テスト", method: "command", command: "npm test" },
        human("方針に合意できる"),
      ];
    });
    const r = ok(baseInput({ incoming: { scheduledSteps: steps }, irregular: true, reason: "厳しくする" }));
    expect(r.gateChanges).toHaveLength(1);
  });
});

describe("ゲートの追加と command の検査（GATE_COMMAND_DENIED）", () => {
  const extraGate = (command: string): ScheduledStep => ({
    stepId: "gate-extra",
    role: "code-review",
    description: "追加のゲート",
    status: "pending",
    phaseId: "P3",
    kind: "gate",
    checks: [{ text: "追加の確認", method: "command", command }],
  });

  it("ゲートの追加は irregular なしで可（status は pending）", () => {
    const steps = edit((s) => {
      s.push({ ...extraGate("npm run lint"), status: "in_progress" });
    });
    const r = ok(baseInput({ incoming: { scheduledSteps: steps } }));
    expect(r.gateChanges).toEqual([]);
    expect(byId(r.scheduledSteps, "gate-extra").status).toBe("pending");
    expect(r.replanned.added.map((s) => s.stepId)).toContain("gate-extra");
  });

  it("追加するゲートの command が禁止パターンなら GATE_COMMAND_DENIED", () => {
    const steps = edit((s) => {
      s.push(extraGate("git push origin main"));
    });
    expect(ng(baseInput({ incoming: { scheduledSteps: steps } })).code).toBe("GATE_COMMAND_DENIED");
  });

  it("変更するゲートの command が禁止パターンなら（irregular でも）GATE_COMMAND_DENIED", () => {
    const steps = edit((s) => {
      byId(s, "gate-P3").checks = [{ text: "x", method: "command", command: "sudo npm test" }];
    });
    const r = ng(baseInput({ incoming: { scheduledSteps: steps }, irregular: true, reason: "x" }));
    expect(r.code).toBe("GATE_COMMAND_DENIED");
  });

  it("command が空でも GATE_COMMAND_DENIED", () => {
    const steps = edit((s) => {
      s.push(extraGate(""));
    });
    expect(ng(baseInput({ incoming: { scheduledSteps: steps } })).code).toBe("GATE_COMMAND_DENIED");
  });

  it("許可リスト指定時は許可リスト外の command も拒否する", () => {
    const strict = buildCommandPolicy({
      gateCommands: { ...DEFAULT_WORKSPACE_CONFIG.gateCommands, allow: ["npm "] },
    });
    const steps = edit((s) => {
      s.push(extraGate("make test"));
    });
    expect(ng(baseInput({ incoming: { scheduledSteps: steps }, commandPolicy: strict })).code).toBe(
      "GATE_COMMAND_DENIED",
    );
  });
});

describe("phases（INVALID_PHASES）", () => {
  it("phases を省略したら current を維持する", () => {
    const r = ok(baseInput());
    expect(r.phases).toEqual(plan.phases);
  });

  it("承認済みのフェーズの削除は INVALID_PHASES", () => {
    const phases = plan.phases.filter((p) => p.id !== "P3");
    const steps = edit((s) => s.filter((x) => x.phaseId !== "P3"));
    const r = ng(baseInput({ incoming: { phases, scheduledSteps: steps }, irregular: true, reason: "x" }));
    expect(r.code).toBe("INVALID_PHASES");
  });

  it("承認済みのフェーズの final の変更は INVALID_PHASES", () => {
    const phases: Phase[] = structuredClone(plan.phases);
    phases.find((p) => p.id === "PF")!.final = false;
    expect(ng(baseInput({ incoming: { phases, scheduledSteps: edit(() => {}) } })).code).toBe("INVALID_PHASES");
    const phases2: Phase[] = structuredClone(plan.phases);
    phases2.find((p) => p.id === "P3")!.final = true;
    expect(ng(baseInput({ incoming: { phases: phases2, scheduledSteps: edit(() => {}) } })).code).toBe(
      "INVALID_PHASES",
    );
  });

  it("新しいフェーズを final にはできない", () => {
    const phases: Phase[] = [...structuredClone(plan.phases), phase({ id: "PX", final: true })];
    expect(ng(baseInput({ incoming: { phases, scheduledSteps: edit(() => {}) } })).code).toBe("INVALID_PHASES");
  });

  it("フェーズ ID の重複は INVALID_PHASES", () => {
    const phases: Phase[] = [...structuredClone(plan.phases), phase({ id: "P2" })];
    expect(ng(baseInput({ incoming: { phases, scheduledSteps: edit(() => {}) } })).code).toBe("INVALID_PHASES");
  });

  it("修正フェーズの参照が不正なら INVALID_PHASES", () => {
    const phases: Phase[] = [
      ...structuredClone(plan.phases),
      phase({
        id: "FX9",
        parentPhaseId: "P2",
        fix: { failedGateId: "no-such-gate", causePhaseId: "P1", triageStepId: "t1" },
      }),
    ];
    expect(ng(baseInput({ incoming: { phases, scheduledSteps: edit(() => {}) } })).code).toBe("INVALID_PHASES");
  });

  it("Step が存在しないフェーズを指していたら INVALID_PHASES", () => {
    const steps = edit((s) => {
      s.push({ stepId: "z1", role: "impl-code", description: "z", status: "pending", phaseId: "NOPE", kind: "work" });
    });
    expect(ng(baseInput({ incoming: { scheduledSteps: steps } })).code).toBe("INVALID_PHASES");
  });

  it("修正フェーズを入れ子で追加できる（makeFixPlan の形）", () => {
    const fix = makeFixPlan();
    const incoming = { phases: fix.phases, scheduledSteps: toScheduledSteps(fix) };
    const r = ok(baseInput({ incoming }));
    expect(r.phases.map((p) => p.id)).toContain("FX1");
    // P2 は deferred なので、そこへの work Step（i1 / t1）の追加は直前計画として扱う
    expect(r.phasePlanned.map((p) => p.phaseId)).toEqual(["P2"]);
    expect(r.phasePlanned[0].addedSteps.map((s) => s.stepId).sort()).toEqual(["i1", "t1"]);
    expect(r.replanned.added.map((s) => s.stepId).sort()).toEqual(["f1", "gate-FX1"]);
    // 親ゲート gate-P2 は修正フェーズの出口ゲートと同じフェーズの末端 Step の完了後に動く
    expect(byId(r.scheduledSteps, "gate-P2").dependsOn).toEqual(expect.arrayContaining(["gate-FX1"]));
  });
});

describe("dependsOn の正規化（実効依存）", () => {
  const p2Steps = (): ScheduledStep[] =>
    edit((s) => {
      s.push(
        {
          stepId: "i1",
          role: "impl-code",
          description: "実装 1",
          status: "pending",
          phaseId: "P2",
          kind: "work",
          doneCriteria: ["できた"],
        },
        {
          stepId: "i2",
          role: "impl-code",
          description: "実装 2",
          status: "pending",
          phaseId: "P2",
          kind: "work",
          doneCriteria: ["できた"],
          // 別フェーズ（P1）への依存は落ちる。同じフェーズ内の i1 は残る
          dependsOn: ["s2", "i1"],
        },
      );
    });

  it("空の dependsOn には前フェーズのゲートが入る", () => {
    const r = ok(baseInput({ incoming: { scheduledSteps: p2Steps() } }));
    expect(byId(r.scheduledSteps, "i1").dependsOn).toEqual(["gate-P1"]);
  });

  it("別フェーズへの依存は落ちて、同じフェーズ内の依存だけ残る", () => {
    const r = ok(baseInput({ incoming: { scheduledSteps: p2Steps() } }));
    expect(byId(r.scheduledSteps, "i2").dependsOn).toEqual(["i1"]);
  });

  it("出口ゲートの依存は、そのフェーズの末端 Step になる", () => {
    const r = ok(baseInput({ incoming: { scheduledSteps: p2Steps() } }));
    expect(byId(r.scheduledSteps, "gate-P2").dependsOn).toEqual(["i2"]);
  });

  it("完了済み Step の dependsOn は変更しない", () => {
    const steps = p2Steps();
    byId(steps, "i1").status = "completed";
    byId(steps, "i1").dependsOn = ["s1"]; // 実効依存に直せば gate-P1 になるが、完了済みなのでそのまま
    const r = ok(baseInput({ incoming: { scheduledSteps: steps } }));
    expect(byId(r.scheduledSteps, "i1").dependsOn).toEqual(["s1"]);
  });

  it("新規 Step に phaseId が無ければ INVALID_PHASES（Workspace グループ）", () => {
    const input = baseInput();
    const steps = structuredClone(input.incoming.scheduledSteps);
    steps.push({ stepId: "free", role: "impl-code", description: "x", status: "pending", dependsOn: ["s1"] });
    const r = ng({ ...input, incoming: { scheduledSteps: steps } });
    expect(r.code).toBe("INVALID_PHASES");
    expect(r.message).toContain("free");
  });
});

describe("phasePlanned / replanned", () => {
  const added = (phaseId: string, id: string): ScheduledStep => ({
    stepId: id,
    role: "impl-code",
    description: `${id} の作業`,
    status: "pending",
    phaseId,
    kind: "work",
    doneCriteria: ["できた"],
  });

  it("deferred フェーズへの work Step の追加は phasePlanned（フェーズごと）", () => {
    const steps = edit((s) => {
      s.push(added("P2", "i1"), added("P2", "i2"));
    });
    const r = ok(baseInput({ incoming: { scheduledSteps: steps } }));
    expect(r.phasePlanned).toHaveLength(1);
    expect(r.phasePlanned[0].phaseId).toBe("P2");
    expect(r.phasePlanned[0].addedSteps.map((s) => s.stepId)).toEqual(["i1", "i2"]);
    expect(r.replanned.added).toEqual([]);
  });

  it("deferred 以外への追加は replanned.added", () => {
    const steps = edit((s) => {
      s.push(added("P3", "s5"));
    });
    const r = ok(baseInput({ incoming: { scheduledSteps: steps } }));
    expect(r.phasePlanned).toEqual([]);
    expect(r.replanned.added.map((s) => s.stepId)).toEqual(["s5"]);
  });

  it("deferred フェーズへのゲートの追加は phasePlanned ではなく replanned.added", () => {
    const steps = edit((s) => {
      s.push({
        stepId: "gate-P2b",
        role: "code-review",
        description: "追加ゲート",
        status: "pending",
        phaseId: "P2",
        kind: "gate",
        checks: [{ text: "x", method: "agent-review" }],
      });
    });
    const r = ok(baseInput({ incoming: { scheduledSteps: steps } }));
    expect(r.phasePlanned).toEqual([]);
    expect(r.replanned.added.map((s) => s.stepId)).toEqual(["gate-P2b"]);
  });

  it("承認済みフェーズの planning（deferred → fixed）の書き換えは INVALID_PHASES", () => {
    const phases: Phase[] = structuredClone(plan.phases);
    phases.find((p) => p.id === "P2")!.planning = "fixed";
    const steps = edit((s) => {
      s.push(added("P2", "i1"));
    });
    const r = ng(baseInput({ incoming: { phases, scheduledSteps: steps } }));
    expect(r.code).toBe("INVALID_PHASES");
    expect(r.message).toContain("P2");
  });

  it("変更（role / description）と削除は replanned、status のみの変更は含めない", () => {
    const steps = edit((s) => {
      byId(s, "s1").status = "completed";
      byId(s, "s2").description = "説明を変えた";
      byId(s, "s2").role = "impl-code";
      const i = s.findIndex((x) => x.stepId === "s4");
      s.splice(i, 1);
    });
    const r = ok(baseInput({ incoming: { scheduledSteps: steps } }));
    expect(r.replanned.changed.map((s) => s.stepId)).toEqual(["s2"]);
    expect(r.replanned.removed).toEqual(["s4"]);
    expect(r.replanned.added).toEqual([]);
  });

  it("work Step の追加・削除はゲートに影響せず gateChanges は空", () => {
    const steps = edit((s) => {
      s.push(added("P3", "s5"));
    });
    expect(ok(baseInput({ incoming: { scheduledSteps: steps } })).gateChanges).toEqual([]);
  });
});

describe("stepId の重複（DUPLICATE_STEP_ID）", () => {
  it("incoming に同じ stepId があれば拒否する（human を外した弱いコピーが末尾にあるケース）", () => {
    const steps = edit((s) => {
      const weak = structuredClone(byId(s, "gate-P1"));
      weak.checks = [{ text: "仕様書が矛盾していない", method: "agent-review" }];
      s.push(weak);
    });
    expect(ng(baseInput({ incoming: { scheduledSteps: steps } })).code).toBe("DUPLICATE_STEP_ID");
    expect(
      ng(baseInput({ incoming: { scheduledSteps: steps }, irregular: true, reason: "x" })).code,
    ).toBe("DUPLICATE_STEP_ID");
  });

  it("先頭にあるケースも拒否する", () => {
    const steps = edit((s) => {
      const weak = structuredClone(byId(s, "gate-P1"));
      weak.checks = [{ text: "仕様書が矛盾していない", method: "agent-review" }];
      s.unshift(weak);
    });
    expect(ng(baseInput({ incoming: { scheduledSteps: steps } })).code).toBe("DUPLICATE_STEP_ID");
  });

  it("work Step の重複も拒否する", () => {
    const steps = edit((s) => {
      s.push(structuredClone(byId(s, "s1")));
    });
    const r = ng(baseInput({ incoming: { scheduledSteps: steps } }));
    expect(r.code).toBe("DUPLICATE_STEP_ID");
    expect(r.message).toContain("s1");
  });
});

describe("承認済みフェーズの不変性（INVALID_PHASES）", () => {
  it("承認済みの P3 に fix / parentPhaseId を付けて依存を外そうとしても拒否する", () => {
    // 参照としては正しい（P2 に切り分け手順 t1 があり、gate-P2 は P2 のゲート）形にして、M2 の規則だけで拒否されることを確認する
    const phases: Phase[] = structuredClone(plan.phases);
    phases.find((p) => p.id === "P3")!.parentPhaseId = "P2";
    phases.find((p) => p.id === "P3")!.fix = { failedGateId: "gate-P2", causePhaseId: "P1", triageStepId: "t1" };
    const steps = edit((s) => {
      s.push({
        stepId: "t1",
        role: "code-review",
        description: "切り分け",
        status: "pending",
        phaseId: "P2",
        kind: "work",
        doneCriteria: ["できた"],
      });
    });
    const r = ng(baseInput({ incoming: { phases, scheduledSteps: steps } }));
    expect(r.code).toBe("INVALID_PHASES");
    expect(r.message).toContain("P3");
  });

  it("承認済みフェーズの fix を別の値に変える書き換えは拒否する（元が修正フェーズの場合）", () => {
    const fix = makeFixPlan(); // FX1 は承認済みとして扱う
    const input = baseInput({
      approvedPlan: fix,
      current: { phases: structuredClone(fix.phases), scheduledSteps: toScheduledSteps(fix) },
      incoming: { scheduledSteps: toScheduledSteps(fix) },
    });
    const phases: Phase[] = structuredClone(fix.phases);
    phases.find((p) => p.id === "FX1")!.fix = { failedGateId: "gate-P2", causePhaseId: "P2", triageStepId: "t1" };
    expect(ng({ ...input, incoming: { phases, scheduledSteps: toScheduledSteps(fix) } }).code).toBe("INVALID_PHASES");
  });

  it("承認済みフェーズの final / fix / parentPhaseId の省略は現行値で補完される（元が final / 修正フェーズ）", () => {
    const fix = makeFixPlan();
    const input = baseInput({
      approvedPlan: fix,
      current: { phases: structuredClone(fix.phases), scheduledSteps: toScheduledSteps(fix) },
    });
    const partial = fix.phases.map((p) => ({ id: p.id }));
    const r = ok({ ...input, incoming: { phases: partial, scheduledSteps: toScheduledSteps(fix) } });
    expect(r.phases).toEqual(fix.phases);
    expect(r.phases.find((p) => p.id === "PF")!.final).toBe(true);
    expect(r.phases.find((p) => p.id === "FX1")!.parentPhaseId).toBe("P2");
  });

  it("承認済みフェーズに final: false を明示すると拒否する", () => {
    const phases: Phase[] = structuredClone(plan.phases);
    phases.find((p) => p.id === "PF")!.final = false;
    expect(ng(baseInput({ incoming: { phases, scheduledSteps: edit(() => {}) } })).code).toBe("INVALID_PHASES");
  });

  it("再送で省略された name / goal / planning / notes は現行値で補完する", () => {
    const partial = plan.phases.map((p) => ({ id: p.id, ...(p.final ? { final: true } : {}) }));
    const r = ok(baseInput({ incoming: { phases: partial, scheduledSteps: edit(() => {}) } }));
    expect(r.phases).toEqual(plan.phases);
  });

  it("追加フェーズで name / goal が無ければ INVALID_PHASES、planning / notes は既定（fixed / 空）で補完する", () => {
    const base = plan.phases.slice(0, 3);
    const withNew = (extra: Record<string, unknown>) => [
      ...structuredClone(base),
      extra as unknown as Phase,
      structuredClone(plan.phases[3]),
    ];
    const steps = edit((s) => {
      s.push({
        stepId: "gate-FXa",
        role: "code-review",
        description: "g",
        status: "pending",
        phaseId: "PXa",
        kind: "gate",
        checks: [{ text: "x", method: "agent-review" }],
      });
    });
    expect(ng(baseInput({ incoming: { phases: withNew({ id: "PXa", goal: "目的" }), scheduledSteps: steps } })).code).toBe(
      "INVALID_PHASES",
    );
    const r = ok(baseInput({ incoming: { phases: withNew({ id: "PXa", name: "追加", goal: "目的" }), scheduledSteps: steps } }));
    const px = r.phases.find((p) => p.id === "PXa")!;
    expect(px).toMatchObject({ name: "追加", goal: "目的", planning: "fixed", notes: [] });
  });
});

describe("実行時に追加した修正フェーズ（承認済みでないフェーズ）の再送", () => {
  /** 修正フェーズ FX1 を実行時に追加した状態（承認済みの計画は makeAuthPlan のまま） */
  function withRuntimeFix() {
    const fix = makeFixPlan();
    return baseInput({
      current: { phases: structuredClone(fix.phases), scheduledSteps: toScheduledSteps(fix) },
      incoming: { scheduledSteps: toScheduledSteps(fix) },
    });
  }

  it("fix / parentPhaseId / final を省略して再送しても現行値で補完される", () => {
    const input = withRuntimeFix();
    const phases = input.current.phases.map((p) => ({ id: p.id }));
    const r = ok({ ...input, incoming: { phases, scheduledSteps: input.incoming.scheduledSteps } });
    expect(r.phases).toEqual(input.current.phases);
    const fx = r.phases.find((p) => p.id === "FX1")!;
    expect(fx.parentPhaseId).toBe("P2");
    expect(fx.fix).toEqual({ failedGateId: "gate-P2", causePhaseId: "P1", triageStepId: "t1" });
  });

  it("明示的に異なる fix / parentPhaseId が来たら INVALID_PHASES", () => {
    const input = withRuntimeFix();
    const changedFix: Phase[] = structuredClone(input.current.phases);
    changedFix.find((p) => p.id === "FX1")!.fix = { failedGateId: "gate-P2", causePhaseId: "P2", triageStepId: "t1" };
    const r1 = ng({ ...input, incoming: { phases: changedFix, scheduledSteps: input.incoming.scheduledSteps } });
    expect(r1.code).toBe("INVALID_PHASES");
    expect(r1.message).toContain("FX1");

    const changedParent: Phase[] = structuredClone(input.current.phases);
    changedParent.find((p) => p.id === "FX1")!.parentPhaseId = "P3";
    expect(ng({ ...input, incoming: { phases: changedParent, scheduledSteps: input.incoming.scheduledSteps } }).code).toBe(
      "INVALID_PHASES",
    );

    const asFinal: Phase[] = structuredClone(input.current.phases);
    asFinal.find((p) => p.id === "FX1")!.final = true;
    expect(ng({ ...input, incoming: { phases: asFinal, scheduledSteps: input.incoming.scheduledSteps } }).code).toBe(
      "INVALID_PHASES",
    );
  });
});

describe("追加フェーズの出口ゲートと並び（INVALID_PHASES）", () => {
  it("追加した非 final フェーズに出口ゲートが無ければ INVALID_PHASES", () => {
    const phases: Phase[] = [
      ...structuredClone(plan.phases.slice(0, 3)),
      phase({ id: "PXb" }),
      structuredClone(plan.phases[3]),
    ];
    const steps = edit((s) => {
      s.push({ stepId: "xb1", role: "impl-code", description: "x", status: "pending", phaseId: "PXb", kind: "work", doneCriteria: ["a"] });
    });
    const r = ng(baseInput({ incoming: { phases, scheduledSteps: steps } }));
    expect(r.code).toBe("INVALID_PHASES");
    expect(r.message).toContain("PXb");
  });

  it("出口ゲートがあれば受理する", () => {
    const phases: Phase[] = [
      ...structuredClone(plan.phases.slice(0, 3)),
      phase({ id: "PXb" }),
      structuredClone(plan.phases[3]),
    ];
    const steps = edit((s) => {
      s.push(
        { stepId: "xb1", role: "impl-code", description: "x", status: "pending", phaseId: "PXb", kind: "work", doneCriteria: ["a"] },
        { stepId: "gate-PXb", role: "code-review", description: "g", status: "pending", phaseId: "PXb", kind: "gate", checks: [{ text: "x", method: "agent-review" }] },
      );
    });
    expect(ok(baseInput({ incoming: { phases, scheduledSteps: steps } })).phases.map((p) => p.id)).toContain("PXb");
  });

  it("final フェーズが phases の最後でなければ INVALID_PHASES", () => {
    const phases: Phase[] = [...structuredClone(plan.phases), phase({ id: "PXc" })];
    const steps = edit((s) => {
      s.push({ stepId: "gate-PXc", role: "code-review", description: "g", status: "pending", phaseId: "PXc", kind: "gate", checks: [{ text: "x", method: "agent-review" }] });
    });
    const r = ng(baseInput({ incoming: { phases, scheduledSteps: steps } }));
    expect(r.code).toBe("INVALID_PHASES");
    expect(r.message).toContain("final");
  });
});

// 使われない import の警告を避けるためのダミー参照
void work;
void gate;
