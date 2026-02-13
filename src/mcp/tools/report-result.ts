// ============================================================
// MCP ツール: report_result — Agent の実行結果を登録する
// ============================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../types/index.js";

export function registerReportResult(server: McpServer, _config: AppConfig): void {
  server.tool(
    "report_result",
    "Agent の実行完了後に結果データを登録する",
    {
      agentId: z.string().describe("Agent ID"),
      status: z
        .enum(["success", "failure", "timeout", "cancelled"])
        .describe("実行ステータス"),
      summary: z.string().describe("端的なテキストサマリ"),
      editedFiles: z.array(z.string()).optional().describe("編集したファイルパス一覧"),
      createdFiles: z.array(z.string()).optional().describe("新規作成したファイルパス一覧"),
      errorMessage: z.string().optional().describe("失敗時のエラーメッセージ"),
    },
    async ({ agentId }) => {
      // TODO: 実装（Step 3 で実装予定）
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ registered: true, agentId }),
          },
        ],
      };
    },
  );
}
