// ============================================================
// Workspace テスト用フィクスチャ
// ============================================================

import type { GateCheck, Phase, PlanStep, WorkPlan, WorkspaceConfig } from "../../src/types/index.js";

export const AVAILABLE_ROLES = new Set([
  "research",
  "design",
  "impl-code",
  "impl-test",
  "code-review",
  "text-review",
  "text-writer",
]);

export const DEFAULT_WORKSPACE_CONFIG: WorkspaceConfig = {
  gateCommands: { deny: [], allow: [], timeout_ms: 600000, maxOutput_bytes: 1048576 },
};

export function work(
  o: Partial<PlanStep> & { id: string; phaseId: string },
): PlanStep {
  return {
    kind: "work",
    title: o.id,
    role: "impl-code",
    description: `${o.id} の作業`,
    dependsOn: [],
    doneCriteria: [`${o.id} が完了している`],
    scope: `src/${o.id}/**`,
    ...o,
  };
}

export function gate(
  o: Partial<PlanStep> & { id: string; phaseId: string },
): PlanStep {
  return {
    kind: "gate",
    title: o.id,
    role: "code-review",
    description: `${o.id} のゲート`,
    dependsOn: [],
    checks: [{ text: "完了定義が満たされている", method: "agent-review" }],
    onFail: { action: "rework", maxRetries: 2 },
    ...o,
  };
}

export function phase(o: Partial<Phase> & { id: string }): Phase {
  return {
    name: o.id,
    goal: `${o.id} の目的`,
    planning: "fixed",
    notes: [],
    ...o,
  };
}

export const human = (text: string): GateCheck => ({ text, method: "human" });

/**
 * 「3 フェーズ + 最終ゲート」の計画（モックの planAuth 相当）
 *
 * - P1 アーキテクチャを決める（fixed。出口は人間レビュー）: s1 -> s2 -> gate-P1
 * - P2 実装を行う（deferred。手順は未決定）: gate-P2
 * - P3 テストを実装する（fixed）: s3 / s4（並列）-> gate-P3
 * - PF 完了確認（final）: gate-final
 */
export function makeAuthPlan(): WorkPlan {
  return {
    revision: 1,
    title: "認証機能（JWT）の追加",
    goal: "既存 API に JWT 認証を追加する",
    spec: {
      workspace: "/tmp/project",
      scope: ["src/auth/**", "tests/auth/**"],
      constraints: ["TDD"],
      completion: ["npm test が成功する", "認証 API が仕様どおりに動く"],
      assumptions: ["HS256 署名"],
    },
    phases: [
      phase({ id: "P1", name: "アーキテクチャを決める", goal: "認証方式と API 仕様を決める" }),
      phase({
        id: "P2",
        name: "実装を行う",
        planning: "deferred",
        goal: "設計どおりに実装する",
        notes: ["設計の分割を見て手順を決める"],
      }),
      phase({ id: "P3", name: "テストを実装する", goal: "テストを揃える" }),
      phase({ id: "PF", name: "完了確認", goal: "完了条件を全体で確認する", final: true }),
    ],
    steps: [
      work({ id: "s1", phaseId: "P1", role: "research", scope: "（読み取りのみ）" }),
      work({ id: "s2", phaseId: "P1", role: "design", dependsOn: ["s1"], scope: "docs/spec.md" }),
      gate({
        id: "gate-P1",
        phaseId: "P1",
        checks: [
          { text: "仕様書が矛盾していない", method: "agent-review" },
          human("方針に合意できる"),
        ],
      }),
      gate({
        id: "gate-P2",
        phaseId: "P2",
        checks: [{ text: "ビルドが成功する", method: "command", command: "npm run build" }],
      }),
      work({ id: "s3", phaseId: "P3", role: "impl-test", scope: "tests/unit/**" }),
      work({ id: "s4", phaseId: "P3", role: "impl-test", scope: "tests/integration/**" }),
      gate({
        id: "gate-P3",
        phaseId: "P3",
        checks: [
          { text: "全テストが成功する", method: "command", command: "npm test && npx tsc --noEmit" },
        ],
      }),
      gate({
        id: "gate-final",
        phaseId: "PF",
        checks: [{ text: "npm test が成功する", method: "agent-review" }],
      }),
    ],
    facts: { given: ["Express 製"], toInvestigate: [], toDerive: [], assumptions: [] },
    maxIterations: 12,
  };
}

/**
 * makeAuthPlan に「P2 のゲート不合格 → 修正フェーズ FX1 を入れ子で追加」した計画。
 *
 * - P2: i1 -> t1（原因の切り分け）-> [FX1] -> gate-P2（再チェック）
 * - FX1（parent: P2）: f1（triage 後に開始）-> gate-FX1
 */
export function makeFixPlan(): WorkPlan {
  const plan = makeAuthPlan();
  plan.phases.splice(
    2,
    0,
    phase({
      id: "FX1",
      name: "修正",
      goal: "P1 の仕様の不備を直す",
      parentPhaseId: "P2",
      fix: { failedGateId: "gate-P2", causePhaseId: "P1", triageStepId: "t1" },
    }),
  );
  plan.steps.push(
    work({ id: "i1", phaseId: "P2", scope: "src/impl/**" }),
    work({ id: "t1", phaseId: "P2", role: "code-review", dependsOn: ["i1"], scope: "（読み取りのみ）" }),
    work({ id: "f1", phaseId: "FX1", role: "design", scope: "docs/spec.md" }),
    gate({ id: "gate-FX1", phaseId: "FX1" }),
  );
  return plan;
}
