// ============================================================
// update_ledger ツール テスト
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentManager } from "../../../src/agent/manager.js";
import { handleUpdateLedger } from "../../../src/mcp/tools/update-ledger.js";
import type {
  AppConfig,
  MagenticConfig,
  MagenticLedger,
  ScheduledStep,
} from "../../../src/types/index.js";

// AgentExecutor をモック化
vi.mock("../../../src/agent/executor.js", () => {
  class MockAgentExecutor {
    execute = vi.fn().mockReturnValue(99999);
    kill = vi.fn();
    killAll = vi.fn();
  }
  return { AgentExecutor: MockAgentExecutor };
});

function createTestConfig(): AppConfig {
  return {
    dashboard: { port: 9696 },
    agent: { defaultTimeout_ms: 300_000, maxConcurrent: 10 },
    log: { level: "info" },
    roles: [
      {
        id: "impl-code",
        name: "コード実装者",
        description: "コードの実装・修正を行う",
        model: "claude-4-sonnet",
        systemPrompt: "You are a code implementer.",
        healthCheckPrompt: "OK",
      },
      {
        id: "orchestrator",
        name: "オーケストレーター",
        description: "Magentic パターンでサブ Agent を自律管理する",
        model: "opus-4.6-thinking",
        systemPrompt: "You are an orchestrator.",
        healthCheckPrompt: "OK",
      },
    ],
  };
}

function createMagenticGroup(manager: AgentManager): string {
  const group = manager.createGroup("Magentic テスト", "magentic");
  const magenticConfig: MagenticConfig = {
    task: "テストタスク",
    completionCriteria: "全テストパス",
    scope: "src/",
    availableRoles: ["impl-code"],
    maxIterations: 5,
    currentIteration: 0,
  };
  manager.setMagenticConfig(group.id, magenticConfig);
  return group.id;
}

describe("update_ledger", () => {
  let manager: AgentManager;
  let config: AppConfig;

  beforeEach(() => {
    config = createTestConfig();
    manager = new AgentManager(config);
  });

  it("正常系: type=task で TaskLedger が保存される", () => {
    const groupId = createMagenticGroup(manager);

    const result = handleUpdateLedger(manager, {
      groupId,
      type: "task",
      facts: {
        given: ["TypeScript プロジェクト"],
        toInvestigate: ["API 仕様"],
        toDerive: ["最適設計"],
        assumptions: ["Node.js 18+"],
      },
      plan: ["調査", "実装", "テスト"],
    });

    expect(result).not.toHaveProperty("isError");
    const data = JSON.parse(result.content[0].text);
    expect(data.groupId).toBe(groupId);
    expect(data.type).toBe("task");

    const ledger = manager.getLedger(groupId);
    expect(ledger).toBeDefined();
    expect(ledger!.taskLedger!.facts.given).toEqual(["TypeScript プロジェクト"]);
    expect(ledger!.taskLedger!.plan).toEqual(["調査", "実装", "テスト"]);
  });

  it("正常系: type=progress で ProgressLedger が保存される", () => {
    const groupId = createMagenticGroup(manager);

    const result = handleUpdateLedger(manager, {
      groupId,
      type: "progress",
      isRequestSatisfied: { reason: "まだ途中", answer: false },
      isInLoop: { reason: "新ステップに進行中", answer: false },
      isProgressBeingMade: { reason: "ステップ1完了", answer: true },
      nextAction: { reason: "実装フェーズへ", answer: "impl-code を起動" },
      instruction: { reason: "認証が必要", answer: "login.ts を実装せよ" },
      iteration: 1,
    });

    expect(result).not.toHaveProperty("isError");
    const data = JSON.parse(result.content[0].text);
    expect(data.groupId).toBe(groupId);
    expect(data.type).toBe("progress");

    const ledger = manager.getLedger(groupId);
    expect(ledger).toBeDefined();
    expect(ledger!.progressLedger!.isRequestSatisfied.answer).toBe(false);
    expect(ledger!.progressLedger!.iteration).toBe(1);
  });

  it("異常系: 存在しないグループ ID (GROUP_NOT_FOUND)", () => {
    const result = handleUpdateLedger(manager, {
      groupId: "grp-nonexistent",
      type: "task",
      facts: {
        given: [],
        toInvestigate: [],
        toDerive: [],
        assumptions: [],
      },
      plan: [],
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe("GROUP_NOT_FOUND");
  });

  it("異常系: Magentic モードでないグループ (NOT_MAGENTIC_GROUP)", () => {
    const group = manager.createGroup("通常グループ", "concurrent");

    const result = handleUpdateLedger(manager, {
      groupId: group.id,
      type: "task",
      facts: {
        given: [],
        toInvestigate: [],
        toDerive: [],
        assumptions: [],
      },
      plan: [],
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe("NOT_MAGENTIC_GROUP");
  });

  it("group:ledger_updated イベントが発行される", () => {
    const groupId = createMagenticGroup(manager);
    const handler = vi.fn();
    manager.on("group:ledger_updated", handler);

    handleUpdateLedger(manager, {
      groupId,
      type: "task",
      facts: {
        given: ["事実"],
        toInvestigate: [],
        toDerive: [],
        assumptions: [],
      },
      plan: ["計画"],
    });

    expect(handler).toHaveBeenCalledOnce();
    const emitted: MagenticLedger = handler.mock.calls[0][0];
    expect(emitted.groupId).toBe(groupId);
    expect(emitted.taskLedger).toBeDefined();
  });

  it("progress 台帳の連続更新で progressHistory に蓄積される", () => {
    const groupId = createMagenticGroup(manager);

    for (let i = 1; i <= 3; i++) {
      handleUpdateLedger(manager, {
        groupId,
        type: "progress",
        isRequestSatisfied: { reason: "理由", answer: false },
        isInLoop: { reason: "理由", answer: false },
        isProgressBeingMade: { reason: "理由", answer: true },
        nextAction: { reason: "理由", answer: "次のアクション" },
        instruction: { reason: "理由", answer: "指示" },
        iteration: i,
      });
    }

    const ledger = manager.getLedger(groupId);
    expect(ledger!.progressLedger!.iteration).toBe(3);
    expect(ledger!.progressHistory).toHaveLength(2);
  });

  it("scheduledSteps 付きの task 台帳更新が成功すること", () => {
    const groupId = createMagenticGroup(manager);
    const scheduledSteps: ScheduledStep[] = [
      {
        stepId: "s1",
        role: "impl-code",
        description: "ステップ1",
        status: "pending",
      },
    ];

    const result = handleUpdateLedger(manager, {
      groupId,
      type: "task",
      facts: {
        given: [],
        toInvestigate: [],
        toDerive: [],
        assumptions: [],
      },
      plan: ["計画"],
      scheduledSteps,
    });

    expect(result).not.toHaveProperty("isError");
    const ledger = manager.getLedger(groupId);
    expect(ledger?.taskLedger?.scheduledSteps).toEqual(scheduledSteps);
  });

  it("scheduledSteps 省略時はレスポンスに nextRunnableSteps が含まれないこと", () => {
    const groupId = createMagenticGroup(manager);

    const result = handleUpdateLedger(manager, {
      groupId,
      type: "task",
      facts: {
        given: [],
        toInvestigate: [],
        toDerive: [],
        assumptions: [],
      },
      plan: ["計画"],
    });

    expect(result).not.toHaveProperty("isError");
    const data = JSON.parse(result.content[0].text);
    expect(data).not.toHaveProperty("nextRunnableSteps");
  });

  it("nextRunnableSteps: 依存なしステップが即時 runnable", () => {
    const groupId = createMagenticGroup(manager);
    const scheduledSteps: ScheduledStep[] = [
      {
        stepId: "s1",
        role: "impl-code",
        description: "依存なし",
        status: "pending",
      },
    ];

    const result = handleUpdateLedger(manager, {
      groupId,
      type: "task",
      facts: {
        given: [],
        toInvestigate: [],
        toDerive: [],
        assumptions: [],
      },
      plan: [],
      scheduledSteps,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.nextRunnableSteps).toEqual([
      { stepId: "s1", role: "impl-code", description: "依存なし" },
    ]);
  });

  it("nextRunnableSteps: 依存先が completed/skipped のステップが runnable", () => {
    const groupId = createMagenticGroup(manager);
    const scheduledSteps: ScheduledStep[] = [
      { stepId: "s1", role: "impl-code", description: "s1", status: "completed" },
      {
        stepId: "s2",
        role: "impl-code",
        description: "s2",
        status: "pending",
        dependsOn: ["s1"],
      },
    ];

    const result = handleUpdateLedger(manager, {
      groupId,
      type: "task",
      facts: {
        given: [],
        toInvestigate: [],
        toDerive: [],
        assumptions: [],
      },
      plan: [],
      scheduledSteps,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.nextRunnableSteps).toEqual([
      { stepId: "s2", role: "impl-code", description: "s2" },
    ]);
  });

  it("nextRunnableSteps: 依存先が pending のステップは runnable でないこと", () => {
    const groupId = createMagenticGroup(manager);
    const scheduledSteps: ScheduledStep[] = [
      { stepId: "s1", role: "impl-code", description: "s1", status: "pending" },
      {
        stepId: "s2",
        role: "impl-code",
        description: "s2",
        status: "pending",
        dependsOn: ["s1"],
      },
    ];

    const result = handleUpdateLedger(manager, {
      groupId,
      type: "task",
      facts: {
        given: [],
        toInvestigate: [],
        toDerive: [],
        assumptions: [],
      },
      plan: [],
      scheduledSteps,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.nextRunnableSteps).toEqual([
      { stepId: "s1", role: "impl-code", description: "s1" },
    ]);
  });

  it("nextRunnableSteps: 全ステップ completed 時は空配列", () => {
    const groupId = createMagenticGroup(manager);
    const scheduledSteps: ScheduledStep[] = [
      { stepId: "s1", role: "impl-code", description: "s1", status: "completed" },
      { stepId: "s2", role: "impl-code", description: "s2", status: "completed" },
    ];

    const result = handleUpdateLedger(manager, {
      groupId,
      type: "task",
      facts: {
        given: [],
        toInvestigate: [],
        toDerive: [],
        assumptions: [],
      },
      plan: [],
      scheduledSteps,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.nextRunnableSteps).toEqual([]);
  });

  it("nextRunnableSteps: 並列実行可能なステップが複数返ること", () => {
    const groupId = createMagenticGroup(manager);
    const scheduledSteps: ScheduledStep[] = [
      { stepId: "s1", role: "impl-code", description: "s1", status: "completed" },
      {
        stepId: "s2",
        role: "impl-code",
        description: "s2",
        status: "pending",
        dependsOn: ["s1"],
      },
      {
        stepId: "s3",
        role: "impl-code",
        description: "s3",
        status: "pending",
        dependsOn: ["s1"],
      },
    ];

    const result = handleUpdateLedger(manager, {
      groupId,
      type: "task",
      facts: {
        given: [],
        toInvestigate: [],
        toDerive: [],
        assumptions: [],
      },
      plan: [],
      scheduledSteps,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.nextRunnableSteps).toHaveLength(2);
    expect(data.nextRunnableSteps).toContainEqual({
      stepId: "s2",
      role: "impl-code",
      description: "s2",
    });
    expect(data.nextRunnableSteps).toContainEqual({
      stepId: "s3",
      role: "impl-code",
      description: "s3",
    });
  });

  it("scheduledSteps 省略の再更新で既存の scheduledSteps が保持されること", () => {
    const groupId = createMagenticGroup(manager);
    const scheduledSteps: ScheduledStep[] = [
      { stepId: "s1", role: "impl-code", description: "調査", status: "pending" },
      {
        stepId: "s2",
        role: "impl-code",
        description: "実装",
        status: "pending",
        dependsOn: ["s1"],
      },
    ];

    handleUpdateLedger(manager, {
      groupId,
      type: "task",
      facts: {
        given: ["初回"],
        toInvestigate: [],
        toDerive: [],
        assumptions: [],
      },
      plan: ["計画1"],
      scheduledSteps,
    });

    handleUpdateLedger(manager, {
      groupId,
      type: "task",
      facts: {
        given: ["更新後"],
        toInvestigate: [],
        toDerive: [],
        assumptions: [],
      },
      plan: ["計画2"],
    });

    const ledger = manager.getLedger(groupId);
    expect(ledger!.taskLedger!.facts.given).toEqual(["更新後"]);
    expect(ledger!.taskLedger!.plan).toEqual(["計画2"]);
    expect(ledger!.taskLedger!.scheduledSteps).toEqual(scheduledSteps);
  });

  it("scheduledSteps 付きの連続更新でステータスが正しく反映されること", () => {
    const groupId = createMagenticGroup(manager);

    handleUpdateLedger(manager, {
      groupId,
      type: "task",
      facts: {
        given: ["初回"],
        toInvestigate: [],
        toDerive: [],
        assumptions: [],
      },
      plan: ["計画"],
      scheduledSteps: [
        { stepId: "s1", role: "impl-code", description: "調査", status: "pending" },
        {
          stepId: "s2",
          role: "impl-code",
          description: "実装",
          status: "pending",
          dependsOn: ["s1"],
        },
      ],
    });

    const result = handleUpdateLedger(manager, {
      groupId,
      type: "task",
      facts: {
        given: ["更新"],
        toInvestigate: [],
        toDerive: [],
        assumptions: [],
      },
      plan: ["計画"],
      scheduledSteps: [
        { stepId: "s1", role: "impl-code", description: "調査", status: "completed" },
        {
          stepId: "s2",
          role: "impl-code",
          description: "実装",
          status: "pending",
          dependsOn: ["s1"],
        },
      ],
    });

    const ledger = manager.getLedger(groupId);
    expect(ledger!.taskLedger!.scheduledSteps![0].status).toBe("completed");
    expect(ledger!.taskLedger!.scheduledSteps![1].status).toBe("pending");

    const data = JSON.parse(result.content[0].text);
    expect(data.nextRunnableSteps).toEqual([
      { stepId: "s2", role: "impl-code", description: "実装" },
    ]);
  });

  it("type=progress + scheduledSteps 付きで taskLedger.scheduledSteps が更新されること", () => {
    const groupId = createMagenticGroup(manager);

    handleUpdateLedger(manager, {
      groupId,
      type: "task",
      facts: { given: ["初回"], toInvestigate: [], toDerive: [], assumptions: [] },
      plan: ["計画"],
      scheduledSteps: [
        { stepId: "s1", role: "impl-code", description: "調査", status: "pending" },
        { stepId: "s2", role: "impl-code", description: "実装", status: "pending", dependsOn: ["s1"] },
      ],
    });

    handleUpdateLedger(manager, {
      groupId,
      type: "progress",
      isRequestSatisfied: { reason: "途中", answer: false },
      isInLoop: { reason: "正常", answer: false },
      isProgressBeingMade: { reason: "s1完了", answer: true },
      nextAction: { reason: "次へ", answer: "s2 を起動" },
      instruction: { reason: "実装", answer: "実装せよ" },
      iteration: 1,
      scheduledSteps: [
        { stepId: "s1", role: "impl-code", description: "調査", status: "completed" },
        { stepId: "s2", role: "impl-code", description: "実装", status: "in_progress", dependsOn: ["s1"] },
      ],
    });

    const ledger = manager.getLedger(groupId);
    expect(ledger!.taskLedger!.scheduledSteps![0].status).toBe("completed");
    expect(ledger!.taskLedger!.scheduledSteps![1].status).toBe("in_progress");
    expect(ledger!.taskLedger!.facts.given).toEqual(["初回"]);
    expect(ledger!.taskLedger!.plan).toEqual(["計画"]);
    expect(ledger!.progressLedger!.iteration).toBe(1);
  });

  it("type=progress + scheduledSteps 付きでレスポンスに nextRunnableSteps が含まれること", () => {
    const groupId = createMagenticGroup(manager);

    handleUpdateLedger(manager, {
      groupId,
      type: "task",
      facts: { given: [], toInvestigate: [], toDerive: [], assumptions: [] },
      plan: ["計画"],
      scheduledSteps: [
        { stepId: "s1", role: "impl-code", description: "調査", status: "pending" },
        { stepId: "s2", role: "impl-code", description: "実装", status: "pending", dependsOn: ["s1"] },
      ],
    });

    const result = handleUpdateLedger(manager, {
      groupId,
      type: "progress",
      isRequestSatisfied: { reason: "途中", answer: false },
      isInLoop: { reason: "正常", answer: false },
      isProgressBeingMade: { reason: "進捗", answer: true },
      nextAction: { reason: "次", answer: "実行" },
      instruction: { reason: "指示", answer: "実装" },
      iteration: 1,
      scheduledSteps: [
        { stepId: "s1", role: "impl-code", description: "調査", status: "completed" },
        { stepId: "s2", role: "impl-code", description: "実装", status: "pending", dependsOn: ["s1"] },
      ],
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.type).toBe("progress");
    expect(data.status).toBe("updated");
    expect(data.nextRunnableSteps).toEqual([
      { stepId: "s2", role: "impl-code", description: "実装" },
    ]);
  });

  it("type=progress で scheduledSteps 省略時に既存の scheduledSteps が保持されること", () => {
    const groupId = createMagenticGroup(manager);
    const scheduledSteps: ScheduledStep[] = [
      { stepId: "s1", role: "impl-code", description: "調査", status: "pending" },
    ];

    handleUpdateLedger(manager, {
      groupId,
      type: "task",
      facts: { given: ["初回"], toInvestigate: [], toDerive: [], assumptions: [] },
      plan: ["計画"],
      scheduledSteps,
    });

    handleUpdateLedger(manager, {
      groupId,
      type: "progress",
      isRequestSatisfied: { reason: "途中", answer: false },
      isInLoop: { reason: "正常", answer: false },
      isProgressBeingMade: { reason: "進捗", answer: true },
      nextAction: { reason: "次", answer: "実行" },
      instruction: { reason: "指示", answer: "指示" },
      iteration: 1,
    });

    const ledger = manager.getLedger(groupId);
    expect(ledger!.taskLedger!.scheduledSteps).toEqual(scheduledSteps);
    const data = JSON.parse(
      handleUpdateLedger(manager, {
        groupId,
        type: "progress",
        isRequestSatisfied: { reason: "途中", answer: false },
        isInLoop: { reason: "正常", answer: false },
        isProgressBeingMade: { reason: "進捗", answer: true },
        nextAction: { reason: "次", answer: "実行" },
        instruction: { reason: "指示", answer: "指示" },
        iteration: 2,
      }).content[0].text,
    );
    expect(data).not.toHaveProperty("nextRunnableSteps");
  });
});
