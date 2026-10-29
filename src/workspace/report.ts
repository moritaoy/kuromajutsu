// ============================================================
// Workspace の完了レポート（docs/spec.md §13.11）
//
// 純粋関数。文章（何が実装されたか / 試し方 / 確認しておくと良いこと）は Orchestrator の
// 最終 `report_result` の `response`（Markdown）から取り、それ以外はサーバーが持つデータから
// 機械的に組み立てる。
// ============================================================

import type {
  AgentState,
  GateChange,
  GateResult,
  HumanReview,
  MagenticLedger,
  Phase,
  ScheduledStep,
  WorkPlan,
  Workspace,
  WorkspaceReport,
} from "../types/index.js";
import fs from "node:fs";
import path from "node:path";
import { finalGate, toScheduledSteps } from "./plan.js";

export interface BuildWorkspaceReportInput {
  workspace: Workspace;
  plan: WorkPlan;
  ledger?: MagenticLedger;
  /** この Workspace の Magentic グループと子グループの Agent（`result` 入り） */
  agents: AgentState[];
  /** Orchestrator の最終 `report_result` の `response`（Markdown） */
  finalResponse?: string;
  /** 生成時刻（ISO 8601）。省略時は現在時刻 */
  now?: string;
}

// --------------------------------------------------
// finalResponse の分解
// --------------------------------------------------

type ProseKey = "summary" | "howToTry" | "notes";

/** 見出しの文言から、どの項目かをゆるく判定する（howToTry を先に見る: 「動作確認」を notes と区別するため） */
const HEADING_PATTERNS: [ProseKey, RegExp][] = [
  ["howToTry", /試し方|試して|試す|確認手順|確認方法|動作確認|使い方|how\s*to\s*try|how\s*to\s*test/i],
  ["notes", /確認しておく|確認事項|確認してほしい|注意|前提|懸念|申し送り|留意|notes?\b|caveats?/i],
  ["summary", /何が実装|実装された|実装内容|実装した|できるよう|概要|サマリ|成果|summary|overview/i],
];

/** Markdown を見出しごとに区切る（全レベル）。コードフェンス内の `#` は見出しとみなさない。先頭は見出しの前の前置き */
function splitByHeadings(markdown: string): { heading?: string; level: number; lines: string[] }[] {
  const out: { heading?: string; level: number; lines: string[] }[] = [{ level: 0, lines: [] }];
  let fence: string | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
    }
    const h = fence === null ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (h) out.push({ heading: h[2], level: h[1].length, lines: [] });
    else out[out.length - 1].lines.push(line);
  }
  return out;
}

function classify(heading: string): ProseKey | undefined {
  for (const [key, re] of HEADING_PATTERNS) if (re.test(heading)) return key;
  return undefined;
}

/**
 * `summary` / `howToTry` / `notes` を抜き出す。
 *
 * - 見出しは全レベルで区切って分類する（H1 のタイトルの下の H2 も拾える）。
 *   見出し自体が一致しない小見出しは、直近の上位の見出しの分類を引き継ぐ
 * - どの項目にも一致しなかった節は `notes` に回す
 * - 見出しが 1 つも一致しなければ `summary` に全文、他は空
 * - 見出しの前の前置きは、`summary` の節が無ければ `summary`、あれば `notes` に回す
 */
export function extractReportProse(finalResponse: string | undefined): Record<ProseKey, string> {
  const empty = { summary: "", howToTry: "", notes: "" };
  if (finalResponse === undefined || finalResponse.trim() === "") return empty;

  const sections = splitByHeadings(finalResponse);
  const preamble = sections[0].lines.join("\n").trim();
  const found: Record<ProseKey, string[]> = { summary: [], howToTry: [], notes: [] };
  const other: string[] = [];
  const stack: { level: number; key: ProseKey | "other" }[] = [];
  let matched = false;

  for (const sec of sections.slice(1)) {
    const heading = sec.heading ?? "";
    const own = classify(heading);
    while (stack.length > 0 && stack[stack.length - 1].level >= sec.level) stack.pop();
    const inherited = stack.length > 0 ? stack[stack.length - 1].key : "other";
    const key = own ?? inherited;
    stack.push({ level: sec.level, key });

    const body = sec.lines.join("\n").trim();
    if (own) {
      matched = true;
      if (body) found[own].push(body);
    } else {
      const text = `${"#".repeat(sec.level)} ${heading}${body ? `\n${body}` : ""}`;
      if (key === "other") other.push(text);
      else found[key].push(text);
    }
  }
  if (!matched) return { ...empty, summary: finalResponse.trim() };

  const hasSummary = found.summary.length > 0;
  const notes = [...found.notes, ...other, ...(hasSummary && preamble ? [preamble] : [])];
  return {
    summary: hasSummary ? found.summary.join("\n\n") : preamble,
    howToTry: found.howToTry.join("\n\n"),
    notes: notes.join("\n\n"),
  };
}

// --------------------------------------------------
// 各項目
// --------------------------------------------------

/** workspacePath と、解決できればその realpath（macOS の /tmp → /private/tmp など）を比較候補にする */
function workspaceRoots(workspacePath: string): string[] {
  const roots = [path.resolve(workspacePath)];
  try {
    const real = fs.realpathSync.native(workspacePath);
    if (!roots.includes(real)) roots.push(real);
  } catch {
    // ディレクトリが無いなど。元のパスだけで比較する
  }
  return roots;
}

/**
 * Agent の報告（絶対パス）とサーバーの自動収集（相対パス）が混在するため、
 * workspacePath（または realpath）配下の絶対パスは相対パスに揃えてから重複を除く。
 * どちらの配下でもないパスは絶対パスのまま残す。
 */
function normalizeChangedPath(roots: string[], file: string): string {
  const p = path.normalize(file);
  if (!path.isAbsolute(p)) return p;
  for (const root of roots) {
    const rel = path.relative(root, p);
    if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
    return rel;
  }
  return p;
}

function collectChangedFiles(
  agents: AgentState[],
  workspacePath: string,
): WorkspaceReport["changedFiles"] {
  const edited = new Set<string>();
  const created = new Set<string>();
  const roots = workspaceRoots(workspacePath);
  const add = (set: Set<string>, f: string) => {
    if (f.trim() === "") return;
    set.add(normalizeChangedPath(roots, f));
  };
  for (const a of agents) {
    for (const f of a.editedFiles) add(edited, f);
    for (const f of a.createdFiles) add(created, f);
    for (const f of a.result?.editedFiles ?? []) add(edited, f);
    for (const f of a.result?.createdFiles ?? []) add(created, f);
  }
  for (const f of created) edited.delete(f);
  return { editedFiles: [...edited].sort(), createdFiles: [...created].sort() };
}

function describeReview(r: HumanReview): string {
  const label = r.status === "approved" ? "承認" : r.status === "changes_requested" ? "差し戻し" : "判断待ち";
  const head = `ゲート ${r.gateId}（v${r.version}）: ${label}`;
  if (r.comments.length === 0) return head;
  const comments = r.comments.map((c) => `[${c.sectionId ?? "全体"}] ${c.text}`).join(" / ");
  return `${head} — ${comments}`;
}

function latestAttempt(gate: GateResult | undefined) {
  return gate && gate.attempts.length > 0 ? gate.attempts[gate.attempts.length - 1] : undefined;
}

/** 最終ゲートのチェック結果の要約 */
function summarizeFinalGate(plan: WorkPlan, workspace: Workspace): { passed: boolean; note: string } {
  const gate = finalGate(plan);
  if (!gate) return { passed: false, note: "最終ゲートがありません" };
  const result = workspace.gateResults.find((g) => g.gateId === gate.id);
  const status = result?.status ?? "pending";
  const attempt = latestAttempt(result);
  const lines: string[] = [];
  for (const [i, check] of (gate.checks ?? []).entries()) {
    if (check.method === "human") {
      const reviews = workspace.humanReviews.filter((r) => r.gateId === gate.id);
      const last = reviews[reviews.length - 1];
      lines.push(`[${i}] human: ${check.text} — ${last ? (last.status === "approved" ? "承認" : last.status === "changes_requested" ? "差し戻し" : "判断待ち") : "未実施"}`);
      continue;
    }
    const r = attempt?.checks.find((c) => c.checkIndex === i);
    const verdict = r ? (r.passed ? "合格" : "不合格") : "未実施";
    lines.push(`[${i}] ${check.method}: ${check.text} — ${verdict}${r?.note ? `（${r.note}）` : ""}`);
  }
  const head = status === "passed" ? `最終ゲート ${gate.id} は合格` : `最終ゲート ${gate.id} は未合格（status: ${status}）`;
  return { passed: status === "passed", note: lines.length > 0 ? `${head}。${lines.join(" / ")}` : head };
}

function buildNotes(prose: string, workspace: Workspace, plan: WorkPlan): string {
  const unacked = workspace.gateChanges.filter((c) => c.acknowledgedAt === undefined);
  const parts: string[] = [];
  if (prose) parts.push(prose);
  const irregularLines =
    unacked.length > 0
      ? [`未確認のイレギュラー: ${unacked.length} 件`, ...unacked.map((c) => `- ${c.id}（${c.gateId}）: ${c.reason}`)]
      : ["未確認のイレギュラー: 0 件"];
  parts.push(irregularLines.join("\n"));
  if (plan.spec.assumptions.length > 0) {
    parts.push(["AI が置いた前提:", ...plan.spec.assumptions.map((a) => `- ${a}`)].join("\n"));
  }
  return parts.join("\n\n");
}

// --------------------------------------------------
// 経過
// --------------------------------------------------

/** Task Ledger の scheduledSteps（なければ計画から導出。ゲートは gateResults の passed で completed） */
function currentSteps(plan: WorkPlan, workspace: Workspace, ledger?: MagenticLedger): ScheduledStep[] {
  const fromLedger = ledger?.taskLedger?.scheduledSteps;
  if (fromLedger) return fromLedger;
  return toScheduledSteps(plan).map((s) => {
    const passed = s.kind === "gate" && workspace.gateResults.some((g) => g.gateId === s.stepId && g.status === "passed");
    return passed ? { ...s, status: "completed" as const } : s;
  });
}

function buildPhases(
  plan: WorkPlan,
  workspace: Workspace,
  ledger: MagenticLedger | undefined,
): WorkspaceReport["progress"]["phases"] {
  const steps = currentSteps(plan, workspace, ledger);
  const phases: Phase[] = ledger?.taskLedger?.phases ?? plan.phases;
  const titleOf = (s: ScheduledStep): string =>
    plan.steps.find((p) => p.id === s.stepId)?.title ?? s.description;

  const toReport = (s: ScheduledStep) => ({
    stepId: s.stepId,
    title: titleOf(s),
    role: s.role,
    status: s.status as string,
  });

  const known = new Set(phases.map((p) => p.id));
  const result: WorkspaceReport["progress"]["phases"] = phases.map((p) => ({
    phaseId: p.id,
    name: p.name,
    steps: steps.filter((s) => s.phaseId === p.id).map(toReport),
  }));
  const orphans = steps.filter((s) => s.phaseId === undefined || !known.has(s.phaseId));
  if (orphans.length > 0) {
    result.push({ phaseId: "", name: "（フェーズ未指定）", steps: orphans.map(toReport) });
  }
  return result;
}

function buildTimeline(
  workspace: Workspace,
  agents: AgentState[],
): WorkspaceReport["progress"]["timeline"] {
  const events: { at: string; kind: string; text: string }[] = [];

  for (const a of agents) {
    events.push({ at: a.startedAt, kind: "agent_started", text: `${a.role} を起動（${a.agentId}）` });
    if (a.result) {
      const at = a.result.timestamp || new Date(Date.parse(a.startedAt) + a.result.duration_ms).toISOString();
      events.push({
        at,
        kind: "agent_finished",
        text: `${a.role} が完了（${a.agentId}、${a.result.status}）: ${a.result.summary}`,
      });
    }
  }

  for (const g of workspace.gateResults) {
    for (const attempt of g.attempts) {
      for (const c of attempt.checks) {
        events.push({
          at: c.at,
          kind: "gate_check",
          text: `${g.gateId} attempt ${attempt.attempt} のチェック ${c.checkIndex}（${c.method}）: ${c.passed ? "合格" : "不合格"}${c.note ? ` — ${c.note}` : ""}`,
        });
      }
    }
  }

  for (const r of workspace.humanReviews) {
    events.push({
      at: r.requestedAt,
      kind: "human_review_requested",
      text: `${r.gateId} の人間レビューを依頼（v${r.version}）`,
    });
    if (r.resolvedAt) {
      events.push({
        at: r.resolvedAt,
        kind: "human_review_resolved",
        text: `${r.gateId} の人間レビュー（v${r.version}）: ${r.status === "approved" ? "承認" : "差し戻し"}`,
      });
    }
  }

  for (const c of workspace.gateChanges) {
    events.push({
      at: c.at,
      kind: "irregular",
      text: `${c.gateId} のゲートを${c.after === null ? "削除" : "変更"}（${c.id}）: ${c.reason}`,
    });
  }

  return events
    .map((e, i) => ({ e, i, t: Date.parse(e.at) }))
    .sort((x, y) => (x.t - y.t) || (x.i - y.i))
    .map((x) => x.e);
}

/** 反復数: 最新の Progress Ledger の反復番号（通し番号）。無ければ履歴の末尾、それも無ければ 0 */
function currentIteration(ledger?: MagenticLedger): number {
  const latest = ledger?.progressLedger?.iteration;
  if (latest !== undefined) return latest;
  const history = ledger?.progressHistory ?? [];
  return history.length > 0 ? history[history.length - 1].iteration : 0;
}

// --------------------------------------------------
// 本体
// --------------------------------------------------

/** 完了レポートを組み立てる（入力は変更しない） */
export function buildWorkspaceReport(input: BuildWorkspaceReportInput): WorkspaceReport {
  const { workspace, plan, ledger, agents, finalResponse } = input;
  const now = input.now ?? new Date().toISOString();

  const prose = extractReportProse(finalResponse);
  const finalGateSummary = summarizeFinalGate(plan, workspace);
  const steps = currentSteps(plan, workspace, ledger);
  const irregulars: GateChange[] = structuredClone(workspace.gateChanges);

  return {
    summary: prose.summary,
    howToTry: prose.howToTry,
    changedFiles: collectChangedFiles(agents, workspace.workspacePath),
    humanDecisions: workspace.humanReviews.map(describeReview),
    completion: plan.spec.completion.map((criterion) => ({
      criterion,
      achieved: finalGateSummary.passed,
      note: finalGateSummary.note,
    })),
    notes: buildNotes(prose.notes, workspace, plan),
    irregulars,
    progress: {
      phases: buildPhases(plan, workspace, ledger),
      timeline: buildTimeline(workspace, agents),
      gateResults: structuredClone(workspace.gateResults),
      stats: {
        steps: steps.filter((s) => s.kind !== "gate").length,
        gates: steps.filter((s) => s.kind === "gate").length,
        iterations: currentIteration(ledger),
        duration_ms: Math.max(0, Date.parse(now) - Date.parse(workspace.createdAt)),
      },
    },
    generatedAt: now,
  };
}
