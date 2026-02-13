// ============================================================
// run_agent ツール テスト
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentManager } from "../../../src/agent/manager.js";
import { handleRunAgent } from "../../../src/mcp/tools/run-agent.js";
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
        model: "claude-4-sonnet",
        systemPrompt: "You are a code implementer.",
        healthCheckPrompt: "OK",
      },
      {
        id: "code-review",
        name: "コードレビュワー",
        model: "claude-4-sonnet",
        systemPrompt: "You are a code reviewer.",
        healthCheckPrompt: "OK",
      },
    ],
    ...overrides,
  };
}

describe("run_agent", () => {
  let manager: AgentManager;
  let config: AppConfig;

  beforeEach(() => {
    config = createTestConfig();
    manager = new AgentManager(config);
  });

  it("存在しないグループ ID の場合 GROUP_NOT_FOUND エラーを返す", () => {
    const result = handleRunAgent(config, manager, {
      groupId: "grp-nonexistent",
      role: "impl-code",
      prompt: "Hello",
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe("GROUP_NOT_FOUND");
  });

  it("削除済みグループの場合 GROUP_NOT_ACTIVE エラーを返す", () => {
    const group = manager.createGroup("test");
    manager.deleteGroup(group.id);

    const result = handleRunAgent(config, manager, {
      groupId: group.id,
      role: "impl-code",
      prompt: "Hello",
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe("GROUP_NOT_ACTIVE");
  });

  it("存在しない職種の場合 ROLE_NOT_FOUND エラーを返す", () => {
    const group = manager.createGroup("test");

    const result = handleRunAgent(config, manager, {
      groupId: group.id,
      role: "nonexistent-role",
      prompt: "Hello",
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe("ROLE_NOT_FOUND");
  });

  it("ヘルスチェック未通過の職種の場合 ROLE_UNAVAILABLE エラーを返す", () => {
    const group = manager.createGroup("test");

    // ヘルスチェック結果: impl-code は利用不可
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

    const result = handleRunAgent(config, manager, {
      groupId: group.id,
      role: "impl-code",
      prompt: "Hello",
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe("ROLE_UNAVAILABLE");
  });

  it("同時実行上限に達している場合 MAX_CONCURRENT_REACHED エラーを返す", () => {
    const maxConfig = createTestConfig({
      agent: { defaultTimeout_ms: 300_000, maxConcurrent: 1 },
    });
    const mgr = new AgentManager(maxConfig);
    const group = mgr.createGroup("test");

    // 1つ目は成功
    mgr.startAgent(group.id, maxConfig.roles[0], "first");

    // 2つ目は上限到達
    const result = handleRunAgent(maxConfig, mgr, {
      groupId: group.id,
      role: "impl-code",
      prompt: "second",
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe("MAX_CONCURRENT_REACHED");
  });

  it("正常に Agent を起動できる", () => {
    const group = manager.createGroup("test");

    const result = handleRunAgent(config, manager, {
      groupId: group.id,
      role: "impl-code",
      prompt: "テスト実装して",
    });

    expect(result).not.toHaveProperty("isError");
    const data = JSON.parse(result.content[0].text);
    expect(data.agentId).toMatch(/^impl-code-/);
    expect(data.groupId).toBe(group.id);
    expect(data.role).toBe("impl-code");
    expect(data.model).toBe("claude-4-sonnet");
    expect(data.status).toBe("queued");
  });

  it("起動した Agent が AgentManager に登録されている", () => {
    const group = manager.createGroup("test");

    const result = handleRunAgent(config, manager, {
      groupId: group.id,
      role: "impl-code",
      prompt: "テスト",
    });

    const data = JSON.parse(result.content[0].text);
    const agent = manager.getAgent(data.agentId);
    expect(agent).toBeDefined();
    expect(agent!.groupId).toBe(group.id);
  });

  it("agent:created イベントが発火する", () => {
    const listener = vi.fn();
    manager.on("agent:created", listener);

    const group = manager.createGroup("test");
    handleRunAgent(config, manager, {
      groupId: group.id,
      role: "impl-code",
      prompt: "テスト",
    });

    expect(listener).toHaveBeenCalledOnce();
  });
});
