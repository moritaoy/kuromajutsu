// ============================================================
// Workspace 用の Orchestrator プロンプト（docs/spec.md §13.8.2 / §13.8.6）
//
// - `buildWorkspaceInjectionBlock`: 既存の 7 層プロンプト（manager.ts の
//   buildMagenticOrchestratorPrompt）に **追加** する注入ブロック
// - `buildResumePrompt`: 人間レビュー / 差し戻し上限超過のあとで再開する
//   新しい Orchestrator に渡す状態のスナップショットと「次にやること」
//
// どちらも純粋関数（文字列を返すだけ）。
// ============================================================

import type {
  GateCheck,
  MagenticLedger,
  Phase,
  PlanStep,
  ScheduledStep,
  ReviewComment,
  WorkPlan,
  Workspace,
} from "../types/index.js";
import { finalGate, gateOfPhase, toScheduledSteps } from "./plan.js";

// --------------------------------------------------
// 共通ヘルパー
// --------------------------------------------------

/** 既存の Orchestrator プロンプトと同じ「---【見出し】---」ブロック */
function block(title: string, lines: string[]): string {
  return ["", "---", `【${title}】`, "", ...lines, "", "---"].join("\n");
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function bullets(items: string[], empty = "（なし）"): string[] {
  return items.length > 0 ? items.map((x) => `- ${x}`) : [empty];
}

function planStepsOfKind(plan: WorkPlan, kind: PlanStep["kind"]): PlanStep[] {
  return plan.steps.filter((s) => s.kind === kind);
}

// --------------------------------------------------
// ReviewDoc の形（text-writer への依頼用）
// --------------------------------------------------

const REVIEW_DOC_TYPES = [
  "```typescript",
  "interface ReviewDoc {",
  "  title: string;",
  "  version: number;                    // 差し戻しごとに +1（サーバーが正しい値に補正する）",
  "  previousFeedback?: ReviewSection;   // version >= 2 では必須。前回の指摘への対応",
  "  sections: ReviewSection[];",
  "}",
  "",
  "interface ReviewSection {",
  "  id: string;           // ReviewDoc 内で一意",
  "  heading: string;",
  '  kind: "markdown" | "html" | "file" | "table" | "mermaid";',
  "  body?: string;        // markdown / html / mermaid の本文（markdown の生 HTML は無効化される。html は自己完結で外部リソース不可）",
  "  path?: string;        // file: 作業ディレクトリ内の既存ファイル（例: モックの HTML）",
  "  table?: { columns: string[]; rows: string[][] };  // table",
  "}",
  "```",
];

const STANDARD_SECTIONS: { id: string; heading: string; content: string }[] = [
  { id: "conclusion", heading: "結論", content: "何を決めた / 作ったか" },
  { id: "alternatives", heading: "比較した案と採否", content: "検討した案と採用 / 不採用の理由（kind: \"table\" が向く）" },
  { id: "structure", heading: "構成", content: "構成図（kind: \"mermaid\" 可）" },
  { id: "spec", heading: "仕様の表", content: "仕様・インターフェースの表（kind: \"table\"）" },
  { id: "changed-files", heading: "変更したファイル", content: "変更・作成したファイルと要点" },
  { id: "precheck", heading: "AI 事前チェックの結果", content: "自動チェック（agent-review / command）の結果" },
  { id: "decisions", heading: "判断してほしいこと", content: "human のチェック項目と、AI が置いた前提" },
];

// --------------------------------------------------
// 計画の全文
// --------------------------------------------------

function renderPhase(plan: WorkPlan, phase: Phase): string[] {
  const tags: string[] = [phase.planning === "deferred" ? "deferred（手順は開始直前に決める）" : phase.planning];
  if (phase.final) tags.push("final");
  const lines = [`- ${phase.id} 「${phase.name}」 [${tags.join(", ")}]`, `    目的: ${phase.goal}`];
  if (phase.parentPhaseId) lines.push(`    親フェーズ: ${phase.parentPhaseId}`);
  if (phase.fix) {
    lines.push(
      `    修正フェーズ: 不合格ゲート=${phase.fix.failedGateId}, 原因フェーズ=${phase.fix.causePhaseId}, 原因の切り分け手順=${phase.fix.triageStepId}`,
    );
  }
  if (phase.notes.length > 0) {
    lines.push("    notes:");
    for (const n of phase.notes) lines.push(`      - ${n}`);
  }
  const gate = gateOfPhase(plan, phase.id);
  if (gate) lines.push(`    出口ゲート: ${gate.id}`);
  return lines;
}

function renderWorkStep(step: PlanStep): string[] {
  const lines = [`- ${step.id} [${step.phaseId}] role=${step.role} 「${step.title}」`];
  lines.push(`    説明: ${step.description}`);
  lines.push(`    dependsOn: ${step.dependsOn.length > 0 ? step.dependsOn.join(", ") : "（なし）"}`);
  if (step.doneCriteria && step.doneCriteria.length > 0) {
    lines.push("    完了定義（DoD）:");
    for (const d of step.doneCriteria) lines.push(`      - ${d}`);
  }
  if (step.scope !== undefined) lines.push(`    scope: ${step.scope}`);
  return lines;
}

function renderCheck(check: GateCheck, index: number): string {
  const cmd = check.method === "command" && check.command ? `（command: \`${check.command}\`）` : "";
  return `      [${index}] ${check.method}: ${check.text}${cmd}`;
}

function renderGate(plan: WorkPlan, gate: PlanStep): string[] {
  const isFinal = finalGate(plan)?.id === gate.id;
  const lines = [`- ${gate.id} [${gate.phaseId}]${isFinal ? " [最終ゲート]" : ""} 「${gate.title}」 role=${gate.role}`];
  if (gate.description) lines.push(`    説明: ${gate.description}`);
  lines.push("    checks:");
  for (const [i, c] of (gate.checks ?? []).entries()) lines.push(renderCheck(c, i));
  if (gate.onFail) {
    lines.push(`    onFail: ${gate.onFail.action}（maxRetries: ${gate.onFail.maxRetries}）`);
  }
  return lines;
}

function planFullText(workspace: Workspace, plan: WorkPlan): string[] {
  const s = plan.spec;
  const works = planStepsOfKind(plan, "work");
  return [
    `Workspace ID: ${workspace.id}`,
    `計画のタイトル: ${plan.title}`,
    `計画の目的: ${plan.goal}`,
    `作業ディレクトリ: ${workspace.workspacePath}`,
    "",
    "スコープ:",
    ...bullets(s.scope),
    "制約:",
    ...bullets(s.constraints),
    "完了条件:",
    ...bullets(s.completion),
    "前提（AI が置いたもの）:",
    ...bullets(s.assumptions),
    "",
    "■ フェーズ一覧（上から順に実行する）",
    ...plan.phases.flatMap((p) => renderPhase(plan, p)),
    "",
    "■ 手順一覧（work）",
    ...(works.length > 0
      ? works.flatMap(renderWorkStep)
      : ["（確定している手順はありません。deferred フェーズの手順は開始直前に決めます）"]),
    "",
    "■ ゲート一覧",
    ...planStepsOfKind(plan, "gate").flatMap((g) => renderGate(plan, g)),
  ];
}

// --------------------------------------------------
// 注入ブロック（§13.8.2）
// --------------------------------------------------

export interface WorkspaceInjectionInput {
  workspace: Workspace;
  plan: WorkPlan;
  /** command チェックの実行に関する補足（禁止パターンの要約など）。あれば実行手順に添える */
  gateCommandNote?: string;
}

/**
 * Orchestrator プロンプトに追加する Workspace 用のブロックを組み立てる。
 * 既存の 7 層プロンプトの後ろに連結する前提で、同じ「---【...】---」の文体で書く。
 */
export function buildWorkspaceInjectionBlock(input: WorkspaceInjectionInput): string {
  const { workspace, plan, gateCommandNote } = input;

  const rules = block("Workspace 実行ルール — この計画を正とする", [
    "この実行は Workspace（作業スペース）から起動されています。以下の【Workspace 計画】は人間が承認済みです。",
    "",
    "1. **この計画を正とする。** フェーズの順序・ゲート・各手順の完了定義（DoD）を守って進める。計画にない作業を勝手に始めない。",
    "2. 前のフェーズのゲートを通過する前に、次のフェーズの手順を開始してはならない（ゲート通過前の成果物は次のフェーズに渡さない）。",
    "3. `planning: deferred` のフェーズは、**そのフェーズを始める直前に**、前フェーズの成果（サブ Agent の報告・変更ファイル）を見て手順を決め、",
    '   `update_ledger(type: "task", phases, scheduledSteps)` で Ledger に追加する。',
    '   - 追加する手順は `scheduledSteps` に `stepId` / `role` / `description` / `status: "pending"` / `dependsOn` / `phaseId` / `kind: "work"` / `doneCriteria` を付けて入れる。',
    "   - 既存の `phases` と `scheduledSteps`（ゲートを含む）は変更せず、そのまま含めて渡す。**ゲートは変えない。**",
    "   - **そのフェーズのゲートを実行する前に**、追加した手順をすべて実行して完了させる。",
    "4. 作業はすべてサブ Agent に委任する。自分では調査・実装・テスト実行をしない。サブ Agent のプロンプトには scope と constraints を必ず転記する。",
    '5. ゲートの合否はサーバーが管理する。**ゲート（kind: "gate" の手順）の `status` を自分で `completed` / `skipped` にしない**（`update_ledger` はエラー `GATE_PROTECTED` を返す）。ゲートの状態は、チェックの結果に応じてサーバーが更新する。',
    "6. maxIterations は人間レビューによる停止・再開をまたいで通算で数える。上限に達したら、途中経過を含めて `report_result` を呼ぶ。",
    '7. すべてのゲート（最終ゲートを含む）が合格したら、`report_result(status: "success")` で最終報告をする。その `response` は Markdown で、次の見出しを使って書く（人間向けの完了レポートの文章に使われる）:',
    "   - `## 何が実装されたか` — できるようになったこと",
    "   - `## 試し方` — 確認手順（コマンド・画面操作）",
    "   - `## 確認しておくと良いこと` — 注意点、未確認の事項、AI が置いた前提",
    "   文章の起草が必要なら `text-writer` に依頼してよい。",
  ]);

  const gateCommandLines = [
    `ゲートは \`checks\` の \`method\` ごとに次のとおり実行する。\`groupId\` には **Workspace の親（Magentic）グループの ID**（上記のシステム情報の Group ID${workspace.groupId ? `。この Workspace では \`${workspace.groupId}\`` : ""}）を指定する。\`create_group\` で作った **子グループの ID ではない**。`,
    "",
    "**`command`**",
    "- `run_gate_check(groupId, gateId)` を呼ぶ。サーバーがそのゲートの `command` チェックを配列順にすべて `sh -c` で実行し、合否・exit code・stdout/stderr の末尾を返す。あなたやサブ Agent がコマンドを実行してはならない。",
    "- 返却値の `gateStatus` を見て進める: `failed` なら原因の切り分けへ、`auto_passed` なら次のチェック（人間レビュー）へ、`passed` なら次のフェーズへ進む。",
    "- `gateStatus` が `pending` のときは、まだ結果の出ていないチェックが残っている。返却値の `pendingChecks` にある `agent-review` を続けて実行し（下記）、`report_gate_result` で記録する（`human` は自動チェックがすべて合格した後に扱う）。",
    ...(gateCommandNote ? [`- 補足: ${gateCommandNote}`] : []),
    "",
    "**`agent-review`**",
    "- 作業した職種とは別のレビュー職種（`code-review` / `text-review` など）のサブ Agent を `run_agents` で起動し、`report_result` の報告を読む。",
    "- 読んだ結果を `report_gate_result(groupId, gateId, checkIndex, passed, note)` で記録する。`checkIndex` は `checks` 配列の添字（0 始まり）。不合格のときは `note` に原因の箇所（どのフェーズのどの成果物か）を含める。",
    "",
    "**`human`（人間レビュー）**",
    "- `human` チェックを持つゲートでは、まず自動チェック（`agent-review` / `command`）をすべて実行し、合格させる。不合格なら通常どおり差し戻す。",
    "- 自動チェックがすべて合格したら、`text-writer` に ReviewDoc JSON の作成を依頼する（下記【レビュー資料の作成依頼】）。",
    '- `text-writer` の完了を待ち、その agentId で `request_human_review(groupId, gateId, reviewDocPath: "agent:<text-writer の agentId>")` を呼ぶ。',
    '- 呼んだら **直ちに** `report_result(status: "success", summary: "人間レビュー待ちで一時停止")` を呼んで終了する。人の判断を待ってはならない。人が承認または差し戻しをすると、サーバーが新しい Orchestrator を起動して再開する。',
    "- `REVIEW_DOC_INVALID` が返ったら、エラー内容を添えて `text-writer` に修正を依頼し、`request_human_review` をやり直す。",
  ];

  const onFail = block("ゲート不合格時の原則", [
    "ゲートが不合格になったときは、**自分で調査・修正しない**。次の順にサブ Agent へ委任する。",
    "",
    "1. そのフェーズに **「原因の切り分け」手順** を追加し、レビュー職種（`code-review` など。読み取り専用）に依頼する。報告に含めさせる内容は、原因の箇所（どのフェーズのどの成果物か）と、直すべき職種。",
    "2. 報告を読んで、直す場所を決める。",
    "   - 原因が不合格になったフェーズの中 → 同じフェーズに「修正」手順を追加する（職種は原因に合わせる）。",
    "   - 原因が前のフェーズの成果物 → 不合格になったフェーズの中に **修正フェーズ** を入れ子で追加し、原因に合う職種で手順を組む。人間レビューで承認済みの成果物を直す場合は、修正フェーズの出口を人間レビューにする。",
    "   - 修正フェーズは、原因のあったフェーズを巻き戻すのではなく **追加** する。合格済みのフェーズやゲートの記録は残す。",
    "3. 修正が終わったら、不合格になったゲートを **同じ条件で** 再チェックする。",
    "",
    "修正フェーズの作り方（`update_ledger` で追加する。既存の `phases` / `scheduledSteps` は変更せず、そのまま含めること）:",
    "",
    "```",
    'update_ledger(type: "task",',
    "  phases: [",
    "    ...既存の phases,",
    '    { id: "FX1", name: "<修正の名前>", goal: "<直す内容>", planning: "fixed", notes: [],',
    '      parentPhaseId: "<不合格になったゲートのフェーズ ID>",',
    '      fix: { failedGateId: "<不合格のゲート ID>", causePhaseId: "<原因のあったフェーズ ID>", triageStepId: "<原因の切り分け手順の stepId>" } }',
    "  ],",
    "  scheduledSteps: [",
    "    ...既存の scheduledSteps,",
    '    { stepId: "triage-<ゲート ID>-1", role: "code-review", description: "<原因の切り分け: 原因の箇所と直すべき職種を報告>", status: "pending", phaseId: "<不合格のフェーズ ID>", kind: "work", dependsOn: [<同じフェーズの直前の手順>], doneCriteria: ["原因の箇所と直すべき職種が報告されている"] },',
    '    { stepId: "fix-1", role: "<原因に合う職種>", description: "<修正内容と scope>", status: "pending", phaseId: "FX1", kind: "work", dependsOn: [], doneCriteria: ["..."] },',
    '    { stepId: "gate-FX1", role: "code-review", description: "<修正フェーズの出口ゲート>", status: "pending", phaseId: "FX1", kind: "gate", checks: [<元のゲートと同じ checks>], onFail: { action: "rework", maxRetries: 2 } }',
    "  ])",
    "```",
    "",
    "- `scheduledSteps` の要素には `title` / `scope` は無い。手順の内容・対象範囲は `description` に書く。",
    "- 修正フェーズにも **出口ゲートを必ず置く**。`checks` は元の（不合格になった）ゲートと同じにする。",
    "- 人間レビューで承認済みの成果物を直すときは、出口ゲートの `checks` に `{ text: \"...\", method: \"human\" }`（元のゲートのレビュー観点を引き継ぐ）を含める。",
    "- 修正フェーズの先頭の手順は `dependsOn: []` でよい（起点は `fix.triageStepId` から自動で決まる）。`dependsOn` は同じフェーズ内の手順だけを指定する。",
    "- 修正フェーズの出口ゲートに合格したら、元の不合格ゲート（`fix.failedGateId`）を同じ条件で再チェックする。",
    "4. `run_gate_check` / `report_gate_result` の返却値に `retryLimitExceeded: true` が含まれていたら、作業を打ち切る。",
    '   `report_result(status: "success", summary: "差し戻し上限超過で一時停止")` を呼んで終了する（返却値の `instruction` に従う）。人が判断したあと、サーバーが再開する。',
    "",
    "人間レビューでの差し戻しは `maxRetries` に数えない。人が納得するまで繰り返してよい。",
  ]);

  const changeRules = block("ゲートの変更ルール", [
    "ゲートは **通常は変更しない**。work 手順の追加・分割・スキップ・職種変更・順序変更、`deferred` フェーズの手順の決定、不合格時の切り分け・修正手順の追加は自由に行ってよい。",
    "",
    "- ゲートの追加（確認を厳しくする方向）は可。`command` は禁止パターンに当たらないこと（当たると `GATE_COMMAND_DENIED`）。",
    "- ゲートの変更・削除・緩和（チェックの削除、コマンドの変更、人間レビューの解除など）は **原則不可**。進行上どうしても必要な場合だけ、`update_ledger` に `irregular: true` と `reason`（理由）を付けて変更する。`irregular` と `reason` が無い変更は `GATE_CHANGE_NOT_ALLOWED` で拒否される。",
    "- イレギュラーな変更は、変更前後の差分と理由が人に警告として表示され、完了レポートにも載る。濫用しないこと。",
    "- **最終ゲートの削除、人間レビューの省略は、`irregular: true` を付けても不可**（`GATE_PROTECTED`）。",
  ]);

  const reviewDocBlock = block("レビュー資料の作成依頼（ReviewDoc）", [
    "人間レビューのゲートでは、`text-writer` に **ReviewDoc JSON** を作らせる。`text-writer` に HTML を書かせてはならない（サーバーが HTML に変換する）。",
    "`text-writer` は ReviewDoc JSON を `report_result` の `response` に返す。",
    "",
    "ReviewDoc の形:",
    "",
    ...REVIEW_DOC_TYPES,
    "",
    "標準の節（原則としてこの順で出す）:",
    "",
    ...STANDARD_SECTIONS.map((s) => `- \`${s.id}\` 「${s.heading}」: ${s.content}`),
    "",
    "- `version` ≥ 2（差し戻し後の版）では、先頭に `previousFeedback`（前回の指摘への対応）を置く。指摘ごとに、どう直したか（直さない場合はその理由）を書く。",
    '- 図（構成図・フロー図）は markdown のコードブロックではなく、`kind: "mermaid"` の節として `body` に mermaid の記法だけを書く。コードブロックにすると図にならずコードとして表示される。',
    '- モック HTML をそのまま見せたいときは `kind: "html"`（自己完結の HTML を `body` に書く）または `kind: "file"`（作業ディレクトリ内のファイルの `path`）を使ってよい。',
    "",
    "text-writer への依頼文のひな形（`run_agents` の prompt に入れる。`< >` の部分を埋める）:",
    "",
    "```",
    "人間レビュー用の資料（ReviewDoc JSON）を作成してください。HTML は書かないでください。",
    "- 対象ゲート: <gateId>（<ゲートの説明>）",
    "- version: <n>（初回は 1。差し戻し後は前の版 + 1）",
    "- 節: conclusion / alternatives / structure / spec / changed-files / precheck / decisions を、この順で出してください。",
    "  decisions には、このゲートの human チェック項目（<チェック項目>）と、AI が置いた前提を書いてください。",
    '- 図（構成図・フロー図）は markdown のコードブロックではなく、kind: "mermaid" の節として body に mermaid の記法だけを書いてください。コードブロックにすると図にならずコードとして表示されます。',
    "- 素材: <成果物のパス、各サブ Agent の報告の要点、自動チェックの結果（precheck 用）>",
    "- （version ≥ 2 のとき）先頭の previousFeedback に、次の指摘への対応を書いてください: <差し戻しコメント（節 ID 付き）>",
    "- 出力: ReviewDoc JSON だけを report_result の response に入れてください。前後に説明文は付けないでください。",
    "- ファイルの編集はしないでください。素材から確認できない事実は書かず、不明点は decisions に書いてください。",
    "```",
  ]);

  const planBlock = block("Workspace 計画（承認済み。この計画を正とする）", planFullText(workspace, plan));

  return [
    rules,
    block("ゲートの実行手順", gateCommandLines),
    onFail,
    changeRules,
    reviewDocBlock,
    planBlock,
  ]
    .join("\n")
    .replace(/^\n+/, "");
}

// --------------------------------------------------
// 再開プロンプト（§13.8.6）
// --------------------------------------------------

export type ResumeReason =
  | { kind: "approved"; gateId: string }
  | { kind: "changes_requested"; gateId: string; comments: ReviewComment[] }
  | { kind: "retry"; gateId: string; instruction?: string }
  | { kind: "recover"; failure: string; instruction?: string };

export interface ResumePromptInput {
  workspace: Workspace;
  plan: WorkPlan;
  ledger?: MagenticLedger;
  agentSummaries: {
    agentId: string;
    role: string;
    summary: string;
    editedFiles: string[];
    createdFiles: string[];
  }[];
  reason: ResumeReason;
  /**
   * 結果を報告しないまま終わった（再開で停止した）サブ Agent（Orchestrator 自身は除く）。
   * 異常終了からの再開（`recover`）のときだけプロンプトに含める
   */
  stoppedAgents?: {
    agentId: string;
    role: string;
    status: string;
    editedFiles: string[];
    createdFiles: string[];
  }[];
}

function formatComment(c: ReviewComment): string {
  return `[${c.sectionId ?? "全体"}] ${c.text}`;
}

/** 次の版の番号（対象ゲートの既存の最大版 + 1） */
function nextReviewVersion(workspace: Workspace, gateId: string): number {
  const versions = workspace.humanReviews.filter((r) => r.gateId === gateId).map((r) => r.version);
  return (versions.length > 0 ? Math.max(...versions) : 0) + 1;
}

/** 人からの指示（再試行・異常終了からの再開のとき。引数の指示、再試行ならなければ `retryInstructions` の最新） */
function humanInstruction(input: ResumePromptInput): string | undefined {
  if (input.reason.kind !== "retry" && input.reason.kind !== "recover") return undefined;
  if (input.reason.instruction !== undefined && input.reason.instruction.trim() !== "") {
    return input.reason.instruction;
  }
  if (input.reason.kind === "recover") return undefined;
  const gateId = input.reason.gateId;
  const result = input.workspace.gateResults.find((g) => g.gateId === gateId);
  const list = result?.retryInstructions ?? [];
  return list.length > 0 ? list[list.length - 1].text : undefined;
}

function reasonHeadline(reason: ResumeReason): string {
  switch (reason.kind) {
    case "approved":
      return `人間レビューの承認（対象ゲート: ${reason.gateId}）`;
    case "changes_requested":
      return `人間レビューの差し戻し（対象ゲート: ${reason.gateId}）`;
    case "retry":
      return `差し戻し上限超過後の再試行（対象ゲート: ${reason.gateId}）`;
    case "recover":
      return "Orchestrator の異常終了からの再開";
  }
}

/** 実行時の計画の姿（Task Ledger があればそれ。修正フェーズ・直前計画を含む）。なければ承認済みの計画 */
function runtimeView(input: ResumePromptInput): { phases: Phase[]; steps: ScheduledStep[] } {
  const t = input.ledger?.taskLedger;
  return {
    phases: t?.phases ?? input.plan.phases,
    steps: t?.scheduledSteps ?? toScheduledSteps(input.plan),
  };
}

/** 差し戻された人間レビューの次の行動（差し戻しからの再開、未対応の差し戻しの引き継ぎで共用） */
function changesRequestedActions(input: ResumePromptInput, gateId: string, comments: ReviewComment[]): string[] {
  const { phases, steps } = runtimeView(input);
  const gate = steps.find((s) => s.stepId === gateId);
  const phase = gate?.phaseId ? phases.find((p) => p.id === gate.phaseId) : undefined;
  const phaseLabel = phase ? `${phase.id}「${phase.name}」` : "（該当フェーズ）";
  const version = nextReviewVersion(input.workspace, gateId);
  return [
    `${phaseLabel} の出口ゲート ${gateId} は人間レビューで差し戻されました。次の順に進めてください。`,
    "",
    "差し戻しコメント（節 ID 付き）:",
    ...comments.map((c) => `- ${formatComment(c)}`),
    "",
    '1. そのフェーズに「レビュー指摘の反映」手順を追加し（`update_ledger(type: "task", phases, scheduledSteps)`。ゲートは変えない）、サブ Agent に実行させる。',
    `2. ゲート ${gateId} の自動チェック（\`command\` は \`run_gate_check(groupId, gateId)\`、\`agent-review\` はレビュー職種の起動 + \`report_gate_result\`）をやり直す。不合格なら通常の不合格時の原則に従う。`,
    `3. \`text-writer\` に **次の版**（version: ${version}）のレビュー資料を作らせる。先頭の \`previousFeedback\` に、上記コメントそれぞれへの対応（直した内容、直さない場合はその理由）を書かせる。`,
    `4. \`request_human_review(groupId, gateId: "${gateId}", reviewDocPath: "agent:<text-writer の agentId>")\` を呼び、`,
    '   `report_result(status: "success", summary: "人間レビュー待ちで一時停止")` で終了する。',
    "",
    "人間レビューの差し戻しは maxRetries に数えない。",
  ];
}

/** 差し戻し上限超過後の再試行の次の行動（再試行からの再開、未対応の再試行の引き継ぎで共用） */
function retryActions(gateId: string, instruction: string | undefined): string[] {
  return [
    `ゲート ${gateId} は不合格が続き、差し戻し上限を超えて停止していました。人が指示を付けて再試行を選びました。`,
    "このゲートの失敗回数は 0 に戻っています。",
    "",
    `人の指示: ${instruction ?? "（指示なし）"}`,
    "",
    "1. 人の指示を踏まえて、**原因の切り分けからやり直す**（そのフェーズに「原因の切り分け」手順を追加し、レビュー職種に依頼する。自分で調査・修正しない）。",
    "2. 報告を読んで、直す場所（同じフェーズ / 修正フェーズ）を決め、修正手順をサブ Agent に実行させる。",
    `3. ゲート ${gateId} を同じ条件で再チェックする。`,
    '4. 再び `retryLimitExceeded: true` が返ったら、`report_result(status: "success", summary: "差し戻し上限超過で一時停止")` で終了する。',
  ];
}

/**
 * 異常終了の前に始まっていた再開（人間レビューの差し戻し・再試行）のうち、まだ対応が始まっていないもの。
 * `orchestrator_failed` は再開時の起動失敗でも付くため、元の再開理由を状態から復元する。
 */
function pendingResumes(workspace: Workspace): {
  changeRequests: { gateId: string; comments: ReviewComment[] }[];
  retries: { gateId: string; text: string }[];
} {
  const changeRequests: { gateId: string; comments: ReviewComment[] }[] = [];
  const gateIds = [...new Set(workspace.humanReviews.map((r) => r.gateId))];
  for (const gateId of gateIds) {
    const reviews = workspace.humanReviews.filter((r) => r.gateId === gateId);
    const latest = reviews.reduce((a, b) => (b.version > a.version ? b : a));
    if (latest.status === "changes_requested") changeRequests.push({ gateId, comments: latest.comments });
  }

  const retries: { gateId: string; text: string }[] = [];
  for (const g of workspace.gateResults) {
    const last = g.retryInstructions[g.retryInstructions.length - 1];
    if (!last) continue;
    const maxAttempt = g.attempts.reduce((m, a) => Math.max(m, a.attempt), 0);
    if (maxAttempt <= (last.afterAttempt ?? 0)) retries.push({ gateId: g.gateId, text: last.text });
  }
  return { changeRequests, retries };
}

/** ゲートの状態別の一覧（未対応の再開があるゲートは除く）。まだ着手していない pending は含めない */
function gateBuckets(workspace: Workspace, skip: Set<string>): { failed: string[]; autoPassed: string[]; partial: string[] } {
  const out = { failed: [] as string[], autoPassed: [] as string[], partial: [] as string[] };
  for (const g of workspace.gateResults) {
    if (skip.has(g.gateId)) continue;
    const last = g.attempts[g.attempts.length - 1];
    if (g.status === "failed") out.failed.push(g.gateId);
    else if (g.status === "auto_passed") out.autoPassed.push(g.gateId);
    else if (g.status === "pending" && last && last.closedAt === undefined) out.partial.push(g.gateId);
  }
  return out;
}

/** 異常終了からの再開: 特定のゲートに紐付かないため、台帳（Task / Progress Ledger）とゲートの状態から続きを判断させる */
function recoverActions(input: ResumePromptInput, failure: string, instruction: string | undefined): string[] {
  const { workspace } = input;
  const pending = pendingResumes(workspace);
  const handled = new Set([...pending.changeRequests.map((c) => c.gateId), ...pending.retries.map((r) => r.gateId)]);
  const buckets = gateBuckets(workspace, handled);

  const lines = [
    `前の Orchestrator は異常終了しました（理由: ${failure}）。`,
    "途中で動いていたサブ Agent は停止済みです（上記「途中で停止したサブ Agent」）。その成果は部分的にディスクに残っている可能性があります。",
    "",
    ...(instruction !== undefined ? [`人の指示: ${instruction}`, ""] : []),
    "1. Task Ledger・Progress Ledger・サブ Agent の結果（上記）を見て、**完了していない最初の手順** から続ける。完了済みの作業はやり直さない。",
    '2. 途中だった手順（停止したサブ Agent の手順）は、同じ手順をやり直させるか、成果を確認するレビュー手順を挟んでから先へ進める。手順の追加は `update_ledger(type: "task", phases, scheduledSteps)` で行う（ゲートは変えない）。自分では作業しない原則は変えない。',
    "3. ゲートの状態は **サーバーの記録を正** とする（上記のゲート結果）。状態ごとに次のとおり進める。",
  ];

  const gateLines: string[] = [];
  if (buckets.failed.length > 0) {
    gateLines.push(
      `   - 不合格（failed）: ${buckets.failed.join(", ")} — 修正の手順（原因の切り分け / 修正フェーズ）を続け、修正が終わってから同じ条件で再チェックする。修正の前に再チェックしない。`,
    );
  }
  if (buckets.autoPassed.length > 0) {
    gateLines.push(
      `   - 自動チェック合格・人間レビュー前（auto_passed）: ${buckets.autoPassed.join(", ")} — 自動チェックはやり直さない。\`text-writer\` にレビュー資料を作らせ、\`request_human_review(groupId, gateId, reviewDocPath: "agent:<text-writer の agentId>")\` を呼んで、\`report_result(status: "success", summary: "人間レビュー待ちで一時停止")\` で終了する。`,
    );
  }
  if (buckets.partial.length > 0) {
    gateLines.push(
      `   - 途中の attempt（pending）: ${buckets.partial.join(", ")} — 同じ条件で再チェックする（\`command\` は \`run_gate_check(groupId, gateId)\`、\`agent-review\` はレビュー職種の起動 + \`report_gate_result\`）。`,
    );
  }
  lines.push(...(gateLines.length > 0 ? gateLines : ["   - 途中のゲートはありません。通常どおり、手順が終わったフェーズの出口ゲートをチェックする。"]));
  lines.push(
    '4. 最終ゲートが合格済みで残りの手順が無ければ、完了条件を確認し、`report_result(status: "success")` で最終報告をする（`response` は Markdown で、見出し `## 何が実装されたか` / `## 試し方` / `## 確認しておくと良いこと`）。',
  );

  for (const c of pending.changeRequests) {
    lines.push(
      "",
      `【未対応の人間レビューの差し戻し — ゲート ${c.gateId}】`,
      "異常終了の前に人間レビューが差し戻されていましたが、その対応はまだ始まっていません（再開に失敗していた可能性があります）。上の 3 よりこちらを先に行ってください。",
      ...changesRequestedActions(input, c.gateId, c.comments),
    );
  }
  for (const r of pending.retries) {
    lines.push(
      "",
      `【未対応の再試行の指示 — ゲート ${r.gateId}】`,
      "異常終了の前に人が再試行の指示を出していましたが、その後の attempt はまだありません（再開に失敗していた可能性があります）。上の 3 よりこちらを先に行ってください。",
      ...retryActions(r.gateId, r.text.trim() !== "" ? r.text : undefined),
    );
  }
  return lines;
}

function nextActions(input: ResumePromptInput): string[] {
  const { plan, reason } = input;
  if (reason.kind === "recover") return recoverActions(input, reason.failure, humanInstruction(input));
  const { phases, steps } = runtimeView(input);
  const gateId = reason.gateId;
  const gate = steps.find((s) => s.stepId === gateId);
  const phase = gate?.phaseId ? phases.find((p) => p.id === gate.phaseId) : undefined;
  const finalPhaseId = phases.find((p) => p.final)?.id;
  const finalGateId =
    (finalPhaseId ? steps.find((s) => s.kind === "gate" && s.phaseId === finalPhaseId)?.stepId : undefined) ??
    finalGate(plan)?.id;

  switch (reason.kind) {
    case "approved": {
      const lines = [
        `対象ゲート ${gateId} は人間レビューで承認され、合格済みです（Task Ledger 上は completed。自分では変更しない）。`,
      ];
      if (finalGateId === gateId) {
        lines.push(
          "これは **最終ゲート** です。すべてのフェーズが完了しています。完了条件を確認し、",
          '`report_result(status: "success")` で最終報告をしてください。`response` は Markdown で、見出し `## 何が実装されたか` / `## 試し方` / `## 確認しておくと良いこと` を使って書きます。',
        );
        return lines;
      }
      if (phase?.fix) {
        const failedGate = steps.find((s) => s.stepId === phase.fix?.failedGateId);
        lines.push(
          `${gateId} は修正フェーズ ${phase.id}「${phase.name}」の出口ゲートです。次に、元の不合格ゲート ${phase.fix.failedGateId}${failedGate?.phaseId ? `（フェーズ ${failedGate.phaseId}）` : ""} を **同じ条件で再チェック** してください（\`command\` は \`run_gate_check(groupId, gateId)\`、\`agent-review\` はレビュー職種の起動 + \`report_gate_result\`）。`,
          "再チェックに合格したら、そのフェーズの次へ進みます。不合格なら通常の不合格時の原則に従ってください。",
        );
        return lines;
      }
      const idx = phase ? phases.findIndex((p) => p.id === phase.id) : -1;
      const next = idx >= 0 ? phases.slice(idx + 1).find((p) => !p.parentPhaseId) : undefined;
      if (next) {
        lines.push(`次のフェーズ ${next.id}「${next.name}」へ進んでください。`);
        if (next.planning === "deferred") {
          lines.push(
            `${next.id} は planning: deferred です。直前計画から始めます: 前フェーズの成果（上記のサブ Agent の結果）を見て手順を決め、`,
            '`update_ledger(type: "task", phases, scheduledSteps)` で追加してから実行してください。ゲートは変えないこと。',
          );
        }
      } else {
        lines.push("Task Ledger の `scheduledSteps` を見て、まだ完了していない最初のフェーズ（なければ最終ゲート）へ進んでください。");
      }
      return lines;
    }
    case "changes_requested":
      return changesRequestedActions(input, reason.gateId, reason.comments);
    case "retry":
      return retryActions(reason.gateId, humanInstruction(input));
  }
}

function taskLedgerLines(ledger?: MagenticLedger): string[] {
  const t = ledger?.taskLedger;
  if (!t) {
    return ['（Task Ledger は未登録です。【Workspace 計画】を元に `update_ledger(type: "task")` で登録してください）'];
  }
  return [
    "facts:",
    "```json",
    json(t.facts),
    "```",
    "plan:",
    "```json",
    json(t.plan),
    "```",
    "phases（直前計画・修正フェーズを含む現在の姿）:",
    "```json",
    json(t.phases ?? []),
    "```",
    "scheduledSteps（各手順の status を含む）:",
    "```json",
    json(t.scheduledSteps ?? []),
    "```",
  ];
}

function progressLedgerLines(ledger?: MagenticLedger): string[] {
  if (!ledger) return ["（Progress Ledger はありません）"];
  const history = [...ledger.progressHistory];
  if (ledger.progressLedger) history.push(ledger.progressLedger);
  if (history.length === 0) return ["（まだ記録がありません）"];
  return [
    "各反復の判定（最後が最新。反復番号は通し番号で続ける）:",
    "```json",
    json(history),
    "```",
  ];
}

/**
 * 再開する Orchestrator に渡す「状態のスナップショット」と「次にやること」を組み立てる。
 * 新しい Orchestrator は会話の記憶を持たないため、再開に必要な情報をすべて含める。
 * 承認時のプロンプト（既存の 7 層 + `buildWorkspaceInjectionBlock`）に **加えて** 注入する。
 */
export function buildResumePrompt(input: ResumePromptInput): string {
  const { workspace, plan, ledger, agentSummaries, reason } = input;
  const stoppedAgents = input.stoppedAgents ?? [];
  const spec = plan.spec;
  const instruction = humanInstruction(input);

  const intro = block("再開 — あなたは前の Orchestrator の続きを担当します", [
    "前の Orchestrator は停止しました。あなたは会話の記憶を持たない新しい Orchestrator です。以下の状態のスナップショットを読み、",
    "最後の【次にやること】から作業を再開してください。完了済みの作業をやり直してはいけません。",
    "",
    `再開の理由: ${reasonHeadline(reason)}`,
  ]);

  const workspaceBlock = block("再開時の状態 1 — Workspace", [
    `Workspace ID: ${workspace.id}`,
    `最初の指示: ${workspace.instruction}`,
    `作業ディレクトリ: ${workspace.workspacePath}`,
    "",
    "承認済みの計画の spec:",
    "スコープ:",
    ...bullets(spec.scope),
    "制約:",
    ...bullets(spec.constraints),
    "完了条件:",
    ...bullets(spec.completion),
    "前提:",
    ...bullets(spec.assumptions),
  ]);

  const ledgerBlock = block("再開時の状態 2 — Task Ledger と Progress Ledger", [
    "【Task Ledger】",
    ...taskLedgerLines(ledger),
    "",
    "【Progress Ledger の履歴】",
    ...progressLedgerLines(ledger),
  ]);

  const gateBlock = block("再開時の状態 3 — ゲート結果・レビュー結果・イレギュラー", [
    "【ゲート結果】（attempt ごとの各チェックの合否・note・command の結果の末尾）",
    ...(workspace.gateResults.length > 0 ? ["```json", json(workspace.gateResults), "```"] : ["（まだありません）"]),
    "",
    "【レビュー結果】（版、承認 / 差し戻し、差し戻しコメントは節 ID 付き）",
    ...(workspace.humanReviews.length > 0 ? ["```json", json(workspace.humanReviews), "```"] : ["（まだありません）"]),
    "",
    "【イレギュラー】（これまでのゲートの変更と理由）",
    ...(workspace.gateChanges.length > 0 ? ["```json", json(workspace.gateChanges), "```"] : ["（なし）"]),
  ]);

  const agentBlock = block("再開時の状態 4 — 完了したサブ Agent の結果の要約", [
    ...(agentSummaries.length > 0
      ? agentSummaries.flatMap((a) => [
          `- ${a.agentId}（${a.role}）: ${a.summary}`,
          `    編集したファイル: ${a.editedFiles.length > 0 ? a.editedFiles.join(", ") : "（なし）"}`,
          `    作成したファイル: ${a.createdFiles.length > 0 ? a.createdFiles.join(", ") : "（なし）"}`,
        ])
      : ["（なし）"]),
  ]);

  const stoppedBlock =
    reason.kind === "recover"
      ? block("再開時の状態 5 — 途中で停止したサブ Agent（結果を報告していない）", [
          ...(stoppedAgents.length > 0
            ? stoppedAgents.flatMap((a) => [
                `- ${a.agentId}（${a.role}、状態: ${a.status}）`,
                `    途中までに編集したファイル: ${a.editedFiles.length > 0 ? a.editedFiles.join(", ") : "（なし）"}`,
                `    途中までに作成したファイル: ${a.createdFiles.length > 0 ? a.createdFiles.join(", ") : "（なし）"}`,
              ])
            : ["（なし）"]),
        ])
      : "";

  const humanBlock = block("人からの指示", [instruction ?? "（なし）"]);

  const nextBlock = block("次にやること", nextActions(input));

  return [intro, workspaceBlock, ledgerBlock, gateBlock, agentBlock, stoppedBlock, humanBlock, nextBlock]
    .filter((b) => b !== "")
    .join("\n")
    .replace(/^\n+/, "");
}
