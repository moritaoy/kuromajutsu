// ============================================================
// MCP ツール: delete_group — グループを削除する
// ============================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../types/index.js";

export function registerDeleteGroup(server: McpServer, _config: AppConfig): void {
  server.tool(
    "delete_group",
    "指定したグループを削除する",
    {
      groupId: z.string().describe("削除対象のグループ ID"),
    },
    async ({ groupId }) => {
      // TODO: 実装（Step 3 で実装予定）
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ deleted: true, groupId }),
          },
        ],
      };
    },
  );
}
