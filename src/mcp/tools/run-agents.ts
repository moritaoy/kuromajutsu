// ============================================================
// MCP ツール: run_agents — 複数の Agent を一括起動する
// ============================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../types/index.js";
import type { AgentManager } from "../../agent/manager.js";
import { errorResponse } from "./error-response.js";

/** run_agents ツールのハンドラ（テスト用にエクスポート） */
export function handleRunAgents(
  config: AppConfig,
  manager: AgentManager,
  args: {
    groupId: string;
    agents: Array<{
      role: string;
      prompt: string;
      workingDirectory?: string;
      timeout_ms?: number;
    }>;
  },
) {
  const { groupId, agents: taskDefs } = args;

  if (taskDefs.length === 0) {
    return errorResponse("EMPTY_AGENTS", "agents 配列が空です。1 台以上指定してください");
  }

  const group = manager.getGroup(groupId);
  if (!group) {
    return errorResponse("GROUP_NOT_FOUND", `グループ '${groupId}' が見つかりません`);
  }
  if (group.status !== "active") {
    return errorResponse("GROUP_NOT_ACTIVE", `グループ '${groupId}' はアクティブではありません`);
  }
  if (group.mode !== "concurrent") {
    return errorResponse(
      "MODE_MISMATCH",
      `グループ '${groupId}' のモードは '${group.mode}' です。run_agents は concurrent グループでのみ使用できます`,
    );
  }

  // 全タスクの role を事前検証
  for (const task of taskDefs) {
    const roleDef = config.roles.find((r) => r.id === task.role);
    if (!roleDef) {
      return errorResponse("ROLE_NOT_FOUND", `職種 '${task.role}' が見つかりません`);
    }
    const healthResult = manager.getHealthCheckResult(task.role);
    if (healthResult && !healthResult.available) {
      return errorResponse("ROLE_UNAVAILABLE", `職種 '${task.role}' はヘルスチェック未通過のため利用できません`);
    }
  }

  const running = manager.getRunningCount();
  if (running + taskDefs.length > config.agent.maxConcurrent) {
    return errorResponse(
      "MAX_CONCURRENT_REACHED",
      `同時実行上限 (${config.agent.maxConcurrent}) を超えます。現在 ${running} 実行中、${taskDefs.length} 台を要求`,
    );
  }

  try {
    const agents = manager.startAgents(groupId, taskDefs);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            agents: agents.map((a) => ({
              agentId: a.agentId,
              groupId: a.groupId,
              role: a.role,
              model: a.model,
              status: a.status,
            })),
            total: agents.length,
          }),
        },
      ],
    };
  } catch (err) {
    return errorResponse("AGENTS_START_FAILED", (err as Error).message);
  }
}

const agentSchema = z.object({
  role: z.string().describe("職種 ID（例: impl-code）"),
  prompt: z.string().describe("Agent に渡すユーザープロンプト"),
  workingDirectory: z.string().optional().describe("作業ディレクトリ"),
  timeout_ms: z.number().optional().describe("タイムアウト（ミリ秒）"),
});

export function registerRunAgents(
  server: McpServer,
  config: AppConfig,
  manager: AgentManager,
): void {
  server.tool(
    "run_agents",
    "指定した職種とプロンプトで 1 台以上の Agent を一括起動する（Concurrent グループ用）",
    {
      groupId: z.string().describe("所属するグループ ID"),
      agents: z.array(agentSchema).min(1).describe("起動する Agent の定義配列"),
    },
    async (args) => handleRunAgents(config, manager, args),
  );
}
