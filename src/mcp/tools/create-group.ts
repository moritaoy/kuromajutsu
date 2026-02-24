// ============================================================
// MCP ツール: create_group — グループを作成する
// ============================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, GroupMode } from "../../types/index.js";
import type { AgentManager } from "../../agent/manager.js";

/** create_group ツールのハンドラ（テスト用にエクスポート） */
export function handleCreateGroup(
  manager: AgentManager,
  args: { description: string; mode?: GroupMode; parentGroupId?: string },
) {
  const mode = args.mode ?? "concurrent";
  const group = manager.createGroup(args.description, mode, args.parentGroupId);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          groupId: group.id,
          description: group.description,
          mode: group.mode,
          createdAt: group.createdAt,
          status: group.status,
          parentGroupId: group.parentGroupId,
        }),
      },
    ],
  };
}

export function registerCreateGroup(
  server: McpServer,
  _config: AppConfig,
  manager: AgentManager,
): void {
  server.tool(
    "create_group",
    "関連する Agent 群をまとめるグループを作成し、一意の ID を発番して返す",
    {
      description: z.string().describe("グループの目的の簡潔な説明"),
      mode: z.enum(["concurrent", "sequential", "magentic"]).optional()
        .describe("実行モード: concurrent（並列、デフォルト）、sequential（ステージ制直列）、magentic（Orchestrator 自律管理）"),
      parentGroupId: z.string().optional()
        .describe("親グループ ID（Magentic モードの子グループ作成時に指定）"),
    },
    async (args) => handleCreateGroup(manager, args),
  );
}
