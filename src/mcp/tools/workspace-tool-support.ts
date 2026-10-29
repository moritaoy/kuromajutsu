// ============================================================
// Workspace 系 MCP ツールの共通処理（run_gate_check / report_gate_result / request_human_review）
// ============================================================

import type { AgentManager } from "../../agent/manager.js";
import { WorkspaceError } from "../../workspace/errors.js";
import type { WorkspaceService } from "../../workspace/service.js";
import { errorResponse } from "./error-response.js";

/** JSON をテキストとして返すツールの成功レスポンス */
export function jsonResponse(body: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }] };
}

/**
 * グループの存在と Workspace への紐付けを確認する。問題があればエラーレスポンスを返す。
 * （Workspace が running かどうかは service が確認する）
 */
export function checkWorkspaceGroup(
  manager: AgentManager,
  groupId: string,
  workspaceService: WorkspaceService | undefined,
): ReturnType<typeof errorResponse> | undefined {
  if (!manager.getGroup(groupId)) {
    return errorResponse("GROUP_NOT_FOUND", `グループが見つかりません: ${groupId}`);
  }
  if (!workspaceService?.findByGroupId(groupId)) {
    return errorResponse(
      "NOT_WORKSPACE_GROUP",
      `グループ ${groupId} は Workspace に紐付いていません。このツールは Workspace の Orchestrator 専用です`,
    );
  }
  return undefined;
}

/** WorkspaceError はエラーコード付きのレスポンスに、それ以外は INTERNAL_ERROR にする */
export function workspaceErrorResponse(e: unknown) {
  if (e instanceof WorkspaceError) return errorResponse(e.code, e.message);
  return errorResponse("INTERNAL_ERROR", e instanceof Error ? e.message : String(e));
}
