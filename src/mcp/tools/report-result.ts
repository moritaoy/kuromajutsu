// ============================================================
// MCP ツール: report_result — Agent の実行結果を登録する
// ============================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../types/index.js";
import type { AgentManager } from "../../agent/manager.js";

/** report_result ツールのハンドラ（テスト用にエクスポート） */
export function handleReportResult(
  manager: AgentManager,
  args: {
    agentId: string;
    status: "success" | "failure" | "timeout" | "cancelled";
    summary: string;
    editedFiles?: string[];
    createdFiles?: string[];
    errorMessage?: string;
  },
) {
  const { agentId, status, summary, editedFiles, createdFiles, errorMessage } =
    args;

  // Agent の存在チェック
  const agent = manager.getAgent(agentId);
  if (!agent) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: true,
            code: "AGENT_NOT_FOUND",
            message: `Agent '${agentId}' が見つかりません`,
          }),
        },
      ],
      isError: true as const,
    };
  }

  try {
    manager.reportResult(agentId, {
      status,
      summary,
      editedFiles,
      createdFiles,
      errorMessage,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ registered: true, agentId }),
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: true,
            code: "REPORT_FAILED",
            message: (err as Error).message,
          }),
        },
      ],
      isError: true as const,
    };
  }
}

export function registerReportResult(
  server: McpServer,
  _config: AppConfig,
  manager: AgentManager,
): void {
  server.tool(
    "report_result",
    "Agent の実行完了後に結果データを登録する",
    {
      agentId: z.string().describe("Agent ID"),
      status: z
        .enum(["success", "failure", "timeout", "cancelled"])
        .describe("実行ステータス"),
      summary: z.string().describe("端的なテキストサマリ"),
      editedFiles: z
        .array(z.string())
        .optional()
        .describe("編集したファイルパス一覧"),
      createdFiles: z
        .array(z.string())
        .optional()
        .describe("新規作成したファイルパス一覧"),
      errorMessage: z
        .string()
        .optional()
        .describe("失敗時のエラーメッセージ"),
    },
    async (args) => handleReportResult(manager, args),
  );
}
