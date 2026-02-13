// ============================================================
// MCP ツール: run_agent — Agent を実行する
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

/** run_agent ツールのハンドラ（テスト用にエクスポート） */
export function handleRunAgent(
  config: AppConfig,
  manager: AgentManager,
  args: {
    groupId: string;
    role: string;
    prompt: string;
    workingDirectory?: string;
    timeout_ms?: number;
  },
) {
  const { groupId, role, prompt, workingDirectory, timeout_ms } = args;

  // 1. グループの存在チェック
  const group = manager.getGroup(groupId);
  if (!group) {
    return errorResponse("GROUP_NOT_FOUND", `グループ '${groupId}' が見つかりません`);
  }

  // 2. グループがアクティブかチェック
  if (group.status !== "active") {
    return errorResponse("GROUP_NOT_ACTIVE", `グループ '${groupId}' はアクティブではありません`);
  }

  // 3. 職種の存在チェック
  const roleDef = config.roles.find((r) => r.id === role);
  if (!roleDef) {
    return errorResponse("ROLE_NOT_FOUND", `職種 '${role}' が見つかりません`);
  }

  // 4. ヘルスチェック結果の確認
  const healthResult = manager.getHealthCheckResult(role);
  if (healthResult && !healthResult.available) {
    return errorResponse("ROLE_UNAVAILABLE", `職種 '${role}' はヘルスチェック未通過のため利用できません`);
  }

  // 5. 同時実行数チェック
  const running = manager.getRunningCount();
  if (running >= config.agent.maxConcurrent) {
    return errorResponse(
      "MAX_CONCURRENT_REACHED",
      `同時実行上限 (${config.agent.maxConcurrent}) に達しています`,
    );
  }

  // 6. Agent を起動
  try {
    const agent = manager.startAgent(groupId, roleDef, prompt, {
      workingDirectory,
      timeout_ms,
    });

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
          }),
        },
      ],
    };
  } catch (err) {
    return errorResponse("AGENT_START_FAILED", (err as Error).message);
  }
}

export function registerRunAgent(
  server: McpServer,
  config: AppConfig,
  manager: AgentManager,
): void {
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
    async (args) => handleRunAgent(config, manager, args),
  );
}
