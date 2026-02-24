// ============================================================
// list_agents ツール テスト
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentManager } from "../../../src/agent/manager.js";
import { handleListAgents } from "../../../src/mcp/tools/list-agents.js";
import type { AppConfig } from "../../../src/types/index.js";

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
        id: "code-review",
        name: "コードレビュワー",
        description: "コードの品質をレビューする",
        model: "claude-4-sonnet",
        systemPrompt: "You are a code reviewer.",
        healthCheckPrompt: "OK",
      },
    ],
  };
}

describe("list_agents", () => {
  let manager: AgentManager;
  let config: AppConfig;

  beforeEach(() => {
    config = createTestConfig();
    manager = new AgentManager(config);
  });

  it("存在しない groupId を指定した場合 GROUP_NOT_FOUND エラーを返す", () => {
    const result = handleListAgents(manager, {
      groupId: "grp-nonexistent",
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe("GROUP_NOT_FOUND");
  });

  it("Agent がない場合は空配列と total: 0 を返す", () => {
    const result = handleListAgents(manager, {});

    const data = JSON.parse(result.content[0].text);
    expect(data.agents).toEqual([]);
    expect(data.total).toBe(0);
  });

  it("全 Agent を一覧取得できる", () => {
    const group = manager.createGroup("test");
    manager.startAgent(group.id, config.roles[0], "prompt1");
    manager.startAgent(group.id, config.roles[1], "prompt2");

    const result = handleListAgents(manager, {});

    const data = JSON.parse(result.content[0].text);
    expect(data.agents).toHaveLength(2);
    expect(data.total).toBe(2);
  });

  it("groupId でフィルタリングできる", () => {
    const group1 = manager.createGroup("group1");
    const group2 = manager.createGroup("group2");

    manager.startAgent(group1.id, config.roles[0], "prompt1");
    manager.startAgent(group2.id, config.roles[0], "prompt2");

    const result = handleListAgents(manager, { groupId: group1.id });

    const data = JSON.parse(result.content[0].text);
    expect(data.agents).toHaveLength(1);
    expect(data.agents[0].groupId).toBe(group1.id);
  });

  it("status=all は全件を返す", () => {
    const group = manager.createGroup("test");
    manager.startAgent(group.id, config.roles[0], "prompt");

    const result = handleListAgents(manager, { status: "all" });

    const data = JSON.parse(result.content[0].text);
    expect(data.agents).toHaveLength(1);
  });

  it("各 Agent のフィールドが正しい形式で含まれる", () => {
    const group = manager.createGroup("test");
    manager.startAgent(group.id, config.roles[0], "prompt");

    const result = handleListAgents(manager, {});

    const data = JSON.parse(result.content[0].text);
    const agent = data.agents[0];
    expect(agent.agentId).toBeDefined();
    expect(agent.groupId).toBe(group.id);
    expect(agent.role).toBe("impl-code");
    expect(agent.model).toBe("claude-4-sonnet");
    expect(agent.status).toBeDefined();
    expect(agent.startedAt).toBeDefined();
    expect(typeof agent.elapsed_ms).toBe("number");
    expect(typeof agent.toolCallCount).toBe("number");
  });
});
