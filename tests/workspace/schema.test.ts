import { describe, it, expect } from "vitest";
import {
  extractJson,
  parseReviewDoc,
  parseWorkPlanInput,
} from "../../src/workspace/schema.js";
import { makeAuthPlan } from "./fixtures.js";

/** Planner の出力形（revision / maxIterations を含まない） */
function plannerOutput(): Record<string, unknown> {
  const { revision: _r, maxIterations: _m, ...rest } = makeAuthPlan();
  return JSON.parse(JSON.stringify(rest)) as Record<string, unknown>;
}

function errorsOf(json: unknown): string[] {
  const r = parseWorkPlanInput(json);
  return r.ok ? [] : r.errors;
}

describe("parseWorkPlanInput", () => {
  it("正常な WorkPlan 入力を受理する", () => {
    const r = parseWorkPlanInput(plannerOutput());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.title).toBe("認証機能（JWT）の追加");
      expect(r.value.phases).toHaveLength(4);
      expect(r.value.steps).toHaveLength(8);
      expect("revision" in r.value).toBe(false);
      expect("maxIterations" in r.value).toBe(false);
    }
  });

  it("dependsOn の省略は [] になる", () => {
    const json = plannerOutput();
    const steps = json["steps"] as Record<string, unknown>[];
    delete steps[0]["dependsOn"];
    const r = parseWorkPlanInput(json);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.steps[0].dependsOn).toEqual([]);
  });

  it("phases[].notes の省略は [] になる", () => {
    const json = plannerOutput();
    delete (json["phases"] as Record<string, unknown>[])[0]["notes"];
    const r = parseWorkPlanInput(json);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.phases[0].notes).toEqual([]);
  });

  it("gate の onFail の省略は rework / maxRetries 2 になる", () => {
    const json = plannerOutput();
    const gateStep = (json["steps"] as Record<string, unknown>[]).find((s) => s["id"] === "gate-P2")!;
    delete gateStep["onFail"];
    const r = parseWorkPlanInput(json);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.steps.find((s) => s.id === "gate-P2")!.onFail).toEqual({
        action: "rework",
        maxRetries: 2,
      });
    }
  });

  it("onFail の maxRetries の省略は 2 になる", () => {
    const json = plannerOutput();
    const gateStep = (json["steps"] as Record<string, unknown>[]).find((s) => s["id"] === "gate-P2")!;
    gateStep["onFail"] = { action: "rework" };
    const r = parseWorkPlanInput(json);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.steps.find((s) => s.id === "gate-P2")!.onFail?.maxRetries).toBe(2);
    }
  });

  it("オブジェクトでない入力は拒否する", () => {
    expect(parseWorkPlanInput(null).ok).toBe(false);
    expect(parseWorkPlanInput("text").ok).toBe(false);
    expect(parseWorkPlanInput(undefined).ok).toBe(false);
  });

  it("必須項目の欠落をパス付きで報告する", () => {
    const json = plannerOutput();
    delete json["title"];
    delete (json["spec"] as Record<string, unknown>)["completion"];
    const errors = errorsOf(json);
    expect(errors.some((e) => e.includes("title"))).toBe(true);
    expect(errors.some((e) => e.includes("spec.completion"))).toBe(true);
  });

  it("Step の必須項目（role）欠落を拒否する", () => {
    const json = plannerOutput();
    delete (json["steps"] as Record<string, unknown>[])[0]["role"];
    expect(errorsOf(json).some((e) => e.includes("steps[0].role"))).toBe(true);
  });

  it("不正な enum 値を拒否する", () => {
    const json = plannerOutput();
    (json["phases"] as Record<string, unknown>[])[0]["planning"] = "later";
    (json["steps"] as Record<string, unknown>[])[0]["kind"] = "task";
    const errors = errorsOf(json);
    expect(errors.some((e) => e.includes("phases[0].planning"))).toBe(true);
    expect(errors.some((e) => e.includes("steps[0].kind"))).toBe(true);
  });

  it("method: command で command が無いチェックを拒否する", () => {
    const json = plannerOutput();
    const g = (json["steps"] as Record<string, unknown>[]).find((s) => s["id"] === "gate-P2")!;
    g["checks"] = [{ text: "ビルド", method: "command" }];
    expect(errorsOf(json).some((e) => e.includes("command"))).toBe(true);
  });

  it("phases が空の計画を拒否する", () => {
    const json = plannerOutput();
    json["phases"] = [];
    expect(errorsOf(json).some((e) => e.includes("phases"))).toBe(true);
  });

  it("spec.completion は空でもスキーマとしては受理する（最終ゲートの自動生成側で補う）", () => {
    const json = plannerOutput();
    (json["spec"] as Record<string, unknown>)["completion"] = [];
    expect(parseWorkPlanInput(json).ok).toBe(true);
  });

  describe("Planner が出してはいけないもの / 構造チェック", () => {
    it("修正フェーズ（fix / parentPhaseId）は Planner の出力では拒否する", () => {
      const a = plannerOutput();
      (a["phases"] as Record<string, unknown>[])[1]["fix"] = {
        failedGateId: "gate-P1",
        causePhaseId: "P1",
        triageStepId: "s1",
      };
      expect(errorsOf(a).some((e) => e.includes("phases[1].fix"))).toBe(true);

      const b = plannerOutput();
      (b["phases"] as Record<string, unknown>[])[1]["parentPhaseId"] = "P1";
      expect(errorsOf(b).some((e) => e.includes("phases[1].parentPhaseId"))).toBe(true);
    });

    it("1 フェーズにゲートは最大 1 つ", () => {
      const json = plannerOutput();
      const steps = json["steps"] as Record<string, unknown>[];
      steps.push({ ...steps.find((s) => s["id"] === "gate-P2")!, id: "gate-P2b" });
      const errors = errorsOf(json);
      expect(errors.some((e) => e.includes("P2") && e.includes("ゲート"))).toBe(true);
    });

    it("final フェーズは最大 1 つ", () => {
      const json = plannerOutput();
      (json["phases"] as Record<string, unknown>[])[2]["final"] = true;
      expect(errorsOf(json).some((e) => e.includes("final"))).toBe(true);
    });

    it("final フェーズは最後に置く", () => {
      const json = plannerOutput();
      const phases = json["phases"] as Record<string, unknown>[];
      const fin = phases.pop()!;
      phases.unshift(fin);
      expect(errorsOf(json).some((e) => e.includes("final") && e.includes("最後"))).toBe(true);
    });

    it("final フェーズに work Step を置けない", () => {
      const json = plannerOutput();
      (json["steps"] as Record<string, unknown>[]).push({
        id: "sx",
        phaseId: "PF",
        kind: "work",
        title: "t",
        role: "impl-code",
        description: "d",
        doneCriteria: ["x"],
      });
      expect(errorsOf(json).some((e) => e.includes("PF") && e.includes("work"))).toBe(true);
    });
  });

  describe("構造の整合性", () => {
    it("Step ID の重複を拒否する", () => {
      const json = plannerOutput();
      (json["steps"] as Record<string, unknown>[])[1]["id"] = "s1";
      expect(errorsOf(json).some((e) => e.includes("s1") && e.includes("重複"))).toBe(true);
    });

    it("フェーズ ID の重複を拒否する", () => {
      const json = plannerOutput();
      (json["phases"] as Record<string, unknown>[])[1]["id"] = "P1";
      expect(errorsOf(json).some((e) => e.includes("P1") && e.includes("重複"))).toBe(true);
    });

    it("存在しない phaseId を拒否する", () => {
      const json = plannerOutput();
      (json["steps"] as Record<string, unknown>[])[0]["phaseId"] = "PX";
      expect(errorsOf(json).some((e) => e.includes("PX"))).toBe(true);
    });

    it("存在しない dependsOn を拒否する", () => {
      const json = plannerOutput();
      (json["steps"] as Record<string, unknown>[])[1]["dependsOn"] = ["zzz"];
      expect(errorsOf(json).some((e) => e.includes("zzz"))).toBe(true);
    });

    it("別フェーズへの dependsOn を拒否する（§13.4.1）", () => {
      const json = plannerOutput();
      (json["steps"] as Record<string, unknown>[])[4]["dependsOn"] = ["s1"]; // s3 (P3) -> s1 (P1)
      expect(errorsOf(json).some((e) => e.includes("同じフェーズ"))).toBe(true);
    });
  });
});

describe("extractJson", () => {
  const obj = { a: 1, b: { c: [1, 2, 3] } };

  it("素の JSON を取り出す", () => {
    expect(extractJson(JSON.stringify(obj))).toEqual(obj);
  });

  it("前後の空白・改行を許す", () => {
    expect(extractJson(`\n\n  ${JSON.stringify(obj)}  \n`)).toEqual(obj);
  });

  it("コードフェンス付き（json 指定）", () => {
    const text = "計画です。\n```json\n" + JSON.stringify(obj, null, 2) + "\n```\n以上";
    expect(extractJson(text)).toEqual(obj);
  });

  it("コードフェンス付き（言語指定なし）", () => {
    expect(extractJson("```\n" + JSON.stringify(obj) + "\n```")).toEqual(obj);
  });

  it("前後に文章がある", () => {
    expect(extractJson(`以下が計画です。${JSON.stringify(obj)} よろしくお願いします。`)).toEqual(obj);
  });

  it("文字列内の波括弧に惑わされない", () => {
    const o = { text: "閉じ括弧 } と開き括弧 { を含む \" エスケープ", n: 1 };
    expect(extractJson(`前置き ${JSON.stringify(o)} 後置き`)).toEqual(o);
  });

  it("先頭に JSON でない波括弧があっても次の候補を試す", () => {
    expect(extractJson(`メモ {これは JSON ではない} 本体: ${JSON.stringify(obj)}`)).toEqual(obj);
  });

  it("JSON が見つからなければ undefined", () => {
    expect(extractJson("計画はありません")).toBeUndefined();
    expect(extractJson("{ 壊れた json")).toBeUndefined();
    expect(extractJson("")).toBeUndefined();
  });

  it("Planner 出力を丸ごとコードフェンスで包んでも WorkPlan として検証できる", () => {
    const text = "```json\n" + JSON.stringify(plannerOutput()) + "\n```";
    const r = parseWorkPlanInput(extractJson(text));
    expect(r.ok).toBe(true);
  });
});

describe("parseReviewDoc", () => {
  const base = () => ({
    title: "アーキテクチャレビュー",
    version: 1,
    sections: [
      { id: "conclusion", heading: "結論", kind: "markdown", body: "JWT を採用する" },
      { id: "structure", heading: "構成", kind: "mermaid", body: "graph TD; A-->B" },
      { id: "mock", heading: "モック", kind: "html", body: "<p>x</p>" },
      { id: "file", heading: "ファイル", kind: "file", path: "src/dashboard/public/mock/workspace.html" },
      {
        id: "spec",
        heading: "仕様",
        kind: "table",
        table: { columns: ["名前", "値"], rows: [["a", "1"]] },
      },
    ],
  });

  it("正常な ReviewDoc を受理する", () => {
    const r = parseReviewDoc(base());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.sections).toHaveLength(5);
  });

  it.each(["markdown", "html", "mermaid"])("%s は body が必須", (kind) => {
    const doc = base();
    doc.sections = [{ id: "x", heading: "h", kind } as (typeof doc.sections)[number]];
    const r = parseReviewDoc(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("body"))).toBe(true);
  });

  it("file は path が必須", () => {
    const doc = base();
    doc.sections = [{ id: "x", heading: "h", kind: "file" } as (typeof doc.sections)[number]];
    const r = parseReviewDoc(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("path"))).toBe(true);
  });

  it("table は table が必須", () => {
    const doc = base();
    doc.sections = [{ id: "x", heading: "h", kind: "table" } as (typeof doc.sections)[number]];
    const r = parseReviewDoc(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("table"))).toBe(true);
  });

  it("不正な kind を拒否する", () => {
    const doc = base();
    (doc.sections[0] as { kind: string }).kind = "pdf";
    expect(parseReviewDoc(doc).ok).toBe(false);
  });

  it("sections[].id の重複を拒否する", () => {
    const doc = base();
    doc.sections[1].id = "conclusion";
    const r = parseReviewDoc(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("conclusion") && e.includes("重複"))).toBe(true);
  });

  it("sections が空の資料を拒否する", () => {
    const doc = base();
    doc.sections = [];
    expect(parseReviewDoc(doc).ok).toBe(false);
  });

  describe("差し戻し後の版", () => {
    it("version >= 2 で previousFeedback が無ければ不正", () => {
      const doc = { ...base(), version: 2 };
      const r = parseReviewDoc(doc);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.some((e) => e.includes("previousFeedback"))).toBe(true);
    });

    it("version >= 2 で previousFeedback があれば受理する", () => {
      const doc = {
        ...base(),
        version: 2,
        previousFeedback: { id: "feedback", heading: "前回の指摘への対応", kind: "markdown", body: "対応した" },
      };
      expect(parseReviewDoc(doc).ok).toBe(true);
    });

    it("version 1 の previousFeedback は任意", () => {
      expect(parseReviewDoc(base()).ok).toBe(true);
    });

    it("previousFeedback も節として検証される（id の重複・必須項目）", () => {
      const dup = {
        ...base(),
        version: 2,
        previousFeedback: { id: "conclusion", heading: "h", kind: "markdown", body: "x" },
      };
      expect(parseReviewDoc(dup).ok).toBe(false);

      const noBody = {
        ...base(),
        version: 2,
        previousFeedback: { id: "fb", heading: "h", kind: "markdown" },
      };
      expect(parseReviewDoc(noBody).ok).toBe(false);
    });

    it("version は 1 以上の整数", () => {
      expect(parseReviewDoc({ ...base(), version: 0 }).ok).toBe(false);
      expect(parseReviewDoc({ ...base(), version: 1.5 }).ok).toBe(false);
    });
  });
});
