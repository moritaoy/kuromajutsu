// ============================================================
// MCP ツール: wait_agent — Agent の完了を待機する
// ============================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../types/index.js";
import type { AgentManager } from "../../agent/manager.js";
import { errorResponse } from "./error-response.js";

/** wait_agent ツールのハンドラ（テスト用にエクスポート） */
export async function handleWaitAgent(
  manager: AgentManager,
  args: { agentIds: string[]; timeout_ms?: number; mode?: "all" | "any" },
) {
  if (args.agentIds.length === 0) {
    return errorResponse("EMPTY_AGENT_IDS", "agentIds 配列が空です。1 件以上指定してください");
  }

  // 各 agentId の存在チェック
  for (const id of args.agentIds) {
    const agent = manager.getAgent(id);
    if (!agent) {
      return errorResponse("AGENT_NOT_FOUND", `Agent '${id}' が見つかりません`);
    }
  }

  const result = await manager.waitForAgents(
    args.agentIds,
    args.mode ?? "all",
    args.timeout_ms,
  );

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          completed: result.completed.map((a) => ({
            agentId: a.agentId,
            status: a.status,
            duration_ms: a.elapsed_ms,
          })),
          pending: result.pending.map((a) => ({
            agentId: a.agentId,
            status: a.status,
          })),
          timedOut: result.timedOut,
        }),
      },
    ],
  };
}

export function registerWaitAgent(
  server: McpServer,
  _config: AppConfig,
  manager: AgentManager,
): void {
  server.tool(
    "wait_agent",
    "指定した Agent（複数可）が完了するまでブロックする",
    {
      agentIds: z.array(z.string()).describe("待機対象の Agent ID の配列"),
      timeout_ms: z
        .number()
        .optional()
        .describe("全体のタイムアウト（ミリ秒）"),
      mode: z
        .enum(["all", "any"])
        .optional()
        .describe("all（全て完了で返却）または any（いずれか完了で返却）"),
    },
    async (args) => handleWaitAgent(manager, args),
  );
}
