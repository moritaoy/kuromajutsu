// ============================================================
// run_agents ツール テスト
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentManager } from "../../../src/agent/manager.js";
import { handleRunAgents } from "../../../src/mcp/tools/run-agents.js";
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

describe("run_agents", () => {
  let manager: AgentManager;
  let config: AppConfig;

  beforeEach(() => {
    config = createTestConfig();
    manager = new AgentManager(config);
  });

  it("正常系: 1台の Agent 起動（旧 run_agent と同等）", () => {
    const group = manager.createGroup("test");

    const result = handleRunAgents(config, manager, {
      groupId: group.id,
      agents: [{ role: "impl-code", prompt: "テスト実装して" }],
    });

    expect(result).not.toHaveProperty("isError");
    const data = JSON.parse(result.content[0].text);
    expect(data.agents).toHaveLength(1);
    expect(data.agents[0].agentId).toMatch(/^impl-code-/);
    expect(data.agents[0].groupId).toBe(group.id);
    expect(data.agents[0].role).toBe("impl-code");
    expect(data.agents[0].model).toBe("claude-4-sonnet");
    expect(data.agents[0].status).toBe("queued");
    expect(data.total).toBe(1);
  });

  it("正常系: 複数台の Agent 一括起動", () => {
    const group = manager.createGroup("test");

    const result = handleRunAgents(config, manager, {
      groupId: group.id,
      agents: [
        { role: "impl-code", prompt: "タスク1" },
        { role: "code-review", prompt: "タスク2" },
      ],
    });

    expect(result).not.toHaveProperty("isError");
    const data = JSON.parse(result.content[0].text);
    expect(data.agents).toHaveLength(2);
    expect(data.total).toBe(2);
    expect(data.agents[0].role).toBe("impl-code");
    expect(data.agents[1].role).toBe("code-review");
  });

  it("異常系: agents 配列が空", () => {
    const group = manager.createGroup("test");

    const result = handleRunAgents(config, manager, {
      groupId: group.id,
      agents: [],
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe("EMPTY_AGENTS");
  });

  it("異常系: グループが存在しない (GROUP_NOT_FOUND)", () => {
    const result = handleRunAgents(config, manager, {
      groupId: "grp-nonexistent",
      agents: [{ role: "impl-code", prompt: "Hello" }],
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe("GROUP_NOT_FOUND");
  });

  it("異常系: グループが active でない (GROUP_NOT_ACTIVE)", () => {
    const group = manager.createGroup("test");
    const agent = manager.startAgent(group.id, config.roles[0], "setup");
    manager.updateAgentState(agent.agentId, { status: "running" });
    manager.updateAgentState(agent.agentId, { status: "completed" });
    manager.deleteGroup(group.id);

    const result = handleRunAgents(config, manager, {
      groupId: group.id,
      agents: [{ role: "impl-code", prompt: "Hello" }],
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe("GROUP_NOT_ACTIVE");
  });

  it("異常系: グループの mode が sequential (MODE_MISMATCH)", () => {
    const group = manager.createGroup("test", "sequential");

    const result = handleRunAgents(config, manager, {
      groupId: group.id,
      agents: [{ role: "impl-code", prompt: "Hello" }],
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe("MODE_MISMATCH");
  });

  it("異常系: 存在しない role (ROLE_NOT_FOUND)", () => {
    const group = manager.createGroup("test");

    const result = handleRunAgents(config, manager, {
      groupId: group.id,
      agents: [{ role: "nonexistent-role", prompt: "Hello" }],
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe("ROLE_NOT_FOUND");
  });

  it("異常系: ヘルスチェック未通過の role (ROLE_UNAVAILABLE)", () => {
    const group = manager.createGroup("test");
    const healthResults: HealthCheckResult[] = [
      {
        roleId: "impl-code",
        modelValidation: {
          status: "invalid",
          message: "モデルが見つかりません",
          checkedAt: new Date().toISOString(),
        },
        healthCheck: { status: "skipped" },
        available: false,
      },
    ];
    manager.setHealthCheckResults(healthResults);

    const result = handleRunAgents(config, manager, {
      groupId: group.id,
      agents: [{ role: "impl-code", prompt: "Hello" }],
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe("ROLE_UNAVAILABLE");
  });

  it("異常系: maxConcurrent 超過 (MAX_CONCURRENT_REACHED)", () => {
    const maxConfig = createTestConfig({
      agent: { defaultTimeout_ms: 300_000, maxConcurrent: 1 },
    });
    const mgr = new AgentManager(maxConfig);
    const group = mgr.createGroup("test");
    mgr.startAgent(group.id, maxConfig.roles[0], "first");

    const result = handleRunAgents(maxConfig, mgr, {
      groupId: group.id,
      agents: [{ role: "impl-code", prompt: "second" }],
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe("MAX_CONCURRENT_REACHED");
  });
});
