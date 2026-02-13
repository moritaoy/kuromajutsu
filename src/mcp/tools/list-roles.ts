// ============================================================
// MCP ツール: list_roles — 利用可能な職種一覧を返す
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../types/index.js";
import type { AgentManager } from "../../agent/manager.js";

/** list_roles ツールのハンドラ（テスト用にエクスポート） */
export function handleListRoles(config: AppConfig, manager: AgentManager) {
  const healthResults = manager.getHealthCheckResults();
  const healthMap = new Map(healthResults.map((r) => [r.roleId, r]));

  const roles = config.roles.map((role) => {
    const hc = healthMap.get(role.id);
    return {
      id: role.id,
      name: role.name,
      model: role.model,
      available: hc?.available ?? false,
      healthCheck: hc?.healthCheck ?? {
        status: "skipped" as const,
        reason: "ヘルスチェック未実行",
      },
      modelValidation: hc?.modelValidation ?? {
        status: "valid" as const,
        checkedAt: "",
      },
    };
  });

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
  manager: AgentManager,
): void {
  server.tool(
    "list_roles",
    "設定されている全職種の一覧と、それぞれの利用可否ステータスを返す",
    {},
    async () => handleListRoles(config, manager),
  );
}
