// ============================================================
// MCP ツール: delete_group — グループを削除する
// ============================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../types/index.js";
import type { AgentManager } from "../../agent/manager.js";

/** エラーレスポンスヘルパー */
function errorResponse(code: string, message: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: true, code, message }),
      },
    ],
    isError: true as const,
  };
}

/** delete_group ツールのハンドラ（テスト用にエクスポート） */
export function handleDeleteGroup(
  manager: AgentManager,
  args: { groupId: string },
) {
  const { groupId } = args;

  // グループの存在チェック
  const group = manager.getGroup(groupId);
  if (!group) {
    return errorResponse("GROUP_NOT_FOUND", `グループ '${groupId}' が見つかりません`);
  }

  // 実行中の Agent がないことを確認
  const agents = manager.getAgentsByGroup(groupId);
  const runningAgents = agents.filter(
    (a) => a.status === "queued" || a.status === "running",
  );
  if (runningAgents.length > 0) {
    return errorResponse(
      "GROUP_HAS_RUNNING_AGENTS",
      `グループ '${groupId}' に実行中の Agent が ${runningAgents.length} 件あります`,
    );
  }

  try {
    manager.deleteGroup(groupId);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ deleted: true, groupId }),
        },
      ],
    };
  } catch (err) {
    return errorResponse("GROUP_NOT_FOUND", (err as Error).message);
  }
}

export function registerDeleteGroup(
  server: McpServer,
  _config: AppConfig,
  manager: AgentManager,
): void {
  server.tool(
    "delete_group",
    "指定したグループを削除する",
    {
      groupId: z.string().describe("削除対象のグループ ID"),
    },
    async (args) => handleDeleteGroup(manager, args),
  );
}
