// ============================================================
// Workspace のエラー
// ============================================================

import type { ValidationIssue } from "../types/index.js";

export type WorkspaceErrorCode =
  | "INVALID_INSTRUCTION"
  | "INVALID_WORKSPACE_PATH"
  | "INVALID_REQUEST"
  | "PLANNER_UNAVAILABLE"
  | "ORCHESTRATOR_UNAVAILABLE"
  | "INVALID_STATE"
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  // --- 実行系（MCP ツールから呼ばれる。§2.2.12〜2.2.14）---
  | "NOT_WORKSPACE_GROUP"
  | "WORKSPACE_NOT_RUNNING"
  | "GATE_NOT_FOUND"
  | "NO_COMMAND_CHECK"
  | "COMMAND_DENIED"
  | "CHECK_NOT_FOUND"
  | "CHECK_METHOD_MISMATCH"
  | "NO_HUMAN_CHECK"
  | "AUTO_CHECKS_NOT_PASSED"
  | "REVIEW_DOC_NOT_FOUND"
  | "REVIEW_DOC_INVALID"
  // --- update_ledger（§2.2.11）---
  | "GATE_PROTECTED"
  | "GATE_CHANGE_NOT_ALLOWED"
  | "GATE_COMMAND_DENIED"
  | "INVALID_PHASES"
  | "DUPLICATE_STEP_ID"
  // --- ゲートの記録（承認済み成果物の修正は修正フェーズ + 再レビューで行う。§13.5.6）---
  | "GATE_ALREADY_PASSED";

export class WorkspaceError extends Error {
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
    /** `VALIDATION_FAILED` のとき、承認時の検証結果 */
    readonly issues?: ValidationIssue[],
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}
