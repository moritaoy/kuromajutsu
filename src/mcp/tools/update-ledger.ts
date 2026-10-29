// ============================================================
// MCP ツール: update_ledger
// ============================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, Phase, ScheduledStep } from "../../types/index.js";
import type { IncomingPhase } from "../../workspace/ledger-guard.js";
import type { AgentManager } from "../../agent/manager.js";
import type { WorkspaceService } from "../../workspace/service.js";
import { errorResponse } from "./error-response.js";
import { workspaceErrorResponse } from "./workspace-tool-support.js";

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

const gateCheckSchema = z.object({
  text: z.string().describe("チェック項目の説明"),
  method: z.enum(["agent-review", "command", "human"]).describe("チェックの方式"),
  command: z.string().optional().describe("method が command のとき必須: 実行するコマンド"),
});

export const scheduledStepSchema = z.object({
  stepId: z.string().describe("ステップ ID"),
  role: z.string().describe("使用する職種 ID"),
  description: z.string().describe("タスクの説明"),
  status: z.enum(["pending", "in_progress", "completed", "skipped"]).describe("ステータス"),
  dependsOn: z.array(z.string()).optional().describe("依存する stepId の配列"),
  phaseId: z.string().optional().describe("Workspace: 所属するフェーズ ID"),
  kind: z.enum(["work", "gate"]).optional().describe("Workspace: 作業（work）かゲート（gate）か。省略時は work"),
  doneCriteria: z.array(z.string()).optional().describe("Workspace: 完了定義（DoD）"),
  checks: z.array(gateCheckSchema).optional().describe("Workspace: kind が gate のときのチェック項目"),
  onFail: z
    .object({ action: z.literal("rework"), maxRetries: z.number().int().min(0) })
    .optional()
    .describe("Workspace: kind が gate のときの不合格時の方針"),
});

/**
 * フェーズ。`id` 以外は省略でき、既存のフェーズは現行値で補完される（サーバー側。zod の default には頼らない）。
 * 新規フェーズは `name` と `goal` が必須（`planning` の既定は fixed、`notes` は空）。
 */
export const phaseSchema = z.object({
  id: z.string().describe("フェーズ ID"),
  name: z.string().optional().describe("フェーズ名（新規フェーズでは必須。既存のフェーズは省略すると現行値）"),
  goal: z.string().optional().describe("フェーズの目的（新規フェーズでは必須。既存のフェーズは省略すると現行値）"),
  planning: z.enum(["fixed", "deferred"]).optional().describe("手順を計画時に確定（fixed）/ 開始直前に計画（deferred）。承認済みフェーズでは変更できない"),
  notes: z.array(z.string()).optional().describe("deferred のとき、直前計画で考慮すべき指示"),
  final: z.boolean().optional().describe("最終ゲート専用のフェーズ"),
  fix: z
    .object({ failedGateId: z.string(), causePhaseId: z.string(), triageStepId: z.string() })
    .optional()
    .describe("修正フェーズのとき: 不合格のゲート・原因のフェーズ・原因の切り分け手順"),
  parentPhaseId: z.string().optional().describe("修正フェーズのとき: 入れ子の親（不合格になったゲートのフェーズ）"),
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
  phases?: IncomingPhase[];
  irregular?: boolean;
  reason?: string;
};

export function handleUpdateLedger(
  manager: AgentManager,
  args: UpdateLedgerArgs,
  workspaceService?: WorkspaceService,
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

  // Workspace のグループなのにサービスが無い場合は、ゲートの保護ができないので拒否する（fail-closed）
  if (group.workspaceId !== undefined && workspaceService === undefined) {
    return errorResponse(
      "NOT_WORKSPACE_GROUP",
      `グループ ${args.groupId} は Workspace に紐付いていますが、Workspace サービスが利用できないため台帳を更新できません`,
    );
  }

  // Workspace グループ: scheduledSteps / phases を含む更新はゲートの不変性の規則で検証・正規化する（§13.5.5）
  let steps = args.scheduledSteps;
  let phases: Phase[] | undefined;
  if (
    group.workspaceId !== undefined &&
    workspaceService !== undefined &&
    (args.scheduledSteps != null || args.phases != null)
  ) {
    try {
      const applied = workspaceService.applyLedgerUpdate(args.groupId, {
        phases: args.phases,
        scheduledSteps: args.scheduledSteps,
        irregular: args.irregular,
        reason: args.reason,
      });
      steps = applied.scheduledSteps;
      phases = applied.phases;
    } catch (e) {
      return workspaceErrorResponse(e);
    }
  }
  // updateTaskLedger は phases を引き継がないため、台帳にあるフェーズを保つ
  const keptPhases = phases ?? manager.getLedger(args.groupId)?.taskLedger?.phases;

  if (args.type === "task") {
    manager.updateTaskLedger(args.groupId, {
      facts: args.facts!,
      plan: args.plan!,
      ...(steps != null && { scheduledSteps: steps }),
      ...(keptPhases != null && { phases: keptPhases }),
    });

    const response: Record<string, unknown> = {
      groupId: args.groupId,
      type: "task",
      status: "updated",
    };

    if (args.scheduledSteps && steps) {
      response.nextRunnableSteps = computeNextRunnableSteps(steps);
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
  if (steps != null) {
    const existingLedger = manager.getLedger(args.groupId);
    const existingTask = existingLedger?.taskLedger;
    manager.updateTaskLedger(args.groupId, {
      facts: existingTask?.facts ?? { given: [], toInvestigate: [], toDerive: [], assumptions: [] },
      plan: existingTask?.plan ?? [],
      scheduledSteps: steps,
      ...(keptPhases != null && { phases: keptPhases }),
    });
  }

  const response: Record<string, unknown> = {
    groupId: args.groupId,
    type: "progress",
    status: "updated",
  };

  if (args.scheduledSteps && steps) {
    response.nextRunnableSteps = computeNextRunnableSteps(steps);
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
  workspaceService?: WorkspaceService,
): void {
  server.tool(
    "update_ledger",
    "Magentic モードの台帳（Ledger）を更新する。Orchestrator Agent が自身の計画・進捗判定を記録するために使用する。",
    {
      groupId: z.string().describe("対象の Magentic グループ ID"),
      type: z.enum(["task", "progress"]).describe("台帳の種別: task（タスク台帳）または progress（進捗台帳）"),
      facts: factsSchema.optional().describe("タスク台帳: 事実の分類（type=task 時に必須）"),
      plan: z.array(z.string()).optional().describe("タスク台帳: 実行計画ステップ（type=task 時に必須）"),
      scheduledSteps: z.array(scheduledStepSchema).optional().describe("構造化された作業予定。各ステップに role, description, status, dependsOn を指定。type=task / type=progress どちらでも指定可能。progress 時に指定するとタスク台帳の scheduledSteps も同時更新される。Workspace グループでは phaseId / kind / doneCriteria / checks / onFail も指定でき、ゲート（kind: gate）の status は変更できない"),
      isRequestSatisfied: boolJudgmentSchema.optional().describe("進捗台帳: リクエストが満たされたか（type=progress 時に必須）"),
      isInLoop: boolJudgmentSchema.optional().describe("進捗台帳: ループに陥っていないか（type=progress 時に必須）"),
      isProgressBeingMade: boolJudgmentSchema.optional().describe("進捗台帳: 進捗が出ているか（type=progress 時に必須）"),
      nextAction: stringJudgmentSchema.optional().describe("進捗台帳: 次のアクション（type=progress 時に必須）"),
      instruction: stringJudgmentSchema.optional().describe("進捗台帳: サブ Agent への指示（type=progress 時に必須）"),
      iteration: z.number().optional().describe("進捗台帳: 現在の反復番号（type=progress 時に必須）"),
      phases: z.array(phaseSchema).optional().describe("タスク台帳（Workspace グループのみ）: フェーズ定義。修正フェーズの追加や、直前計画で手順を追加するフェーズの指定に使う"),
      irregular: z.boolean().optional().describe("Workspace グループのみ: ゲートの変更・削除・緩和を含む更新であることを示す。reason が必須。最終ゲートの削除と人間レビューの省略は不可"),
      reason: z.string().optional().describe("Workspace グループのみ: irregular が true のとき必須。ゲートを変更する理由"),
    },
    async (args) => handleUpdateLedger(manager, args, workspaceService),
  );
}
