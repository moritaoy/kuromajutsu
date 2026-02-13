// ============================================================
// MCP ツール: list_roles — 利用可能な職種一覧を返す
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../types/index.js";

export function registerListRoles(server: McpServer, config: AppConfig): void {
  server.tool(
    "list_roles",
    "設定されている全職種の一覧と、それぞれの利用可否ステータスを返す",
    {},
    async () => {
      // TODO: ヘルスチェック結果と統合（Step 3 で実装予定）
      const roles = config.roles.map((role) => ({
        id: role.id,
        name: role.name,
        model: role.model,
        available: true,
        healthCheck: { status: "passed" as const },
        modelValidation: { status: "valid" as const },
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ roles }),
          },
        ],
      };
    },
  );
}
