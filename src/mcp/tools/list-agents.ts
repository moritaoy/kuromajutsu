// ============================================================
// MCP ツール: list_agents — 実行中の Agent 一覧を取得する
// ============================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../types/index.js";

export function registerListAgents(server: McpServer, _config: AppConfig): void {
  server.tool(
    "list_agents",
    "現在管理しているすべての Agent の一覧を返す",
    {
      groupId: z.string().optional().describe("フィルタ: 指定したグループに所属する Agent のみ取得"),
      status: z
        .enum(["running", "completed", "failed", "all"])
        .optional()
        .describe("フィルタ: ステータス（デフォルト: all）"),
    },
    async () => {
      // TODO: 実装（Step 3 で実装予定）
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ agents: [], total: 0 }),
          },
        ],
      };
    },
  );
}
