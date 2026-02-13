// ============================================================
// MCP ツール: list_agents — 実行中の Agent 一覧を取得する
// ============================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../types/index.js";
import type { AgentManager } from "../../agent/manager.js";

/** list_agents ツールのハンドラ（テスト用にエクスポート） */
export function handleListAgents(
  manager: AgentManager,
  args: { groupId?: string; status?: string },
) {
  const filter: { groupId?: string; status?: string } = {};
  if (args.groupId) filter.groupId = args.groupId;
  if (args.status && args.status !== "all") filter.status = args.status;

  const agents = manager.listAgents(
    Object.keys(filter).length > 0 ? filter : undefined,
  );

  const agentList = agents.map((a) => ({
    agentId: a.agentId,
    groupId: a.groupId,
    role: a.role,
    model: a.model,
    status: a.status,
    startedAt: a.startedAt,
    elapsed_ms:
      a.status === "running"
        ? Date.now() - new Date(a.startedAt).getTime()
        : a.elapsed_ms,
    toolCallCount: a.toolCallCount,
  }));

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ agents: agentList, total: agentList.length }),
      },
    ],
  };
}

export function registerListAgents(
  server: McpServer,
  _config: AppConfig,
  manager: AgentManager,
): void {
  server.tool(
    "list_agents",
    "現在管理しているすべての Agent の一覧を返す",
    {
      groupId: z
        .string()
        .optional()
        .describe("フィルタ: 指定したグループに所属する Agent のみ取得"),
      status: z
        .enum(["running", "completed", "failed", "all"])
        .optional()
        .describe("フィルタ: ステータス（デフォルト: all）"),
    },
    async (args) => handleListAgents(manager, args),
  );
}
