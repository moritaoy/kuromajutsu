// ============================================================
// MCP ツール: create_group — グループを作成する
// ============================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../types/index.js";
import type { AgentManager } from "../../agent/manager.js";

/** create_group ツールのハンドラ（テスト用にエクスポート） */
export function handleCreateGroup(
  manager: AgentManager,
  args: { description: string },
) {
  const group = manager.createGroup(args.description);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          groupId: group.id,
          description: group.description,
          createdAt: group.createdAt,
          status: group.status,
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
    },
    async (args) => handleCreateGroup(manager, args),
  );
}
