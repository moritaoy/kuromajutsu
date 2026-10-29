// ============================================================
// MCP ツール: run_gate_check — ゲートの command チェックをサーバーが実行する（§2.2.12）
// ============================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../types/index.js";
import type { AgentManager } from "../../agent/manager.js";
import type { WorkspaceService } from "../../workspace/service.js";
import { checkWorkspaceGroup, jsonResponse, workspaceErrorResponse } from "./workspace-tool-support.js";

/** run_gate_check ツールのハンドラ（テスト用にエクスポート） */
export async function handleRunGateCheck(
  manager: AgentManager,
  args: { groupId: string; gateId: string },
  workspaceService?: WorkspaceService,
) {
  const problem = checkWorkspaceGroup(manager, args.groupId, workspaceService);
  if (problem) return problem;

  try {
    return jsonResponse(await workspaceService!.runGateCheck(args.groupId, args.gateId));
  } catch (e) {
    return workspaceErrorResponse(e);
  }
}

export function registerRunGateCheck(
  server: McpServer,
  _config: AppConfig,
  manager: AgentManager,
  workspaceService?: WorkspaceService,
): void {
  server.tool(
    "run_gate_check",
    "Workspace のゲートが持つ command チェックをサーバーが実行し、結果（合否・exit code・stdout/stderr の末尾）を返す。Workspace の Orchestrator 専用。Orchestrator やサブ Agent はコマンドを実行しない。retryLimitExceeded が true の場合は、作業を打ち切り report_result（status: success、summary: 「差し戻し上限超過で一時停止」）で終了すること。",
    {
      groupId: z.string().describe("Workspace に紐付く Magentic グループ ID"),
      gateId: z.string().describe("対象のゲート ID（kind: \"gate\" の Step の stepId）"),
    },
    async (args) => handleRunGateCheck(manager, args, workspaceService),
  );
}
