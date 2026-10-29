// ============================================================
// MCP ツール: report_gate_result — ゲートの agent-review チェックの結果を記録する（§2.2.13）
// ============================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../types/index.js";
import type { AgentManager } from "../../agent/manager.js";
import type { WorkspaceService } from "../../workspace/service.js";
import { checkWorkspaceGroup, jsonResponse, workspaceErrorResponse } from "./workspace-tool-support.js";

/** report_gate_result ツールのハンドラ（テスト用にエクスポート） */
export function handleReportGateResult(
  manager: AgentManager,
  args: { groupId: string; gateId: string; checkIndex: number; passed: boolean; note?: string },
  workspaceService?: WorkspaceService,
) {
  const problem = checkWorkspaceGroup(manager, args.groupId, workspaceService);
  if (problem) return problem;

  try {
    return jsonResponse(
      workspaceService!.reportGateResult(args.groupId, args.gateId, args.checkIndex, args.passed, args.note),
    );
  } catch (e) {
    return workspaceErrorResponse(e);
  }
}

export function registerReportGateResult(
  server: McpServer,
  _config: AppConfig,
  manager: AgentManager,
  workspaceService?: WorkspaceService,
): void {
  server.tool(
    "report_gate_result",
    "Workspace のゲートの agent-review チェックの結果を記録する。Orchestrator がレビュー職種のサブ Agent の報告を読んだ後に呼ぶ。Workspace の Orchestrator 専用。command チェックは run_gate_check、human チェックは人間レビューでのみ記録される。",
    {
      groupId: z.string().describe("Workspace に紐付く Magentic グループ ID"),
      gateId: z.string().describe("対象のゲート ID"),
      checkIndex: z
        .number()
        .describe("checks 配列の添字（0 始まり）。method が agent-review のチェックのみ指定できる"),
      passed: z.boolean().describe("合否"),
      note: z
        .string()
        .optional()
        .describe("レビュー職種の所見の要約（不合格時は原因の箇所を含める）"),
    },
    async (args) => handleReportGateResult(manager, args, workspaceService),
  );
}
