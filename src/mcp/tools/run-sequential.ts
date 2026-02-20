// ============================================================
// MCP ツール: run_sequential — ステージ制 Sequential 実行計画を投入する
// ============================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../types/index.js";
import type { AgentManager } from "../../agent/manager.js";
import { errorResponse } from "./error-response.js";

/** run_sequential ツールのハンドラ（テスト用にエクスポート） */
export function handleRunSequential(
  config: AppConfig,
  manager: AgentManager,
  args: {
    groupId: string;
    stages: Array<{
      tasks: Array<{
        role: string;
        prompt: string;
        workingDirectory?: string;
        timeout_ms?: number;
      }>;
    }>;
  },
) {
  const { groupId, stages } = args;

  if (stages.length === 0) {
    return errorResponse("EMPTY_STAGES", "stages 配列が空です。1 ステージ以上指定してください");
  }

  for (let i = 0; i < stages.length; i++) {
    if (stages[i].tasks.length === 0) {
      return errorResponse("EMPTY_STAGE_TASKS", `ステージ ${i} の tasks が空です`);
    }
  }

  const group = manager.getGroup(groupId);
  if (!group) {
    return errorResponse("GROUP_NOT_FOUND", `グループ '${groupId}' が見つかりません`);
  }
  if (group.status !== "active") {
    return errorResponse("GROUP_NOT_ACTIVE", `グループ '${groupId}' はアクティブではありません`);
  }
  if (group.mode !== "sequential") {
    return errorResponse(
      "MODE_MISMATCH",
      `グループ '${groupId}' のモードは '${group.mode}' です。run_sequential は sequential グループでのみ使用できます`,
    );
  }

  // 全ステージの全タスクの role を事前検証
  for (const stage of stages) {
    for (const task of stage.tasks) {
      const roleDef = config.roles.find((r) => r.id === task.role);
      if (!roleDef) {
        return errorResponse("ROLE_NOT_FOUND", `職種 '${task.role}' が見つかりません`);
      }
      const healthResult = manager.getHealthCheckResult(task.role);
      if (healthResult && !healthResult.available) {
        return errorResponse("ROLE_UNAVAILABLE", `職種 '${task.role}' はヘルスチェック未通過のため利用できません`);
      }
    }
  }

  // maxConcurrent チェック: 最大ステージの並列数
  const maxStageTasks = Math.max(...stages.map((s) => s.tasks.length));
  const running = manager.getRunningCount();
  if (running + maxStageTasks > config.agent.maxConcurrent) {
    return errorResponse(
      "MAX_CONCURRENT_REACHED",
      `最大ステージのタスク数 (${maxStageTasks}) が同時実行上限 (${config.agent.maxConcurrent}) の残枠 (${config.agent.maxConcurrent - running}) を超えます`,
    );
  }

  try {
    const { plan, agents } = manager.submitSequential(groupId, stages);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            groupId,
            totalStages: plan.stages.length,
            currentStageIndex: plan.currentStageIndex,
            stages: plan.stages.map((s) => ({
              stageIndex: s.stageIndex,
              agentIds: s.agentIds,
            })),
            agents: agents.map((a) => ({
              agentId: a.agentId,
              groupId: a.groupId,
              role: a.role,
              model: a.model,
              status: a.status,
              stageIndex: a.stageIndex,
            })),
            total: agents.length,
          }),
        },
      ],
    };
  } catch (err) {
    return errorResponse("SEQUENTIAL_START_FAILED", (err as Error).message);
  }
}

const taskSchema = z.object({
  role: z.string().describe("職種 ID（例: impl-code）"),
  prompt: z.string().describe("Agent に渡すユーザープロンプト"),
  workingDirectory: z.string().optional().describe("作業ディレクトリ"),
  timeout_ms: z.number().optional().describe("タイムアウト（ミリ秒）"),
});

const stageSchema = z.object({
  tasks: z.array(taskSchema).min(1).describe("ステージ内で並列実行するタスクの配列"),
});

export function registerRunSequential(
  server: McpServer,
  config: AppConfig,
  manager: AgentManager,
): void {
  server.tool(
    "run_sequential",
    "ステージ制の Sequential 実行計画を投入する。各ステージ内は並列実行、ステージ間は直列。前ステージの結果は次ステージのプロンプトに自動注入される",
    {
      groupId: z.string().describe("所属するグループ ID（mode: sequential で作成済み）"),
      stages: z.array(stageSchema).min(1).describe("実行ステージの配列（先頭から順に実行）"),
    },
    async (args) => handleRunSequential(config, manager, args),
  );
}
