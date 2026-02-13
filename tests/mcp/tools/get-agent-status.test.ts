// ============================================================
// get_agent_status ツール テスト
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentManager } from "../../../src/agent/manager.js";
import { handleGetAgentStatus } from "../../../src/mcp/tools/get-agent-status.js";
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
        model: "claude-4-sonnet",
        systemPrompt: "You are a code implementer.",
        healthCheckPrompt: "OK",
      },
    ],
  };
}

describe("get_agent_status", () => {
  let manager: AgentManager;
  let config: AppConfig;

  beforeEach(() => {
    config = createTestConfig();
    manager = new AgentManager(config);
  });

  it("存在しない Agent ID の場合 AGENT_NOT_FOUND エラーを返す", () => {
    const result = handleGetAgentStatus(manager, {
      agentId: "nonexistent-agent",
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe("AGENT_NOT_FOUND");
  });

  it("Agent の詳細状態を返す", () => {
    const group = manager.createGroup("test");
    const agent = manager.startAgent(group.id, config.roles[0], "test prompt");

    const result = handleGetAgentStatus(manager, {
      agentId: agent.agentId,
    });

    expect(result).not.toHaveProperty("isError");
    const data = JSON.parse(result.content[0].text);
    expect(data.agentId).toBe(agent.agentId);
    expect(data.groupId).toBe(group.id);
    expect(data.role).toBe("impl-code");
    expect(data.model).toBe("claude-4-sonnet");
    expect(data.status).toBeDefined();
    expect(data.startedAt).toBeDefined();
    expect(typeof data.elapsed_ms).toBe("number");
    expect(typeof data.toolCallCount).toBe("number");
    expect(data.recentToolCalls).toEqual([]);
    expect(data.result).toBeNull();
  });

  it("lastAssistantMessage が null の場合も正しく返す", () => {
    const group = manager.createGroup("test");
    const agent = manager.startAgent(group.id, config.roles[0], "test");

    const result = handleGetAgentStatus(manager, {
      agentId: agent.agentId,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.lastAssistantMessage).toBeNull();
  });
});
