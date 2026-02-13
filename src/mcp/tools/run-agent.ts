// ============================================================
// MCP ツール: run_agent — Agent を実行する
// ============================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../types/index.js";

export function registerRunAgent(server: McpServer, _config: AppConfig): void {
  server.tool(
    "run_agent",
    "指定した職種とプロンプトで新しい Agent を起動する",
    {
      groupId: z.string().describe("所属するグループ ID"),
      role: z.string().describe("職種 ID（例: impl-code）"),
      prompt: z.string().describe("Agent に渡すユーザープロンプト"),
      workingDirectory: z.string().optional().describe("作業ディレクトリ"),
      timeout_ms: z.number().optional().describe("タイムアウト（ミリ秒）"),
    },
    async ({ groupId, role, prompt: _prompt }) => {
      // TODO: 実装（Step 3 で実装予定）
      const agentId = `${role}-${Math.floor(Date.now() / 1000)}-${Math.random().toString(16).slice(2, 6)}`;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              agentId,
              groupId,
              role,
              model: "claude-4-sonnet",
              status: "queued",
            }),
          },
        ],
      };
    },
  );
}
