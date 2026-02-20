// ============================================================
// MCP ツール: run_magentic — Magentic パターンでタスクを実行する
// ============================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../types/index.js";
import type { AgentManager } from "../../agent/manager.js";
import type { MagenticConfig } from "../../types/index.js";
import { errorResponse } from "./error-response.js";

/** run_magentic ツールのハンドラ（テスト用にエクスポート） */
export function handleRunMagentic(
  config: AppConfig,
  manager: AgentManager,
  args: {
    description: string;
    task: string;
    completionCriteria: string;
    scope: string;
    constraints?: string;
    context?: string;
    availableRoles?: string[];
    maxIterations?: number;
    timeout_ms?: number;
  },
) {
  const maxIterations = args.maxIterations ?? 10;

  // 1. orchestrator ロールの存在・利用可能チェック
  const orchestratorRole = config.roles.find((r) => r.id === "orchestrator");
  if (!orchestratorRole) {
    return errorResponse(
      "ORCHESTRATOR_ROLE_NOT_FOUND",
      "orchestrator ロールが設定に存在しません",
    );
  }

  const healthResult = manager.getHealthCheckResult("orchestrator");
  if (healthResult && !healthResult.available) {
    return errorResponse(
      "ORCHESTRATOR_UNAVAILABLE",
      "orchestrator ロールはヘルスチェック未通過のため利用できません",
    );
  }

  // 2. availableRoles の検証
  const availableRoles = args.availableRoles ?? config.roles
    .filter((r) => r.id !== "orchestrator")
    .map((r) => r.id);

  for (const roleId of availableRoles) {
    const roleDef = config.roles.find((r) => r.id === roleId);
    if (!roleDef) {
      return errorResponse(
        "ROLE_NOT_FOUND",
        `availableRoles で指定された職種 '${roleId}' が見つかりません`,
      );
    }
  }

  // 3. グループ作成
  const group = manager.createGroup(args.description, "magentic");

  // 4. MagenticConfig を構築して保存
  const magenticConfig: MagenticConfig = {
    task: args.task,
    completionCriteria: args.completionCriteria,
    scope: args.scope,
    constraints: args.constraints,
    context: args.context,
    availableRoles,
    maxIterations,
    currentIteration: 0,
  };
  manager.setMagenticConfig(group.id, magenticConfig);

  // 5. Magentic タスクブロックをユーザープロンプトとして構築（buildFullPrompt が正しい agentId でメタデータを付与）
  const magenticPrompt = buildMagenticTaskBlock(magenticConfig);

  // 6. Orchestrator を起動
  try {
    const agent = manager.startMagenticOrchestrator(group.id, orchestratorRole, magenticPrompt, {
      timeout_ms: args.timeout_ms,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            groupId: group.id,
            orchestratorAgentId: agent.agentId,
            status: "started",
          }),
        },
      ],
    };
  } catch (err) {
    return errorResponse(
      "MAGENTIC_START_FAILED",
      (err as Error).message,
    );
  }
}

/** Magentic タスクブロックを構築する（ユーザープロンプトとして startAgent に渡す） */
function buildMagenticTaskBlock(config: MagenticConfig): string {
  return [
    "---",
    "【Magentic タスク】",
    "",
    "## タスク",
    config.task,
    "",
    "## 完了条件",
    config.completionCriteria,
    "",
    "## 操作範囲",
    config.scope,
    "",
    ...(config.constraints ? ["## 制約", config.constraints, ""] : []),
    ...(config.context ? ["## コンテキスト", config.context, ""] : []),
    "## 使用可能な職種",
    config.availableRoles.join(", "),
    "",
    "## 最大反復回数",
    String(config.maxIterations),
    "---",
  ].join("\n");
}

export function registerRunMagentic(
  server: McpServer,
  config: AppConfig,
  manager: AgentManager,
): void {
  server.tool(
    "run_magentic",
    "Magentic パターン（Orchestrator 自律管理）でタスクを実行する。Orchestrator Agent が計画→委任→評価→リプランのループで自律的にサブ Agent を管理し、タスクを遂行する",
    {
      description: z.string().describe("グループの説明"),
      task: z.string().describe("達成すべきタスクの詳細な説明"),
      completionCriteria: z.string().describe("完了条件（どうなったらタスク完了とみなすか）"),
      scope: z.string().describe("操作範囲（変更してよいファイル・ディレクトリの範囲）"),
      constraints: z.string().optional().describe("追加制約（守るべきルールや禁止事項）"),
      context: z.string().optional().describe("補足コンテキスト（背景情報、関連仕様書パス等）"),
      availableRoles: z.array(z.string()).optional()
        .describe("使用可能な職種（未指定時は orchestrator 以外の全職種）"),
      maxIterations: z.number().optional().default(10)
        .describe("最大反復回数"),
      timeout_ms: z.number().optional().describe("全体タイムアウト（ミリ秒）"),
    },
    async (args) => handleRunMagentic(config, manager, args),
  );
}
