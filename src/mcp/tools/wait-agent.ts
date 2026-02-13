// ============================================================
// MCP ツール: wait_agent — Agent の完了を待機する
// ============================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../types/index.js";

export function registerWaitAgent(server: McpServer, _config: AppConfig): void {
  server.tool(
    "wait_agent",
    "指定した Agent（複数可）が完了するまでブロックする",
    {
      agentIds: z.array(z.string()).describe("待機対象の Agent ID の配列"),
      timeout_ms: z.number().optional().describe("全体のタイムアウト（ミリ秒）"),
      mode: z
        .enum(["all", "any"])
        .optional()
        .describe("all（全て完了で返却）または any（いずれか完了で返却）"),
    },
    async () => {
      // TODO: 実装（Step 3 で実装予定）
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              completed: [],
              pending: [],
              timedOut: false,
            }),
          },
        ],
      };
    },
  );
}
