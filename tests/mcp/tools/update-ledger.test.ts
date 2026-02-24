// ============================================================
// update_ledger ツール テスト
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentManager } from "../../../src/agent/manager.js";
import { handleUpdateLedger } from "../../../src/mcp/tools/update-ledger.js";
import type { AppConfig, MagenticConfig, MagenticLedger } from "../../../src/types/index.js";

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
});
