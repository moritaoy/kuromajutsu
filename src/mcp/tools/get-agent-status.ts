// ============================================================
// MCP ツール: get_agent_status — Agent の詳細状況を取得する
// ============================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../types/index.js";

export function registerGetAgentStatus(server: McpServer, _config: AppConfig): void {
  server.tool(
    "get_agent_status",
    "指定した ID の Agent のリアルタイム詳細情報を返す",
    {
      agentId: z.string().describe("Agent ID"),
    },
    async ({ agentId }) => {
      // TODO: 実装（Step 3 で実装予定）
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: `Agent ${agentId} が見つかりません` }),
          },
        ],
        isError: true,
      };
    },
  );
}
