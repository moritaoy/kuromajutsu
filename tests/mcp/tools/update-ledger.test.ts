// ============================================================
// update_ledger ツール テスト
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentManager } from "../../../src/agent/manager.js";
import { handleUpdateLedger, phaseSchema, scheduledStepSchema } from "../../../src/mcp/tools/update-ledger.js";
import { createRunHarness, type RunHarness } from "../../workspace/harness.js";
import { makeFixPlan } from "../../workspace/fixtures.js";
import { toScheduledSteps } from "../../../src/workspace/plan.js";
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
    // scheduledSteps 省略時も、台帳の現在の scheduledSteps から nextRunnableSteps を返す
    expect(data.nextRunnableSteps).toEqual([{ stepId: "s1", role: "impl-code", description: "調査" }]);
  });
});

// ==================================================
// Workspace グループでの update_ledger（docs/spec.md §2.2.11 / §13.5.5）
// ==================================================

describe("update_ledger（Workspace グループ）", () => {
  let h: RunHarness;
  let groupId: string;
  let workspaceId: string;

  const facts = { given: ["f"], toInvestigate: [], toDerive: [], assumptions: [] };
  const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);
  const currentSteps = (): ScheduledStep[] => structuredClone(h.steps(groupId));
  const ledgerOf = () => h.manager.getLedger(groupId)!.taskLedger!;

  function updateTask(over: Record<string, unknown>) {
    return handleUpdateLedger(
      h.manager,
      { groupId, type: "task", facts, plan: ["計画"], ...over } as Parameters<typeof handleUpdateLedger>[1],
      h.service,
    );
  }

  beforeEach(() => {
    h = createRunHarness();
    const r = h.running();
    groupId = r.groupId;
    workspaceId = r.id;
  });
  afterEach(() => h.cleanup());

  it("ゲートを completed にする更新は GATE_PROTECTED で拒否され、台帳は変わらない", () => {
    const before = currentSteps();
    const steps = currentSteps();
    steps.find((s) => s.stepId === "gate-P3")!.status = "completed";
    const res = updateTask({ scheduledSteps: steps });
    expect(res).toHaveProperty("isError", true);
    expect(parse(res)).toMatchObject({ error: true, code: "GATE_PROTECTED" });
    expect(ledgerOf().scheduledSteps).toEqual(before);
  });

  it("進捗台帳の更新に含めたゲートの完了も GATE_PROTECTED（進捗台帳も更新されない）", () => {
    const steps = currentSteps();
    steps.find((s) => s.stepId === "gate-P3")!.status = "completed";
    const res = handleUpdateLedger(
      h.manager,
      {
        groupId,
        type: "progress",
        isRequestSatisfied: { reason: "r", answer: false },
        isInLoop: { reason: "r", answer: false },
        isProgressBeingMade: { reason: "r", answer: true },
        nextAction: { reason: "r", answer: "a" },
        instruction: { reason: "r", answer: "i" },
        iteration: 1,
        scheduledSteps: steps,
      },
      h.service,
    );
    expect(parse(res).code).toBe("GATE_PROTECTED");
    expect(h.manager.getLedger(groupId)!.progressLedger).toBeUndefined();
  });

  it("ゲートの変更は irregular なしで GATE_CHANGE_NOT_ALLOWED、irregular + reason なら受理して gateChanges を記録する", () => {
    const steps = currentSteps();
    steps.find((s) => s.stepId === "gate-P3")!.checks = [{ text: "ビルドのみ", method: "command", command: "npm run build" }];

    const ng = updateTask({ scheduledSteps: structuredClone(steps) });
    expect(parse(ng).code).toBe("GATE_CHANGE_NOT_ALLOWED");
    expect(h.store.get(workspaceId)!.gateChanges).toEqual([]);

    const ok = updateTask({ scheduledSteps: steps, irregular: true, reason: "全テストは重い" });
    expect(ok).not.toHaveProperty("isError");
    expect(ledgerOf().scheduledSteps!.find((s) => s.stepId === "gate-P3")!.checks![0].command).toBe("npm run build");
    expect(h.store.get(workspaceId)!.gateChanges).toHaveLength(1);
    expect(h.store.get(workspaceId)!.gateChanges[0]).toMatchObject({ gateId: "gate-P3", reason: "全テストは重い" });
  });

  it("最終ゲートの削除は irregular でも GATE_PROTECTED", () => {
    const steps = currentSteps().filter((s) => s.stepId !== "gate-final");
    const res = updateTask({ scheduledSteps: steps, irregular: true, reason: "不要" });
    expect(parse(res).code).toBe("GATE_PROTECTED");
  });

  it("追加するゲートの command が禁止パターンなら GATE_COMMAND_DENIED", () => {
    const steps = currentSteps();
    steps.push({
      stepId: "gate-x",
      role: "code-review",
      description: "x",
      status: "pending",
      phaseId: "P3",
      kind: "gate",
      checks: [{ text: "push", method: "command", command: "git push origin main" }],
    });
    expect(parse(updateTask({ scheduledSteps: steps })).code).toBe("GATE_COMMAND_DENIED");
  });

  it("phases が不正なら INVALID_PHASES", () => {
    const phases = structuredClone(ledgerOf().phases!).filter((p) => p.id !== "P3");
    expect(parse(updateTask({ phases })).code).toBe("INVALID_PHASES");
  });

  it("deferred フェーズへの追加: dependsOn を実効依存に正規化して保存し、nextRunnableSteps も正規化後で算出する", () => {
    const steps = currentSteps();
    steps.push({
      stepId: "i1",
      role: "impl-code",
      description: "実装",
      status: "pending",
      phaseId: "P2",
      kind: "work",
      doneCriteria: ["できた"],
      dependsOn: ["s2"], // 別フェーズへの依存は落ちる
    });
    const res = updateTask({ scheduledSteps: steps });
    const body = parse(res);
    expect(body.status).toBe("updated");
    expect(ledgerOf().scheduledSteps!.find((s) => s.stepId === "i1")!.dependsOn).toEqual(["gate-P1"]);
    // gate-P1 が未完了なので i1 は着手できない（s1 だけが着手可能）
    expect(body.nextRunnableSteps.map((s: { stepId: string }) => s.stepId)).toEqual(["s1"]);
  });

  it("phases（修正フェーズの追加）を台帳に保存する", () => {
    const fix = makeFixPlan();
    const res = updateTask({ phases: fix.phases, scheduledSteps: toScheduledSteps(fix) });
    expect(res).not.toHaveProperty("isError");
    expect(ledgerOf().phases!.map((p) => p.id)).toContain("FX1");
  });

  it("scheduledSteps / phases を含まない task 更新でも phases を失わない", () => {
    const res = updateTask({ facts: { ...facts, given: ["更新"] }, plan: ["新しい計画"] });
    expect(res).not.toHaveProperty("isError");
    expect(ledgerOf().plan).toEqual(["新しい計画"]);
    expect(ledgerOf().phases!.map((p) => p.id)).toEqual(["P1", "P2", "P3", "PF"]);
    expect(ledgerOf().scheduledSteps).toHaveLength(h.steps(groupId).length);
  });

  it("進捗台帳の更新（scheduledSteps 付き）でも phases を保持し、ゲートの status はサーバー管理の値のまま", () => {
    const steps = currentSteps();
    steps.find((s) => s.stepId === "s1")!.status = "in_progress";
    steps.find((s) => s.stepId === "gate-P1")!.status = "in_progress";
    const res = handleUpdateLedger(
      h.manager,
      {
        groupId,
        type: "progress",
        isRequestSatisfied: { reason: "r", answer: false },
        isInLoop: { reason: "r", answer: false },
        isProgressBeingMade: { reason: "r", answer: true },
        nextAction: { reason: "r", answer: "a" },
        instruction: { reason: "r", answer: "i" },
        iteration: 1,
        scheduledSteps: steps,
      },
      h.service,
    );
    expect(res).not.toHaveProperty("isError");
    expect(ledgerOf().phases).toHaveLength(4);
    expect(ledgerOf().scheduledSteps!.find((s) => s.stepId === "s1")!.status).toBe("in_progress");
    expect(ledgerOf().scheduledSteps!.find((s) => s.stepId === "gate-P1")!.status).toBe("pending");
  });

  it("scheduledSteps / phases を含まない進捗台帳の更新は検証せずに通る", () => {
    const res = handleUpdateLedger(
      h.manager,
      {
        groupId,
        type: "progress",
        isRequestSatisfied: { reason: "r", answer: false },
        isInLoop: { reason: "r", answer: false },
        isProgressBeingMade: { reason: "r", answer: true },
        nextAction: { reason: "r", answer: "a" },
        instruction: { reason: "r", answer: "i" },
        iteration: 1,
      },
      h.service,
    );
    expect(res).not.toHaveProperty("isError");
  });

  describe("初回の再登録の吸収（§13.5.5）", () => {
    const progressArgs = {
      isRequestSatisfied: { reason: "r", answer: false },
      isInLoop: { reason: "r", answer: false },
      isProgressBeingMade: { reason: "r", answer: true },
      nextAction: { reason: "r", answer: "a" },
      instruction: { reason: "r", answer: "i" },
      iteration: 1,
    };
    const rephrased = (): ScheduledStep[] =>
      currentSteps().map((s) =>
        s.kind === "gate"
          ? { ...s, description: `言い換え: ${s.description}` }
          : { ...s, description: `言い換え: ${s.description}`, doneCriteria: ["別の文言"], dependsOn: [] },
      );
    const runnableIds = (body: { nextRunnableSteps: { stepId: string }[] }) => body.nextRunnableSteps.map((s) => s.stepId);

    it("最初の type: progress の言い換えは吸収され、応答に absorbed: true と note、nextRunnableSteps が付く", () => {
      const planned = currentSteps();
      const res = handleUpdateLedger(
        h.manager,
        { groupId, type: "progress", ...progressArgs, scheduledSteps: rephrased() },
        h.service,
      );
      expect(res).not.toHaveProperty("isError");
      const body = parse(res);
      expect(body).toMatchObject({ type: "progress", status: "updated", absorbed: true });
      expect(body.note).toContain("承認済みの計画の文言を維持しました");
      expect(runnableIds(body)).toEqual(["s1"]);
      expect(ledgerOf().scheduledSteps).toEqual(planned);
    });

    it("type: task の言い換えも吸収され、応答に absorbed: true と note が付く", () => {
      const res = updateTask({ scheduledSteps: rephrased() });
      const body = parse(res);
      expect(body).toMatchObject({ type: "task", status: "updated", absorbed: true });
      expect(typeof body.note).toBe("string");
      expect(ledgerOf().scheduledSteps).toEqual(currentSteps());
    });

    it("吸収しない更新（言い換えなし）の応答に absorbed / note は付かない", () => {
      const body = parse(updateTask({ scheduledSteps: currentSteps() }));
      expect(body).not.toHaveProperty("absorbed");
      expect(body).not.toHaveProperty("note");
    });

    it("scheduledSteps を省略した進捗更新でも nextRunnableSteps を台帳の現在の手順から返す（task も同様）", () => {
      const prog = parse(handleUpdateLedger(h.manager, { groupId, type: "progress", ...progressArgs }, h.service));
      expect(runnableIds(prog)).toEqual(["s1"]);
      expect(prog).not.toHaveProperty("absorbed");

      const steps = currentSteps();
      steps.find((s) => s.stepId === "s1")!.status = "completed";
      h.manager.updateTaskLedger(groupId, {
        facts,
        plan: ["計画"],
        phases: ledgerOf().phases,
        scheduledSteps: steps,
      });
      const after = parse(handleUpdateLedger(h.manager, { groupId, type: "progress", ...progressArgs, iteration: 2 }, h.service));
      expect(runnableIds(after)).not.toContain("s1");
      const task = parse(updateTask({}));
      expect(Array.isArray(task.nextRunnableSteps)).toBe(true);
    });
  });

  it("停止した Workspace の台帳更新は WORKSPACE_NOT_RUNNING", () => {
    h.service.abort(workspaceId);
    expect(parse(updateTask({ scheduledSteps: currentSteps() })).code).toBe("WORKSPACE_NOT_RUNNING");
  });

  it("Workspace に紐付かないグループは従来どおり（irregular / reason は無視。検証しない）", () => {
    const group = h.manager.createGroup("通常の Magentic", "magentic");
    const steps: ScheduledStep[] = [
      { stepId: "g1", role: "impl-code", description: "ゲートっぽいもの", status: "completed", kind: "gate" },
    ];
    const res = handleUpdateLedger(
      h.manager,
      { groupId: group.id, type: "task", facts, plan: ["p"], scheduledSteps: steps, irregular: true, reason: "x" },
      h.service,
    );
    expect(res).not.toHaveProperty("isError");
    expect(h.manager.getLedger(group.id)!.taskLedger!.scheduledSteps).toEqual(steps);
  });

  it("Workspace のグループなのにサービスが渡されなければ fail-closed（NOT_WORKSPACE_GROUP。台帳は変わらない）", () => {
    const steps = currentSteps();
    steps.find((s) => s.stepId === "gate-P3")!.status = "completed";
    const before = currentSteps();
    const res = handleUpdateLedger(h.manager, { groupId, type: "task", facts, plan: ["p"], scheduledSteps: steps });
    expect(res).toHaveProperty("isError", true);
    expect(parse(res).code).toBe("NOT_WORKSPACE_GROUP");
    expect(ledgerOf().scheduledSteps).toEqual(before);
    const progress = handleUpdateLedger(h.manager, {
      groupId,
      type: "progress",
      isRequestSatisfied: { reason: "r", answer: false },
      isInLoop: { reason: "r", answer: false },
      isProgressBeingMade: { reason: "r", answer: true },
      nextAction: { reason: "r", answer: "a" },
      instruction: { reason: "r", answer: "i" },
      iteration: 1,
    });
    expect(parse(progress).code).toBe("NOT_WORKSPACE_GROUP");
  });

  it("stepId が重複する更新は DUPLICATE_STEP_ID（human を外した弱いコピーでの検証すり抜けを防ぐ）。台帳は変わらない", () => {
    const before = currentSteps();
    for (const position of ["head", "tail"] as const) {
      const steps = currentSteps();
      const weak = structuredClone(steps.find((s) => s.stepId === "gate-P1")!);
      weak.checks = [{ text: "仕様書が矛盾していない", method: "agent-review" }];
      if (position === "head") steps.unshift(weak);
      else steps.push(weak);
      const res = updateTask({ scheduledSteps: steps, irregular: true, reason: "x" });
      expect(res).toHaveProperty("isError", true);
      expect(parse(res)).toMatchObject({ error: true, code: "DUPLICATE_STEP_ID" });
    }
    expect(ledgerOf().scheduledSteps).toEqual(before);
    expect(ledgerOf().scheduledSteps!.find((s) => s.stepId === "gate-P1")!.checks).toHaveLength(2);
    expect(h.store.get(workspaceId)!.gateChanges).toEqual([]);
  });

  it("承認済みフェーズへの fix / planning の書き換えは INVALID_PHASES", () => {
    const phases = structuredClone(ledgerOf().phases!);
    phases.find((p) => p.id === "P2")!.planning = "fixed";
    expect(parse(updateTask({ phases })).code).toBe("INVALID_PHASES");
  });

  it("フェーズを id だけで再送しても、name / goal / planning / notes は現行値のまま（既定値で上書きしない）", () => {
    const original = structuredClone(ledgerOf().phases!);
    const phases = original.map((p) => ({ id: p.id, ...(p.final ? { final: true } : {}) }));
    const res = updateTask({ phases });
    expect(res).not.toHaveProperty("isError");
    expect(ledgerOf().phases).toEqual(original);
  });

  it("新規 Step に phaseId が無ければ INVALID_PHASES", () => {
    const steps = currentSteps();
    steps.push({ stepId: "free", role: "impl-code", description: "x", status: "pending" });
    expect(parse(updateTask({ scheduledSteps: steps })).code).toBe("INVALID_PHASES");
  });

  it("入力スキーマ: onFail.maxRetries は 0 以上の整数、phases は id 以外を省略できる", () => {
    const okStep = { stepId: "s", role: "r", description: "d", status: "pending" as const };
    expect(scheduledStepSchema.safeParse({ ...okStep, onFail: { action: "rework", maxRetries: 0 } }).success).toBe(true);
    expect(scheduledStepSchema.safeParse({ ...okStep, onFail: { action: "rework", maxRetries: -1 } }).success).toBe(false);
    expect(scheduledStepSchema.safeParse({ ...okStep, onFail: { action: "rework", maxRetries: 1.5 } }).success).toBe(false);
    const parsed = phaseSchema.parse({ id: "P1" });
    expect(parsed).toEqual({ id: "P1" }); // 既定値で埋めない
  });
});
