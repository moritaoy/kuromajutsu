import { describe, it, expect } from "vitest";
import {
  autoFixWorkPlan,
  hasErrors,
  validatePhaseReferences,
  validateWorkPlan,
} from "../../src/workspace/validator.js";
import { buildCommandPolicy } from "../../src/workspace/gate-commands.js";
import { getStep, getPhase, finalGate, finalPhase, gateOfPhase } from "../../src/workspace/plan.js";
import type { ValidationIssue, WorkPlan } from "../../src/types/index.js";
import {
  AVAILABLE_ROLES,
  DEFAULT_WORKSPACE_CONFIG,
  gate,
  makeAuthPlan,
  makeFixPlan,
  phase,
  work,
} from "./fixtures.js";

const ctx = (gc: Partial<typeof DEFAULT_WORKSPACE_CONFIG.gateCommands> = {}) => ({
  availableRoles: AVAILABLE_ROLES,
  commandPolicy: buildCommandPolicy({
    gateCommands: { ...DEFAULT_WORKSPACE_CONFIG.gateCommands, ...gc },
  }),
});

const rules = (issues: ValidationIssue[]) => issues.map((i) => i.rule);
const find = (issues: ValidationIssue[], rule: string) => issues.filter((i) => i.rule === rule);

describe("validateWorkPlan", () => {
  it("正常な計画は問題なし", () => {
    expect(validateWorkPlan(makeAuthPlan(), ctx())).toEqual([]);
  });

  it("修正フェーズを含む正常な計画は問題なし", () => {
    expect(validateWorkPlan(makeFixPlan(), ctx())).toEqual([]);
  });

  describe("V1 最終ゲート", () => {
    it("final フェーズがない", () => {
      const p = makeAuthPlan();
      p.phases = p.phases.filter((x) => !x.final);
      p.steps = p.steps.filter((s) => s.id !== "gate-final");
      const issues = find(validateWorkPlan(p, ctx()), "V1");
      expect(issues).toHaveLength(1);
      expect(issues[0].level).toBe("error");
    });

    it("final フェーズはあるが最終ゲートがない", () => {
      const p = makeAuthPlan();
      p.steps = p.steps.filter((s) => s.id !== "gate-final");
      expect(rules(validateWorkPlan(p, ctx()))).toContain("V1");
    });
  });

  describe("V2 出口ゲート", () => {
    it("出口ゲートのないフェーズを検出する（final は除く）", () => {
      const p = makeAuthPlan();
      p.steps = p.steps.filter((s) => s.id !== "gate-P3");
      const issues = find(validateWorkPlan(p, ctx()), "V2");
      expect(issues).toHaveLength(1);
      expect(issues[0].targetIds).toEqual(["P3"]);
      expect(issues[0].level).toBe("error");
    });

    it("修正フェーズにも出口ゲートが必要", () => {
      const p = makeFixPlan();
      p.steps = p.steps.filter((s) => s.id !== "gate-FX1");
      const issues = find(validateWorkPlan(p, ctx()), "V2");
      expect(issues.flatMap((i) => i.targetIds ?? [])).toEqual(["FX1"]);
    });
  });

  describe("V3 DoD", () => {
    it("確定フェーズの work Step に DoD がない", () => {
      const p = makeAuthPlan();
      getStep(p, "s1")!.doneCriteria = [];
      delete getStep(p, "s2")!.doneCriteria;
      getStep(p, "s3")!.doneCriteria = ["  "];
      const issues = find(validateWorkPlan(p, ctx()), "V3");
      expect(issues).toHaveLength(1);
      expect(issues[0].targetIds).toEqual(["s1", "s2", "s3"]);
    });

    it("未決定フェーズの Step は対象外", () => {
      const p = makeAuthPlan();
      p.steps.push(work({ id: "d1", phaseId: "P2", doneCriteria: [] }));
      expect(find(validateWorkPlan(p, ctx()), "V3")).toEqual([]);
    });
  });

  describe("V4 確定 / 未決定フェーズ", () => {
    it("手順のない確定フェーズ", () => {
      const p = makeAuthPlan();
      getPhase(p, "P2")!.planning = "fixed";
      const issues = find(validateWorkPlan(p, ctx()), "V4");
      expect(issues).toHaveLength(1);
      expect(issues[0].targetIds).toEqual(["P2"]);
    });

    it("目的のない未決定フェーズ", () => {
      const p = makeAuthPlan();
      getPhase(p, "P2")!.goal = "  ";
      const issues = find(validateWorkPlan(p, ctx()), "V4");
      expect(issues).toHaveLength(1);
      expect(issues[0].targetIds).toEqual(["P2"]);
    });

    it("final フェーズは対象外", () => {
      expect(find(validateWorkPlan(makeAuthPlan(), ctx()), "V4")).toEqual([]);
    });
  });

  describe("V5 ゲートのチェック", () => {
    it("チェックのないゲート", () => {
      const p = makeAuthPlan();
      getStep(p, "gate-P2")!.checks = [];
      delete getStep(p, "gate-P3")!.checks;
      const issues = find(validateWorkPlan(p, ctx()), "V5");
      expect(issues.flatMap((i) => i.targetIds ?? [])).toEqual(["gate-P2", "gate-P3"]);
    });

    it("テキストが空のチェックしかないゲート", () => {
      const p = makeAuthPlan();
      getStep(p, "gate-P2")!.checks = [{ text: " ", method: "agent-review" }];
      expect(rules(validateWorkPlan(p, ctx()))).toContain("V5");
    });

    it("command が空の command チェック", () => {
      const p = makeAuthPlan();
      getStep(p, "gate-P2")!.checks = [{ text: "ビルド", method: "command", command: " " }];
      const issues = find(validateWorkPlan(p, ctx()), "V5");
      expect(issues).toHaveLength(1);
      expect(issues[0].targetIds).toEqual(["gate-P2"]);
    });
  });

  describe("V6 職種", () => {
    it("ヘルスチェックを通過していない職種", () => {
      const p = makeAuthPlan();
      getStep(p, "s1")!.role = "ghost";
      getStep(p, "gate-P1")!.role = "phantom";
      const issues = find(validateWorkPlan(p, ctx()), "V6");
      expect(issues).toHaveLength(1);
      expect(issues[0].level).toBe("error");
      expect(issues[0].targetIds).toEqual(["s1", "gate-P1"]);
      expect(issues[0].message).toContain("ghost");
      expect(issues[0].message).toContain("phantom");
    });
  });

  describe("V7 循環", () => {
    it("依存の循環を検出する", () => {
      const p = makeAuthPlan();
      getStep(p, "s1")!.dependsOn = ["s2"];
      const issues = find(validateWorkPlan(p, ctx()), "V7");
      expect(issues).toHaveLength(1);
      expect(issues[0].level).toBe("error");
    });
  });

  describe("V7 修正フェーズの参照整合性（validatePhaseReferences）", () => {
    it("正常な修正フェーズは問題なし", () => {
      expect(validatePhaseReferences(makeFixPlan())).toEqual([]);
    });

    it("triageStepId が存在しないと error", () => {
      const p = makeFixPlan();
      getPhase(p, "FX1")!.fix!.triageStepId = "ghost";
      expect(validatePhaseReferences(p).some((m) => m.includes("ghost"))).toBe(true);
      const issues = find(validateWorkPlan(p, ctx()), "V7");
      expect(issues).toHaveLength(1);
      expect(issues[0].level).toBe("error");
      expect(issues[0].message).toContain("ghost");
      expect(issues[0].targetIds).toEqual(["FX1"]);
    });

    it("triageStepId が親フェーズの手順でないと error", () => {
      const p = makeFixPlan();
      getPhase(p, "FX1")!.fix!.triageStepId = "s1"; // P1 の Step
      expect(validatePhaseReferences(p)).toHaveLength(1);
    });

    it("failedGateId が存在しない / ゲートでない / 親フェーズのゲートでないと error", () => {
      for (const bad of ["nope", "i1", "gate-P3"]) {
        const p = makeFixPlan();
        getPhase(p, "FX1")!.fix!.failedGateId = bad;
        expect(validatePhaseReferences(p).length).toBeGreaterThan(0);
      }
    });

    it("causePhaseId が存在しないと error", () => {
      const p = makeFixPlan();
      getPhase(p, "FX1")!.fix!.causePhaseId = "PX";
      expect(validatePhaseReferences(p).some((m) => m.includes("PX"))).toBe(true);
    });

    it("parentPhaseId が存在しない、または fix と片方だけだと error", () => {
      const a = makeFixPlan();
      getPhase(a, "FX1")!.parentPhaseId = "PX";
      expect(validatePhaseReferences(a).some((m) => m.includes("PX"))).toBe(true);

      const b = makeFixPlan();
      delete getPhase(b, "FX1")!.parentPhaseId;
      expect(validatePhaseReferences(b).length).toBeGreaterThan(0);

      const c = makeFixPlan();
      delete getPhase(c, "FX1")!.fix;
      expect(validatePhaseReferences(c).length).toBeGreaterThan(0);
    });
  });

  describe("V8 並列 Step のスコープ衝突", () => {
    it("同じフェーズで並列に動く Step が同じ scope を編集する（warning）", () => {
      const p = makeAuthPlan();
      getStep(p, "s4")!.scope = getStep(p, "s3")!.scope;
      const issues = find(validateWorkPlan(p, ctx()), "V8");
      expect(issues).toHaveLength(1);
      expect(issues[0].level).toBe("warning");
      expect(issues[0].targetIds).toEqual(["s3", "s4"]);
      expect(hasErrors(validateWorkPlan(p, ctx()))).toBe(false);
    });

    it("依存関係で直列になる Step は衝突しない", () => {
      const p = makeAuthPlan();
      getStep(p, "s2")!.scope = getStep(p, "s1")!.scope = "docs/spec.md";
      expect(find(validateWorkPlan(p, ctx()), "V8")).toEqual([]);
    });

    it("読み取りのみ・空の scope は衝突扱いにしない", () => {
      const p = makeAuthPlan();
      getStep(p, "s3")!.scope = "（読み取りのみ）";
      getStep(p, "s4")!.scope = "（読み取りのみ）";
      expect(find(validateWorkPlan(p, ctx()), "V8")).toEqual([]);
      getStep(p, "s3")!.scope = "";
      getStep(p, "s4")!.scope = "";
      expect(find(validateWorkPlan(p, ctx()), "V8")).toEqual([]);
    });

    it("別フェーズの同じ scope は衝突しない", () => {
      const p = makeAuthPlan();
      getStep(p, "s3")!.scope = "docs/spec.md";
      expect(find(validateWorkPlan(p, ctx()), "V8")).toEqual([]);
    });
  });

  describe("V9 ゲートの command", () => {
    it("禁止パターンに当たる command", () => {
      const p = makeAuthPlan();
      getStep(p, "gate-P2")!.checks = [
        { text: "デプロイ", method: "command", command: "git push origin main" },
        { text: "テスト", method: "command", command: "npm test" },
      ];
      const issues = find(validateWorkPlan(p, ctx()), "V9");
      expect(issues).toHaveLength(1);
      expect(issues[0].level).toBe("error");
      expect(issues[0].targetIds).toEqual(["gate-P2"]);
      expect(issues[0].message).toContain("git push");
    });

    it("allow 指定時は許可リスト外の command も違反", () => {
      const p = makeAuthPlan(); // npm run build / npm test && npx tsc --noEmit
      const issues = find(validateWorkPlan(p, ctx({ allow: ["npm run build"] })), "V9");
      expect(issues.flatMap((i) => i.targetIds ?? [])).toEqual(["gate-P3"]);
    });
  });

  it("hasErrors は error があるときだけ true（autoFixed の issue は無視する）", () => {
    expect(hasErrors([])).toBe(false);
    expect(hasErrors([{ rule: "V1", level: "error", message: "fixed", autoFixed: true }])).toBe(false);
    expect(
      hasErrors([
        { rule: "V1", level: "error", message: "fixed", autoFixed: true },
        { rule: "V3", level: "error", message: "e" },
      ]),
    ).toBe(true);
    expect(hasErrors([{ rule: "V8", level: "warning", message: "w" }])).toBe(false);
    expect(hasErrors([{ rule: "V1", level: "error", message: "e" }])).toBe(true);
  });
});

describe("autoFixWorkPlan", () => {
  it("問題がなければ何も変えない", () => {
    const p = makeAuthPlan();
    const r = autoFixWorkPlan(p, ctx());
    expect(r.fixed).toEqual([]);
    expect(r.plan).toEqual(p);
  });

  it("入力を変更せず新しいオブジェクトを返す", () => {
    const p = makeAuthPlan();
    p.steps = p.steps.filter((s) => s.id !== "gate-P3");
    const snapshot = JSON.parse(JSON.stringify(p)) as WorkPlan;
    const r = autoFixWorkPlan(p, ctx());
    expect(p).toEqual(snapshot);
    expect(r.plan).not.toBe(p);
  });

  describe("V1 最終ゲートの生成", () => {
    it("final フェーズと最終ゲートを生成する（チェックは completion の各項目）", () => {
      const p = makeAuthPlan();
      p.phases = p.phases.filter((x) => !x.final);
      p.steps = p.steps.filter((s) => s.id !== "gate-final");
      const r = autoFixWorkPlan(p, ctx());

      expect(finalPhase(r.plan)).toBeDefined();
      expect(r.plan.phases[r.plan.phases.length - 1].final).toBe(true);
      const fg = finalGate(r.plan)!;
      expect(fg.id).toBe("gate-final");
      expect(fg.role).toBe("code-review");
      expect(fg.checks).toEqual(
        p.spec.completion.map((text) => ({ text, method: "agent-review" })),
      );
      expect(fg.onFail).toEqual({ action: "rework", maxRetries: 2 });
      expect(r.fixed.map((i) => i.rule)).toEqual(["V1"]);
      expect(r.fixed[0].autoFixed).toBe(true);
      expect(hasErrors(validateWorkPlan(r.plan, ctx()))).toBe(false);
    });

    it("final フェーズだけあって最終ゲートがない場合はゲートだけ追加する", () => {
      const p = makeAuthPlan();
      p.steps = p.steps.filter((s) => s.id !== "gate-final");
      const r = autoFixWorkPlan(p, ctx());
      expect(r.plan.phases).toHaveLength(p.phases.length);
      expect(finalGate(r.plan)?.phaseId).toBe("PF");
    });

    it("completion が空のときは汎用のチェックを 1 件置く", () => {
      const p = makeAuthPlan();
      p.spec.completion = [];
      p.phases = p.phases.filter((x) => !x.final);
      p.steps = p.steps.filter((s) => s.id !== "gate-final");
      const fg = finalGate(autoFixWorkPlan(p, ctx()).plan)!;
      expect(fg.checks).toHaveLength(1);
      expect(fg.checks![0].method).toBe("agent-review");
    });

    it("ID が衝突する場合は別 ID を採番する", () => {
      const p = makeAuthPlan();
      p.phases = p.phases.filter((x) => !x.final);
      p.steps = p.steps.filter((s) => s.id !== "gate-final");
      p.steps.push(work({ id: "gate-final", phaseId: "P3" }));
      const r = autoFixWorkPlan(p, ctx());
      const ids = r.plan.steps.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(finalGate(r.plan)).toBeDefined();
    });
  });

  describe("V2 出口ゲートの自動挿入", () => {
    it("出口ゲート gate-<phaseId> を挿入する", () => {
      const p = makeAuthPlan();
      p.steps = p.steps.filter((s) => s.id !== "gate-P3");
      const r = autoFixWorkPlan(p, ctx());
      const g = gateOfPhase(r.plan, "P3")!;
      expect(g.id).toBe("gate-P3");
      expect(g.role).toBe("code-review");
      expect(g.checks).toEqual([
        { text: "フェーズの完了定義がすべて満たされている", method: "agent-review" },
      ]);
      expect(g.onFail).toEqual({ action: "rework", maxRetries: 2 });
      // フェーズの最後の Step の直後に入る
      const ids = r.plan.steps.map((s) => s.id);
      expect(ids.indexOf("gate-P3")).toBe(ids.indexOf("s4") + 1);
      expect(r.fixed.map((i) => i.rule)).toEqual(["V2"]);
      expect(r.fixed[0].targetIds).toEqual(["P3"]);
    });

    it("Step のないフェーズにも挿入できる", () => {
      const p = makeAuthPlan();
      p.steps = p.steps.filter((s) => s.id !== "gate-P2");
      const r = autoFixWorkPlan(p, ctx());
      expect(gateOfPhase(r.plan, "P2")?.id).toBe("gate-P2");
    });

    it("複数フェーズ分まとめて挿入する", () => {
      const p = makeAuthPlan();
      p.steps = p.steps.filter((s) => s.kind !== "gate" || s.id === "gate-final");
      const r = autoFixWorkPlan(p, ctx());
      const v2 = r.fixed.filter((i) => i.rule === "V2");
      expect(v2).toHaveLength(1);
      expect(v2[0].targetIds).toEqual(["P1", "P2", "P3"]);
      expect(find(validateWorkPlan(r.plan, ctx()), "V2")).toEqual([]);
    });
  });

  describe("V4 手順のない確定フェーズ", () => {
    it("deferred に変更する", () => {
      const p = makeAuthPlan();
      getPhase(p, "P2")!.planning = "fixed";
      const r = autoFixWorkPlan(p, ctx());
      expect(getPhase(r.plan, "P2")!.planning).toBe("deferred");
      expect(getPhase(p, "P2")!.planning).toBe("fixed");
      expect(r.fixed.map((i) => i.rule)).toEqual(["V4"]);
    });

    it("目的のない未決定フェーズは自動修正できず、エラーとして残る", () => {
      const p = makeAuthPlan();
      getPhase(p, "P2")!.goal = "";
      const r = autoFixWorkPlan(p, ctx());
      expect(r.fixed).toEqual([]);
      expect(rules(validateWorkPlan(r.plan, ctx()))).toEqual(["V4"]);
    });
  });

  describe("挿入するゲートの職種", () => {
    const withRoles = (roles: string[]) => ({ ...ctx(), availableRoles: new Set(roles) });

    it("code-review があればそれを使う", () => {
      const p = makeAuthPlan();
      p.steps = p.steps.filter((s) => s.id !== "gate-P3");
      const r = autoFixWorkPlan(p, withRoles(["impl-code", "code-review"]));
      expect(getStep(r.plan, "gate-P3")!.role).toBe("code-review");
    });

    it("code-review がなければ availableRoles の最初の要素を使う（V2 / V1）", () => {
      const p = makeAuthPlan();
      p.steps = p.steps.filter((s) => s.id !== "gate-P3" && s.id !== "gate-final");
      const r = autoFixWorkPlan(p, withRoles(["text-review", "impl-code"]));
      expect(getStep(r.plan, "gate-P3")!.role).toBe("text-review");
      expect(finalGate(r.plan)!.role).toBe("text-review");
    });

    it("availableRoles が空なら code-review", () => {
      const p = makeAuthPlan();
      p.steps = p.steps.filter((s) => s.id !== "gate-P3");
      const r = autoFixWorkPlan(p, withRoles([]));
      expect(getStep(r.plan, "gate-P3")!.role).toBe("code-review");
    });
  });

  it("V3 / V5 / V6 / V7 / V9 は自動修正しない", () => {
    const p = makeAuthPlan();
    getStep(p, "s1")!.doneCriteria = [];
    getStep(p, "s2")!.role = "ghost";
    getStep(p, "gate-P2")!.checks = [];
    const r = autoFixWorkPlan(p, ctx());
    expect(r.fixed).toEqual([]);
    expect(rules(validateWorkPlan(r.plan, ctx())).sort()).toEqual(["V3", "V5", "V6"]);
  });

  it("gate / phase ヘルパーの健全性", () => {
    expect(gate({ id: "x", phaseId: "P1" }).onFail?.maxRetries).toBe(2);
    expect(phase({ id: "Z" }).planning).toBe("fixed");
  });
});
