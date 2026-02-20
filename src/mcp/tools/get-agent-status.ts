// ============================================================
// MCP ツール: get_agent_status — Agent の詳細状況を取得する
// ============================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../types/index.js";
import type { AgentManager } from "../../agent/manager.js";
import { errorResponse } from "./error-response.js";

/** get_agent_status ツールのハンドラ（テスト用にエクスポート） */
export function handleGetAgentStatus(
  manager: AgentManager,
  args: { agentId: string },
) {
  const agent = manager.getAgent(args.agentId);
  if (!agent) {
    return errorResponse("AGENT_NOT_FOUND", `Agent '${args.agentId}' が見つかりません`);
  }

  // running 中は elapsed_ms を再計算
  const elapsed_ms =
    agent.status === "running"
      ? Date.now() - new Date(agent.startedAt).getTime()
      : agent.elapsed_ms;

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          agentId: agent.agentId,
          groupId: agent.groupId,
          role: agent.role,
          model: agent.model,
          status: agent.status,
          startedAt: agent.startedAt,
          elapsed_ms,
          toolCallCount: agent.toolCallCount,
          result: agent.result,
        }),
      },
    ],
  };
}

export function registerGetAgentStatus(
  server: McpServer,
  _config: AppConfig,
  manager: AgentManager,
): void {
  server.tool(
    "get_agent_status",
    "指定した ID の Agent のリアルタイム詳細情報を返す",
    {
      agentId: z.string().describe("Agent ID"),
    },
    async (args) => handleGetAgentStatus(manager, args),
  );
}
