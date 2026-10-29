// ============================================================
// MCP ツール: request_human_review — 人間レビューを依頼する（§2.2.14）
// ============================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../types/index.js";
import type { AgentManager } from "../../agent/manager.js";
import type { WorkspaceService } from "../../workspace/service.js";
import { checkWorkspaceGroup, jsonResponse, workspaceErrorResponse } from "./workspace-tool-support.js";

/** request_human_review ツールのハンドラ（テスト用にエクスポート） */
export function handleRequestHumanReview(
  manager: AgentManager,
  args: { groupId: string; gateId: string; reviewDocPath: string },
  workspaceService?: WorkspaceService,
) {
  const problem = checkWorkspaceGroup(manager, args.groupId, workspaceService);
  if (problem) return problem;

  try {
    return jsonResponse(
      workspaceService!.requestHumanReview(args.groupId, args.gateId, args.reviewDocPath),
    );
  } catch (e) {
    return workspaceErrorResponse(e);
  }
}

export function registerRequestHumanReview(
  server: McpServer,
  _config: AppConfig,
  manager: AgentManager,
  workspaceService?: WorkspaceService,
): void {
  server.tool(
    "request_human_review",
    "Workspace のゲートの人間レビューを依頼する。ゲートの自動チェックがすべて合格した後、レビュー資料（ReviewDoc）を添えて呼ぶ。呼んだ後、Orchestrator は自身の実行を終了する（report_result の status は success、summary に「人間レビュー待ちで一時停止」）。人の判断後、サーバーが新しい Orchestrator を起動して再開する。Workspace の Orchestrator 専用。",
    {
      groupId: z.string().describe("Workspace に紐付く Magentic グループ ID"),
      gateId: z.string().describe("人間レビューのゲート ID（human チェックを持つゲート）"),
      reviewDocPath: z
        .string()
        .describe(
          "ReviewDoc JSON の場所。agent:<agentId>（text-writer の report_result の response に入った ReviewDoc JSON を読む。標準）または作業ディレクトリ内の JSON ファイルのパス",
        ),
    },
    async (args) => handleRequestHumanReview(manager, args, workspaceService),
  );
}
