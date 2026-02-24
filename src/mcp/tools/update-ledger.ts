// ============================================================
// MCP ツール: update_ledger
// ============================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../types/index.js";
import type { AgentManager } from "../../agent/manager.js";
import { errorResponse } from "./error-response.js";

const factsSchema = z.object({
  given: z.array(z.string()),
  toInvestigate: z.array(z.string()),
  toDerive: z.array(z.string()),
  assumptions: z.array(z.string()),
});

const boolJudgmentSchema = z.object({
  reason: z.string(),
  answer: z.boolean(),
});

const stringJudgmentSchema = z.object({
  reason: z.string(),
  answer: z.string(),
});

type UpdateLedgerArgs = {
  groupId: string;
  type: "task" | "progress";
  facts?: { given: string[]; toInvestigate: string[]; toDerive: string[]; assumptions: string[] };
  plan?: string[];
  isRequestSatisfied?: { reason: string; answer: boolean };
  isInLoop?: { reason: string; answer: boolean };
  isProgressBeingMade?: { reason: string; answer: boolean };
  nextAction?: { reason: string; answer: string };
  instruction?: { reason: string; answer: string };
  iteration?: number;
};

export function handleUpdateLedger(
  manager: AgentManager,
  args: UpdateLedgerArgs,
) {
  const group = manager.getGroup(args.groupId);
  if (!group) {
    return errorResponse(
      "GROUP_NOT_FOUND",
      `グループが見つかりません: ${args.groupId}`,
    );
  }

  if (group.mode !== "magentic") {
    return errorResponse(
      "NOT_MAGENTIC_GROUP",
      `グループ ${args.groupId} は magentic モードではありません。update_ledger は magentic グループでのみ使用できます。`,
    );
  }

  if (args.type === "task") {
    manager.updateTaskLedger(args.groupId, {
      facts: args.facts!,
      plan: args.plan!,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            groupId: args.groupId,
            type: "task",
            status: "updated",
          }),
        },
      ],
    };
  }

  manager.updateProgressLedger(args.groupId, {
    isRequestSatisfied: args.isRequestSatisfied!,
    isInLoop: args.isInLoop!,
    isProgressBeingMade: args.isProgressBeingMade!,
    nextAction: args.nextAction!,
    instruction: args.instruction!,
    iteration: args.iteration!,
  });

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          groupId: args.groupId,
          type: "progress",
          status: "updated",
        }),
      },
    ],
  };
}

export function registerUpdateLedger(
  server: McpServer,
  _config: AppConfig,
  manager: AgentManager,
): void {
  server.tool(
    "update_ledger",
    "Magentic モードの台帳（Ledger）を更新する。Orchestrator Agent が自身の計画・進捗判定を記録するために使用する。",
    {
      groupId: z.string().describe("対象の Magentic グループ ID"),
      type: z.enum(["task", "progress"]).describe("台帳の種別: task（タスク台帳）または progress（進捗台帳）"),
      facts: factsSchema.optional().describe("タスク台帳: 事実の分類（type=task 時に必須）"),
      plan: z.array(z.string()).optional().describe("タスク台帳: 実行計画ステップ（type=task 時に必須）"),
      isRequestSatisfied: boolJudgmentSchema.optional().describe("進捗台帳: リクエストが満たされたか（type=progress 時に必須）"),
      isInLoop: boolJudgmentSchema.optional().describe("進捗台帳: ループに陥っていないか（type=progress 時に必須）"),
      isProgressBeingMade: boolJudgmentSchema.optional().describe("進捗台帳: 進捗が出ているか（type=progress 時に必須）"),
      nextAction: stringJudgmentSchema.optional().describe("進捗台帳: 次のアクション（type=progress 時に必須）"),
      instruction: stringJudgmentSchema.optional().describe("進捗台帳: サブ Agent への指示（type=progress 時に必須）"),
      iteration: z.number().optional().describe("進捗台帳: 現在の反復番号（type=progress 時に必須）"),
    },
    async (args) => handleUpdateLedger(manager, args),
  );
}
