// ============================================================
// MCP ツール: create_group — グループを作成する
// ============================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../types/index.js";

export function registerCreateGroup(server: McpServer, _config: AppConfig): void {
  server.tool(
    "create_group",
    "関連する Agent 群をまとめるグループを作成し、一意の ID を発番して返す",
    {
      description: z.string().describe("グループの目的の簡潔な説明"),
    },
    async ({ description }) => {
      // TODO: 実装（Step 3 で実装予定）
      const groupId = `grp-${Math.floor(Date.now() / 1000)}-${Math.random().toString(16).slice(2, 6)}`;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              groupId,
              description,
              createdAt: new Date().toISOString(),
              status: "active",
            }),
          },
        ],
      };
    },
  );
}
