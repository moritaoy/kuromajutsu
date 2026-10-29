// ============================================================
// WorkPlan 入力 / ReviewDoc のスキーマ検証（docs/spec.md §13.3 / §13.6.1 / §13.7）
// ============================================================

import { z } from "zod";
import type { ReviewDoc, WorkPlan } from "../types/index.js";

// --------------------------------------------------
// 共通
// --------------------------------------------------

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Planner の出力（`revision` と `maxIterations` はサーバーが設定するため含まない） */
export type WorkPlanInput = Omit<WorkPlan, "revision" | "maxIterations" | "request">;

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const seg of path) {
    out += typeof seg === "number" ? `[${seg}]` : out === "" ? String(seg) : `.${String(seg)}`;
  }
  return out;
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = formatPath(issue.path);
    return path === "" ? issue.message : `${path}: ${issue.message}`;
  });
}

// --------------------------------------------------
// WorkPlan 入力
// --------------------------------------------------

const gateCheckSchema = z
  .object({
    text: z.string(),
    method: z.enum(["agent-review", "command", "human"]),
    command: z.string().optional(),
  })
  .superRefine((check, ctx) => {
    if (check.method === "command" && (check.command ?? "").trim() === "") {
      ctx.addIssue({
        code: "custom",
        path: ["command"],
        message: "method: command のチェックには command が必須です",
      });
    }
  });

const onFailSchema = z.object({
  action: z.literal("rework"),
  maxRetries: z.number().int().min(0).default(2),
});

const stepSchema = z
  .object({
    id: z.string().min(1),
    phaseId: z.string().min(1),
    kind: z.enum(["work", "gate"]),
    title: z.string(),
    role: z.string().min(1),
    description: z.string(),
    dependsOn: z.array(z.string()).default([]),
    doneCriteria: z.array(z.string()).optional(),
    scope: z.string().optional(),
    checks: z.array(gateCheckSchema).optional(),
    onFail: onFailSchema.optional(),
  })
  .transform((step) =>
    step.kind === "gate" && step.onFail === undefined
      ? { ...step, onFail: { action: "rework" as const, maxRetries: 2 } }
      : step,
  );

const phaseSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  goal: z.string(),
  planning: z.enum(["fixed", "deferred"]),
  notes: z.array(z.string()).default([]),
  final: z.boolean().optional(),
  fix: z
    .object({
      failedGateId: z.string(),
      causePhaseId: z.string(),
      triageStepId: z.string(),
    })
    .optional(),
  parentPhaseId: z.string().optional(),
});

const specSchema = z.object({
  workspace: z.string(),
  scope: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  completion: z.array(z.string()),
  assumptions: z.array(z.string()).default([]),
});

const factsSchema = z
  .object({
    given: z.array(z.string()).default([]),
    toInvestigate: z.array(z.string()).default([]),
    toDerive: z.array(z.string()).default([]),
    assumptions: z.array(z.string()).default([]),
  })
  .default({ given: [], toInvestigate: [], toDerive: [], assumptions: [] });

export const workPlanInputSchema = z
  .object({
    title: z.string(),
    goal: z.string(),
    spec: specSchema,
    phases: z.array(phaseSchema).min(1),
    steps: z.array(stepSchema),
    facts: factsSchema,
  })
  .superRefine((plan, ctx) => {
    // 修正フェーズは実行時にだけ作られる（Planner は出力しない。§13.5.6）
    plan.phases.forEach((p, i) => {
      for (const key of ["fix", "parentPhaseId"] as const) {
        if (p[key] !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["phases", i, key],
            message: `${key} は Planner の出力に含められません（修正フェーズは実行時に追加されます）`,
          });
        }
      }
    });

    // final フェーズは最大 1 つで、最後に置く。work Step は置かない
    const finals = plan.phases.flatMap((p, i) => (p.final === true ? [i] : []));
    if (finals.length > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["phases"],
        message: "final フェーズは 1 つだけにしてください",
      });
    } else if (finals.length === 1 && finals[0] !== plan.phases.length - 1) {
      ctx.addIssue({
        code: "custom",
        path: ["phases", finals[0]],
        message: "final フェーズは最後に置いてください",
      });
    }
    const finalIds = new Set(plan.phases.filter((p) => p.final === true).map((p) => p.id));
    plan.steps.forEach((s, i) => {
      if (s.kind === "work" && finalIds.has(s.phaseId)) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", i, "phaseId"],
          message: `final フェーズ ${s.phaseId} に work Step は置けません（最終ゲートのみ）`,
        });
      }
    });

    // 1 フェーズにゲートは最大 1 つ
    const gateCount = new Map<string, number>();
    plan.steps.forEach((s, i) => {
      if (s.kind !== "gate") return;
      const n = (gateCount.get(s.phaseId) ?? 0) + 1;
      gateCount.set(s.phaseId, n);
      if (n === 2) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", i, "phaseId"],
          message: `フェーズ ${s.phaseId} にゲートが複数あります（出口ゲートは 1 つだけ）`,
        });
      }
    });

    // ID の一意性
    const phaseIds = new Set<string>();
    plan.phases.forEach((p, i) => {
      if (phaseIds.has(p.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["phases", i, "id"],
          message: `フェーズ ID が重複しています: ${p.id}`,
        });
      }
      phaseIds.add(p.id);
    });

    const stepPhase = new Map<string, string>();
    plan.steps.forEach((s, i) => {
      if (stepPhase.has(s.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", i, "id"],
          message: `Step ID が重複しています: ${s.id}`,
        });
      }
      stepPhase.set(s.id, s.phaseId);
    });

    // 参照の整合性（§13.4.1: dependsOn は同じフェーズ内の Step のみ）
    plan.steps.forEach((s, i) => {
      if (!phaseIds.has(s.phaseId)) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", i, "phaseId"],
          message: `存在しないフェーズです: ${s.phaseId}`,
        });
      }
      s.dependsOn.forEach((dep, j) => {
        const depPhase = stepPhase.get(dep);
        if (depPhase === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["steps", i, "dependsOn", j],
            message: `存在しない Step への依存です: ${dep}`,
          });
        } else if (depPhase !== s.phaseId) {
          ctx.addIssue({
            code: "custom",
            path: ["steps", i, "dependsOn", j],
            message: `${dep} は別フェーズの Step です（dependsOn は同じフェーズ内の Step のみ指定できます）`,
          });
        }
      });
    });
  });

/** Planner の出力（JSON を解析済みのもの）を検証する */
export function parseWorkPlanInput(json: unknown): ParseResult<WorkPlanInput> {
  const result = workPlanInputSchema.safeParse(json);
  if (!result.success) return { ok: false, errors: formatIssues(result.error) };
  const value: WorkPlanInput = result.data;
  return { ok: true, value };
}

// --------------------------------------------------
// ReviewDoc
// --------------------------------------------------

const reviewSectionSchema = z
  .object({
    id: z.string().min(1),
    heading: z.string(),
    kind: z.enum(["markdown", "html", "file", "table", "mermaid"]),
    body: z.string().optional(),
    path: z.string().optional(),
    table: z
      .object({
        columns: z.array(z.string()),
        rows: z.array(z.array(z.string())),
      })
      .optional(),
  })
  .superRefine((section, ctx) => {
    const need = (field: "body" | "path" | "table") => {
      if (section[field] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `kind: ${section.kind} の節には ${field} が必須です`,
        });
      }
    };
    switch (section.kind) {
      case "markdown":
      case "html":
      case "mermaid":
        need("body");
        break;
      case "file":
        need("path");
        break;
      case "table":
        need("table");
        break;
    }
  });

export const reviewDocSchema = z
  .object({
    title: z.string(),
    version: z.number().int().min(1),
    previousFeedback: reviewSectionSchema.optional(),
    sections: z.array(reviewSectionSchema).min(1),
  })
  .superRefine((doc, ctx) => {
    if (doc.version >= 2 && doc.previousFeedback === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["previousFeedback"],
        message: "version 2 以降の資料には previousFeedback（前回の指摘への対応）が必須です",
      });
    }

    const seen = new Set<string>();
    const check = (id: string, path: (string | number)[]) => {
      if (seen.has(id)) {
        ctx.addIssue({ code: "custom", path, message: `節 ID が重複しています: ${id}` });
      }
      seen.add(id);
    };
    if (doc.previousFeedback) check(doc.previousFeedback.id, ["previousFeedback", "id"]);
    doc.sections.forEach((s, i) => check(s.id, ["sections", i, "id"]));
  });

/** text-writer が返した ReviewDoc JSON を検証する */
export function parseReviewDoc(json: unknown): ParseResult<ReviewDoc> {
  const result = reviewDocSchema.safeParse(json);
  if (!result.success) return { ok: false, errors: formatIssues(result.error) };
  const value: ReviewDoc = result.data;
  return { ok: true, value };
}

// --------------------------------------------------
// JSON の取り出し
// --------------------------------------------------

/** `text` の `start` にある `{` から対応する `}` までの範囲を返す（文字列リテラルを考慮） */
function balancedObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function tryParse(text: string): unknown | undefined {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null ? v : undefined;
  } catch {
    return undefined;
  }
}

/** テキスト中の最初に JSON として解釈できる `{ ... }` を取り出す */
function scanObjects(text: string): unknown | undefined {
  let from = text.indexOf("{");
  while (from !== -1) {
    const end = balancedObjectEnd(text, from);
    if (end !== -1) {
      const v = tryParse(text.slice(from, end + 1));
      if (v !== undefined) return v;
    }
    from = text.indexOf("{", from + 1);
  }
  return undefined;
}

/**
 * Planner / text-writer の出力から JSON を取り出す。
 *
 * 1. 全体が JSON ならそのまま
 * 2. コードフェンス（```json ... ```）の中
 * 3. 最初の `{` から対応する `}` まで
 *
 * 見つからなければ `undefined`。
 */
export function extractJson(text: string): unknown | undefined {
  const whole = tryParse(text.trim());
  if (whole !== undefined) return whole;

  const fence = /```[\w-]*[ \t]*\r?\n([\s\S]*?)```/g;
  for (const m of text.matchAll(fence)) {
    const body = m[1] ?? "";
    const v = tryParse(body.trim()) ?? scanObjects(body);
    if (v !== undefined) return v;
  }

  return scanObjects(text);
}
