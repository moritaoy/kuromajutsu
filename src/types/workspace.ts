// ============================================================
// Workspace 型定義（docs/spec.md §13）
// ============================================================

import type { TaskLedger } from "./index.js";

// --------------------------------------------------
// Workspace（§13.3.1）
// --------------------------------------------------

export type WorkspaceStatus =
  | "planning"
  | "review"
  | "running"
  | "waiting_human"
  | "done"
  | "failed"
  | "aborted";

export interface StatusReason {
  code:
    | "human_review"
    | "gate_retry_exceeded" // waiting_human
    | "plan_failed"
    | "max_iterations"
    | "orchestrator_failed"
    | "server_restart" // failed
    | "user_abort"; // aborted
  /** human_review / gate_retry_exceeded のとき対象ゲート */
  gateId?: string;
  /** 人が読む理由文 */
  message: string;
}

/** Orchestrator の異常終了からの再開の履歴（§13.8.9） */
export interface WorkspaceRecovery {
  /** 再開した時刻（ISO 8601） */
  at: string;
  /** 再開前の失敗（`failed` / `orchestrator_failed` の理由文） */
  failure: { code: "orchestrator_failed"; message: string };
  /** 人が付けた指示 */
  instruction?: string;
}

export interface Workspace {
  /** ws-{unixTimestamp}-{random4hex} */
  id: string;
  /** 最初の指示 */
  instruction: string;
  /** 作業ディレクトリ */
  workspacePath: string;
  status: WorkspaceStatus;
  statusReason?: StatusReason;
  /** 計画の改訂履歴（revisions[n-1] が revision n） */
  revisions: WorkPlan[];
  /** 承認された revision */
  approvedRevision?: number;
  /** 実行時の Magentic 親グループ ID */
  groupId?: string;
  gateResults: GateResult[];
  humanReviews: HumanReview[];
  gateChanges: GateChange[];
  /** Orchestrator の異常終了からの再開の履歴（再開したことがなければ無い。古い保存ファイルとの互換のため optional） */
  recoveries?: WorkspaceRecovery[];
  report?: WorkspaceReport;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601 */
  updatedAt: string;
}

// --------------------------------------------------
// WorkPlan（§13.3.2）
// --------------------------------------------------

/** Planner が指示から導出する「解釈」 */
export interface PlanSpec {
  workspace: string;
  scope: string[];
  constraints: string[];
  completion: string[];
  assumptions: string[];
}

export interface WorkPlan {
  /** サーバーが採番（1 始まり） */
  revision: number;
  title: string;
  goal: string;
  spec: PlanSpec;
  /** 上から順に実行。最後は final フェーズ */
  phases: Phase[];
  steps: PlanStep[];
  facts: TaskLedger["facts"];
  /** サーバーが算出（§13.8.7） */
  maxIterations: number;
  /**
   * この revision を作らせた指示（サーバーが付与する。Planner の出力には含めない）。
   * 初回生成は最初の指示、再計画は追加指示と対象。
   */
  request?: PlanRequest;
}

/** WorkPlan の revision を生成させた指示 */
export interface PlanRequest {
  instruction: string;
  targets?: PlanTarget[];
  /** ISO 8601 */
  at: string;
}

export interface Phase {
  id: string;
  name: string;
  goal: string;
  planning: "fixed" | "deferred";
  notes: string[];
  final?: boolean;
  /** 修正フェーズ（§13.5.6） */
  fix?: {
    failedGateId: string;
    causePhaseId: string;
    triageStepId: string;
  };
  /** 入れ子の親（不合格になったゲートのフェーズ） */
  parentPhaseId?: string;
}

export interface GateCheck {
  text: string;
  method: "agent-review" | "command" | "human";
  /** method: "command" のとき必須 */
  command?: string;
}

export interface PlanStep {
  id: string;
  phaseId: string;
  kind: "work" | "gate";
  title: string;
  role: string;
  description: string;
  /** 同じフェーズ内の Step のみ */
  dependsOn: string[];
  // work
  doneCriteria?: string[];
  scope?: string;
  // gate
  checks?: GateCheck[];
  onFail?: { action: "rework"; maxRetries: number };
}

// --------------------------------------------------
// ゲート結果・人間レビュー・イレギュラー（§13.3.3）
// --------------------------------------------------

export interface GateCheckResult {
  checkIndex: number;
  method: "agent-review" | "command";
  passed: boolean;
  note?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  duration_ms?: number;
  stdoutTail?: string;
  stderrTail?: string;
  /** ISO 8601 */
  at: string;
}

export interface GateAttempt {
  /** 1 始まり。再試行リセット後も通し番号 */
  attempt: number;
  checks: GateCheckResult[];
  closedAt?: string;
}

export interface GateResult {
  gateId: string;
  phaseId: string;
  status: "pending" | "failed" | "auto_passed" | "waiting_human" | "passed";
  attempts: GateAttempt[];
  /**
   * D3: 人が「指示を付けて再試行」したときの指示。以後、failedAttempts は 0 から数え直す。
   * `afterAttempt` は再試行の時点で最後だった attempt の番号（これより後の attempt だけを数える）。
   */
  retryInstructions: { text: string; at: string; afterAttempt?: number }[];
}

export interface ReviewComment {
  sectionId?: string;
  text: string;
}

export interface HumanReview {
  gateId: string;
  /** レビュー資料の版（1 始まり） */
  version: number;
  status: "pending" | "approved" | "changes_requested";
  /** reviews/<gateId>-v<n>.html（Workspace ディレクトリからの相対） */
  docFile: string;
  comments: ReviewComment[];
  requestedAt: string;
  resolvedAt?: string;
}

export interface GateChange {
  /** gc-{n} */
  id: string;
  gateId: string;
  before: PlanStep;
  /** 削除された場合は null */
  after: PlanStep | null;
  reason: string;
  at: string;
  acknowledgedAt?: string;
}

// --------------------------------------------------
// ReviewDoc（§13.6.1）
// --------------------------------------------------

export interface ReviewSection {
  /** ReviewDoc 内で一意 */
  id: string;
  heading: string;
  kind: "markdown" | "html" | "file" | "table" | "mermaid";
  body?: string;
  path?: string;
  table?: { columns: string[]; rows: string[][] };
}

export interface ReviewDoc {
  title: string;
  version: number;
  previousFeedback?: ReviewSection;
  sections: ReviewSection[];
}

// --------------------------------------------------
// 完了レポート（§13.11）
// --------------------------------------------------

export interface WorkspaceReport {
  /** 何が実装されたか */
  summary: string;
  /** 試し方 */
  howToTry: string;
  changedFiles: { editedFiles: string[]; createdFiles: string[] };
  /** 人が判断したこと */
  humanDecisions: string[];
  /** 完了条件ごとの達成状況 */
  completion: { criterion: string; achieved: boolean; note?: string }[];
  /** 確認しておくと良いこと */
  notes: string;
  irregulars: GateChange[];
  /** 経過（折りたたみ） */
  progress: {
    phases: {
      phaseId: string;
      name: string;
      steps: { stepId: string; title: string; role: string; status: string }[];
    }[];
    timeline: { at: string; kind: string; text: string }[];
    gateResults: GateResult[];
    stats: { steps: number; gates: number; iterations: number; duration_ms: number };
  };
  generatedAt: string;
}

// --------------------------------------------------
// 設定・計画対象・検証
// --------------------------------------------------

/** workspace.gateCommands 設定（§9.2 / §13.5.3） */
export interface WorkspaceConfig {
  gateCommands: {
    deny: string[];
    allow: string[];
    timeout_ms: number;
    maxOutput_bytes: number;
  };
}

/** 再計画の指示の対象（§13.10.2） */
export interface PlanTarget {
  kind: "phase" | "step" | "gate";
  id: string;
}

export type ValidationRule = "V1" | "V2" | "V3" | "V4" | "V5" | "V6" | "V7" | "V8" | "V9";

export interface ValidationIssue {
  rule: ValidationRule;
  level: "error" | "warning";
  message: string;
  targetIds?: string[];
  autoFixed?: boolean;
}
