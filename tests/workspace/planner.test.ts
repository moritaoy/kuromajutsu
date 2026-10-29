// ============================================================
// Planner プロンプト構築・出力抽出テスト（docs/spec.md §13.7 / §13.10.2）
// ============================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  buildPlannerPrompt,
  extractPlannerOutput,
  renderTargets,
} from "../../src/workspace/planner.js";
import type { RoleDefinition } from "../../src/types/index.js";
import { makeAuthPlan } from "./fixtures.js";

const ROLES: RoleDefinition[] = [
  {
    id: "impl-code",
    name: "コード実装者（Grok）",
    description: "コードの実装・修正を行う",
    provider: "cursor",
    model: "cursor-grok-4.6-high-fast",
    systemPrompt: "x",
    healthCheckPrompt: "OK",
  },
  {
    id: "design",
    name: "設計者（Opus）",
    description: "設計・アーキテクチャ検討を行う",
    provider: "claude",
    model: "opus",
    systemPrompt: "x",
    healthCheckPrompt: "OK",
  },
];

function planJson(): string {
  const { revision: _r, maxIterations: _m, ...input } = makeAuthPlan();
  return JSON.stringify(input);
}

describe("buildPlannerPrompt — 初回", () => {
  const prompt = buildPlannerPrompt({
    instruction: "認証機能を追加して",
    workspacePath: "/work/my-project",
    roles: ROLES,
  });

  it("指示と作業ディレクトリを含む", () => {
    expect(prompt).toContain("認証機能を追加して");
    expect(prompt).toContain("/work/my-project");
  });

  it("職種の ID・名前・説明を含み、Provider / モデル名は含まない", () => {
    expect(prompt).toContain("impl-code");
    expect(prompt).toContain("コード実装者（Grok）");
    expect(prompt).toContain("設計・アーキテクチャ検討を行う");
    expect(prompt).not.toContain("cursor");
    expect(prompt).not.toContain("claude");
    expect(prompt).not.toContain("cursor-grok-4.6-high-fast");
  });

  it("WorkPlan の JSON の形と ID の慣例を含み、revision / maxIterations は出力させない", () => {
    expect(prompt).toContain("interface WorkPlanInput");
    expect(prompt).toContain("phases");
    expect(prompt).toContain("steps");
    expect(prompt).toContain("gate-final");
    expect(prompt).toContain("gate-<phaseId>");
    expect(prompt).toContain("PF");
    expect(prompt).toContain("deferred");
    expect(prompt).toMatch(/revision.*maxIterations.*(出力しない|含めない)/s);
    // インターフェース定義自体には revision / maxIterations のフィールドがない
    const iface = prompt.slice(prompt.indexOf("interface WorkPlanInput"));
    expect(iface.slice(0, iface.indexOf("```"))).not.toMatch(/^\s*revision\??:/m);
    expect(iface.slice(0, iface.indexOf("```"))).not.toMatch(/^\s*maxIterations\??:/m);
  });

  it("spec（解釈）の各項目と facts の 4 分類の意味を説明する", () => {
    for (const key of ["scope", "constraints", "completion", "assumptions"]) {
      expect(prompt).toContain(key);
    }
    for (const key of ["given", "toInvestigate", "toDerive"]) {
      expect(prompt).toContain(key);
    }
  });

  it("報告節: システム情報ブロックのガイドラインより優先して response は JSON のみにする", () => {
    expect(prompt).toContain("システム情報");
    expect(prompt).toContain("優先");
    expect(prompt).toContain("には WorkPlan の JSON のみを入れてください");
    expect(prompt).toContain("前置き");
    expect(prompt).toContain("コードフェンス");
  });

  it("deferred フェーズには work の手順を置かず、出口ゲートと notes だけ置くよう指示する", () => {
    expect(prompt).toMatch(/deferred.*work の手順を置かず/s);
    expect(prompt).toContain("notes");
  });

  it("他の Agent を起動するツールを使わず report_result のみ使うよう指示する", () => {
    for (const tool of ["run_agents", "run_sequential", "run_magentic", "create_group"]) {
      expect(prompt).toContain(tool);
    }
    expect(prompt).toMatch(/`report_result` のみ/);
  });

  it("ゲートの dependsOn は空でよい（末端手順に自動で依存する）ことを説明する", () => {
    expect(prompt).toMatch(/ゲートの `dependsOn` は空/);
    expect(prompt).toContain("自動");
  });

  it("前の計画・対象・エラーの節は含まない", () => {
    expect(prompt).not.toContain("前の計画");
    expect(prompt).not.toContain("指示の対象");
    expect(prompt).not.toContain("不備");
  });
});

describe("renderTargets", () => {
  const plan = makeAuthPlan();

  it("フェーズ / 手順 / ゲートを ID から解決する", () => {
    const lines = renderTargets(plan, [
      { kind: "phase", id: "P2" },
      { kind: "step", id: "s3" },
      { kind: "gate", id: "gate-P1" },
    ]);
    expect(lines).toEqual([
      "@P2 実装を行う（フェーズ）",
      "@s3 s3（手順）",
      "@gate-P1 gate-P1（ゲート）",
    ]);
  });

  it("存在しない ID は ID のみ + 注記で出す", () => {
    const [line] = renderTargets(plan, [{ kind: "step", id: "zzz" }]);
    expect(line).toContain("@zzz");
    expect(line).toContain("手順");
    expect(line).toContain("存在しません");
  });
});

describe("buildPlannerPrompt — 再計画", () => {
  const plan = makeAuthPlan();
  const prompt = buildPlannerPrompt({
    instruction: "認証機能を追加して",
    workspacePath: "/work/my-project",
    roles: ROLES,
    previousPlan: plan,
    additionalInstruction: "出口ゲートを人間レビューにして",
    targets: [{ kind: "phase", id: "P2" }],
  });

  it("前の計画の JSON・追加指示・対象を含む", () => {
    expect(prompt).toContain("前の計画");
    expect(prompt).toContain(plan.title);
    expect(prompt).toContain('"id":"gate-P3"'); // インデントなしの JSON
    expect(prompt).toContain("出口ゲートを人間レビューにして");
    expect(prompt).toContain("@P2 実装を行う（フェーズ）");
  });

  it("前の計画の revision / maxIterations は載せない", () => {
    expect(prompt).not.toContain('"maxIterations"');
    expect(prompt).not.toContain('"revision"');
  });

  it("対象以外は極力変えず ID を維持するよう指示する", () => {
    expect(prompt).toContain("対象以外");
    expect(prompt).toContain("ID を維持");
  });

  it("targets なしでは対象の節を出さず、計画全体への指示として扱う", () => {
    const p = buildPlannerPrompt({
      instruction: "x",
      workspacePath: "/w",
      roles: ROLES,
      previousPlan: plan,
      additionalInstruction: "セキュリティ確認のフェーズを追加して",
    });
    expect(p).toContain("計画全体");
    expect(p).not.toContain("@P2");
  });
});

describe("buildPlannerPrompt — リトライ", () => {
  it("直前の出力の不備を列挙して修正を求める", () => {
    const prompt = buildPlannerPrompt({
      instruction: "x",
      workspacePath: "/w",
      roles: ROLES,
      validationErrors: ["phases: Required", "spec.completion: 1 件以上必要です"],
    });
    expect(prompt).toContain("不備");
    expect(prompt).toContain("- phases: Required");
    expect(prompt).toContain("- spec.completion: 1 件以上必要です");
    expect(prompt).toContain("修正");
  });
});

describe("extractPlannerOutput", () => {
  it("JSON のみの出力を検証して返す", () => {
    const r = extractPlannerOutput(planJson());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.title).toBe("認証機能（JWT）の追加");
      expect(r.value.phases).toHaveLength(4);
    }
  });

  it("コードフェンスと前置きが付いていても取り出せる", () => {
    const r = extractPlannerOutput(`計画です。\n\`\`\`json\n${planJson()}\n\`\`\`\n以上`);
    expect(r.ok).toBe(true);
  });

  it("JSON が見つからなければ ok: false", () => {
    const r = extractPlannerOutput("計画を作成しました。");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toContain("JSON が見つかりません");
  });

  it("スキーマ不正なら errors を返す", () => {
    const r = extractPlannerOutput(JSON.stringify({ title: "x" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe("kuromajutsu.config.yaml の planner 職種", () => {
  const config = parseYaml(
    readFileSync(resolve(process.cwd(), "kuromajutsu.config.yaml"), "utf-8"),
  ) as { roles: RoleDefinition[] };
  const planner = config.roles.find((r) => r.id === "planner");

  it("claude / opus、tools なしで定義されている", () => {
    expect(planner).toBeDefined();
    expect(planner?.provider).toBe("claude");
    expect(planner?.model).toBe("opus");
    expect(planner?.tools ?? []).toEqual([]);
  });

  it("systemPrompt に JSON のみの出力・他 Agent を起動しない・deferred・ゲートの dependsOn の指示がある", () => {
    const sp = planner?.systemPrompt ?? "";
    expect(sp).toContain("JSON のみ");
    expect(sp).toContain("report_result");
    for (const tool of ["run_agents", "run_sequential", "run_magentic", "create_group"]) {
      expect(sp).toContain(tool);
    }
    expect(sp).toMatch(/deferred.*work の手順を置かず/s);
    expect(sp).toMatch(/ゲートの `dependsOn` は空/);
  });
});
