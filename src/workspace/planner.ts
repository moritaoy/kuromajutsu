// ============================================================
// Planner（計画生成）のプロンプト構築と出力抽出（docs/spec.md §13.7 / §13.10.2）
//
// 純粋関数のみ。Agent の起動・状態遷移は service.ts が行う。
// ============================================================

import type { PlanTarget, RoleDefinition, WorkPlan } from "../types/index.js";
import { extractJson, parseWorkPlanInput, type ParseResult, type WorkPlanInput } from "./schema.js";

// --------------------------------------------------
// 入力
// --------------------------------------------------

export interface PlannerPromptInput {
  /** Workspace の最初の指示 */
  instruction: string;
  /** 作業ディレクトリ */
  workspacePath: string;
  /** 利用可能な職種（orchestrator / planner を除く） */
  roles: RoleDefinition[];
  /** 再計画のとき、直前の計画 */
  previousPlan?: WorkPlan;
  /** 再計画のとき、追加指示 */
  additionalInstruction?: string;
  /** 再計画のとき、追加指示の対象 */
  targets?: PlanTarget[];
  /** リトライのとき、直前の出力の不備 */
  validationErrors?: string[];
}

// --------------------------------------------------
// 指示の対象の解決
// --------------------------------------------------

const TARGET_KIND_LABEL: Record<PlanTarget["kind"], string> = {
  phase: "フェーズ",
  step: "手順",
  gate: "ゲート",
};

/** 「@P2 実装を行う（フェーズ）」の形に解決する。存在しない ID は注記を付ける */
export function renderTargets(plan: WorkPlan, targets: PlanTarget[]): string[] {
  return targets.map((t) => {
    const label = TARGET_KIND_LABEL[t.kind];
    const name =
      t.kind === "phase"
        ? plan.phases.find((p) => p.id === t.id)?.name
        : plan.steps.find((s) => s.id === t.id)?.title;
    return name === undefined
      ? `@${t.id} （${label}。現在の計画に存在しません）`
      : `@${t.id} ${name}（${label}）`;
  });
}

// --------------------------------------------------
// WorkPlan JSON の形
// --------------------------------------------------

const WORK_PLAN_INPUT_TS = `interface WorkPlanInput {
  title: string;                       // 計画の題名
  goal: string;                        // ゴール（1〜2 文）
  spec: {                              // 指示から導出した「解釈」
    workspace: string;                 // 作業ディレクトリ
    scope: string[];                   // 変更してよい範囲（パス・ディレクトリ）
    constraints: string[];             // 守るべき制約
    completion: string[];              // 完了条件（1 件以上。最終ゲートの根拠）
    assumptions: string[];             // あなたが置いた前提（人に確認してほしい点）
  };
  phases: Phase[];                     // 上から順に実行。最後は final フェーズ
  steps: PlanStep[];                   // 全フェーズの手順とゲート（フェーズ順に並べる）
  facts: {
    given: string[];                   // 指示や既存コードから確定している事実
    toInvestigate: string[];           // 調査が必要な事項
    toDerive: string[];                // 調査・設計の結果から導く事項
    assumptions: string[];             // 確認できていない前提
  };
}

interface Phase {
  id: string;                          // "P1", "P2", ... / final フェーズは "PF"
  name: string;                        // 大まかな段階の名前（例: 「アーキテクチャを決める」）
  goal: string;                        // フェーズの目的
  planning: "fixed" | "deferred";      // fixed: 手順を今決める / deferred: フェーズ開始直前に決める
  notes: string[];                     // deferred のとき、直前計画で考慮すべきこと
  final?: boolean;                     // 最終フェーズ（完了確認）のみ true
}

interface PlanStep {
  id: string;                          // 手順は "s1", "s2", ... / 出口ゲートは "gate-<phaseId>" / 最終ゲートは "gate-final"
  phaseId: string;                     // 所属するフェーズの ID
  kind: "work" | "gate";
  title: string;
  role: string;                        // 職種 ID（上の職種一覧から選ぶ。gate は自動チェックを行う職種）
  description: string;
  dependsOn: string[];                 // 同じフェーズ内の手順 ID のみ。依存がなければ空配列
  // kind: "work" のとき
  doneCriteria?: string[];             // 完了定義。観測可能な条件を 1 件以上
  scope?: string;                      // 変更してよい範囲（並列手順の衝突検出に使う。読み取りのみなら「（読み取りのみ）」）
  // kind: "gate" のとき
  checks?: {                           // 1 件以上
    text: string;
    method: "agent-review" | "command" | "human";
    command?: string;                  // method: "command" のとき必須
  }[];
  onFail?: { action: "rework"; maxRetries: number };   // 省略可（既定: maxRetries 2）
}`;

const OUTPUT_RULES = [
  "- 出力は **WorkPlan の JSON オブジェクト 1 つだけ** にする。前後に説明文を付けない。コードフェンスで囲まない。",
  "- `revision` と `maxIterations` はサーバーが設定するため出力しない。",
  "- すべてのフェーズに出口ゲート（`kind: \"gate\"`、ID は `gate-<phaseId>`、`checks` 1 件以上）を置く。",
  "- 最後に final フェーズ（ID は `PF`、`final: true`、`planning: \"fixed\"`、work の手順は置かない）を置き、最終ゲート `gate-final`（`phaseId: \"PF\"`）を 1 つだけ置く。",
  "- 確定フェーズ（`fixed`）の work の手順には `doneCriteria` を 1 件以上書く。",
  "- `deferred` フェーズには work の手順を置かず、出口ゲート（`gate-<phaseId>`）と `notes` だけを置く。",
  "- `dependsOn` は同じフェーズ内の手順 ID のみ。ゲートの `dependsOn` は空でよい（フェーズの末端の手順に自動で依存する）。",
  "- ID は計画内で一意にする。",
].join("\n");

const PLANNING_POLICY = [
  "- フェーズは「アーキテクチャを決める」「実装を行う」「テストを実装する」のような大まかな段階にし、上から順に進む。並列にできるのはフェーズの中の手順だけ。",
  "- 実装結果や調査結果に依存して手順を今決められないフェーズは `planning: \"deferred\"` にし、`notes` に直前計画で考慮すべきことを書く。",
  "- 設計判断を含むフェーズの出口ゲートには人間レビュー（`method: \"human\"` のチェック）を提案する。",
  "- ゲートの `command` チェックはプロジェクトの標準コマンド（`npm test` 等）を使う。破壊的なコマンド（削除・`git push`・`sudo` など）は書かない。",
  "- 並列に動く手順には、衝突しないよう `scope` を分けて書く。",
  "- kuromajutsu の `run_agents` / `run_sequential` / `run_magentic` / `create_group` などで他の Agent を起動しない。使ってよい kuromajutsu のツールは `report_result` のみ。",
].join("\n");

// --------------------------------------------------
// プロンプト構築
// --------------------------------------------------

function renderRoles(roles: RoleDefinition[]): string {
  if (roles.length === 0) return "（利用可能な職種がありません）";
  return roles.map((r) => `- ${r.id}（${r.name}）: ${r.description}`).join("\n");
}

/** 前の計画を、サーバーが設定する項目を除いた JSON（インデントなし）で出す */
function renderPreviousPlan(plan: WorkPlan): string {
  const { revision: _revision, maxIterations: _maxIterations, ...rest } = plan;
  return JSON.stringify(rest);
}

/** Planner Agent に渡す user プロンプトを組み立てる */
export function buildPlannerPrompt(input: PlannerPromptInput): string {
  const sections: string[] = [];

  sections.push(
    input.previousPlan
      ? "# 依頼\n\n前の計画と追加指示から、作業計画（WorkPlan）を作り直してください。ファイルの編集や実作業は行わないでください。"
      : "# 依頼\n\n次の指示から作業計画（WorkPlan）を作ってください。ファイルの編集や実作業は行わないでください。",
  );

  sections.push(`## 指示\n\n${input.instruction}`);
  sections.push(`## 作業ディレクトリ\n\n${input.workspacePath}`);
  sections.push(`## 利用可能な職種\n\n手順の \`role\` にはこの ID だけを使うこと。\n\n${renderRoles(input.roles)}`);

  if (input.previousPlan) {
    const plan = input.previousPlan;
    sections.push(`## 前の計画\n\n\`\`\`json\n${renderPreviousPlan(plan)}\n\`\`\``);

    const additional = (input.additionalInstruction ?? "").trim();
    sections.push(`## 追加指示\n\n${additional === "" ? "（追加指示なし）" : additional}`);

    const targets = input.targets ?? [];
    if (targets.length > 0) {
      sections.push(
        `## 指示の対象\n\n追加指示は次の対象に対するものです。\n\n${renderTargets(plan, targets)
          .map((l) => `- ${l}`)
          .join("\n")}`,
      );
    } else {
      sections.push("## 指示の対象\n\n指定なし。追加指示は計画全体への指示として扱ってください。");
    }

    sections.push(
      "## 再計画の方針\n\n- 追加指示の対象以外は極力変えないこと。\n- 既存のフェーズ・手順・ゲートの ID を維持すること（変更しない要素の ID を振り直さない）。新しい要素には未使用の ID を付ける。\n- 差分は ID で突き合わせて UI に表示される。",
    );
  }

  sections.push(`## 計画の方針\n\n${PLANNING_POLICY}`);

  sections.push(
    `## 出力する JSON の形\n\n次の \`WorkPlanInput\` の形の JSON を出力してください。\n\n\`\`\`typescript\n${WORK_PLAN_INPUT_TS}\n\`\`\`\n\n### ルール\n\n${OUTPUT_RULES}`,
  );

  const errors = input.validationErrors ?? [];
  if (errors.length > 0) {
    sections.push(
      `## 直前の出力の不備\n\n直前の出力は次の理由で受理できませんでした。これらを修正した JSON を出力してください。\n\n${errors
        .map((e) => `- ${e}`)
        .join("\n")}`,
    );
  }

  sections.push(
    "## 報告\n\n作業が終わったら、kuromajutsu MCP の `report_result` ツールを呼び出してください（`status` は `success`）。\n\nシステム情報ブロックに書かれた `response` のガイドライン（実施内容の整理など）より優先して、`response` には WorkPlan の JSON のみを入れてください。前置き・コードフェンス・説明文は付けないでください。",
  );

  return sections.join("\n\n");
}

// --------------------------------------------------
// 出力の抽出
// --------------------------------------------------

/** Planner の `response` から WorkPlan JSON を取り出して検証する */
export function extractPlannerOutput(response: string): ParseResult<WorkPlanInput> {
  const json = extractJson(response);
  if (json === undefined) {
    return { ok: false, errors: ["出力に JSON が見つかりません（WorkPlan の JSON のみを出力してください）"] };
  }
  return parseWorkPlanInput(json);
}
