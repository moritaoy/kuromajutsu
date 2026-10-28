// ============================================================
// MCP ツール: update_ledger
// ============================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, ScheduledStep } from "../../types/index.js";
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

const scheduledStepSchema = z.object({
  stepId: z.string().describe("ステップ ID"),
  role: z.string().describe("使用する職種 ID"),
  description: z.string().describe("タスクの説明"),
  status: z.enum(["pending", "in_progress", "completed", "skipped"]).describe("ステータス"),
  dependsOn: z.array(z.string()).optional().describe("依存する stepId の配列"),
});

type UpdateLedgerArgs = {
  groupId: string;
  type: "task" | "progress";
  facts?: { given: string[]; toInvestigate: string[]; toDerive: string[]; assumptions: string[] };
  plan?: string[];
  scheduledSteps?: ScheduledStep[];
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
      ...(args.scheduledSteps != null && { scheduledSteps: args.scheduledSteps }),
    });

    const response: Record<string, unknown> = {
      groupId: args.groupId,
      type: "task",
      status: "updated",
    };

    if (args.scheduledSteps) {
      response.nextRunnableSteps = computeNextRunnableSteps(args.scheduledSteps);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(response),
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

  // scheduledSteps が同時に指定された場合、タスク台帳の scheduledSteps も更新する
  if (args.scheduledSteps != null) {
    const existingLedger = manager.getLedger(args.groupId);
    const existingTask = existingLedger?.taskLedger;
    manager.updateTaskLedger(args.groupId, {
      facts: existingTask?.facts ?? { given: [], toInvestigate: [], toDerive: [], assumptions: [] },
      plan: existingTask?.plan ?? [],
      scheduledSteps: args.scheduledSteps,
    });
  }

  const response: Record<string, unknown> = {
    groupId: args.groupId,
    type: "progress",
    status: "updated",
  };

  if (args.scheduledSteps) {
    response.nextRunnableSteps = computeNextRunnableSteps(args.scheduledSteps);
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(response),
      },
    ],
  };
}

/**
 * scheduledSteps から次に実行可能なステップを算出する。
 * 条件: status === "pending" かつ dependsOn の全ステップが completed または skipped。
 */
export function computeNextRunnableSteps(
  steps: ScheduledStep[],
): Array<{ stepId: string; role: string; description: string }> {
  const statusMap = new Map(steps.map((s) => [s.stepId, s.status]));

  return steps
    .filter((step) => {
      if (step.status !== "pending") return false;
      if (!step.dependsOn || step.dependsOn.length === 0) return true;
      return step.dependsOn.every((depId) => {
        const depStatus = statusMap.get(depId);
        return depStatus === "completed" || depStatus === "skipped";
      });
    })
    .map(({ stepId, role, description }) => ({ stepId, role, description }));
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
      scheduledSteps: z.array(scheduledStepSchema).optional().describe("構造化された作業予定。各ステップに role, description, status, dependsOn を指定。type=task / type=progress どちらでも指定可能。progress 時に指定するとタスク台帳の scheduledSteps も同時更新される"),
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
