// ============================================================
// MCP ツール: report_result — Agent の実行結果を登録する
// ============================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../types/index.js";
import type { AgentManager } from "../../agent/manager.js";
import { errorResponse } from "./error-response.js";

/** report_result ツールのハンドラ（テスト用にエクスポート） */
export function handleReportResult(
  manager: AgentManager,
  args: {
    agentId: string;
    status: "success" | "failure" | "timeout" | "cancelled";
    summary: string;
    response: string;
    editedFiles?: string[];
    createdFiles?: string[];
    errorMessage?: string;
  },
) {
  const { agentId, status, summary, response, editedFiles, createdFiles, errorMessage } =
    args;

  // Agent の存在チェック
  const agent = manager.getAgent(agentId);
  if (!agent) {
    return errorResponse("AGENT_NOT_FOUND", `Agent '${agentId}' が見つかりません`);
  }

  try {
    manager.reportResult(agentId, {
      status,
      summary,
      response,
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
    return errorResponse("REPORT_FAILED", (err as Error).message);
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
      summary: z.string().describe("実行結果の要約（1-2文で簡潔に）"),
      response: z
        .string()
        .describe(
          "実行結果の構造化レポート。実施内容・成果・判断理由・注意点・申し送り事項を整理して記載",
        ),
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
