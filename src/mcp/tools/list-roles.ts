// ============================================================
// MCP ツール: list_roles — 利用可能な職種一覧を返す
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../types/index.js";

/** list_roles ツールのハンドラ（テスト用にエクスポート） */
export function handleListRoles(config: AppConfig) {
  const roles = config.roles.map((role) => ({
    id: role.id,
    name: role.name,
    description: role.description,
    model: role.model,
  }));

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ roles }),
      },
    ],
  };
}

export function registerListRoles(
  server: McpServer,
  config: AppConfig,
): void {
  server.tool(
    "list_roles",
    "設定されている全職種の一覧を返す",
    {},
    async () => handleListRoles(config),
  );
}
