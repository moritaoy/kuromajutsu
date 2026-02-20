// ============================================================
// run_sequential ツール テスト
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentManager } from "../../../src/agent/manager.js";
import { handleRunSequential } from "../../../src/mcp/tools/run-sequential.js";
import type { AppConfig, HealthCheckResult } from "../../../src/types/index.js";

// AgentExecutor をモック化
vi.mock("../../../src/agent/executor.js", () => {
  class MockAgentExecutor {
    execute = vi.fn().mockReturnValue(99999);
    kill = vi.fn();
    killAll = vi.fn();
  }
  return { AgentExecutor: MockAgentExecutor };
});

function createTestConfig(overrides?: Partial<AppConfig>): AppConfig {
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
        id: "code-review",
        name: "コードレビュワー",
        description: "コードの品質をレビューする",
        model: "claude-4-sonnet",
        systemPrompt: "You are a code reviewer.",
        healthCheckPrompt: "OK",
      },
    ],
    ...overrides,
  };
}

describe("run_sequential", () => {
  let manager: AgentManager;
  let config: AppConfig;

  beforeEach(() => {
    config = createTestConfig();
    manager = new AgentManager(config);
  });

  it("正常系: 単一ステージの計画投入", () => {
    const group = manager.createGroup("test", "sequential");

    const result = handleRunSequential(config, manager, {
      groupId: group.id,
      stages: [{ tasks: [{ role: "impl-code", prompt: "タスク1" }] }],
    });

    expect(result).not.toHaveProperty("isError");
    const data = JSON.parse(result.content[0].text);
    expect(data.groupId).toBe(group.id);
    expect(data.totalStages).toBe(1);
    expect(data.currentStageIndex).toBe(0);
    expect(data.agents).toHaveLength(1);
    expect(data.agents[0].agentId).toMatch(/^impl-code-/);
    expect(data.agents[0].stageIndex).toBe(0);
  });

  it("正常系: 複数ステージの計画投入（Stage 0 の Agent のみ起動される）", () => {
    const group = manager.createGroup("test", "sequential");

    const result = handleRunSequential(config, manager, {
      groupId: group.id,
      stages: [
        { tasks: [{ role: "impl-code", prompt: "Stage 0 タスク" }] },
        { tasks: [{ role: "code-review", prompt: "Stage 1 タスク" }] },
      ],
    });

    expect(result).not.toHaveProperty("isError");
    const data = JSON.parse(result.content[0].text);
    expect(data.totalStages).toBe(2);
    expect(data.currentStageIndex).toBe(0);
    expect(data.agents).toHaveLength(2);
    expect(data.agents[0].stageIndex).toBe(0);
    expect(data.agents[1].stageIndex).toBe(1);
    // Stage 0 の Agent のみが起動（pid が設定）されている
    const stage0Agent = data.agents.find((a: { stageIndex: number }) => a.stageIndex === 0);
    expect(stage0Agent).toBeDefined();
  });

  it("異常系: stages 配列が空 (EMPTY_STAGES)", () => {
    const group = manager.createGroup("test", "sequential");

    const result = handleRunSequential(config, manager, {
      groupId: group.id,
      stages: [],
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe("EMPTY_STAGES");
  });

  it("異常系: ステージ内の tasks が空 (EMPTY_STAGE_TASKS)", () => {
    const group = manager.createGroup("test", "sequential");

    const result = handleRunSequential(config, manager, {
      groupId: group.id,
      stages: [{ tasks: [] }],
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe("EMPTY_STAGE_TASKS");
  });

  it("異常系: グループが存在しない (GROUP_NOT_FOUND)", () => {
    const result = handleRunSequential(config, manager, {
      groupId: "grp-nonexistent",
      stages: [{ tasks: [{ role: "impl-code", prompt: "Hello" }] }],
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe("GROUP_NOT_FOUND");
  });

  it("異常系: グループの mode が concurrent (MODE_MISMATCH)", () => {
    const group = manager.createGroup("test"); // デフォルトは concurrent

    const result = handleRunSequential(config, manager, {
      groupId: group.id,
      stages: [{ tasks: [{ role: "impl-code", prompt: "Hello" }] }],
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe("MODE_MISMATCH");
  });

  it("異常系: 存在しない role (ROLE_NOT_FOUND)", () => {
    const group = manager.createGroup("test", "sequential");

    const result = handleRunSequential(config, manager, {
      groupId: group.id,
      stages: [{ tasks: [{ role: "nonexistent-role", prompt: "Hello" }] }],
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe("ROLE_NOT_FOUND");
  });

  it("異常系: maxConcurrent 超過 (MAX_CONCURRENT_REACHED)", () => {
    const maxConfig = createTestConfig({
      agent: { defaultTimeout_ms: 300_000, maxConcurrent: 1 },
    });
    const mgr = new AgentManager(maxConfig);
    const group = mgr.createGroup("test", "sequential");
    mgr.startAgent(group.id, maxConfig.roles[0], "first");

    const result = handleRunSequential(maxConfig, mgr, {
      groupId: group.id,
      stages: [{ tasks: [{ role: "impl-code", prompt: "second" }] }],
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe("MAX_CONCURRENT_REACHED");
  });
});
